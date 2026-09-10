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
