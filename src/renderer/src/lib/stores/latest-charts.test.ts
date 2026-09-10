import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../api/enchor'

const searchCharts = vi.fn()
vi.mock('../api/enchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/enchor')>()),
  searchCharts: (...args: unknown[]) => searchCharts(...args) as Promise<SearchResult>
}))

const result = (names: string[]): SearchResult => ({
  found: names.length,
  out_of: 9999,
  page: 1,
  data: names.map((name, i) => ({
    chartId: i,
    songId: i,
    md5: 'a'.repeat(32),
    albumArtMd5: null,
    hasVideoBackground: false,
    name,
    artist: 'A',
    album: '',
    genre: '',
    year: '2020',
    charter: 'C',
    song_length: 1000,
    diff_guitar: 4,
    diff_bass: null,
    diff_drums: null,
    diff_keys: null,
    diff_vocals: null
  }))
})

async function importStore(): Promise<typeof import('./latest-charts')> {
  return import('./latest-charts')
}

beforeEach(() => {
  searchCharts.mockReset()
  vi.resetModules()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('latestCharts', () => {
  it('loads the wildcard row sorted by modifiedTime and records the catalog total', async () => {
    searchCharts.mockResolvedValue(result(['Everlong']))
    const store = await importStore()
    await store.loadLatestCharts()
    expect(searchCharts).toHaveBeenCalledWith({
      search: '*',
      page: 1,
      sort: { type: 'modifiedTime', direction: 'desc' }
    })
    expect(get(store.latestCharts)).toEqual({
      charts: expect.arrayContaining([expect.objectContaining({ name: 'Everlong' })]),
      total: 9999,
      loading: false,
      error: null
    })
  })

  it('serves a fresh row from cache so revisiting Home costs no request', async () => {
    searchCharts.mockResolvedValue(result(['Everlong']))
    const store = await importStore()
    await store.loadLatestCharts()
    await store.loadLatestCharts()
    await store.loadLatestCharts()
    expect(searchCharts).toHaveBeenCalledTimes(1)
  })

  it('reloads once the cached row goes stale', async () => {
    vi.useFakeTimers()
    searchCharts.mockResolvedValue(result(['Everlong']))
    const store = await importStore()
    await store.loadLatestCharts()
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    await store.loadLatestCharts()
    expect(searchCharts).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight request between concurrent callers', async () => {
    let resolve: (value: SearchResult) => void = () => {}
    searchCharts.mockReturnValue(
      new Promise<SearchResult>((r) => {
        resolve = r
      })
    )
    const store = await importStore()
    const a = store.loadLatestCharts()
    const b = store.loadLatestCharts()
    expect(searchCharts).toHaveBeenCalledTimes(1)
    resolve(result(['Everlong']))
    await Promise.all([a, b])
    expect(get(store.latestCharts).charts).toHaveLength(1)
  })

  it('surfaces a failure and retries on the next call', async () => {
    searchCharts.mockRejectedValueOnce(new Error('Search failed: 500'))
    const store = await importStore()
    await store.loadLatestCharts()
    expect(get(store.latestCharts)).toMatchObject({
      charts: [],
      loading: false,
      error: 'Search failed: 500'
    })
    searchCharts.mockResolvedValueOnce(result(['Everlong']))
    await store.loadLatestCharts()
    expect(get(store.latestCharts).error).toBeNull()
    expect(get(store.latestCharts).charts).toHaveLength(1)
  })
})
