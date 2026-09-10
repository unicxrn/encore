import { get } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import type { ChartData, SearchResult } from '../api/enchor'
import { createSearch, groupBySong } from './search'

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
