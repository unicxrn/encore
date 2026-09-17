import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { browseSearch } from '../stores/search'
import { latestCharts } from '../stores/latest-charts'
import { globalQuery } from '../stores/global-search'
import { settings } from '../stores/settings'
import { defaultSettings } from '../../../../shared/settings-defaults'
import type { ChartData, SearchParams, SearchResult } from '../api/enchor'

/**
 * Explore with rows it was handed rather than ones it searched for, which today means Surprise me.
 *
 * A file of its own, and not because the subject is different: `browseSearch` is module-scoped and
 * outlives every render in a file, and a handed-over set is the one piece of its state that cannot
 * be put back without either spending a request or growing a store method nothing in the app would
 * call. Vitest gives each file its own module graph, so this file's copy of that store is its own,
 * and `Browse.svelte.test.ts` is left to search the way it always has.
 */

const searchCharts = vi.fn()
vi.mock('../api/enchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/enchor')>()),
  searchCharts: (...args: unknown[]) => searchCharts(...args) as Promise<SearchResult>
}))

import Browse from './Browse.svelte'

function chart(chartId: number): ChartData {
  return {
    chartId,
    songId: chartId,
    md5: String(chartId).padStart(32, 'a'),
    albumArtMd5: null,
    hasVideoBackground: false,
    name: `Song ${chartId}`,
    artist: 'Foo Fighters',
    album: '',
    genre: '',
    year: '1997',
    charter: `Charter ${chartId}`,
    song_length: 250_000,
    diff_guitar: 4,
    diff_bass: null,
    diff_drums: null,
    diff_keys: null,
    diff_vocals: null,
    notesData: { noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 900 }] }
  }
}

const FIVE = [1, 2, 3, 4, 5].map(chart)

/**
 * jsdom ships no IntersectionObserver and computes no layout, so there is nothing to observe and
 * nothing that could ever intersect. Nothing here needs one to fire either: a handed-over set is
 * exhausted by construction, so the sentinel it would watch is not on the page at all.
 */
class StubIntersectionObserver {
  observe(): void {
    // Nothing crosses anything in a document with no layout.
  }
  unobserve(): void {
    // Nothing was ever watched.
  }
  disconnect(): void {
    // As above.
  }
  takeRecords(): never[] {
    return []
  }
}

function renderBrowse(onSelectChart: (target: unknown) => void = () => {}): void {
  settings.set({ ...defaultSettings(), libraryFolders: [{ path: '/music', isDefault: true }] })
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
  vi.stubGlobal('encore', {
    existsByMeta: (keys: unknown[]): Promise<boolean[]> => Promise.resolve(keys.map(() => false)),
    platform: 'linux'
  })
  render(Browse, { onSelectChart })
}

beforeEach(() => {
  searchCharts.mockReset()
  browseSearch.setMode('list')
  // The catalog size Surprise me borrows from Home's row, so a Shuffle here spends one request
  // rather than two.
  latestCharts.set({ charts: [], total: 95_299, loading: false, error: null })
})

afterEach(async () => {
  globalQuery.set('')
  settings.set(defaultSettings())
  // Browse is still mounted while this runs, and its in-library effect reaches for the bridge
  // whenever the rows change; pulling the bridge first is an unhandled TypeError blamed on
  // whichever test ran last.
  await new Promise((r) => setTimeout(r, 0))
  vi.unstubAllGlobals()
  latestCharts.set({ charts: [], total: null, loading: true, error: null })
})

describe('Explore showing a set it was handed', () => {
  it('draws the note over the list, so five rows under an empty search box are explained', async () => {
    browseSearch.present('Five charts you do not have, drawn at random.', FIVE)
    renderBrowse()
    expect(screen.getByText('Five charts you do not have, drawn at random.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Shuffle' })).toBeTruthy()
    // The rows are Explore's own rows, not a second list drawn beside it.
    expect(
      screen.getByRole('button', { name: 'Song 1 by Foo Fighters, charted by Charter 1' })
    ).toBeTruthy()
    // Nothing to append: there is no page 2 of a handed-over set.
    expect(screen.queryByRole('button', { name: /Load more|Keep loading/ })).toBeNull()
  })

  it('hands a row to the rail exactly as a searched row does', async () => {
    const onSelectChart = vi.fn()
    browseSearch.present('Five charts you do not have, drawn at random.', FIVE)
    renderBrowse(onSelectChart)
    await fireEvent.click(
      screen.getByRole('button', { name: 'Song 3 by Foo Fighters, charted by Charter 3' })
    )
    expect(onSelectChart).toHaveBeenCalledWith({
      kind: 'remote',
      chart: expect.objectContaining({ chartId: 3 })
    })
  })

  it('lets the note speak for an empty answer instead of the search empty state', async () => {
    // Every chart the roll drew was one the user already has. The note says exactly that, and the
    // branch below the list would answer the same emptiness with a sentence about a search.
    browseSearch.present('Encore drew 40 playable charts and you already have every one.', [])
    renderBrowse()
    expect(screen.getByText(/you already have every one/)).toBeTruthy()
    expect(screen.queryByText(/returned no charts at all/)).toBeNull()
    expect(screen.queryByText(/Nothing on Chorus Encore matches/)).toBeNull()
  })

  it('draws no note at all when the rows are a search of its own', async () => {
    searchCharts.mockResolvedValue({ found: 1, out_of: 1, page: 1, data: [chart(9)] })
    renderBrowse()
    globalQuery.set('everlong')
    await waitFor(() => expect(get(browseSearch.results)).toHaveLength(1), { timeout: 2000 })
    expect(screen.queryByRole('button', { name: 'Shuffle' })).toBeNull()
  })

  it('shuffles another page out of Chorus Encore when the button is pressed', async () => {
    browseSearch.present('Five charts you do not have, drawn at random.', FIVE)
    renderBrowse()
    searchCharts.mockResolvedValue({ found: 95_299, out_of: 95_299, page: 1, data: [] })
    await fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }))
    await waitFor(() => expect(searchCharts).toHaveBeenCalled(), { timeout: 2000 })
    const params = searchCharts.mock.calls[0][0] as SearchParams
    expect(params.search).toBe('*')
    expect(params.perPage).toBe(100)
  })
})
