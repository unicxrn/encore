import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { CatalogFilter, ChartRecord, ChartRecordSchema } from '../../shared/schemas'
import { openCatalog, CatalogDb } from './db'
import {
  upsertChart,
  queryCharts,
  countCharts,
  deleteChartByPath,
  getChartByPath,
  chartsExistByMeta,
  chartFacets
} from './queries'
import { tmpDir } from '../../../test/helpers/tmp'
import {
  EIGHT_TAG_CHARTER,
  EIGHT_TAG_CHARTER_TEXT,
  TAGGED_CHARTER,
  TAGGED_CHARTER_TEXT
} from '../../../test/helpers/marked-up-names'

const record = (path: string, name: string, artist: string): ChartRecord =>
  ChartRecordSchema.parse({
    path,
    chartType: 'folder',
    name,
    artist,
    folderHash: 'h1',
    modifiedTime: 1
  })

describe('catalog queries', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('q'), 'catalog.db'))
    upsertChart(db, record('/lib/a', 'Everlong', 'Foo Fighters'))
    upsertChart(db, record('/lib/b', 'Painkiller', 'Judas Priest'))
  })

  it('upserts by path without duplicating', () => {
    upsertChart(db, { ...record('/lib/a', 'Everlong (fixed)', 'Foo Fighters'), folderHash: 'h2' })
    expect(countCharts(db, { search: '', offset: 0, limit: 100 })).toBe(2)
    expect(getChartByPath(db, '/lib/a')?.name).toBe('Everlong (fixed)')
  })
  it('full-text searches across name and artist', () => {
    const hits = queryCharts(db, { search: 'judas', offset: 0, limit: 100 })
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('Painkiller')
  })
  it('returns all charts sorted by name when search is empty', () => {
    const all = queryCharts(db, { search: '', offset: 0, limit: 100 })
    expect(all.map((c) => c.name)).toEqual(['Everlong', 'Painkiller'])
  })
  it('deletes by path and updates the FTS index', () => {
    deleteChartByPath(db, '/lib/b')
    expect(queryCharts(db, { search: 'judas', offset: 0, limit: 100 })).toHaveLength(0)
  })
  it('does not crash on FTS special characters', () => {
    expect(() => queryCharts(db, { search: 'AC/DC "quoted*', offset: 0, limit: 10 })).not.toThrow()
  })
  it('does not crash on embedded NUL bytes', () => {
    expect(() => queryCharts(db, { search: 'judas\0priest', offset: 0, limit: 10 })).not.toThrow()
  })

  it('round-trips arrays and the new metadata through the row mapping', () => {
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path: '/songs/a.sng',
        chartType: 'sng',
        folderHash: 'h',
        modifiedTime: 1,
        albumArtMd5: 'a'.repeat(32),
        instruments: ['guitar', 'drums'],
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 900 }],
        maxNps: [{ instrument: 'guitar', difficulty: 'expert', nps: 12.5 }],
        previewStartTime: 45_000,
        proDrums: true
      })
    )
    const back = getChartByPath(db, '/songs/a.sng')
    expect(back?.instruments).toEqual(['guitar', 'drums'])
    expect(back?.noteCounts).toEqual([{ instrument: 'guitar', difficulty: 'expert', count: 900 }])
    expect(back?.maxNps[0].nps).toBe(12.5)
    expect(back?.previewStartTime).toBe(45_000)
    expect(back?.proDrums).toBe(true)
    expect(back?.modchart).toBe(false)
  })

  // One unreadable value must cost one field on one chart, not the whole library list.
  it('survives a corrupt JSON column without losing the row or the other columns', () => {
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path: '/lib/c',
        chartType: 'folder',
        name: 'Raining Blood',
        artist: 'Slayer',
        folderHash: 'h3',
        modifiedTime: 1,
        instruments: ['guitar'],
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 12 }]
      })
    )
    db.prepare(`UPDATE charts SET instruments = ? WHERE path = ?`).run('["gui', '/lib/c')

    const all = queryCharts(db, { search: '', offset: 0, limit: 100 })
    expect(all).toHaveLength(3)
    const row = all.find((c) => c.path === '/lib/c')
    expect(row?.instruments).toEqual([])
    expect(row?.noteCounts).toEqual([{ instrument: 'guitar', difficulty: 'expert', count: 12 }])
    expect(row?.name).toBe('Raining Blood')
    expect(getChartByPath(db, '/lib/c')?.instruments).toEqual([])
  })

  // Valid JSON of the wrong shape reaches IPC the same way malformed JSON does: it parses,
  // then fails the zod parse below it. Only the array-vs-not case is guarded here.
  it.each([
    ['null', 'null'],
    ['an object', '{"a":1}']
  ])('treats %s in a JSON column as an empty list', (_label, stored) => {
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path: '/lib/d',
        chartType: 'folder',
        name: 'Angel of Death',
        artist: 'Slayer',
        folderHash: 'h4',
        modifiedTime: 1,
        instruments: ['guitar'],
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 34 }]
      })
    )
    db.prepare(`UPDATE charts SET instruments = ? WHERE path = ?`).run(stored, '/lib/d')

    const all = queryCharts(db, { search: '', offset: 0, limit: 100 })
    expect(all).toHaveLength(3)
    const row = all.find((c) => c.path === '/lib/d')
    expect(row?.instruments).toEqual([])
    expect(row?.noteCounts).toEqual([{ instrument: 'guitar', difficulty: 'expert', count: 34 }])
    expect(row?.name).toBe('Angel of Death')
    expect(getChartByPath(db, '/lib/d')?.instruments).toEqual([])
  })
})

describe('missing-asset filter', () => {
  let db: CatalogDb

  const assetRecord = (
    path: string,
    name: string,
    artist: string,
    assets: Partial<
      Pick<ChartRecord, 'hasVideo' | 'hasBackground' | 'hasAlbumArt' | 'hasLyrics'>
    > = {}
  ): ChartRecord =>
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      name,
      artist,
      folderHash: 'h1',
      modifiedTime: 1,
      ...assets
    })

  beforeEach(() => {
    db = openCatalog(join(tmpDir('miss'), 'catalog.db'))
    // full: everything present; novid: missing video; bare: missing everything
    upsertChart(
      db,
      assetRecord('/lib/full', 'Everlong', 'Foo Fighters', {
        hasVideo: true,
        hasBackground: true,
        hasAlbumArt: true,
        hasLyrics: true
      })
    )
    upsertChart(
      db,
      assetRecord('/lib/novid', 'Painkiller', 'Judas Priest', {
        hasVideo: false,
        hasBackground: true,
        hasAlbumArt: true,
        hasLyrics: true
      })
    )
    upsertChart(db, assetRecord('/lib/bare', 'Aces High', 'Iron Maiden'))
  })

  it('filters by a single missing kind', () => {
    const hits = queryCharts(db, { search: '', offset: 0, limit: 100, missing: ['video'] })
    expect(hits.map((c) => c.path).sort()).toEqual(['/lib/bare', '/lib/novid'])
    expect(countCharts(db, { search: '', offset: 0, limit: 100, missing: ['video'] })).toBe(2)
  })

  it('filters by two missing kinds (AND semantics)', () => {
    const filter = { search: '', offset: 0, limit: 100, missing: ['video', 'lyrics'] as const }
    const hits = queryCharts(db, { ...filter, missing: [...filter.missing] })
    expect(hits.map((c) => c.path)).toEqual(['/lib/bare'])
    expect(countCharts(db, { ...filter, missing: [...filter.missing] })).toBe(1)
  })

  // Asset Studio's default view is "charts needing work", which is an OR across all four
  // kinds: a chart qualifies if ANY one of them is absent.
  it('filters by any missing kind when missingMode is "any"', () => {
    const filter = {
      search: '',
      offset: 0,
      limit: 100,
      missing: ['video', 'background', 'albumArt', 'lyrics'] as const,
      missingMode: 'any' as const
    }
    const hits = queryCharts(db, { ...filter, missing: [...filter.missing] })
    expect(hits.map((c) => c.path).sort()).toEqual(['/lib/bare', '/lib/novid'])
    expect(countCharts(db, { ...filter, missing: [...filter.missing] })).toBe(2)
  })

  it('defaults to AND semantics when missingMode is omitted', () => {
    const filter = { search: '', offset: 0, limit: 100, missing: ['video', 'lyrics'] as const }
    expect(queryCharts(db, { ...filter, missing: [...filter.missing] }).map((c) => c.path)).toEqual(
      ['/lib/bare']
    )
  })

  it('combines missing with full-text search', () => {
    const hits = queryCharts(db, {
      search: 'painkiller',
      offset: 0,
      limit: 100,
      missing: ['video']
    })
    expect(hits.map((c) => c.path)).toEqual(['/lib/novid'])
    expect(
      queryCharts(db, { search: 'everlong', offset: 0, limit: 100, missing: ['video'] })
    ).toHaveLength(0)
    expect(
      countCharts(db, { search: 'painkiller', offset: 0, limit: 100, missing: ['video'] })
    ).toBe(1)
    expect(countCharts(db, { search: 'everlong', offset: 0, limit: 100, missing: ['video'] })).toBe(
      0
    )
  })

  it('albumArt and background kinds map to their columns', () => {
    const hits = queryCharts(db, {
      search: '',
      offset: 0,
      limit: 100,
      missing: ['albumArt', 'background']
    })
    expect(hits.map((c) => c.path)).toEqual(['/lib/bare'])
  })

  it('an empty missing array applies no filter', () => {
    expect(queryCharts(db, { search: '', offset: 0, limit: 100, missing: [] })).toHaveLength(3)
    expect(countCharts(db, { search: '', offset: 0, limit: 100, missing: [] })).toBe(3)
  })
})

describe('chartsExistByMeta', () => {
  let db: CatalogDb

  const fullRecord = (path: string, name: string, artist: string, charter: string): ChartRecord =>
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      name,
      artist,
      charter,
      folderHash: 'h1',
      modifiedTime: 1
    })

  beforeEach(() => {
    db = openCatalog(join(tmpDir('meta'), 'catalog.db'))
    upsertChart(db, fullRecord('/lib/a', 'Everlong', 'Foo Fighters', 'GuitarHero'))
    upsertChart(db, fullRecord('/lib/b', 'Painkiller', 'Judas Priest', 'Metalhead'))
    // Row with a NULL name: must never match any key.
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path: '/lib/c',
        chartType: 'folder',
        name: null,
        artist: 'Some Artist',
        charter: 'Some Charter',
        folderHash: 'h2',
        modifiedTime: 1
      })
    )
  })

  it('returns true for an exact match', () => {
    expect(
      chartsExistByMeta(db, [{ name: 'Everlong', artist: 'Foo Fighters', charter: 'GuitarHero' }])
    ).toEqual([true])
  })
  it('matches case-insensitively', () => {
    expect(
      chartsExistByMeta(db, [{ name: 'EVERLONG', artist: 'foo fighters', charter: 'GUITARHERO' }])
    ).toEqual([true])
  })
  it('returns false when any field misses', () => {
    expect(
      chartsExistByMeta(db, [{ name: 'Everlong', artist: 'Foo Fighters', charter: 'WrongCharter' }])
    ).toEqual([false])
  })
  it('preserves input order across a mixed batch', () => {
    expect(
      chartsExistByMeta(db, [
        { name: 'Everlong', artist: 'Foo Fighters', charter: 'GuitarHero' },
        { name: 'Nobody', artist: 'Nobody', charter: 'Nobody' },
        { name: 'Painkiller', artist: 'Judas Priest', charter: 'Metalhead' }
      ])
    ).toEqual([true, false, true])
  })
  it('never matches a row with a null name', () => {
    expect(
      chartsExistByMeta(db, [{ name: 'Some Name', artist: 'Some Artist', charter: 'Some Charter' }])
    ).toEqual([false])
  })
  it('returns an empty array for empty input', () => {
    expect(chartsExistByMeta(db, [])).toEqual([])
  })
})

describe('neverPlayed filter', () => {
  let db: CatalogDb
  const PLAYED = 'e54e9a0521444e81bd1fed4f3f3a3201'
  const UNPLAYED = 'aac70b7c7bfc0092a8f7f05a59db5676'

  const withChecksum = (path: string, name: string, checksum: string | null): ChartRecord =>
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      name,
      artist: 'Tool',
      cloneHeroChecksum: checksum,
      folderHash: 'h1',
      modifiedTime: 1
    })

  beforeEach(() => {
    db = openCatalog(join(tmpDir('np'), 'catalog.db'))
    upsertChart(db, withChecksum('/lib/played', 'Lateralus', PLAYED))
    upsertChart(db, withChecksum('/lib/unplayed', 'Schism', UNPLAYED))
    // A chart with no readable chart file, so nothing can ever join a play to it.
    upsertChart(db, withChecksum('/lib/nochecksum', 'Parabola', null))
    db.prepare(`INSERT INTO plays (checksum, playedAt) VALUES (?, ?)`).run(
      PLAYED,
      '2026-09-10T22:23:37.1089500Z'
    )
  })

  const names = (filter: Partial<CatalogFilter>): string[] =>
    queryCharts(db, { search: '', offset: 0, limit: 100, ...filter })
      .map((c) => c.name!)
      .sort()

  it('is inert when not asked for', () => {
    expect(names({})).toEqual(['Lateralus', 'Parabola', 'Schism'])
    expect(countCharts(db, { search: '', offset: 0, limit: 100 })).toBe(3)
  })

  it('keeps only charts with no recorded play', () => {
    expect(names({ neverPlayed: true })).toEqual(['Parabola', 'Schism'])
    expect(countCharts(db, { search: '', offset: 0, limit: 100, neverPlayed: true })).toBe(2)
  })

  it('counts a chart with no checksum as never played', () => {
    // It cannot be joined to a play by any means, so it belongs in the "not got round to" pile.
    // Excluding it would hide it from both halves of a played/unplayed split.
    expect(names({ neverPlayed: true })).toContain('Parabola')
  })

  it('applies on the search path too, where the FTS table needs the charts join', () => {
    // The count has a cheaper FTS-only branch it must NOT take once this constraint is asked
    // for: that branch cannot see a chart column and would fail or over-count.
    expect(names({ search: 'Lateralus', neverPlayed: true })).toEqual([])
    expect(names({ search: 'Schism', neverPlayed: true })).toEqual(['Schism'])
    expect(countCharts(db, { search: 'Schism', offset: 0, limit: 100, neverPlayed: true })).toBe(1)
    expect(countCharts(db, { search: 'Lateralus', offset: 0, limit: 100, neverPlayed: true })).toBe(
      0
    )
  })

  it('combines with the missing-asset constraints', () => {
    expect(names({ neverPlayed: true, missing: ['video'] })).toEqual(['Parabola', 'Schism'])
  })

  it('stops matching once a play for that chart is recorded', () => {
    db.prepare(`INSERT INTO plays (checksum, playedAt) VALUES (?, ?)`).run(
      UNPLAYED,
      '2026-09-11T10:00:00.0000000Z'
    )
    expect(names({ neverPlayed: true })).toEqual(['Parabola'])
  })
})

/**
 * The metadata filters the Installed view offers, and the sort beside them.
 *
 * The seed is shaped after the owner's own library rather than after what is convenient: album
 * nearly unique per chart, artists and charters repeating a few times each, one chart with no
 * year and one with no length, and a pair sharing a title so the paging tiebreaker has something
 * to break.
 */
describe('metadata filters', () => {
  let db: CatalogDb

  const meta = (path: string, fields: Partial<ChartRecord>): ChartRecord =>
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      folderHash: path,
      modifiedTime: 1,
      ...fields
    })

  beforeEach(() => {
    db = openCatalog(join(tmpDir('meta-filter'), 'catalog.db'))
    upsertChart(
      db,
      meta('/lib/yyz', {
        name: 'YYZ',
        artist: 'Rush',
        album: 'Moving Pictures',
        genre: 'Rock',
        year: 1981,
        charter: 'Skyline',
        songLength: 265_000
      })
    )
    upsertChart(
      db,
      meta('/lib/limelight', {
        name: 'Limelight',
        artist: 'Rush',
        album: 'Moving Pictures',
        genre: 'Rock',
        year: 1981,
        charter: 'Skyline',
        songLength: 259_000
      })
    )
    upsertChart(
      db,
      meta('/lib/painkiller', {
        name: 'Painkiller',
        artist: 'Judas Priest',
        album: 'Painkiller (Live)',
        genre: 'Metal',
        year: 1990,
        charter: 'Metalhead',
        songLength: 366_000
      })
    )
    upsertChart(
      db,
      meta('/lib/aces', {
        name: 'Aces High',
        artist: 'Iron Maiden',
        album: 'Powerslave',
        genre: 'Metal',
        year: null,
        charter: 'Metalhead',
        songLength: null
      })
    )
  })

  const paths = (filter: Partial<CatalogFilter>): string[] =>
    queryCharts(db, { search: '', offset: 0, limit: 100, ...filter }).map((c) => c.path)

  const count = (filter: Partial<CatalogFilter>): number =>
    countCharts(db, { search: '', offset: 0, limit: 100, ...filter })

  it('matches an artist exactly, not as a prefix', () => {
    expect(paths({ artist: 'Rush' }).sort()).toEqual(['/lib/limelight', '/lib/yyz'])
    expect(count({ artist: 'Rush' })).toBe(2)
    // "Rush" must not also drag in a band whose name merely starts with it.
    upsertChart(db, meta('/lib/hour', { name: 'Overtime', artist: 'Rush Hour' }))
    expect(paths({ artist: 'Rush' }).sort()).toEqual(['/lib/limelight', '/lib/yyz'])
  })

  it('matches artist, genre and charter case-insensitively', () => {
    expect(paths({ artist: 'rUsH' })).toHaveLength(2)
    expect(paths({ genre: 'METAL' })).toHaveLength(2)
    expect(paths({ charter: 'metalhead' })).toHaveLength(2)
  })

  // The one text filter among them: album is close to unique per chart, so a picker is useless
  // and an exact match would mean typing the album's full name.
  it('matches an album as a substring', () => {
    expect(paths({ album: 'moving' }).sort()).toEqual(['/lib/limelight', '/lib/yyz'])
    expect(paths({ album: 'live' })).toEqual(['/lib/painkiller'])
    expect(count({ album: 'live' })).toBe(1)
  })

  it('treats LIKE wildcards in an album as literal characters', () => {
    // Unescaped, '%' would match every album and '_' would match any single character.
    expect(paths({ album: '%' })).toEqual([])
    expect(paths({ album: 'Powerslav_' })).toEqual([])
    upsertChart(db, meta('/lib/pct', { name: '100%', artist: 'Nobody', album: '100% Live' }))
    expect(paths({ album: '100%' })).toEqual(['/lib/pct'])
  })

  it('treats a blank filter value as no filter at all', () => {
    // A picker reset to "any artist" posts an empty string; it must not ask for charts whose
    // artist is literally "".
    expect(paths({ artist: '', genre: '   ', charter: '', album: '' })).toHaveLength(4)
  })

  it('filters by a year range, with either end alone allowed', () => {
    expect(paths({ yearMin: 1985 })).toEqual(['/lib/painkiller'])
    expect(paths({ yearMax: 1985 }).sort()).toEqual(['/lib/limelight', '/lib/yyz'])
    expect(paths({ yearMin: 1980, yearMax: 1990 }).sort()).toEqual([
      '/lib/limelight',
      '/lib/painkiller',
      '/lib/yyz'
    ])
    expect(count({ yearMin: 1980, yearMax: 1990 })).toBe(3)
  })

  it('filters by a length range in milliseconds', () => {
    expect(paths({ lengthMinMs: 300_000 })).toEqual(['/lib/painkiller'])
    expect(paths({ lengthMaxMs: 260_000 })).toEqual(['/lib/limelight'])
    expect(count({ lengthMinMs: 300_000 })).toBe(1)
  })

  // An unknown value cannot be shown to be inside the range asked for. Including it would put a
  // chart of unknown length into "under five minutes".
  it('drops charts with no year or no length once that range is bounded', () => {
    expect(paths({ yearMin: 1900 })).not.toContain('/lib/aces')
    expect(paths({ lengthMaxMs: 999_999_999 })).not.toContain('/lib/aces')
    expect(paths({})).toContain('/lib/aces')
  })

  it('combines the metadata filters with each other and with the search', () => {
    expect(paths({ artist: 'Rush', lengthMaxMs: 260_000 })).toEqual(['/lib/limelight'])
    expect(paths({ search: 'painkiller', genre: 'Metal' })).toEqual(['/lib/painkiller'])
    expect(paths({ search: 'painkiller', genre: 'Rock' })).toEqual([])
    // The count has a cheaper FTS-only branch it must not take once a chart column is read.
    expect(count({ search: 'painkiller', genre: 'Metal' })).toBe(1)
    expect(count({ search: 'painkiller', genre: 'Rock' })).toBe(0)
  })

  it('combines with the missing-asset and never-played constraints', () => {
    expect(paths({ artist: 'Rush', missing: ['video'] }).sort()).toEqual([
      '/lib/limelight',
      '/lib/yyz'
    ])
    expect(paths({ genre: 'Metal', neverPlayed: true }).sort()).toEqual([
      '/lib/aces',
      '/lib/painkiller'
    ])
  })
})

describe('sorting', () => {
  let db: CatalogDb

  const meta = (path: string, fields: Partial<ChartRecord>): ChartRecord =>
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      folderHash: path,
      modifiedTime: 1,
      ...fields
    })

  beforeEach(() => {
    db = openCatalog(join(tmpDir('sort'), 'catalog.db'))
    upsertChart(
      db,
      meta('/lib/b', {
        name: 'Beat It',
        artist: 'Michael Jackson',
        year: 1982,
        songLength: 258_000
      })
    )
    upsertChart(
      db,
      meta('/lib/a', { name: 'aces high', artist: 'Iron Maiden', year: 1984, songLength: 270_000 })
    )
    upsertChart(db, meta('/lib/c', { name: 'Coma', artist: 'Tool', year: null, songLength: null }))
    upsertChart(
      db,
      meta('/lib/d', { name: 'Dogma', artist: 'Tool', year: 1993, songLength: 120_000 })
    )
  })

  const names = (filter: Partial<CatalogFilter>): (string | null)[] =>
    queryCharts(db, { search: '', offset: 0, limit: 100, ...filter }).map((c) => c.name)

  it('sorts by title in both directions, ignoring case', () => {
    // Lower-cased "aces high" sorts first only under a case-insensitive collation; byte order
    // would put every capital ahead of it.
    expect(names({ sort: 'title', direction: 'asc' })).toEqual([
      'aces high',
      'Beat It',
      'Coma',
      'Dogma'
    ])
    expect(names({ sort: 'title', direction: 'desc' })).toEqual([
      'Dogma',
      'Coma',
      'Beat It',
      'aces high'
    ])
  })

  it('sorts by artist, by year and by length', () => {
    expect(names({ sort: 'artist', direction: 'asc' })).toEqual([
      'aces high',
      'Beat It',
      'Coma',
      'Dogma'
    ])
    expect(names({ sort: 'year', direction: 'asc' }).slice(0, 3)).toEqual([
      'Beat It',
      'aces high',
      'Dogma'
    ])
    expect(names({ sort: 'length', direction: 'desc' }).slice(0, 3)).toEqual([
      'aces high',
      'Beat It',
      'Dogma'
    ])
  })

  // SQLite sorts NULLs first ascending, so "oldest first" would otherwise open on the charts
  // whose year nobody knows.
  it('puts charts with no value last, whichever direction is asked for', () => {
    expect(names({ sort: 'year', direction: 'asc' }).at(-1)).toBe('Coma')
    expect(names({ sort: 'year', direction: 'desc' }).at(-1)).toBe('Coma')
    expect(names({ sort: 'length', direction: 'asc' }).at(-1)).toBe('Coma')
    expect(names({ sort: 'length', direction: 'desc' }).at(-1)).toBe('Coma')
  })

  it('defaults to ascending when no direction is given', () => {
    expect(names({ sort: 'title' })).toEqual(names({ sort: 'title', direction: 'asc' }))
  })

  it('leaves the existing order alone when no sort is named', () => {
    expect(names({})).toEqual(['aces high', 'Beat It', 'Coma', 'Dogma'])
  })

  /**
   * The reason this has to be SQL and not a renderer-side sort of the rows on screen.
   *
   * The view pages at 100 and appends. Sorting a page sorts a hundred arbitrary charts; the
   * assertion here is that page two continues page one rather than starting over, which is only
   * true if the database did the ordering.
   */
  it('orders across pages, not within one', () => {
    const page = (offset: number, limit: number): (string | null)[] =>
      queryCharts(db, { search: '', offset, limit, sort: 'year', direction: 'desc' }).map(
        (c) => c.name
      )
    const whole = page(0, 100)
    expect([...page(0, 2), ...page(2, 2)]).toEqual(whole)
    expect(whole[0]).toBe('Dogma')
  })

  /**
   * Ties must not shuffle between pages.
   *
   * Without a unique tiebreaker SQLite may return tied rows in any order, and need not pick the
   * same one twice, so a row can fall off the end of one page and reappear on the next. Every
   * chart here sorts equal on the requested column, which is the worst case and not a rare one:
   * a library sorted by artist is mostly ties.
   */
  it('pages tied rows without losing or repeating any', () => {
    for (let i = 0; i < 12; i++) {
      upsertChart(
        db,
        meta(`/lib/tie-${i}`, { name: `Tie ${i}`, artist: 'Same Artist', year: 2000 })
      )
    }
    const filter = { search: '', sort: 'artist' as const, direction: 'asc' as const }
    const whole = queryCharts(db, { ...filter, offset: 0, limit: 100 }).map((c) => c.path)
    const paged = [0, 5, 10, 15].flatMap((offset) =>
      queryCharts(db, { ...filter, offset, limit: 5 }).map((c) => c.path)
    )
    expect(paged).toEqual(whole)
    expect(new Set(paged).size).toBe(whole.length)
  })

  it('sorts the search results too, overriding relevance rank', () => {
    const sorted = queryCharts(db, {
      search: 'tool',
      offset: 0,
      limit: 100,
      sort: 'title',
      direction: 'desc'
    }).map((c) => c.name)
    expect(sorted).toEqual(['Dogma', 'Coma'])
  })

  it('pages a sorted search across pages as well', () => {
    const filter = { search: 'tool', sort: 'title' as const, direction: 'asc' as const }
    const whole = queryCharts(db, { ...filter, offset: 0, limit: 100 }).map((c) => c.name)
    const paged = [0, 1].flatMap((offset) =>
      queryCharts(db, { ...filter, offset, limit: 1 }).map((c) => c.name)
    )
    expect(paged).toEqual(whole)
  })
})

describe('chartFacets', () => {
  let db: CatalogDb

  const meta = (path: string, fields: Partial<ChartRecord>): ChartRecord =>
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      folderHash: path,
      modifiedTime: 1,
      ...fields
    })

  beforeEach(() => {
    db = openCatalog(join(tmpDir('facets'), 'catalog.db'))
    upsertChart(
      db,
      meta('/lib/1', { artist: 'Rush', genre: 'Rock', charter: 'Skyline', year: 1981 })
    )
    upsertChart(
      db,
      meta('/lib/2', { artist: 'rush', genre: 'rock', charter: 'Skyline', year: 1981 })
    )
    upsertChart(db, meta('/lib/3', { artist: 'Iron Maiden', genre: '', charter: '  ', year: null }))
    upsertChart(db, meta('/lib/4', { artist: null, genre: 'Metal', charter: null, year: 1990 }))
  })

  it('offers each value once, case-insensitively, and never a blank or a null', () => {
    const facets = chartFacets(db)
    expect(facets.artists).toEqual(['Iron Maiden', 'Rush'])
    expect(facets.genres).toEqual(['Metal', 'Rock'])
    expect(facets.charters).toEqual(['Skyline'])
  })

  it('lists years newest first', () => {
    expect(chartFacets(db).years).toEqual([1990, 1981])
  })

  // Every option a picker shows has to return at least one row, which is what reading them off
  // the catalog rather than off a fixed list buys.
  it('offers only values some chart actually has', () => {
    for (const artist of chartFacets(db).artists) {
      expect(countCharts(db, { search: '', offset: 0, limit: 100, artist })).toBeGreaterThan(0)
    }
  })

  it('answers an empty catalog with empty lists', () => {
    const empty = openCatalog(join(tmpDir('facets-empty'), 'catalog.db'))
    expect(chartFacets(empty)).toEqual({ artists: [], genres: [], charters: [], years: [] })
  })
})

/**
 * Names as Clone Hero renders them, which is not how song.ini writes them.
 *
 * A charter who colours every letter of their name is one token per letter to a unicode61
 * tokeniser, so the eight-tag name was findable by nothing a user could type, while `color` was a
 * term every styled chart in the library shared. Sorting had the same root: a title opening with
 * a tag files under `<`.
 */
describe('names written in Clone Hero markup', () => {
  let db: CatalogDb

  const meta = (path: string, fields: Partial<ChartRecord>): ChartRecord =>
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      folderHash: path,
      modifiedTime: 1,
      ...fields
    })

  const paths = (filter: Partial<CatalogFilter>): string[] =>
    queryCharts(db, { search: '', offset: 0, limit: 100, ...filter }).map((c) => c.path)

  beforeEach(() => {
    db = openCatalog(join(tmpDir('markup'), 'catalog.db'))
    upsertChart(
      db,
      meta('/lib/firestarter', {
        name: 'Firestarter',
        artist: 'The Prodigy',
        charter: EIGHT_TAG_CHARTER
      })
    )
    upsertChart(
      db,
      meta('/lib/monkfish', { name: 'Bohemian Rhapsody', artist: 'Queen', charter: TAGGED_CHARTER })
    )
    // Sorts between "Bohemian Rhapsody" and "Firestarter" by what it reads as, and ahead of both
    // by what it stores.
    upsertChart(
      db,
      meta('/lib/marked', {
        name: `<b><color=#FF0000>D</color>eath</b> of a Bachelor`,
        artist: 'Panic! at the Disco',
        charter: 'Skyline'
      })
    )
  })

  it('finds a charter by the name on screen', () => {
    expect(paths({ search: EIGHT_TAG_CHARTER_TEXT })).toEqual(['/lib/firestarter'])
    expect(paths({ search: TAGGED_CHARTER_TEXT })).toEqual(['/lib/monkfish'])
  })

  it('finds a marked-up title by the words a reader sees', () => {
    expect(paths({ search: 'Death of a Bachelor' })).toEqual(['/lib/marked'])
  })

  // The index carries the readable form only. Both halves of that decision are here: the tag
  // names stop being search terms, and a term that only ever appeared inside a tag matches
  // nothing rather than matching every styled chart in the library.
  it('no longer matches every marked-up chart on a tag name', () => {
    expect(paths({ search: 'color' })).toEqual([])
    expect(paths({ search: '8200f3' })).toEqual([])
  })

  // The search box is stripped with the same rules as the index, so the one thing a user is
  // likeliest to paste, the line straight out of song.ini, still lands on its chart.
  it('finds a chart from its raw song.ini text pasted into the search box', () => {
    expect(paths({ search: TAGGED_CHARTER })).toEqual(['/lib/monkfish'])
  })

  it('sorts a marked-up title where its visible name belongs', () => {
    expect(paths({ sort: 'title', direction: 'asc' })).toEqual([
      '/lib/monkfish',
      '/lib/marked',
      '/lib/firestarter'
    ])
  })

  // The Installed list opens on this order, before the user has touched a sort control.
  it('sorts the unsorted list the same way', () => {
    expect(paths({})).toEqual(['/lib/monkfish', '/lib/marked', '/lib/firestarter'])
  })

  it('sorts by charter on the readable name', () => {
    expect(paths({ sort: 'charter', direction: 'asc' })).toEqual([
      '/lib/monkfish',
      '/lib/marked',
      '/lib/firestarter'
    ])
  })

  // The catalog keeps what the chart says. Stripping on the way in would edit the user's data to
  // make a query convenient, and the markup cannot be recovered once it is gone.
  it('stores the raw text unchanged', () => {
    expect(getChartByPath(db, '/lib/firestarter')?.charter).toBe(EIGHT_TAG_CHARTER)
    expect(getChartByPath(db, '/lib/monkfish')?.charter).toBe(TAGGED_CHARTER)
  })

  it('filters by the charter name the picker offers', () => {
    expect(paths({ charter: EIGHT_TAG_CHARTER_TEXT })).toEqual(['/lib/firestarter'])
  })

  /**
   * One charter, two spellings, one option.
   *
   * The pickers read the catalog, so a charter who styled their name in one chart and not in
   * another was two entries that each returned half their work, and neither said which was which.
   */
  it('collapses one charter styled two ways into a single picker option', () => {
    upsertChart(
      db,
      meta('/lib/plain-monkfish', {
        name: 'Killer Queen',
        artist: 'Queen',
        charter: TAGGED_CHARTER_TEXT
      })
    )
    const { charters } = chartFacets(db)
    expect(charters.filter((c) => c.toLowerCase() === TAGGED_CHARTER_TEXT.toLowerCase())).toEqual([
      TAGGED_CHARTER_TEXT
    ])
    expect(paths({ charter: TAGGED_CHARTER_TEXT }).sort()).toEqual([
      '/lib/monkfish',
      '/lib/plain-monkfish'
    ])
  })

  it('offers artists by their readable name', () => {
    upsertChart(db, meta('/lib/styled-artist', { name: 'Basket Case', artist: `<i>Green Day</i>` }))
    expect(chartFacets(db).artists).toContain('Green Day')
    expect(paths({ artist: 'Green Day' })).toEqual(['/lib/styled-artist'])
  })
})
