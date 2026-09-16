import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { setlistEntryKey } from '../../shared/setlists'
import { ChartRecordSchema, type ChartRecord } from '../../shared/schemas'
import { tmpDir } from '../../../test/helpers/tmp'
import { EIGHT_TAG_CHARTER, EIGHT_TAG_CHARTER_TEXT } from '../../../test/helpers/marked-up-names'
import { openCatalog, type CatalogDb } from './db'
import {
  createSetlist,
  deleteSetlist,
  listSetlists,
  moveSetlistEntry,
  renameSetlist,
  setSetlistEntry
} from './setlists'
import { chartsByMeta, deleteChartByPath, upsertChart } from './queries'

const record = (path: string, fields: Partial<ChartRecord> = {}): ChartRecord =>
  ChartRecordSchema.parse({
    path,
    chartType: path.endsWith('.sng') ? 'sng' : 'folder',
    name: 'Everlong',
    artist: 'Foo Fighters',
    charter: 'Neversoft',
    folderHash: 'h1',
    modifiedTime: 1,
    ...fields
  })

const EVERLONG = setlistEntryKey({ name: 'Everlong', artist: 'Foo Fighters', charter: 'Neversoft' })
const PAINKILLER = setlistEntryKey({ name: 'Painkiller', artist: 'Judas Priest', charter: 'CCC' })

/** The one setlist in a freshly made catalog, which is what every test below starts from. */
const only = (db: CatalogDb): string => listSetlists(db)[0].id
/** By name, not by index: two setlists made in the same millisecond tie on createdAt. */
const byName = (db: CatalogDb, name: string): string =>
  listSetlists(db).find((l) => l.name === name)!.id
const names = (db: CatalogDb, id: string): string[] =>
  (listSetlists(db).find((l) => l.id === id)?.entries ?? []).map((e) => e.name)

describe('the setlists table', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('setlists'), 'catalog.db'))
  })

  it('starts empty and answers with the list after a create', () => {
    expect(listSetlists(db)).toEqual([])
    const after = createSetlist(db, 'Friday night')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ name: 'Friday night', entries: [] })
    expect(typeof after[0].id).toBe('string')
  })
  it('gives each setlist an id that is not its name, so a rename keeps its entries', () => {
    createSetlist(db, 'Friday night')
    const id = only(db)
    setSetlistEntry(db, id, EVERLONG, true)
    const after = renameSetlist(db, id, 'Saturday night')
    expect(after[0].id).toBe(id)
    expect(after[0].name).toBe('Saturday night')
    expect(after[0].entries.map((e) => e.name)).toEqual(['Everlong'])
  })
  it('refuses a second setlist by a name one already carries, whatever its capitals', () => {
    createSetlist(db, 'Friday night')
    expect(() => createSetlist(db, 'FRIDAY NIGHT')).toThrow(/already have a setlist/)
    expect(listSetlists(db)).toHaveLength(1)
  })
  it('refuses a rename onto another setlist, and allows one onto itself', () => {
    createSetlist(db, 'Friday night')
    createSetlist(db, 'Encores')
    const friday = byName(db, 'Friday night')
    const encores = byName(db, 'Encores')
    expect(() => renameSetlist(db, encores, 'Friday night')).toThrow(/already have a setlist/)
    expect(renameSetlist(db, friday, 'Friday night').map((l) => l.name)).toContain('Friday night')
  })
  it('lists setlists oldest first, so a new one is where it was made', () => {
    createSetlist(db, 'First')
    createSetlist(db, 'Second')
    expect(listSetlists(db).map((l) => l.name)).toEqual(['First', 'Second'])
  })
  it('refuses to add to a setlist that is gone rather than storing a row nothing names', () => {
    createSetlist(db, 'Friday night')
    const id = only(db)
    deleteSetlist(db, id)
    expect(() => setSetlistEntry(db, id, EVERLONG, true)).toThrow(/no longer exists/)
  })
})

describe('what a setlist holds', () => {
  let db: CatalogDb
  let id: string
  beforeEach(() => {
    db = openCatalog(join(tmpDir('setlists'), 'catalog.db'))
    createSetlist(db, 'Friday night')
    id = only(db)
  })

  it('adds a chart and answers with the list as it now stands', () => {
    const after = setSetlistEntry(db, id, EVERLONG, true)
    expect(after[0].entries).toHaveLength(1)
    expect(after[0].entries[0]).toMatchObject({ name: 'Everlong', artist: 'Foo Fighters' })
    expect(typeof after[0].entries[0].addedAt).toBe('string')
  })
  it('adding twice is one entry, and keeps the first addedAt and the place it holds', () => {
    const first = setSetlistEntry(db, id, EVERLONG, true)[0].entries[0].addedAt
    setSetlistEntry(db, id, PAINKILLER, true)
    expect(setSetlistEntry(db, id, EVERLONG, true)[0].entries).toHaveLength(2)
    expect(names(db, id)).toEqual(['Everlong', 'Painkiller'])
    expect(listSetlists(db)[0].entries[0].addedAt).toBe(first)
  })
  it('takes a chart out, and taking out one that was never in is not an error', () => {
    setSetlistEntry(db, id, EVERLONG, true)
    expect(setSetlistEntry(db, id, EVERLONG, false)[0].entries).toEqual([])
    expect(setSetlistEntry(db, id, EVERLONG, false)[0].entries).toEqual([])
  })
  it('is one entry however the chart spells its own capitals', () => {
    setSetlistEntry(db, id, EVERLONG, true)
    setSetlistEntry(
      db,
      id,
      setlistEntryKey({ name: 'EVERLONG', artist: 'FOO FIGHTERS', charter: 'NEVERSOFT' }),
      true
    )
    expect(listSetlists(db)[0].entries).toHaveLength(1)
  })
  it('holds the same song charted by two people as two charts', () => {
    setSetlistEntry(db, id, EVERLONG, true)
    setSetlistEntry(db, id, setlistEntryKey({ ...EVERLONG, charter: 'CCC' }), true)
    expect(listSetlists(db)[0].entries).toHaveLength(2)
  })
  it('holds a chart that credits nobody', () => {
    setSetlistEntry(db, id, setlistEntryKey({ name: 'Untitled' }), true)
    expect(listSetlists(db)[0].entries[0]).toMatchObject({
      name: 'Untitled',
      artist: '',
      charter: ''
    })
  })
  it('puts a new chart at the end rather than overruling an order the user set', () => {
    setSetlistEntry(db, id, EVERLONG, true)
    setSetlistEntry(db, id, PAINKILLER, true)
    expect(names(db, id)).toEqual(['Everlong', 'Painkiller'])
  })
})

describe('the order a setlist is in', () => {
  let db: CatalogDb
  let id: string
  const three = ['A', 'B', 'C']
  beforeEach(() => {
    db = openCatalog(join(tmpDir('setlists'), 'catalog.db'))
    createSetlist(db, 'Friday night')
    id = only(db)
    for (const name of three) setSetlistEntry(db, id, setlistEntryKey({ name }), true)
  })

  it('moves a chart up by one place', () => {
    moveSetlistEntry(db, id, setlistEntryKey({ name: 'C' }), -1)
    expect(names(db, id)).toEqual(['A', 'C', 'B'])
  })
  it('moves a chart down by one place', () => {
    moveSetlistEntry(db, id, setlistEntryKey({ name: 'A' }), 1)
    expect(names(db, id)).toEqual(['B', 'A', 'C'])
  })
  it('does nothing at either end rather than reporting an error nobody caused', () => {
    moveSetlistEntry(db, id, setlistEntryKey({ name: 'A' }), -1)
    moveSetlistEntry(db, id, setlistEntryKey({ name: 'C' }), 1)
    expect(names(db, id)).toEqual(three)
  })
  it('does nothing for a chart this setlist does not hold', () => {
    moveSetlistEntry(db, id, setlistEntryKey({ name: 'Z' }), -1)
    expect(names(db, id)).toEqual(three)
  })
  // The dense numbering is what makes a move a swap. A removal that left a gap would put two
  // entries at positions the neighbour lookup cannot reach across, and the list would stop moving.
  it('closes up after a removal, so the next move still finds its neighbour', () => {
    setSetlistEntry(db, id, setlistEntryKey({ name: 'B' }), false)
    moveSetlistEntry(db, id, setlistEntryKey({ name: 'C' }), -1)
    expect(names(db, id)).toEqual(['C', 'A'])
  })
  it('survives a round trip through the list, ending where it started', () => {
    moveSetlistEntry(db, id, setlistEntryKey({ name: 'A' }), 1)
    moveSetlistEntry(db, id, setlistEntryKey({ name: 'A' }), -1)
    expect(names(db, id)).toEqual(three)
  })
})

describe('two setlists', () => {
  let db: CatalogDb
  let friday: string
  let encores: string
  beforeEach(() => {
    db = openCatalog(join(tmpDir('setlists'), 'catalog.db'))
    createSetlist(db, 'Friday night')
    createSetlist(db, 'Encores')
    friday = byName(db, 'Friday night')
    encores = byName(db, 'Encores')
  })

  it('can both hold the same chart, which the favourites key alone could not', () => {
    setSetlistEntry(db, friday, EVERLONG, true)
    setSetlistEntry(db, encores, EVERLONG, true)
    expect(names(db, friday)).toEqual(['Everlong'])
    expect(names(db, encores)).toEqual(['Everlong'])
  })
  it('lose it separately: taking it out of one leaves it in the other', () => {
    setSetlistEntry(db, friday, EVERLONG, true)
    setSetlistEntry(db, encores, EVERLONG, true)
    setSetlistEntry(db, friday, EVERLONG, false)
    expect(names(db, friday)).toEqual([])
    expect(names(db, encores)).toEqual(['Everlong'])
  })
  it('order it separately', () => {
    for (const id of [friday, encores]) {
      setSetlistEntry(db, id, EVERLONG, true)
      setSetlistEntry(db, id, PAINKILLER, true)
    }
    moveSetlistEntry(db, friday, PAINKILLER, -1)
    expect(names(db, friday)).toEqual(['Painkiller', 'Everlong'])
    expect(names(db, encores)).toEqual(['Everlong', 'Painkiller'])
  })
})

describe('deleting a setlist', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('setlists'), 'catalog.db'))
  })

  it('takes its entries with it, leaving no rows nothing names', () => {
    createSetlist(db, 'Friday night')
    const id = only(db)
    setSetlistEntry(db, id, EVERLONG, true)
    setSetlistEntry(db, id, PAINKILLER, true)
    expect(deleteSetlist(db, id)).toEqual([])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM setlist_entries`).get()).toEqual({ n: 0 })
  })
  it('leaves the other setlists and their entries exactly as they were', () => {
    createSetlist(db, 'Friday night')
    createSetlist(db, 'Encores')
    const friday = byName(db, 'Friday night')
    const encores = byName(db, 'Encores')
    setSetlistEntry(db, friday, EVERLONG, true)
    setSetlistEntry(db, encores, EVERLONG, true)
    deleteSetlist(db, friday)
    expect(names(db, encores)).toEqual(['Everlong'])
  })
  it('leaves the charts themselves in the catalog, because it holds no path to touch', () => {
    upsertChart(db, record('/lib/Everlong'))
    createSetlist(db, 'Friday night')
    const id = only(db)
    setSetlistEntry(db, id, EVERLONG, true)
    deleteSetlist(db, id)
    expect(chartsByMeta(db, [EVERLONG])[0]?.path).toBe('/lib/Everlong')
  })
  it('deleting one that is already gone is not an error', () => {
    expect(deleteSetlist(db, 'nothing')).toEqual([])
  })
})

describe('what a setlist entry survives', () => {
  let db: CatalogDb
  let id: string
  const held = (): string | undefined => chartsByMeta(db, [EVERLONG])[0]?.path
  beforeEach(() => {
    db = openCatalog(join(tmpDir('setlists'), 'catalog.db'))
    createSetlist(db, 'Friday night')
    id = only(db)
    upsertChart(db, record('/lib/Everlong'))
    setSetlistEntry(db, id, EVERLONG, true)
  })

  it('the chart moving on disk', () => {
    deleteChartByPath(db, '/lib/Everlong')
    upsertChart(db, record('/lib/Rock/Everlong'))
    expect(names(db, id)).toEqual(['Everlong'])
    expect(held()).toBe('/lib/Rock/Everlong')
  })
  it('the chart being re-downloaded, as a .sng over a folder', () => {
    deleteChartByPath(db, '/lib/Everlong')
    upsertChart(db, record('/lib/Everlong.sng', { folderHash: 'h2' }))
    expect(names(db, id)).toEqual(['Everlong'])
    expect(held()).toBe('/lib/Everlong.sng')
  })
  it('the chart being deleted, and coming back later', () => {
    deleteChartByPath(db, '/lib/Everlong')
    expect(names(db, id)).toEqual(['Everlong'])
    expect(held()).toBeUndefined()
    upsertChart(db, record('/lib/Everlong'))
    expect(held()).toBe('/lib/Everlong')
  })
  it('the catalog being rebuilt from nothing', () => {
    db.prepare(`DELETE FROM charts`).run()
    upsertChart(db, record('/lib/Everlong'))
    expect(names(db, id)).toEqual(['Everlong'])
    expect(held()).toBe('/lib/Everlong')
  })
  it('an entry made before the chart was ever downloaded', () => {
    setSetlistEntry(db, id, PAINKILLER, true)
    expect(chartsByMeta(db, [PAINKILLER])[0]).toBeNull()
    upsertChart(
      db,
      record('/lib/Painkiller', { name: 'Painkiller', artist: 'Judas Priest', charter: 'CCC' })
    )
    expect(chartsByMeta(db, [PAINKILLER])[0]?.path).toBe('/lib/Painkiller')
  })
  it('two copies of the chart, which are one entry and one row between them', () => {
    upsertChart(db, record('/lib/copy/Everlong', { folderHash: 'h2' }))
    expect(names(db, id)).toEqual(['Everlong'])
    expect(chartsByMeta(db, [EVERLONG, EVERLONG]).map((c) => c?.path)).toEqual([
      '/lib/Everlong',
      '/lib/Everlong'
    ])
  })
})

describe('the catalog rows a setlist is drawn from', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('setlists'), 'catalog.db'))
  })

  it('answers one row per key, in the order asked, with null for what is not held', () => {
    upsertChart(db, record('/lib/Everlong'))
    expect(chartsByMeta(db, [PAINKILLER, EVERLONG]).map((c) => c?.path ?? null)).toEqual([
      null,
      '/lib/Everlong'
    ])
  })
  it('matches a chart whose name carries markup, by the text a reader sees', () => {
    upsertChart(db, record('/lib/marked', { charter: EIGHT_TAG_CHARTER }))
    const key = setlistEntryKey({
      name: 'Everlong',
      artist: 'Foo Fighters',
      charter: EIGHT_TAG_CHARTER_TEXT
    })
    expect(chartsByMeta(db, [key])[0]?.path).toBe('/lib/marked')
  })
  it('matches a chart that credits nobody, where a null would match nothing at all', () => {
    upsertChart(db, record('/lib/Untitled', { name: 'Untitled', artist: null, charter: null }))
    expect(chartsByMeta(db, [setlistEntryKey({ name: 'Untitled' })])[0]?.path).toBe('/lib/Untitled')
  })
  it('does not match the same song charted by somebody else', () => {
    upsertChart(db, record('/lib/Everlong', { charter: 'CCC' }))
    expect(chartsByMeta(db, [EVERLONG])[0]).toBeNull()
  })
  it('carries the length the running time is added up from', () => {
    upsertChart(db, record('/lib/Everlong', { songLength: 250_000 }))
    expect(chartsByMeta(db, [EVERLONG])[0]?.songLength).toBe(250_000)
  })
  it('asks nothing of the database for an empty list', () => {
    expect(chartsByMeta(db, [])).toEqual([])
  })
})
