import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChartData, SearchParams, SearchResult } from '../api/enchor'

/**
 * The seam the whole file hangs on.
 *
 * `latest-charts.ts` and this store both import `searchCharts` from the API module, so mocking
 * the module is what keeps every one of these off the network, including the catalog-size
 * request the store borrows from Home's row. It is the same seam `latest-charts.test.ts` and
 * `Browse.svelte.test.ts` already use, and it is partial because the store also reads real
 * constants from there.
 */
const searchCharts = vi.fn()
vi.mock('../api/enchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/enchor')>()),
  searchCharts: (...args: unknown[]) => searchCharts(...args) as Promise<SearchResult>
}))

import { createSearch, type SearchStore } from './search'
import { latestCharts } from './latest-charts'
import { LOOKING, createSurprise } from './surprise'
import { SURPRISE_COUNT } from '../surprise-pick'

const CATALOG = 95_299

function chart(chartId: number, over: Partial<ChartData> = {}): ChartData {
  return {
    chartId,
    songId: chartId,
    md5: String(chartId).padStart(32, 'a'),
    albumArtMd5: null,
    hasVideoBackground: false,
    name: `Song ${chartId}`,
    artist: 'A',
    album: '',
    genre: '',
    year: '2020',
    charter: `Charter ${chartId}`,
    song_length: 1000,
    diff_guitar: 4,
    diff_bass: null,
    diff_drums: null,
    diff_keys: null,
    diff_vocals: null,
    notesData: { noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 900 }] },
    ...over
  }
}

/** A page of `count` playable charts, numbered so a page's identity is readable off the rows. */
function page(count: number, from = 0): SearchResult {
  return {
    found: CATALOG,
    out_of: CATALOG,
    page: 1,
    data: Array.from({ length: count }, (_, i) => chart(from + i + 1))
  }
}

/** A generator that walks a fixed list and wraps, so every draw a test makes is written down. */
function fixed(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

/** What `searchCharts` was asked for, page by page, with the catalog-size request left out. */
function pagesAsked(): number[] {
  return searchCharts.mock.calls
    .map((call) => call[0] as SearchParams)
    .filter((params) => params.perPage !== undefined)
    .map((params) => params.page ?? 1)
}

let existsByMeta: ReturnType<typeof vi.fn>

beforeEach(() => {
  searchCharts.mockReset()
  existsByMeta = vi
    .fn()
    .mockImplementation((keys: unknown[]) => Promise.resolve(keys.map(() => false)))
  // A store test, so it runs in the node project, where there is no window for the preload bridge
  // to hang off. `encore()` reads `window.encore`, so the window is what has to be stubbed.
  vi.stubGlobal('window', { encore: { existsByMeta, platform: 'linux' } })
  // The catalog size the store borrows from Home's row. Pinned here so most tests spend no
  // request on it; the one test that is about an unknown total clears it.
  latestCharts.set({ charts: [], total: CATALOG, loading: false, error: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  latestCharts.set({ charts: [], total: null, loading: true, error: null })
})

function roll(
  random: () => number,
  list: SearchStore = createSearch({ fetchFn: vi.fn() })
): { store: ReturnType<typeof createSurprise>; list: SearchStore } {
  return { store: createSurprise({ list, random, retryDelayMs: 0 }), list }
}

describe('Surprise me: the happy path', () => {
  it('draws five unowned charts in one request and says where they came from', async () => {
    searchCharts.mockResolvedValue(page(100))
    const { store, list } = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]))
    await store.roll()

    expect(get(list.results)).toHaveLength(SURPRISE_COUNT)
    expect(get(list.found)).toBe(SURPRISE_COUNT)
    expect(get(list.presented)).toContain('Five charts you do not have')
    // The number in the sentence is the catalog Home already counted, not a second count.
    expect(get(list.presented)).toContain('95,299')
    // One page request, and one ownership call over the whole page rather than one per chart.
    expect(pagesAsked()).toHaveLength(1)
    expect(existsByMeta).toHaveBeenCalledTimes(1)
    expect((existsByMeta.mock.calls[0][0] as unknown[]).length).toBe(100)
  })

  it('asks for a page of a hundred out of the whole catalog', async () => {
    searchCharts.mockResolvedValue(page(100))
    const { store } = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]))
    await store.roll()
    const params = searchCharts.mock.calls.at(-1)?.[0] as SearchParams
    expect(params.search).toBe('*')
    expect(params.perPage).toBe(100)
    expect(params.page).toBe(477)
  })

  it('leaves the list unable to append, so nothing fetches page 2 under the five', async () => {
    searchCharts.mockResolvedValue(page(100))
    const { store, list } = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]))
    await store.roll()
    expect(get(list.hasMore)).toBe(false)
    await list.loadMore()
    expect(pagesAsked()).toHaveLength(1)
  })
})

describe('Surprise me: the same five twice', () => {
  it('is the same five for the same draws, which is what makes the app-side randomness testable', async () => {
    searchCharts.mockResolvedValue(page(100))
    const seed = [0.5, 0.1, 0.2, 0.3, 0.4, 0.6]
    const first = roll(fixed(seed))
    await first.store.roll()
    const second = roll(fixed(seed))
    await second.store.roll()
    expect(get(first.list.results).map((c) => c.chartId)).toEqual(
      get(second.list.results).map((c) => c.chartId)
    )
  })

  it('is a different five for different draws', async () => {
    searchCharts.mockResolvedValue(page(100))
    const a = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]))
    await a.store.roll()
    const b = roll(fixed([0.5, 0.9, 0.8, 0.7, 0.6, 0.5]))
    await b.store.roll()
    expect(get(a.list.results).map((c) => c.chartId)).not.toEqual(
      get(b.list.results).map((c) => c.chartId)
    )
  })

  it('never draws the same page two presses running', async () => {
    searchCharts.mockResolvedValue(page(100))
    // A generator that answers the same number every time is the worst case: without the guard
    // in `randomPage` both presses would offer five charts out of one hundred.
    const { store } = roll(() => 0.5)
    await store.roll()
    await store.roll()
    expect(pagesAsked()).toEqual([477, 478])
  })
})

describe('Surprise me: the unhappy cases', () => {
  it('says the service could not be reached, and keeps the rows that were on screen', async () => {
    const list = createSearch({ fetchFn: vi.fn() })
    searchCharts.mockResolvedValueOnce(page(2))
    list.present('an earlier answer', [chart(900), chart(901)])
    searchCharts.mockRejectedValue(new Error('Search failed: 503'))
    const { store } = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]), list)
    await store.roll()
    expect(get(list.presented)).toContain('Search failed: 503')
    expect(get(list.presented)).toContain('Shuffle to try again')
    // A surprise that could not be drawn is no reason to take away what the user was looking at.
    expect(get(list.results).map((c) => c.chartId)).toEqual([900, 901])
  })

  it('offers what it found when a page cannot fill five, and says it ran out', async () => {
    // Three usable charts spread over pages that keep answering, so the loop stops on its own
    // count rather than on a failure.
    searchCharts.mockResolvedValue({ ...page(1, 10), data: [chart(11)] })
    const { store, list } = roll(fixed([0.1, 0.4, 0.7, 0.2, 0.3]))
    await store.roll()
    expect(get(list.results).map((c) => c.chartId)).toEqual([11])
    expect(get(list.presented)).toContain('1 chart you do not have')
    expect(get(list.presented)).toContain('ran out of candidates before five')
  })

  it('stops at three pages rather than working its way through the catalog', async () => {
    searchCharts.mockResolvedValue({ ...page(0), data: [] })
    const { store, list } = roll(fixed([0.1, 0.4, 0.7, 0.9, 0.2]))
    await store.roll()
    expect(pagesAsked()).toHaveLength(3)
    expect(get(list.presented)).toContain('no playable charts to offer')
  })

  it('says so when the user already has everything it drew, rather than showing nothing', async () => {
    searchCharts.mockResolvedValue(page(4))
    existsByMeta.mockImplementation((keys: unknown[]) => Promise.resolve(keys.map(() => true)))
    const { store, list } = roll(fixed([0.1, 0.4, 0.7, 0.2, 0.3]))
    await store.roll()
    expect(get(list.results)).toEqual([])
    expect(get(list.presented)).toContain('you already have every one')
    // The rows are gone, so the generic "nothing matched" below the list must not also speak.
    expect(get(list.presented)).not.toBeNull()
  })

  it('draws five for an empty or unscanned library, because nothing is owned there', async () => {
    // A catalog with no rows answers every key false, which is the truth for an empty library.
    searchCharts.mockResolvedValue(page(100))
    const { store, list } = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]))
    await store.roll()
    expect(get(list.results)).toHaveLength(SURPRISE_COUNT)
    expect(get(list.presented)).toContain('Five charts you do not have')
  })

  it('still offers five when the library could not be read, and admits the check did not happen', async () => {
    searchCharts.mockResolvedValue(page(100))
    existsByMeta.mockRejectedValue(new Error('catalog is closed'))
    const { store, list } = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]))
    await store.roll()
    expect(get(list.results)).toHaveLength(SURPRISE_COUNT)
    // The promise this feature makes is "you do not have these", and it is not made here.
    expect(get(list.presented)).not.toContain('you do not have')
    expect(get(list.presented)).toContain('could not read your library')
  })

  it('leaves out the charts nobody could play, and says how many it actually weighed', async () => {
    const unplayable = [
      chart(1, { md5: '' }),
      chart(2, { notesData: null }),
      chart(3, { folderIssues: [{ folderIssue: 'noAudio', description: 'No audio' }] })
    ]
    searchCharts.mockResolvedValue({ ...page(0), data: unplayable })
    existsByMeta.mockImplementation((keys: unknown[]) => Promise.resolve(keys.map(() => true)))
    const { store, list } = roll(fixed([0.1, 0.4, 0.7, 0.2, 0.3]))
    await store.roll()
    expect(get(list.results)).toEqual([])
    // None of the three was ever weighed for ownership, so the count of playable charts is zero
    // and the sentence is about the service rather than about the library.
    expect(existsByMeta).not.toHaveBeenCalled()
    expect(get(list.presented)).toContain('no playable charts to offer')
  })

  it('refuses to ask for the same page twice when there is only one page to ask for', async () => {
    // No catalog size, so there is one page to draw from, and it did not fill five. Without the
    // guard the loop spends its whole allowance re-fetching a hundred charts it has already
    // rejected, which is two requests bought with nothing.
    latestCharts.set({ charts: [], total: null, loading: false, error: null })
    searchCharts.mockRejectedValueOnce(new Error('Search failed: 500'))
    searchCharts.mockResolvedValue({ ...page(0), data: [chart(11)] })
    const { store, list } = roll(fixed([0.1, 0.4, 0.7, 0.2, 0.3]))
    await store.roll()
    expect(pagesAsked()).toEqual([1])
    expect(get(list.results).map((c) => c.chartId)).toEqual([11])
  })

  it('draws page 1 when the catalog size cannot be had, rather than refusing', async () => {
    latestCharts.set({ charts: [], total: null, loading: false, error: null })
    searchCharts.mockRejectedValueOnce(new Error('Search failed: 500'))
    searchCharts.mockResolvedValue(page(100))
    const { store, list } = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]))
    await store.roll()
    expect(pagesAsked()).toEqual([1])
    expect(get(list.results)).toHaveLength(SURPRISE_COUNT)
    // No total, so the sentence names the service rather than a number nobody measured.
    expect(get(list.presented)).toContain('drawn at random from Chorus Encore')
  })
})

describe('Surprise me: one roll at a time', () => {
  it('ignores a second press while one is running', async () => {
    let release: (value: SearchResult) => void = () => {}
    searchCharts.mockReturnValue(
      new Promise<SearchResult>((resolve) => {
        release = resolve
      })
    )
    const { store, list } = roll(fixed([0.5, 0.1, 0.2, 0.3, 0.4, 0.6]))
    const a = store.roll()
    const b = store.roll()
    // The catalog size is already held, but reading it is still an await, so the page request is
    // one turn out from the press.
    await new Promise((r) => setTimeout(r, 0))
    expect(pagesAsked()).toHaveLength(1)
    // While it is out, the list says what is being looked for rather than nothing.
    expect(get(list.presented)).toBe(LOOKING)
    release(page(100))
    await Promise.all([a, b])
    expect(get(list.results)).toHaveLength(SURPRISE_COUNT)
  })
})
