import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chartKey } from '../../shared/chart-key'
import { ChartRecordSchema, type ChartRecord } from '../../shared/schemas'
import { tmpDir } from '../../../test/helpers/tmp'
import { TAGGED_CHARTER, TAGGED_CHARTER_TEXT } from '../../../test/helpers/marked-up-names'
import { openCatalog, type CatalogDb } from './db'
import { listFavourites, setFavourite } from './favourites'
import { upsertChart } from './queries'
import { rekeyChartLists } from './rekey'
import { createSetlist, listSetlists, setSetlistEntry } from './setlists'

/**
 * Carrying the user's own lists across a chart the metadata editor has renamed.
 *
 * A favourite and a setlist entry are keyed on the song, the artist and the charter, and the editor
 * writes exactly those three fields, so in one release correcting a chart's artist silently took
 * the heart off it and dropped it out of every setlist holding it. These are the move that closes
 * that, and in particular the three cases where a move is not a plain rename: a second copy still
 * answering to the old details, a title cleared to nothing, and a favourite already on the new
 * details.
 */

const chart = (path: string, fields: Partial<ChartRecord> = {}): ChartRecord =>
  ChartRecordSchema.parse({
    path,
    chartType: 'folder',
    name: 'Everlong',
    artist: 'Foo Fighters',
    charter: 'Neversoft',
    folderHash: 'h1',
    modifiedTime: 1,
    ...fields
  })

const OLD = chartKey({ name: 'Everlong', artist: 'Foo Fighters', charter: 'Neversoft' })
/** The artist, corrected. The commonest edit this view exists for. */
const NEW = chartKey({ name: 'Everlong', artist: 'Foo Fighters (US)', charter: 'Neversoft' })
const OTHER = chartKey({ name: 'YYZ', artist: 'Rush', charter: 'Harmonix' })

/** The one setlist in a fresh catalog. */
const only = (db: CatalogDb): string => listSetlists(db)[0].id
/** By name, not by index: setlists made in the same millisecond tie on createdAt. */
const byName = (db: CatalogDb, name: string): string =>
  listSetlists(db).find((list) => list.name === name)!.id
const entriesOf = (db: CatalogDb, id: string): { artist: string; addedAt: string }[] =>
  (listSetlists(db).find((list) => list.id === id)?.entries ?? []).map((entry) => ({
    artist: entry.artist,
    addedAt: entry.addedAt
  }))

/** The stored positions, read straight out, because `listSetlists` orders by them and hides them. */
const positions = (db: CatalogDb, id: string): number[] =>
  (
    db
      .prepare(`SELECT position FROM setlist_entries WHERE setlistId = ? ORDER BY position`)
      .all(id) as { position: number }[]
  ).map((row) => row.position)

describe('rekeyChartLists', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('rekey'), 'catalog.db'))
    // The row as it stands AFTER the edit and the re-index, which is when main calls this.
    upsertChart(db, chart('/library/everlong', { artist: 'Foo Fighters (US)' }))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves the favourite onto the new details, keeping the date it was hearted', () => {
    setFavourite(db, OLD, true)
    const hearted = listFavourites(db)[0].addedAt

    const move = rekeyChartLists(db, OLD, NEW)

    expect(move).toMatchObject({ favourite: true, setlists: [], oldKeyKept: false, merged: false })
    // The date travels, so a chart hearted last year does not jump to the top of a list ordered by
    // when it was hearted just because its artist was corrected.
    expect(listFavourites(db)).toEqual([{ ...NEW, addedAt: hearted }])
  })

  it('moves a setlist entry without moving it up or down the running order', () => {
    createSetlist(db, 'Friday night')
    const list = only(db)
    setSetlistEntry(db, list, OTHER, true)
    setSetlistEntry(db, list, OLD, true)
    setSetlistEntry(db, list, chartKey({ name: 'Painkiller' }), true)
    const added = entriesOf(db, list)[1].addedAt

    const move = rekeyChartLists(db, OLD, NEW)

    expect(move).toMatchObject({ favourite: false, setlists: ['Friday night'] })
    // Second of three, where the user put it. A setlist is a running order and a corrected artist
    // is not a reason for a song to change place in it.
    expect(entriesOf(db, list)[1]).toEqual({ artist: NEW.artist, addedAt: added })
    expect(positions(db, list)).toEqual([0, 1, 2])
  })

  it('says nothing happened when the three fields did not move', () => {
    setFavourite(db, OLD, true)
    expect(rekeyChartLists(db, OLD, OLD)).toBeNull()
    // Case and markup are both below the resolution of every comparison these rows are made
    // through, so neither is a rename and neither may rewrite a row.
    expect(
      rekeyChartLists(db, OLD, chartKey({ ...OLD, name: 'EVERLONG', charter: 'NEVERSOFT' }))
    ).toBeNull()
    expect(
      rekeyChartLists(
        db,
        chartKey({ name: 'Firestarter', charter: TAGGED_CHARTER }),
        chartKey({ name: 'Firestarter', charter: TAGGED_CHARTER_TEXT })
      )
    ).toBeNull()
    expect(listFavourites(db)).toHaveLength(1)
  })

  it('says nothing happened when the chart was on no list', () => {
    expect(rekeyChartLists(db, OLD, NEW)).toBeNull()
  })

  it('says nothing happened when the old details named no chart', () => {
    // Nothing can have been stored under a key with no title, so there is nothing to carry.
    expect(rekeyChartLists(db, chartKey({ name: '', artist: 'Foo Fighters' }), NEW)).toBeNull()
  })

  /**
   * A second, unedited copy of the chart is still in the library.
   *
   * Two copies of one chart is what `catalog:duplicates` calls an exact duplicate, and editing one
   * leaves the other saying what it always said. The old details still name a chart the user has,
   * so the rows stay on them and are copied to the new ones rather than moved.
   */
  describe('with a second copy still answering to the old details', () => {
    beforeEach(() => {
      upsertChart(db, chart('/library/everlong-copy'))
    })

    it('copies the favourite and leaves the old one where it is', () => {
      setFavourite(db, OLD, true)

      const move = rekeyChartLists(db, OLD, NEW)

      expect(move).toMatchObject({ oldKeyKept: true, favourite: true })
      expect(
        listFavourites(db)
          .map((fav) => fav.artist)
          .sort()
      ).toEqual(['Foo Fighters', 'Foo Fighters (US)'])
    })

    it('appends the copied setlist entry rather than sitting it on the original position', () => {
      createSetlist(db, 'Friday night')
      const list = only(db)
      setSetlistEntry(db, list, OLD, true)
      setSetlistEntry(db, list, OTHER, true)

      rekeyChartLists(db, OLD, NEW)

      // The old entry is still at 0 and cannot be shared, so the copy goes to the end, which is
      // where anything new goes and the only place that does not overrule an order the user set.
      expect(entriesOf(db, list).map((entry) => entry.artist)).toEqual([
        'Foo Fighters',
        'Rush',
        'Foo Fighters (US)'
      ])
      expect(positions(db, list)).toEqual([0, 1, 2])
    })
  })

  /**
   * The title was cleared, so there is nowhere to move to.
   *
   * The rows are deliberately left alone rather than deleted. A favourite matching no chart is an
   * ordinary state in this design (it is what a favourite of an undownloaded Chorus chart is), and
   * it starts matching again the moment a chart says that name, which here means the moment the
   * user types the title back. Deleting would make the editor's own undo lossy.
   */
  describe('with the title cleared', () => {
    const NAMELESS = chartKey({ name: '', artist: 'Foo Fighters (US)', charter: 'Neversoft' })

    it('leaves the favourite and every entry on the old details, and says so', () => {
      setFavourite(db, OLD, true)
      createSetlist(db, 'Friday night')
      setSetlistEntry(db, only(db), OLD, true)

      const move = rekeyChartLists(db, OLD, NAMELESS)

      expect(move).toMatchObject({ stranded: true, favourite: true, setlists: ['Friday night'] })
      expect(listFavourites(db)).toHaveLength(1)
      expect(listFavourites(db)[0].artist).toBe('Foo Fighters')
      expect(entriesOf(db, only(db)).map((entry) => entry.artist)).toEqual(['Foo Fighters'])
    })

    it('finds them again when the title is typed back', () => {
      setFavourite(db, OLD, true)
      rekeyChartLists(db, OLD, NAMELESS)
      upsertChart(db, chart('/library/everlong', { artist: 'Foo Fighters' }))

      const hits = listFavourites(db)
      expect(hits).toHaveLength(1)
      // Nothing had to be restored, because nothing was removed.
      expect(hits[0]).toMatchObject(OLD)
    })
  })

  /**
   * The new details already carry a favourite or an entry, so the write is a merge.
   *
   * `INSERT OR IGNORE`, which is what these two tables already mean everywhere else they are
   * written: the row that was there keeps its own date and its own place.
   */
  describe('with the new details already on a list', () => {
    it('keeps one favourite, with the date the new details already carried', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
      setFavourite(db, OLD, true)
      vi.setSystemTime(new Date('2025-06-01T00:00:00.000Z'))
      setFavourite(db, NEW, true)

      const move = rekeyChartLists(db, OLD, NEW)

      expect(move).toMatchObject({ merged: true })
      expect(listFavourites(db)).toEqual([{ ...NEW, addedAt: '2025-06-01T00:00:00.000Z' }])
    })

    it('keeps one entry per setlist, at the place the user already put it', () => {
      createSetlist(db, 'Friday night')
      const list = only(db)
      setSetlistEntry(db, list, NEW, true)
      setSetlistEntry(db, list, OTHER, true)
      setSetlistEntry(db, list, OLD, true)

      const move = rekeyChartLists(db, OLD, NEW)

      expect(move).toMatchObject({ merged: true, setlists: ['Friday night'] })
      expect(entriesOf(db, list).map((entry) => entry.artist)).toEqual([
        'Foo Fighters (US)',
        'Rush'
      ])
      // The row that went left a hole at 2, and the numbering is dense again behind it.
      expect(positions(db, list)).toEqual([0, 1])
    })
  })

  it('moves the chart in every setlist holding it, and names them in the sidebar order', () => {
    createSetlist(db, 'Friday night')
    createSetlist(db, 'Warm up')
    createSetlist(db, 'Never played')
    const friday = byName(db, 'Friday night')
    const warmUp = byName(db, 'Warm up')
    setSetlistEntry(db, friday, OTHER, true)
    setSetlistEntry(db, friday, OLD, true)
    setSetlistEntry(db, warmUp, OLD, true)
    setFavourite(db, OLD, true)

    const move = rekeyChartLists(db, OLD, NEW)

    expect(move).toMatchObject({ favourite: true, setlists: ['Friday night', 'Warm up'] })
    expect(entriesOf(db, friday).map((entry) => entry.artist)).toEqual([
      'Rush',
      'Foo Fighters (US)'
    ])
    expect(entriesOf(db, warmUp).map((entry) => entry.artist)).toEqual(['Foo Fighters (US)'])
    expect(positions(db, friday)).toEqual([0, 1])
    expect(positions(db, warmUp)).toEqual([0])
    // The setlist that never held it is untouched, and is not named in the sentence the editor
    // prints either.
    expect(listSetlists(db).find((list) => list.name === 'Never played')?.entries).toEqual([])
  })
})
