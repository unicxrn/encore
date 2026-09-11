import { describe, expect, it } from 'vitest'
import {
  SettingsSchema,
  defaultSettings,
  ChartRecordSchema,
  JobProgressSchema,
  CatalogFilterSchema,
  DownloadRequestSchema
} from './schemas'

describe('SettingsSchema', () => {
  it('produces complete defaults from an empty object', () => {
    const s = defaultSettings()
    expect(s.libraryFolders).toEqual([])
    expect(s.downloadFormat).toBe('sng')
    expect(s.downloadConcurrency).toBe(3)
    expect(s.chartFolderName).toBe('{artist} - {name} ({charter})')
    expect(s.previewVolume).toBe(50)
    // False, not absent: the welcome tour reads this to decide whether to open on its own, and a
    // key that is simply missing would have to be special-cased everywhere it is read.
    expect(s.tourSeen).toBe(false)
  })
  it('rejects out-of-range concurrency', () => {
    expect(() => SettingsSchema.parse({ downloadConcurrency: 99 })).toThrow()
    expect(() => SettingsSchema.parse({ downloadConcurrency: 0 })).toThrow()
    expect(() => SettingsSchema.parse({ downloadConcurrency: 3.5 })).toThrow()
  })
  it('returns fresh default instances on each call', () => {
    expect(defaultSettings().libraryFolders).not.toBe(defaultSettings().libraryFolders)
  })
  it('keeps the zod-free literal and the schema defaults in lockstep', () => {
    // defaultSettings() is a plain literal so the renderer can seed its store
    // without importing zod. This is the guard against the two drifting apart.
    expect(SettingsSchema.parse({})).toEqual(defaultSettings())
  })
})

describe('ChartRecordSchema', () => {
  it('accepts a minimal record', () => {
    const r = ChartRecordSchema.parse({
      path: '/lib/a',
      chartType: 'folder',
      folderHash: 'abc',
      modifiedTime: 1
    })
    expect(r.name).toBeNull()
    expect(r.hasVideo).toBe(false)
  })
})

describe('JobProgressSchema', () => {
  it('round-trips a progress event', () => {
    const p = JobProgressSchema.parse({
      jobId: 'dl:abc',
      kind: 'download',
      phase: 'fetch',
      percent: 42,
      message: null,
      status: 'running'
    })
    expect(p.percent).toBe(42)
  })
})

describe('CatalogFilterSchema', () => {
  it('produces complete defaults from an empty object', () => {
    expect(CatalogFilterSchema.parse({})).toEqual({ search: '', offset: 0, limit: 100 })
  })
  it('rejects a limit above the maximum', () => {
    expect(() => CatalogFilterSchema.parse({ limit: 501 })).toThrow()
  })
  // Additive: every metadata filter and the sort are optional, so an existing caller that knows
  // nothing about them is unchanged by their arrival.
  it('leaves the metadata filters and the sort out when they are not asked for', () => {
    const parsed = CatalogFilterSchema.parse({ search: 'rush' })
    expect(parsed).toEqual({ search: 'rush', offset: 0, limit: 100 })
  })
  it('carries the metadata filters, the ranges and the sort through', () => {
    expect(
      CatalogFilterSchema.parse({
        artist: 'Rush',
        album: 'Moving',
        genre: 'Rock',
        charter: 'Skyline',
        yearMin: 1980,
        yearMax: 1989,
        lengthMinMs: 120_000,
        lengthMaxMs: 360_000,
        sort: 'length',
        direction: 'desc'
      })
    ).toMatchObject({
      artist: 'Rush',
      album: 'Moving',
      genre: 'Rock',
      charter: 'Skyline',
      yearMin: 1980,
      yearMax: 1989,
      lengthMinMs: 120_000,
      lengthMaxMs: 360_000,
      sort: 'length',
      direction: 'desc'
    })
  })
  // The sort names a column in a closed map inside the query layer; anything else would have to
  // be spliced into an ORDER BY, so it has to be refused at the boundary.
  it('rejects a sort field or direction it does not name', () => {
    expect(() => CatalogFilterSchema.parse({ sort: 'path' })).toThrow()
    expect(() => CatalogFilterSchema.parse({ sort: 'name DESC; DROP TABLE charts' })).toThrow()
    expect(() => CatalogFilterSchema.parse({ direction: 'sideways' })).toThrow()
  })
  it('rejects a negative length bound', () => {
    expect(() => CatalogFilterSchema.parse({ lengthMinMs: -1 })).toThrow()
  })
})

describe('DownloadRequestSchema', () => {
  const md5 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
  it('requires meta to be present', () => {
    expect(() => DownloadRequestSchema.parse({ md5 })).toThrow()
  })
  it('defaults meta fields to null from an empty meta object', () => {
    const r = DownloadRequestSchema.parse({ md5, meta: {} })
    expect(r.meta).toEqual({ name: null, artist: null, charter: null })
    expect(r.hasVideoBackground).toBe(false)
  })
  it('rejects an invalid md5', () => {
    expect(() => DownloadRequestSchema.parse({ md5: 'abc', meta: {} })).toThrow()
  })
})
