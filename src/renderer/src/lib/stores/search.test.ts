import { get } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import type { ChartData, SearchResult } from '../api/enchor'
import { emptyAdvanced, type AdvancedQuery } from '../api/advanced'
import { AUTO_APPEND_CAP, createSearch, groupBySong } from './search'
import { globalQuery } from './global-search'

const makeChart = (
  chartId: number,
  songId: number | null,
  name = 'Song',
  charter = 'C'
): ChartData => ({
  chartId,
  songId,
  md5: 'a'.repeat(32),
  albumArtMd5: null,
  hasVideoBackground: false,
  name,
  artist: 'A',
  album: '',
  genre: '',
  year: '2020',
  charter,
  song_length: 1000,
  diff_guitar: 4,
  diff_bass: null,
  diff_drums: null,
  diff_keys: null,
  diff_vocals: null
})

const result = (names: string[], found = names.length): SearchResult => ({
  found,
  out_of: 100,
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

const ok = (body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

describe('createSearch', () => {
  it('debounces input and stores results', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['Everlong'])))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('ev')
    search.setQuery('everlong')
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(get(search.results).map((c) => c.name)).toEqual(['Everlong'])
    expect(get(search.found)).toBe(1)
    expect(get(search.loading)).toBe(false)
  })
  it('fetches the wildcard listing on empty query', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['Everlong'])))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('   ')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body)) as {
      search: string
    }
    expect(body.search).toBe('*')
    expect(get(search.results).map((c) => c.name)).toEqual(['Everlong'])
  })
  it('re-applying the query the store already answered does not spend another request', async () => {
    // Browse mirrors the global query into the store from an $effect, so the
    // store gets setQuery() again on every mount, and Explore is unmounted by
    // every sidebar navigation and by opening a chart detail. Refetching there
    // resets the loaded pages to page 1 and burns one of the API's 50
    // requests/minute per click.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['Everlong'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('')
    await new Promise((r) => setTimeout(r, 20))
    await search.loadMore()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(get(search.results)).toHaveLength(2)

    // Remount: same query, results already in hand.
    search.setQuery('')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(get(search.results)).toHaveLength(2)

    // A different query still searches, and so does an explicit retry.
    search.setQuery('everlong')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(3)
    search.retry()
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(4)
  })
  it('leaves a failed query alone until retry() asks for it again', async () => {
    // Re-applying on mount is how a rate-limited client stays rate-limited:
    // every navigation back into Explore would spend another request. The
    // error card's Retry button is the deliberate way back.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad', { status: 400 }))
      .mockImplementationOnce(() => ok(result(['Everlong'])))
    const search = createSearch({ fetchFn, debounceMs: 5, retryDelayMs: 1 })
    search.setQuery('')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.error)).toContain('400')
    search.setQuery('')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(get(search.error)).toContain('400')
    search.retry()
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.error)).toBeNull()
    expect(get(search.results).map((c) => c.name)).toEqual(['Everlong'])
  })
  it('leaves a query that legitimately found nothing alone on remount', async () => {
    // An empty result set is an answer, not a missing one. Inferring "answered"
    // from results.length would refetch it on every navigation back into Explore.
    const fetchFn = vi.fn().mockImplementation(() => ok(result([], 0)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('asdkjhasd')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(get(search.results)).toHaveLength(0)
    expect(get(search.error)).toBeNull()

    search.setQuery('asdkjhasd')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Retry is still the deliberate way to ask again.
    search.retry()
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
  it('keeps the pages already loaded when a remount follows a failed loadMore', async () => {
    // A failed append leaves error set while results still hold page 1. Re-running
    // from page 1 on the next mount would discard those rows for no reason.
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => ok(result(['One', 'Two'], 50)))
      .mockImplementation(() => Promise.resolve(new Response('bad', { status: 400 })))
    const search = createSearch({ fetchFn, debounceMs: 5, retryDelayMs: 1 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    await search.loadMore()
    expect(get(search.error)).toContain('400')
    expect(get(search.results)).toHaveLength(2)

    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(get(search.results)).toHaveLength(2)
  })
  it('setFilters re-fetches immediately with filters and resets to page 1', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    await search.loadMore()
    search.setFilters('guitar', 'expert')
    await new Promise((r) => setTimeout(r, 20))
    const lastCall = fetchFn.mock.calls.at(-1) as [string, RequestInit]
    const lastBody = JSON.parse(String(lastCall[1].body)) as {
      instrument: string | null
      difficulty: string | null
      page: number
    }
    expect(lastBody).toMatchObject({ instrument: 'guitar', difficulty: 'expert', page: 1 })
  })
  it('appends on loadMore with incremented page', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => ok(result(['One'], 50)))
      .mockImplementationOnce(() => ok(result(['Two'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    await search.loadMore()
    expect(get(search.results).map((c) => c.name)).toEqual(['One', 'Two'])
    const secondBody = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body))
    expect(secondBody.page).toBe(2)
  })
  it('rolls back the page counter when loadMore fails so the next loadMore retries the same page', async () => {
    // searchCharts retries up to 4 times on 500 errors; we return 500 for all
    // 4 retry attempts of the loadMore call, then succeed on the retry loadMore.
    // retryDelayMs: 1 makes retries fast (1, 2, 4 ms delays).
    const page1Response = ok(
      result(
        Array.from({ length: 50 }, (_, i) => `Song ${i}`),
        100
      )
    )
    const fail500 = (): Promise<Response> => Promise.resolve(new Response('error', { status: 500 }))
    // 4 fetch calls for page 1 (ok), then 4 × 500 for the failed loadMore page 2,
    // then 1 ok for the retry loadMore page 2 (succeeds on first attempt).
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => page1Response) // page 1 → ok
      .mockImplementationOnce(fail500) // page 2 attempt 1 → 500
      .mockImplementationOnce(fail500) // page 2 attempt 2 → 500
      .mockImplementationOnce(fail500) // page 2 attempt 3 → 500
      .mockImplementationOnce(fail500) // page 2 attempt 4 → 500 (throws)
      .mockImplementationOnce(() => ok(result(['RetryResult'], 100))) // retry loadMore page 2 → ok

    const search = createSearch({ fetchFn, debounceMs: 5, retryDelayMs: 1 })

    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    // Page 1 ok
    expect(get(search.results)).toHaveLength(50)

    // loadMore → page 2 → all 4 attempts fail → error set, page rolled back
    await search.loadMore()
    expect(get(search.error)).toMatch(/500/)

    // Verify page was rolled back: trigger another loadMore which should request page 2 again
    // (loading guard passes since loading=false after error)
    await search.loadMore()

    // The last fetch call should have page=2, not page=3
    const lastCall = fetchFn.mock.calls.at(-1) as [string, RequestInit]
    const lastBody = JSON.parse(String(lastCall[1].body)) as { page: number }
    expect(lastBody.page).toBe(2)
    expect(get(search.results).map((c) => c.name)).toContain('RetryResult')
  })
  it('sets error on failure and recovers on next query', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad', { status: 400 }))
      .mockImplementationOnce(() => ok(result(['Good'])))
    const search = createSearch({ fetchFn, debounceMs: 5, retryDelayMs: 1 })
    search.setQuery('bad')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.error)).toContain('400')
    search.setQuery('good')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.error)).toBeNull()
    expect(get(search.results).map((c) => c.name)).toEqual(['Good'])
  })
})

/**
 * Explore's empty state is gated on this. Nothing else in the store separates "we have not
 * asked yet" from "we asked and nothing came back", since both leave `results` empty and
 * `loading` false, so getting it wrong shows "nothing matched" over a request never sent.
 */
describe('searched', () => {
  it('stays false across the debounce window, before any request goes out', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result([])))
    const search = createSearch({ fetchFn, debounceMs: 50 })
    search.setQuery('everlong')
    // Inside the debounce: the state a component sees on its first paint.
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchFn).not.toHaveBeenCalled()
    expect(get(search.loading)).toBe(false)
    expect(get(search.results)).toEqual([])
    expect(get(search.searched)).toBe(false)
  })

  it('turns true once a run finds nothing', async () => {
    const search = createSearch({
      fetchFn: vi.fn().mockImplementation(() => ok(result([]))),
      debounceMs: 5
    })
    search.setQuery('nothing at all matches this')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.searched)).toBe(true)
  })

  it('turns true on a failed run too, because a failure is still a finished one', async () => {
    const search = createSearch({
      fetchFn: vi.fn().mockResolvedValue(new Response('bad', { status: 400 })),
      debounceMs: 5,
      retryDelayMs: 1
    })
    search.setQuery('bad')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.error)).toContain('400')
    expect(get(search.searched)).toBe(true)
  })

  it('is not set by a run that a newer query aborted before it answered', async () => {
    // The abort path returns before touching any store. Were it to set `searched`, the
    // superseded run would license an empty state for a question already replaced.
    const search = createSearch({
      fetchFn: vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            )
          })
      ),
      debounceMs: 5
    })
    search.setQuery('first')
    await new Promise((r) => setTimeout(r, 20))
    search.setQuery('second')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.searched)).toBe(false)
  })
})

describe('groupBySong', () => {
  it('groups charts with the same songId under primary + others in occurrence order', () => {
    const a = makeChart(1, 10, 'Song A', 'CharterA')
    const b = makeChart(2, 10, 'Song A', 'CharterB')
    const c = makeChart(3, 10, 'Song A', 'CharterC')
    const groups = groupBySong([a, b, c])
    expect(groups).toHaveLength(1)
    expect(groups[0].primary).toBe(a)
    expect(groups[0].others).toEqual([b, c])
  })

  it('keeps null-songId charts as their own group each', () => {
    const x = makeChart(99, null, 'Solo X')
    const y = makeChart(100, null, 'Solo Y')
    const groups = groupBySong([x, y])
    expect(groups).toHaveLength(2)
    expect(groups[0].primary).toBe(x)
    expect(groups[0].others).toHaveLength(0)
    expect(groups[1].primary).toBe(y)
    expect(groups[1].others).toHaveLength(0)
  })

  it('preserves group order by first occurrence and mixes null-songId with grouped charts', () => {
    const a = makeChart(1, 10)
    const b = makeChart(2, null)
    const c = makeChart(3, 10)
    const d = makeChart(4, 20)
    const groups = groupBySong([a, b, c, d])
    expect(groups).toHaveLength(3)
    expect(groups[0].primary.chartId).toBe(1)
    expect(groups[0].others.map((g) => g.chartId)).toEqual([3])
    expect(groups[1].primary.chartId).toBe(2)
    expect(groups[2].primary.chartId).toBe(4)
  })

  it('returns empty array for empty input', () => {
    expect(groupBySong([])).toEqual([])
  })
})

describe('expanded version groups', () => {
  it('toggleExpanded adds a songId and toggling again removes it', () => {
    const search = createSearch({ fetchFn: vi.fn(), debounceMs: 5 })
    expect([...get(search.expanded)]).toEqual([])
    search.toggleExpanded(42)
    expect([...get(search.expanded)]).toEqual([42])
    search.toggleExpanded(42)
    expect([...get(search.expanded)]).toEqual([])
  })

  it('survives the setQuery a remount re-applies', async () => {
    // The whole point of moving this off the component: Browse is destroyed by
    // every navigation and by opening a chart Detail, so a per-instance set
    // collapsed every expanded group on the way back.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleExpanded(42)

    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect([...get(search.expanded)]).toEqual([42])
  })

  it('clears when a new query replaces the results', async () => {
    // Keys are songIds. A different query returns unrelated rows, and any
    // songId that happens to recur would arrive pre-expanded.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleExpanded(42)

    search.setQuery('y')
    await new Promise((r) => setTimeout(r, 20))
    expect([...get(search.expanded)]).toEqual([])
  })

  it('clears when a filter change replaces the results', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleExpanded(42)

    search.setFilters('guitar', 'expert')
    await new Promise((r) => setTimeout(r, 20))
    expect([...get(search.expanded)]).toEqual([])
  })

  it('survives loadMore, which appends rather than replaces', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleExpanded(42)

    await search.loadMore()
    expect([...get(search.expanded)]).toEqual([42])
  })

  it('survives a query whose fetch failed, since the rows on screen are unchanged', async () => {
    // The error card leaves the previous rows visible. Clearing on the attempt
    // rather than on the replacement would collapse groups the user can still see.
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => ok(result(['One'], 50)))
      .mockImplementation(() => Promise.resolve(new Response('bad', { status: 400 })))
    const search = createSearch({ fetchFn, debounceMs: 5, retryDelayMs: 1 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleExpanded(42)

    search.setQuery('y')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.error)).toContain('400')
    expect([...get(search.expanded)]).toEqual([42])
  })
})

describe('view mode', () => {
  it('starts as a grid and setMode switches it', () => {
    const search = createSearch({ fetchFn: vi.fn(), debounceMs: 5 })
    expect(get(search.mode)).toBe('grid')
    search.setMode('list')
    expect(get(search.mode)).toBe('list')
    search.setMode('grid')
    expect(get(search.mode)).toBe('grid')
  })

  it('survives a new query, unlike expansion and scroll', async () => {
    // Expansion keys and the scroll offset describe the rows on screen, so a
    // replacement result set invalidates them. The mode describes how the user
    // wants results shown, which a different question does not change.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setMode('grid')
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))

    search.setQuery('y')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.mode)).toBe('grid')
  })
})

describe('selection', () => {
  // Two charts of one song plus an unrelated one, so a group has alternates to
  // hide and there is a chart outside it that hiding must not touch.
  const grouped = (): SearchResult => ({
    found: 3,
    out_of: 3,
    page: 1,
    data: [
      makeChart(1, 42, 'Everlong', 'CharterA'),
      makeChart(2, 42, 'Everlong', 'CharterB'),
      makeChart(3, 7, 'Other', 'CharterC')
    ]
  })

  it('toggleSelected adds a chartId and toggling again removes it', () => {
    const search = createSearch({ fetchFn: vi.fn(), debounceMs: 5 })
    expect([...get(search.selected)]).toEqual([])
    search.toggleSelected(1)
    expect([...get(search.selected)]).toEqual([1])
    search.toggleSelected(1)
    expect([...get(search.selected)]).toEqual([])
  })

  it('clearSelected empties it', () => {
    const search = createSearch({ fetchFn: vi.fn(), debounceMs: 5 })
    search.toggleSelected(1)
    search.toggleSelected(2)
    search.clearSelected()
    expect([...get(search.selected)]).toEqual([])
  })

  it('survives the setQuery a remount re-applies', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleSelected(1)

    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect([...get(search.selected)]).toEqual([1])
  })

  it('clears when a new query replaces the results', async () => {
    // Carrying a selection across an unrelated search is how someone downloads a
    // chart they did not mean to: the ids name rows that are no longer on screen.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleSelected(1)

    search.setQuery('y')
    await new Promise((r) => setTimeout(r, 20))
    expect([...get(search.selected)]).toEqual([])
  })

  it('clears when a filter change replaces the results', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleSelected(1)

    search.setFilters('guitar', 'expert')
    await new Promise((r) => setTimeout(r, 20))
    expect([...get(search.selected)]).toEqual([])
  })

  it('survives loadMore, which appends rather than replaces', async () => {
    // The rows already picked are all still there, so dropping the selection
    // would punish the user for asking for a second page.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.toggleSelected(1)

    await search.loadMore()
    expect([...get(search.selected)]).toEqual([1])
  })

  it("drops a group's alternates from the selection when the group is collapsed", async () => {
    // Collapsing hides the alternate cards/rows. Leaving them selected would
    // leave a checked box nobody can see, and a count nobody can account for:
    // the same "downloaded something I did not pick" failure as carrying a
    // selection across a search, arrived at from the other direction.
    const fetchFn = vi.fn().mockImplementation(() => ok(grouped()))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))

    search.toggleExpanded(42)
    search.toggleSelected(1)
    search.toggleSelected(2)
    search.toggleSelected(3)

    search.toggleExpanded(42)

    // The primary (1) is still on screen, and 3 belongs to another group.
    expect([...get(search.selected)].sort()).toEqual([1, 3])
  })

  it('leaves the selection alone when a group is expanded', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(grouped()))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))

    search.toggleSelected(1)
    search.toggleExpanded(42)
    expect([...get(search.selected)]).toEqual([1])
  })
})

describe('saved scroll offset', () => {
  // Only the bookkeeping is covered here. Whether the offset is actually read
  // off the list and written back to it is a layout question, and jsdom has no
  // layout; see the note in Browse.svelte.
  it('survives the setQuery a remount re-applies', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.saveScroll(420)

    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect(search.savedScroll()).toBe(420)
  })

  it('resets when a new query replaces the results', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.saveScroll(420)

    search.setQuery('y')
    await new Promise((r) => setTimeout(r, 20))
    expect(search.savedScroll()).toBe(0)
  })

  it('survives loadMore, which appends below the current position', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.saveScroll(420)

    await search.loadMore()
    expect(search.savedScroll()).toBe(420)
  })
})

describe('SearchStore groups', () => {
  it('groups store reflects results after a search', async () => {
    const a = makeChart(1, 42, 'Everlong', 'CharterA')
    const b = makeChart(2, 42, 'Everlong', 'CharterB')
    const c = makeChart(3, 99, 'Other')
    const fetchFn = vi.fn().mockImplementation(() =>
      ok({
        found: 3,
        out_of: 100,
        page: 1,
        data: [a, b, c]
      })
    )
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('ev')
    await new Promise((r) => setTimeout(r, 20))
    const gs = get(search.groups)
    expect(gs).toHaveLength(2)
    expect(gs[0].primary.chartId).toBe(1)
    expect(gs[0].others.map((g) => g.chartId)).toEqual([2])
    expect(gs[1].primary.chartId).toBe(3)
    expect(gs[1].others).toHaveLength(0)
  })
})

describe('rate-limited Explore settles', () => {
  it('does not re-run a query whose last attempt failed until retry() is called', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
    const store = createSearch({ fetchFn, debounceMs: 5, retryDelayMs: 1 })

    store.setQuery('everlong')
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(get(store.error)).toContain('Too many searches')

    // Remounting Explore re-applies the same query; it must not spend another
    // request while the client is still rate-limited.
    store.setQuery('everlong')
    store.setQuery('everlong')
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchFn).toHaveBeenCalledTimes(1)

    store.retry()
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

/** The body of the last request the store sent, parsed. */
const lastBody = (fetchFn: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  JSON.parse(String((fetchFn.mock.calls.at(-1) as [string, RequestInit])[1].body)) as Record<
    string,
    unknown
  >

const lastUrl = (fetchFn: ReturnType<typeof vi.fn>): string =>
  (fetchFn.mock.calls.at(-1) as [string, RequestInit])[0]

/** A draft with one field filled in, which is all it takes to route to the advanced endpoint. */
function draftWith(edit: (q: AdvancedQuery) => void): AdvancedQuery {
  const query = emptyAdvanced()
  edit(query)
  return query
}

const asked = (fetchFn: ReturnType<typeof vi.fn>): { search: string; page: number }[] =>
  (fetchFn.mock.calls as [string, RequestInit][]).map(
    ([, init]) => JSON.parse(String(init.body)) as { search: string; page: number }
  )

/**
 * The debounce window, which is 300ms of the store holding a query nothing has answered yet.
 *
 * Explore's Load more button is live throughout it, and so is the sentinel that presses it by
 * scrolling. What that used to reach was a store half moved to the new query: the page counter
 * back at 1 for a page nobody had fetched, the term already replaced, the applied filters already
 * emptied. These pin that a scheduled run is one thing that happens all at once.
 */
describe('a query waiting out the debounce', () => {
  /** `found` far enough above a page that paging never runs out during one of these. */
  const rows = (n: number): SearchResult =>
    result(
      Array.from({ length: n }, (_, i) => `S${i}`),
      9999
    )

  it('does not let loadMore skip the first page of the query that replaced it', async () => {
    // Reproduced before the fix as [{page:1,"first"},{page:2,"second"},{page:2,"second"}]: the
    // new query's top 25 matches were never fetched, and two requests went to the same page.
    const fetchFn = vi.fn().mockImplementation(() => ok(rows(25)))
    const search = createSearch({ fetchFn, debounceMs: 20 })
    search.setQuery('first')
    await new Promise((r) => setTimeout(r, 60))

    search.setQuery('second')
    await search.loadMore()
    await new Promise((r) => setTimeout(r, 60))

    expect(asked(fetchFn).map((b) => [b.search, b.page])).toEqual([
      ['first', 1],
      ['second', 1]
    ])
  })

  it('does not append a page the filters above it were not asked with', async () => {
    // Reproduced before the fix as an advanced page 1 with a plain page 2 appended under it, in
    // one list: `setQuery` emptied the applied filters where it stood, so the append that landed
    // inside the window went to the other endpoint.
    const fetchFn = vi.fn().mockImplementation(() => ok(rows(25)))
    const search = createSearch({ fetchFn, debounceMs: 20 })
    search.setAdvancedDraft(draftWith((q) => (q.flags.modchart = true)))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 60))
    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search/advanced')

    search.setQuery('metallica')
    await search.loadMore()
    await new Promise((r) => setTimeout(r, 60))

    expect((fetchFn.mock.calls as [string, RequestInit][]).map(([url]) => url)).toEqual([
      'https://api.enchor.us/search/advanced',
      'https://api.enchor.us/search'
    ])
    // One page replaced the other rather than being appended to it.
    expect(get(search.results)).toHaveLength(25)
  })

  it('keeps the applied filters describing the rows on screen until the new ones land', async () => {
    // The count is on the Advanced button and drives the Clear chip beside it. Dropping the
    // filters where the keystroke lands takes both away 300ms before the rows they describe are
    // replaced, which says the list on screen is unfiltered while it is not.
    const fetchFn = vi.fn().mockImplementation(() => ok(rows(25)))
    const search = createSearch({ fetchFn, debounceMs: 20 })
    search.setAdvancedDraft(draftWith((q) => (q.flags.modchart = true)))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 60))
    expect(get(search.advancedCount)).toBe(1)

    search.setQuery('metallica')
    expect(get(search.advancedCount)).toBe(1)
    expect(get(search.advancedDropped)).toBe(0)

    await new Promise((r) => setTimeout(r, 60))
    expect(get(search.advancedCount)).toBe(0)
    expect(get(search.advancedDropped)).toBe(1)
  })

  it('carries a term still inside the window into the filter change that interrupts it', async () => {
    // A click is immediate and lands on what is in the boxes. Throwing the scheduled run away
    // would answer the click with the term before the last keystroke.
    const fetchFn = vi.fn().mockImplementation(() => ok(rows(25)))
    const search = createSearch({ fetchFn, debounceMs: 20 })
    search.setQuery('first')
    await new Promise((r) => setTimeout(r, 60))

    search.setQuery('second')
    search.setFilters('drums', 'expert')
    await new Promise((r) => setTimeout(r, 60))

    expect(asked(fetchFn).map((b) => [b.search, b.page])).toEqual([
      ['first', 1],
      ['second', 1]
    ])
  })
})

describe('advanced search', () => {
  it('starts with nothing applied, so a plain query goes to /search', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.advancedCount)).toBe(0)
    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search')
  })

  it('does not search while the draft is being edited', async () => {
    // Thirty controls searching on change is thirty requests against a 50 a minute budget, and a
    // half-filled form is rarely a question anyone means.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(1)

    search.setAdvancedDraft(draftWith((q) => (q.text.name.value = 'bloom')))
    search.setAdvancedDraft(draftWith((q) => (q.text.name.value = 'bloomin')))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(get(search.advancedCount)).toBe(0)
  })

  it('applyAdvanced sends the draft to the advanced endpoint, from page 1', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    await search.loadMore()

    search.setAdvancedDraft(
      draftWith((q) => {
        q.text.name.value = 'bloom'
        q.text.name.exact = true
      })
    )
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))

    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search/advanced')
    expect(lastBody(fetchFn)).toMatchObject({
      page: 1,
      name: { value: 'bloom', exact: true, exclude: false }
    })
    expect(get(search.advancedCount)).toBe(1)
  })

  it('keeps the advanced fields on every page it appends', async () => {
    // A second page fetched without them is a page of the unfiltered catalog appended to a
    // filtered list, which is worse than not paging at all.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setAdvancedDraft(draftWith((q) => (q.flags.modchart = true)))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))

    await search.loadMore()

    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search/advanced')
    expect(lastBody(fetchFn)).toMatchObject({ page: 2, modchart: true })
  })

  it('keeps the instrument and difficulty chips alongside them', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setAdvancedDraft(draftWith((q) => (q.numbers.minLength = '10')))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))

    search.setFilters('drums', 'expert')
    await new Promise((r) => setTimeout(r, 20))

    expect(lastBody(fetchFn)).toMatchObject({
      instrument: 'drums',
      difficulty: 'expert',
      minLength: 10
    })
  })

  it('survives the setQuery a remount re-applies', async () => {
    // Explore is destroyed by every navigation and by opening a chart Detail. An applied query
    // that did not survive would leave the narrowed rows on screen under a form that says nothing
    // is narrowing them.
    //
    // The empty string is what a remount actually re-applies once filters are on: `applyAdvanced`
    // empties the plain term, because the endpoint it routes to ignores one. A remount handing
    // back a term would be a user typing it, and typing now drops the filters, which is the case
    // below this one.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setAdvancedDraft(draftWith((q) => (q.text.artist.value = 'Foo Fighters')))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))
    const spent = fetchFn.mock.calls.length

    search.setQuery('')
    await new Promise((r) => setTimeout(r, 20))

    expect(fetchFn).toHaveBeenCalledTimes(spent)
    expect(get(search.advancedCount)).toBe(1)
    expect(get(search.advanced).text.artist.value).toBe('Foo Fighters')
  })

  /**
   * The one rule both search boxes obey, kept here because it is the store that reconciles them.
   *
   * `/search/advanced` ignores `search` outright, so a term and the filters cannot both narrow one
   * query. The title bar's box used to set a term anyway, and the endpoint threw it away while
   * the results moved for unrelated reasons.
   */
  describe('a plain term and the applied filters', () => {
    const applied = async (): Promise<ReturnType<typeof createSearch>> => {
      const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
      const search = createSearch({ fetchFn, debounceMs: 5 })
      search.setAdvancedDraft(draftWith((q) => (q.text.charter.value = 'Harmonix')))
      search.applyAdvanced()
      await new Promise((r) => setTimeout(r, 20))
      expect(get(search.advancedCount)).toBe(1)
      return search
    }

    it('drops what was applied, and asks the plain question instead', async () => {
      const search = await applied()

      search.setQuery('everlong')
      await new Promise((r) => setTimeout(r, 20))

      expect(get(search.advancedCount)).toBe(0)
      expect(get(search.advanced)).toEqual(emptyAdvanced())
    })

    it('leaves the draft alone, so one press of Search asks the same question again', async () => {
      // The property the whole rule rests on. A keystroke in the title bar must not be able to
      // destroy a filter set someone spent time building.
      const search = await applied()

      search.setQuery('everlong')
      await new Promise((r) => setTimeout(r, 20))

      expect(get(search.advancedDraft).text.charter.value).toBe('Harmonix')
      expect(get(search.advancedDraftCount)).toBe(1)

      search.applyAdvanced()
      await new Promise((r) => setTimeout(r, 20))

      expect(get(search.advancedCount)).toBe(1)
      expect(get(search.advanced).text.charter.value).toBe('Harmonix')
    })

    it('says how many it dropped, and stops saying it once they are back', async () => {
      // A count falling from one to zero with nothing else on screen is not the user being told.
      const search = await applied()
      expect(get(search.advancedDropped)).toBe(0)

      search.setQuery('everlong')
      await new Promise((r) => setTimeout(r, 20))
      expect(get(search.advancedDropped)).toBe(1)

      // Typing more must not reset the report to zero: the news is still news.
      search.setQuery('everlong b')
      await new Promise((r) => setTimeout(r, 20))
      expect(get(search.advancedDropped)).toBe(1)

      search.restoreAdvanced()
      await new Promise((r) => setTimeout(r, 20))
      expect(get(search.advancedDropped)).toBe(0)
      expect(get(search.advancedCount)).toBe(1)
    })

    it('can be dismissed without the filters coming back', async () => {
      const search = await applied()
      search.setQuery('everlong')
      await new Promise((r) => setTimeout(r, 20))

      search.dismissAdvancedDropped()

      expect(get(search.advancedDropped)).toBe(0)
      expect(get(search.advancedCount)).toBe(0)
    })

    it('reports nothing when there was nothing applied to drop', async () => {
      const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
      const search = createSearch({ fetchFn, debounceMs: 5 })

      search.setQuery('everlong')
      await new Promise((r) => setTimeout(r, 20))

      expect(get(search.advancedDropped)).toBe(0)
    })

    it('sends the wildcard once filters are applied, not the term that was there', async () => {
      // The other half of the rule, and the reason neither box has to be disabled: the box is
      // emptied rather than left showing a word the answer had no part in.
      const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
      const search = createSearch({ fetchFn, debounceMs: 5 })
      search.setQuery('everlong')
      await new Promise((r) => setTimeout(r, 20))

      search.setAdvancedDraft(draftWith((q) => (q.text.charter.value = 'Harmonix')))
      search.applyAdvanced()
      await new Promise((r) => setTimeout(r, 20))

      expect(lastBody(fetchFn)).toMatchObject({ search: '*' })
      expect(get(globalQuery)).toBe('')
    })
  })

  it('leaves the search term alone when an empty panel is submitted', async () => {
    // The panel is a `<form>` and Enter in any of its thirty controls submits it, so Search is
    // pressed with nothing in the boxes more often than it looks. It used to send the wildcard
    // and empty the search box: terms went out as ['metallica', '*'] and `advancedDropped` stayed
    // at 0, so nothing on screen explained where the word had gone.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    globalQuery.set('metallica')
    search.setQuery('metallica')
    await new Promise((r) => setTimeout(r, 20))
    const spent = fetchFn.mock.calls.length

    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))

    // Nothing changed, so nothing was asked: the rows on screen already answer this.
    expect(fetchFn).toHaveBeenCalledTimes(spent)
    expect(lastBody(fetchFn)).toMatchObject({ search: 'metallica' })
    expect(get(globalQuery)).toBe('metallica')
    globalQuery.set('')
  })

  it('still clears the filters when an empty panel is submitted over applied ones', async () => {
    // The other reading of an empty form: it is also how someone empties the boxes by hand and
    // presses Search. The filters go, the term that was there stays, and the answer is re-asked.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setAdvancedDraft(draftWith((q) => (q.flags.modchart = true)))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.advancedCount)).toBe(1)

    search.setAdvancedDraft(emptyAdvanced())
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))

    expect(get(search.advancedCount)).toBe(0)
    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search')
  })

  it('keeps a draft that was typed but never searched', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))

    search.setAdvancedDraft(draftWith((q) => (q.text.charter.value = 'half typed')))

    expect(get(search.advancedDraft).text.charter.value).toBe('half typed')
    expect(get(search.advancedCount)).toBe(0)
  })

  it('clearAdvanced empties both the draft and the applied query and searches again', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setAdvancedDraft(draftWith((q) => (q.flags.hasVideoBackground = true)))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))
    const spent = fetchFn.mock.calls.length

    search.clearAdvanced()
    await new Promise((r) => setTimeout(r, 20))

    expect(fetchFn).toHaveBeenCalledTimes(spent + 1)
    expect(get(search.advancedCount)).toBe(0)
    expect(get(search.advancedDraft)).toEqual(emptyAdvanced())
    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search')
  })

  it('clearAdvanced spends nothing when nothing was narrowing the results', async () => {
    // Clearing a form that was only ever a draft changes no answer, and re-asking would spend one
    // of the 50 requests a minute to get back the rows already on screen.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setAdvancedDraft(draftWith((q) => (q.text.name.value = 'never searched')))

    search.clearAdvanced()
    await new Promise((r) => setTimeout(r, 20))

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(get(search.advancedDraft)).toEqual(emptyAdvanced())
  })

  it('remembers whether the panel is open', () => {
    const search = createSearch({ fetchFn: vi.fn(), debounceMs: 5 })
    expect(get(search.advancedOpen)).toBe(false)
    search.setAdvancedOpen(true)
    expect(get(search.advancedOpen)).toBe(true)
  })

  it('does not let the panel hold a reference into the applied query', async () => {
    // Both are the same shape, and an edit to the draft leaking through would change what the
    // rows on screen were fetched with without fetching anything.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    const draft = draftWith((q) => (q.text.name.value = 'bloom'))
    search.setAdvancedDraft(draft)
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))

    draft.text.name.value = 'everlong'

    expect(get(search.advanced).text.name.value).toBe('bloom')
    expect(get(search.advancedDraft).text.name.value).toBe('bloom')
  })
})

describe('how far Explore will append', () => {
  /** `found` big enough that paging never runs out before the cap does. */
  const page = (n: number): SearchResult =>
    result(
      Array.from({ length: n }, (_, i) => `S${i}`),
      9999
    )

  it('reports more to load while rows are short of the count', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(page(25)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.hasMore)).toBe(true)
    expect(get(search.atAutoCap)).toBe(false)
  })

  /** Pages up to the cap, 25 rows a page as the API delivers them. */
  async function pageToCap(search: ReturnType<typeof createSearch>): Promise<void> {
    while (!get(search.atAutoCap)) await search.loadMore()
  }

  it('stops at the cap, and one press of the button lifts it by another cap', async () => {
    // 95,262 charts exist. Appending to the end would be 3,811 requests and a list nothing can
    // scroll, so it stops somewhere and says so rather than running out of memory.
    const fetchFn = vi.fn().mockImplementation(() => ok(page(25)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    await pageToCap(search)
    expect(get(search.results)).toHaveLength(AUTO_APPEND_CAP)
    expect(get(search.atAutoCap)).toBe(true)

    await search.loadMore()

    // The press both fetched a page and raised the ceiling by a whole cap, so appending resumes
    // and runs to the new one rather than stopping again at the next row.
    expect(get(search.results)).toHaveLength(AUTO_APPEND_CAP + 25)
    expect(get(search.atAutoCap)).toBe(false)
  })

  it('puts the cap back where it started when a new query replaces the rows', async () => {
    // A raised ceiling belongs to the question that raised it. Carrying it over would let an
    // unrelated search run straight past the point the user had to ask at last time.
    const fetchFn = vi.fn().mockImplementation(() => ok(page(25)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    await pageToCap(search)
    await search.loadMore()
    expect(get(search.atAutoCap)).toBe(false)

    search.setQuery('y')
    await new Promise((r) => setTimeout(r, 20))

    expect(get(search.results)).toHaveLength(25)
    // The ceiling is back at the first cap, so this list stops after 500 rows the way the last
    // one did rather than inheriting the room the last one was given.
    await pageToCap(search)
    expect(get(search.results)).toHaveLength(AUTO_APPEND_CAP)
  })

  it('keeps paging while songs are missing, though the rows have passed the count', async () => {
    // `found` counts songs and a page carries every version of one, so rows and `found` are
    // different units. Measured on `/search "metallica"`: found=511, 26 rows for 25 distinct
    // songs on most pages, and comparing the two stopped at 525 rows covering 475 songs with the
    // last 36 unreachable and the button gone. Here every song has a second version, which is the
    // same shape sooner: two pages are 100 rows and only 50 of the 100 songs.
    let asked = 0
    const withAlternates = (): SearchResult => {
      const n = ++asked
      return {
        found: 100,
        out_of: 100,
        page: n,
        data: Array.from({ length: 50 }, (_, i) => {
          const songId = (n - 1) * 25 + Math.floor(i / 2)
          return makeChart(songId * 2 + (i % 2), songId, `S${songId}`, i % 2 ? 'Alt' : 'C')
        })
      }
    }
    const fetchFn = vi.fn().mockImplementation(() => ok(withAlternates()))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('metallica')
    await new Promise((r) => setTimeout(r, 20))

    await search.loadMore()
    expect(get(search.results)).toHaveLength(100)
    expect(get(search.groups)).toHaveLength(50)
    expect(get(search.hasMore)).toBe(true)

    await search.loadMore()
    await search.loadMore()

    // Every song `found` counted is now on screen, so this is the end and the button goes.
    expect(get(search.groups)).toHaveLength(100)
    expect(get(search.hasMore)).toBe(false)
    const spent = fetchFn.mock.calls.length
    await search.loadMore()
    expect(fetchFn).toHaveBeenCalledTimes(spent)
  })

  it('stops asking once a page comes back empty, whatever the count says', async () => {
    // `found` counts songs and a page carries every version of one, so the two do not have to
    // meet. Without this an appending list would ask for page after page of nothing.
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => ok(page(25)))
      .mockImplementation(() => ok(result([], 9999)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))

    await search.loadMore()
    expect(get(search.hasMore)).toBe(false)
    const spent = fetchFn.mock.calls.length

    await search.loadMore()
    expect(fetchFn).toHaveBeenCalledTimes(spent)
  })

  it('is willing again after a new query', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => ok(page(25)))
      .mockImplementationOnce(() => ok(result([], 9999)))
      .mockImplementation(() => ok(page(25)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    await search.loadMore()
    expect(get(search.hasMore)).toBe(false)

    search.setQuery('y')
    await new Promise((r) => setTimeout(r, 20))

    expect(get(search.hasMore)).toBe(true)
  })

  it('spends one request for two loadMore calls made in the same turn', async () => {
    // A scroll that crosses the sentinel twice before the first page lands must not spend the
    // budget twice on the same page.
    const fetchFn = vi.fn().mockImplementation(() => ok(page(25)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn).toHaveBeenCalledTimes(1)

    await Promise.all([search.loadMore(), search.loadMore(), search.loadMore()])

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(lastBody(fetchFn).page).toBe(2)
  })
})

describe('result order', () => {
  it('sends no sort until one is chosen, which is the service deciding', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.sort)).toBe('')
    expect(lastBody(fetchFn).sort).toBeNull()
  })

  it('sends the field and the direction the chosen order stands for', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))

    search.setSort('modifiedTime:desc')
    await new Promise((r) => setTimeout(r, 20))
    expect(lastBody(fetchFn).sort).toEqual({ type: 'modifiedTime', direction: 'desc' })
    expect(lastBody(fetchFn).page).toBe(1)
  })

  it('re-runs from page 1, because page 2 of one order is not page 2 of another', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 500)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    await search.loadMore()
    expect(lastBody(fetchFn).page).toBe(2)

    search.setSort('length:desc')
    await new Promise((r) => setTimeout(r, 20))
    expect(lastBody(fetchFn).page).toBe(1)
    expect(get(search.results).map((c) => c.name)).toEqual(['One'])
  })

  it('spends nothing on choosing the order that is already on', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setSort('name:asc')
    await new Promise((r) => setTimeout(r, 20))
    const spent = fetchFn.mock.calls.length
    search.setSort('name:asc')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn.mock.calls.length).toBe(spent)
  })

  it('orders the advanced endpoint too, which honours sort as the plain one does', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setSort('artist:asc')
    await new Promise((r) => setTimeout(r, 20))

    search.setAdvancedDraft(draftWith((q) => (q.text.name.value = 'bloom')))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))
    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search/advanced')
    expect(lastBody(fetchFn).sort).toEqual({ type: 'artist', direction: 'asc' })
  })

  it('keeps the order across a filter change and a new term', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setSort('year:desc')
    await new Promise((r) => setTimeout(r, 20))

    search.setFilters('guitar', null)
    await new Promise((r) => setTimeout(r, 20))
    expect(lastBody(fetchFn).sort).toEqual({ type: 'year', direction: 'desc' })

    search.setQuery('nirvana')
    await new Promise((r) => setTimeout(r, 20))
    expect(lastBody(fetchFn).sort).toEqual({ type: 'year', direction: 'desc' })
  })
})

describe('the intensity band', () => {
  it('sends the two advanced fields the panel would have sent', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))

    search.setFilters('guitar', null)
    await new Promise((r) => setTimeout(r, 20))
    search.setIntensity('4', '5')
    await new Promise((r) => setTimeout(r, 20))
    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search/advanced')
    expect(lastBody(fetchFn)).toMatchObject({
      instrument: 'guitar',
      minIntensity: 4,
      maxIntensity: 5
    })
  })

  it('sends a floor above the drawn scale as the number it is, not clamped to six', async () => {
    // Charters rate past 6 and the service answers on those ratings: `minIntensity: 7` with
    // guitar chosen answers with diff_guitar of 7, 8, 9 and 20 (measured 2026-09-15). A control
    // that sent 6 here would quietly answer a different question.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setFilters('guitar', null)
    await new Promise((r) => setTimeout(r, 20))

    search.setIntensity('7', '')
    await new Promise((r) => setTimeout(r, 20))
    expect(lastBody(fetchFn).minIntensity).toBe(7)
    expect(lastBody(fetchFn).maxIntensity).toBeUndefined()
  })

  it('is one filter set with the panel, not a second copy of it', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setFilters('drums', null)
    await new Promise((r) => setTimeout(r, 20))

    search.setIntensity('5', '6')
    await new Promise((r) => setTimeout(r, 20))
    // The panel edits this object, so what the header set has to be in it.
    expect(get(search.advancedDraft).numbers.minIntensity).toBe('5')
    expect(get(search.advancedDraft).numbers.maxIntensity).toBe('6')
    expect(get(search.advanced).numbers.minIntensity).toBe('5')
  })

  it('counts toward the filters the closed panel reports', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setFilters('guitar', null)
    await new Promise((r) => setTimeout(r, 20))
    search.setIntensity('4', '')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.advancedCount)).toBe(1)
  })

  it('goes with the instrument, because it means nothing without one', async () => {
    // Measured: with no instrument the band matches "some instrument is in it", and an uncharted
    // instrument carries -1, so `maxIntensity: 1` alone answers with 95,093 of the 95,299 charts
    // there are. Leaving the numbers set would leave a filter on screen narrowing nothing.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setFilters('guitar', null)
    await new Promise((r) => setTimeout(r, 20))
    search.setIntensity('4', '5')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.advancedCount)).toBe(2)

    search.setFilters(null, null)
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.advancedCount)).toBe(0)
    expect(get(search.advancedDraft).numbers.minIntensity).toBe('')
    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search')
    expect(lastBody(fetchFn).minIntensity).toBeUndefined()
  })

  it('leaves the rest of the panel alone when it clears the band', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setAdvancedDraft(draftWith((q) => (q.text.charter.value = 'someone')))
    search.applyAdvanced()
    await new Promise((r) => setTimeout(r, 20))
    search.setFilters('keys', null)
    await new Promise((r) => setTimeout(r, 20))
    search.setIntensity('3', '')
    await new Promise((r) => setTimeout(r, 20))

    search.setFilters(null, null)
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.advanced).text.charter.value).toBe('someone')
    expect(lastBody(fetchFn).charter).toEqual({ value: 'someone', exact: false, exclude: false })
    expect(lastBody(fetchFn).minIntensity).toBeUndefined()
  })

  it('takes the term over, the way the panel does, because the endpoint ignores it', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    globalQuery.set('metallica')
    search.setQuery('metallica')
    await new Promise((r) => setTimeout(r, 20))
    search.setFilters('guitar', null)
    await new Promise((r) => setTimeout(r, 20))

    search.setIntensity('5', '')
    await new Promise((r) => setTimeout(r, 20))
    expect(lastBody(fetchFn).search).toBe('*')
    expect(get(globalQuery)).toBe('')
    globalQuery.set('')
  })

  it('is counted by the notice when a typed term drops it', async () => {
    // The band is an advanced filter like any other, so the rule in `setQuery` takes it: a term
    // and the advanced fields cannot both narrow one query. What matters here is that the count
    // the notice reports includes it, rather than the band falling quietly out of the header.
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setFilters('guitar', null)
    await new Promise((r) => setTimeout(r, 20))
    search.setIntensity('4', '5')
    await new Promise((r) => setTimeout(r, 20))

    search.setQuery('metallica')
    await new Promise((r) => setTimeout(r, 20))
    expect(get(search.advancedDropped)).toBe(2)
    expect(get(search.advanced).numbers.minIntensity).toBe('')
    // The panel still holds it, so Restore is a real offer.
    expect(get(search.advancedDraft).numbers.minIntensity).toBe('4')
    expect(lastUrl(fetchFn)).toBe('https://api.enchor.us/search')
  })

  it('spends nothing on setting the band it is already on', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(result(['One'], 50)))
    const search = createSearch({ fetchFn, debounceMs: 5 })
    search.setQuery('x')
    await new Promise((r) => setTimeout(r, 20))
    search.setFilters('guitar', null)
    await new Promise((r) => setTimeout(r, 20))
    search.setIntensity('4', '5')
    await new Promise((r) => setTimeout(r, 20))
    const spent = fetchFn.mock.calls.length
    search.setIntensity('4', '5')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchFn.mock.calls.length).toBe(spent)
  })
})
