import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { favouriteKey } from '../../shared/favourites'
import { ChartRecordSchema, type ChartRecord } from '../../shared/schemas'
import { tmpDir } from '../../../test/helpers/tmp'
import { EIGHT_TAG_CHARTER, EIGHT_TAG_CHARTER_TEXT } from '../../../test/helpers/marked-up-names'
import { openCatalog, type CatalogDb } from './db'
import { listFavourites, setFavourite } from './favourites'
import { countCharts, deleteChartByPath, queryCharts, upsertChart } from './queries'

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

const EVERLONG = favouriteKey({ name: 'Everlong', artist: 'Foo Fighters', charter: 'Neversoft' })

/** The paths a favourites-only query returns, which is the filter as a user meets it. */
const favouritePaths = (db: CatalogDb): string[] =>
  queryCharts(db, { search: '', offset: 0, limit: 100, favouritesOnly: true }).map((c) => c.path)

describe('the favourites table', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('fav'), 'catalog.db'))
  })

  it('stores one row per chart and answers with the list', () => {
    expect(listFavourites(db)).toEqual([])
    const after = setFavourite(db, EVERLONG, true)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ name: 'Everlong', artist: 'Foo Fighters' })
    expect(typeof after[0].addedAt).toBe('string')
  })
  it('hearting twice is one row, and keeps the first addedAt', () => {
    const first = setFavourite(db, EVERLONG, true)[0].addedAt
    expect(setFavourite(db, EVERLONG, true)).toHaveLength(1)
    expect(listFavourites(db)[0].addedAt).toBe(first)
  })
  it('un-hearting something that was never hearted is not an error', () => {
    expect(setFavourite(db, EVERLONG, false)).toEqual([])
  })
  it('un-hearts what it hearted', () => {
    setFavourite(db, EVERLONG, true)
    expect(setFavourite(db, EVERLONG, false)).toEqual([])
  })
  it('is one favourite however the chart spells its own capitals', () => {
    setFavourite(db, EVERLONG, true)
    setFavourite(
      db,
      favouriteKey({ name: 'EVERLONG', artist: 'FOO FIGHTERS', charter: 'NEVERSOFT' }),
      true
    )
    expect(listFavourites(db)).toHaveLength(1)
  })
  it('separates the same song charted by two people', () => {
    setFavourite(db, EVERLONG, true)
    setFavourite(db, { ...EVERLONG, charter: 'CCC' }, true)
    expect(listFavourites(db)).toHaveLength(2)
  })
  it("leaves the chart's own row exactly as the scanner wrote it", () => {
    // The claim behind not bumping SCAN_VERSION: a favourite is something the user did, and
    // nothing about it is derived from a chart on disk. If hearting moved a stored value, every
    // user would owe their library a re-read to get it back.
    upsertChart(db, record('/lib/everlong', { scanVersion: 7 }))
    const before = db.prepare('SELECT * FROM charts WHERE path = ?').get('/lib/everlong')
    setFavourite(db, EVERLONG, true)
    expect(db.prepare('SELECT * FROM charts WHERE path = ?').get('/lib/everlong')).toEqual(before)
  })
  it('favourites a chart that credits nobody', () => {
    setFavourite(db, favouriteKey({ name: 'Untitled' }), true)
    expect(listFavourites(db)[0]).toMatchObject({ name: 'Untitled', artist: '', charter: '' })
  })
})

describe('the favourites filter', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('fav'), 'catalog.db'))
    upsertChart(db, record('/lib/everlong'))
    upsertChart(db, record('/lib/painkiller', { name: 'Painkiller', artist: 'Judas Priest' }))
  })

  it('returns nothing until something is hearted', () => {
    expect(favouritePaths(db)).toEqual([])
    expect(countCharts(db, { search: '', offset: 0, limit: 100, favouritesOnly: true })).toBe(0)
  })
  it('returns the hearted chart and only that one', () => {
    setFavourite(db, EVERLONG, true)
    expect(favouritePaths(db)).toEqual(['/lib/everlong'])
    expect(countCharts(db, { search: '', offset: 0, limit: 100, favouritesOnly: true })).toBe(1)
  })
  it('does not match a chart the same song was charted by somebody else', () => {
    // The mutation this pins: drop `charter` from the join and this chart joins the favourite.
    upsertChart(db, record('/lib/everlong-ccc', { charter: 'CCC' }))
    setFavourite(db, EVERLONG, true)
    expect(favouritePaths(db)).toEqual(['/lib/everlong'])
  })
  it('matches a chart whose name carries markup, by the text a reader sees', () => {
    upsertChart(db, record('/lib/firestarter', { name: 'Firestarter', charter: EIGHT_TAG_CHARTER }))
    setFavourite(
      db,
      favouriteKey({
        name: 'Firestarter',
        artist: 'Foo Fighters',
        charter: EIGHT_TAG_CHARTER_TEXT
      }),
      true
    )
    expect(favouritePaths(db)).toEqual(['/lib/firestarter'])
  })
  it('matches a chart that credits nobody, where a null would match nothing at all', () => {
    // Without COALESCE(..., '') on the catalog's side this chart is unfavouritable in practice,
    // while the heart in the rail says otherwise.
    upsertChart(db, record('/lib/nameless', { name: 'Untitled', artist: null, charter: null }))
    setFavourite(db, favouriteKey({ name: 'Untitled' }), true)
    expect(favouritePaths(db)).toEqual(['/lib/nameless'])
  })
  it('composes with the other constraints rather than replacing them', () => {
    setFavourite(db, EVERLONG, true)
    setFavourite(
      db,
      favouriteKey({ name: 'Painkiller', artist: 'Judas Priest', charter: 'Neversoft' }),
      true
    )
    const hits = queryCharts(db, {
      search: '',
      offset: 0,
      limit: 100,
      favouritesOnly: true,
      artist: 'Judas Priest'
    })
    expect(hits.map((c) => c.path)).toEqual(['/lib/painkiller'])
  })
  it('applies to a search as well as to the plain list', () => {
    setFavourite(db, EVERLONG, true)
    const hits = queryCharts(db, { search: 'foo', offset: 0, limit: 100, favouritesOnly: true })
    expect(hits.map((c) => c.path)).toEqual(['/lib/everlong'])
    expect(countCharts(db, { search: 'judas', offset: 0, limit: 100, favouritesOnly: true })).toBe(
      0
    )
  })
  it('filters the library rather than the page on screen', () => {
    // 30 charts, one of them hearted and sorted last, asked for one page of 10. A renderer
    // picking favourites out of the rows it was handed would find nothing here.
    for (let i = 0; i < 30; i++) {
      upsertChart(db, record(`/lib/bulk-${i}`, { name: `Song ${String(i).padStart(2, '0')}` }))
    }
    setFavourite(db, { ...EVERLONG, name: 'Song 29' }, true)
    const page = queryCharts(db, {
      search: '',
      offset: 0,
      limit: 10,
      favouritesOnly: true,
      sort: 'title',
      direction: 'asc'
    })
    expect(page.map((c) => c.path)).toEqual(['/lib/bulk-29'])
  })
})

/**
 * The five things that happen to a chart, against a favourite that has to survive them.
 *
 * This is the argument for the key in one place: a favourite keyed on the path fails the first,
 * and one keyed on either chart hash fails the second and cannot be made at all for the last two.
 */
describe('what a favourite survives', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('fav'), 'catalog.db'))
    upsertChart(db, record('/lib/Foo Fighters - Everlong'))
    setFavourite(db, EVERLONG, true)
  })

  it('the chart moving on disk', () => {
    // A rescan after the user reorganises their folders: the row is deleted and written back at
    // its new path, with a new folderHash and every other stored value changed with it.
    deleteChartByPath(db, '/lib/Foo Fighters - Everlong')
    upsertChart(db, record('/lib/rock/Everlong', { folderHash: 'h2', modifiedTime: 2 }))
    expect(favouritePaths(db)).toEqual(['/lib/rock/Everlong'])
  })
  it('the chart being re-downloaded, as a .sng over a folder', () => {
    // The shape changes, the chart file's bytes change with the charter's new version, and both
    // chart identities move. The favourite is attached to neither.
    deleteChartByPath(db, '/lib/Foo Fighters - Everlong')
    upsertChart(
      db,
      record('/lib/Foo Fighters - Everlong.sng', {
        folderHash: 'h9',
        cloneHeroChecksum: 'f'.repeat(32),
        chartHash: 'a-different-hash'
      })
    )
    expect(favouritePaths(db)).toEqual(['/lib/Foo Fighters - Everlong.sng'])
  })
  it('two copies of the chart, which are one favourite between them', () => {
    // Deliberate, and the same relationship catalog:duplicates calls an exact duplicate: the
    // favourite names the chart, so both copies of it are favourited.
    upsertChart(db, record('/lib/backup/Everlong'))
    expect(favouritePaths(db).sort()).toEqual([
      '/lib/Foo Fighters - Everlong',
      '/lib/backup/Everlong'
    ])
  })
  it('the chart being deleted, and coming back later', () => {
    deleteChartByPath(db, '/lib/Foo Fighters - Everlong')
    expect(favouritePaths(db)).toEqual([])
    // The row is gone and the favourite is not: it is the user's, not the chart's.
    expect(listFavourites(db)).toHaveLength(1)
    upsertChart(db, record('/lib/Foo Fighters - Everlong'))
    expect(favouritePaths(db)).toEqual(['/lib/Foo Fighters - Everlong'])
  })
  it('the catalog being rebuilt from nothing', () => {
    // Every chart row dropped and scanned again, which is what a user who deletes their catalog
    // and rescans gets. The favourites table is not scanned data and is not touched by it.
    db.exec('DELETE FROM charts')
    expect(listFavourites(db)).toHaveLength(1)
    upsertChart(db, record('/lib/Foo Fighters - Everlong', { folderHash: 'h3' }))
    expect(favouritePaths(db)).toEqual(['/lib/Foo Fighters - Everlong'])
  })
  it('a favourite made before the chart was ever downloaded', () => {
    // The wishlist case, and the reason the heart is drawn over Chorus results at all. Nothing
    // in the library matches this one yet.
    setFavourite(
      db,
      favouriteKey({ name: 'Painkiller', artist: 'Judas Priest', charter: 'CCC' }),
      true
    )
    expect(favouritePaths(db)).toEqual(['/lib/Foo Fighters - Everlong'])
    upsertChart(
      db,
      record('/lib/Painkiller', { name: 'Painkiller', artist: 'Judas Priest', charter: 'CCC' })
    )
    expect(favouritePaths(db).sort()).toEqual(['/lib/Foo Fighters - Everlong', '/lib/Painkiller'])
  })
})
