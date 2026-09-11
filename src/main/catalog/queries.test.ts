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
  chartsExistByMeta
} from './queries'
import { tmpDir } from '../../../test/helpers/tmp'

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
