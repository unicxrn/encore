import { derived, get, writable, type Readable, type Writable } from 'svelte/store'
import { searchCharts, type ChartData } from '../api/enchor'
import { advancedCount, cloneAdvanced, emptyAdvanced, type AdvancedQuery } from '../api/advanced'

export interface SearchConfig {
  fetchFn?: typeof fetch
  debounceMs?: number
  retryDelayMs?: number
}

/**
 * How many results Explore appends on its own before it stops and asks.
 *
 * There are 95,262 charts, so "append until the end" has no end: 3,811 requests, 95,262 cards and
 * as many album art requests, in a list nothing can scroll. Somewhere it has to stop, and a button
 * is a better place to stop than a browser running out of memory.
 *
 * 500 is 20 pages, which is also 20 of the 50 requests a minute the API allows. That makes the cap
 * the rate limit's brake as well: the fastest possible scroll spends at most 20 requests before it
 * has to wait for a click.
 *
 * Deliberately not virtualisation. The grid is `auto-fill` over a window the user can resize, so a
 * windowing layer would have to be told the row height and the column count that layout exists to
 * work out for itself, and it would have to hold the list mode's variable row heights too.
 */
export const AUTO_APPEND_CAP = 500

export interface SongGroup {
  primary: ChartData
  others: ChartData[]
}

/**
 * Groups ChartData by songId. Charts with songId == null are each their own
 * group keyed by chartId. Group order matches first-occurrence order in the
 * input array; within a group, primary is the first occurrence and others are
 * the rest in order.
 */
export function groupBySong(data: ChartData[]): SongGroup[] {
  const groups: SongGroup[] = []
  // Map from songId (number) or "c:<chartId>" (null-songId charts) to group index
  const indexMap = new Map<string | number, number>()

  for (const chart of data) {
    const key: string | number = chart.songId !== null ? chart.songId : `c:${chart.chartId}`
    const existing = indexMap.get(key)
    if (existing !== undefined) {
      groups[existing].others.push(chart)
    } else {
      indexMap.set(key, groups.length)
      groups.push({ primary: chart, others: [] })
    }
  }

  return groups
}

export interface SearchFilters {
  instrument: string | null
  difficulty: string | null
}

/** How Explore draws its results: a dense list of rows, or a grid of album art. */
export type BrowseMode = 'list' | 'grid'

export interface SearchStore {
  results: Writable<ChartData[]>
  groups: Readable<SongGroup[]>
  found: Writable<number>
  loading: Writable<boolean>
  error: Writable<string | null>
  /**
   * False until a run has finished, then true for the life of the store.
   *
   * Explore cannot read "no rows" as "nothing matched" without it: `results` is empty and
   * `loading` false for the whole 300ms debounce before the first request even starts, so an
   * empty state keyed on those alone flashes "nothing matched" on every cold open.
   */
  searched: Readable<boolean>
  /** Filters currently applied, readable so a remounted view can restore its selects. */
  filters: Readable<SearchFilters>
  /**
   * songIds whose alternate versions are shown expanded. Lives here rather than
   * in the view for the same reason the results do: Browse is destroyed by every
   * navigation and by opening a chart Detail, and a per-instance set collapsed
   * every group on the way back. Null-songId charts are always solo, so only
   * number keys land here.
   */
  expanded: Readable<ReadonlySet<number>>
  /**
   * List or grid. Here for the same reason `expanded` is (Explore is destroyed
   * by every navigation and by opening a chart Detail), but it outlives more
   * than that set does: expansion keys describe the rows currently on screen and
   * are dropped when a run replaces them, while the mode is a statement about
   * how the user wants results shown and survives every new query.
   *
   * It does NOT survive a restart. Persisting it would mean a `Settings` field,
   * its zod default and the IPC round trip that writes it, which is a larger
   * change than this view, so a fresh launch opens in the default below.
   */
  mode: Readable<BrowseMode>
  /**
   * chartIds the user has ticked for a bulk action.
   *
   * Cleared when a run replaces the rows, for the same reason `expanded` is and
   * with more at stake: these ids are what a bulk download is built from, so
   * carrying them across an unrelated search would download charts the user
   * never saw. An append leaves them, because every picked row is still there.
   *
   * chartIds, not songIds: a chart is what gets downloaded, and a song may have
   * several. Ticking a group's primary selects the primary and nothing else.
   */
  selected: Readable<ReadonlySet<number>>
  /**
   * The advanced fields the results on screen were asked for.
   *
   * Here rather than in the panel for the reason everything else in this store is: Explore is
   * destroyed by every navigation and by opening a chart Detail, and a panel-owned query would
   * quietly go back to matching everything while the rows from the narrowed one stayed up.
   */
  advanced: Readable<AdvancedQuery>
  /**
   * What the panel currently has typed into it, which is not the same thing.
   *
   * The panel does not search as it is edited: thirty controls searching on change is thirty
   * requests against a 50 per minute budget, and a half-filled form is rarely a question anyone
   * means. So the draft is what the boxes hold and `advanced` is what was asked, and Search is
   * what moves one to the other. The draft is kept here too so a form filled in but not yet
   * submitted survives the same round trip the applied one does.
   */
  advancedDraft: Readable<AdvancedQuery>
  /** How many advanced fields are narrowing the results right now. 0 when none are. */
  advancedCount: Readable<number>
  /** Whether the panel is open. Survives a remount for the same reason `mode` does. */
  advancedOpen: Readable<boolean>
  /**
   * Whether another page exists.
   *
   * Both halves matter. `found` is the service's count and the rows can overshoot it, because a
   * page carries every version of a song it lists while `found` counts songs, so rows past `found`
   * is the ordinary end of the data. A page that comes back empty is the other end, and without it
   * an appending list would ask for page after page of nothing.
   */
  hasMore: Readable<boolean>
  /**
   * Whether Explore has appended as much as it will without being asked. See `AUTO_APPEND_CAP`.
   */
  atAutoCap: Readable<boolean>
  setQuery: (value: string) => void
  setFilters: (instrument: string | null, difficulty: string | null) => void
  /** Records what the panel holds. Changes no results; `applyAdvanced` is what searches. */
  setAdvancedDraft: (next: AdvancedQuery) => void
  /** Runs the draft as the query. */
  applyAdvanced: () => void
  /** Empties both the draft and the applied query, and re-runs if anything was narrowing. */
  clearAdvanced: () => void
  setAdvancedOpen: (open: boolean) => void
  toggleExpanded: (songId: number) => void
  toggleSelected: (chartId: number) => void
  clearSelected: () => void
  setMode: (next: BrowseMode) => void
  /**
   * Scroll offset of the results list, in px. Kept here rather than in a store
   * of its own because it is invalidated by exactly the same event as the
   * expansion set (a replaced result set is a different list, so it starts at
   * the top) and survives a remount for the same reason the results do.
   *
   * Deliberately a plain accessor pair and not a `Writable`: it is written on
   * every scroll event and nothing renders from it, so subscribers would only
   * cost renders.
   */
  saveScroll: (px: number) => void
  savedScroll: () => number
  /** Re-runs the current query unconditionally (the error card's Retry). */
  retry: () => void
  loadMore: () => Promise<void>
}

export function createSearch(config: SearchConfig = {}): SearchStore {
  const { fetchFn = fetch, debounceMs = 300, retryDelayMs } = config
  const results = writable<ChartData[]>([])
  const groups = derived(results, groupBySong)
  const found = writable(0)
  const loading = writable(false)
  const error = writable<string | null>(null)
  const searched = writable(false)
  const filters = writable<SearchFilters>({ instrument: null, difficulty: null })
  const expanded = writable<ReadonlySet<number>>(new Set())
  const selected = writable<ReadonlySet<number>>(new Set())
  // Grid, not list: remote charts carry album art (`albumArtUrl`), and a wall of covers is
  // both faster to scan and the reason the grid was built. The list is a click away and is
  // still the better answer for comparing charters and difficulty tiers across versions of one
  // song, which is why both exist.
  const mode = writable<BrowseMode>('grid')
  const advancedApplied = writable<AdvancedQuery>(emptyAdvanced())
  const advancedDraft = writable<AdvancedQuery>(emptyAdvanced())
  const advancedOpen = writable(false)
  const activeCount = derived(advancedApplied, advancedCount)
  // Raised a cap's worth at a time by an explicit loadMore; see AUTO_APPEND_CAP and loadMore.
  const autoCap = writable(AUTO_APPEND_CAP)
  const atAutoCap = derived([results, autoCap], ([rows, cap]) => rows.length >= cap)
  const exhausted = writable(false)
  const hasMore = derived(
    [results, found, exhausted],
    ([rows, total, done]) => !done && rows.length > 0 && rows.length < total
  )
  let query = '*'
  // The last query we started a run for, or null before the first one. This is
  // what "already answered" means, independent of whether the answer was rows,
  // no rows, or an error.
  let lastRan: string | null = null
  let page = 1
  let instrument: string | null = null
  let difficulty: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let scrollTop = 0

  async function run(append: boolean): Promise<void> {
    controller?.abort()
    controller = new AbortController()
    loading.set(true)
    error.set(null)
    try {
      const response = await searchCharts(
        { search: query, page, instrument, difficulty, advanced: get(advancedApplied) },
        fetchFn,
        {
          signal: controller.signal,
          retryDelayMs
        }
      )
      results.update((prev) => (append ? [...prev, ...response.data] : response.data))
      // An empty page is the end of the data whatever `found` says, and it is the one thing that
      // stops an appending list asking for the next page forever.
      if (append && response.data.length === 0) exhausted.set(true)
      // Expansion keys are songIds from the rows currently on screen, so it goes
      // stale exactly when those rows are replaced, and not when a run merely
      // starts. A failed run leaves the old rows visible, and collapsing groups
      // the user can still see would be wrong; an append keeps them all. The
      // saved scroll offset is stale under the same conditions, and so is the
      // selection: its chartIds name rows that are no longer on screen.
      if (!append) {
        expanded.set(new Set())
        selected.set(new Set())
        scrollTop = 0
        // A different question is a different list, so the appetite for it starts over: the
        // previous one's raised cap would let a fresh search run straight past the point the user
        // had to ask at last time.
        autoCap.set(AUTO_APPEND_CAP)
        exhausted.set(false)
      }
      found.set(response.found)
      searched.set(true)
      loading.set(false)
    } catch (err) {
      // An abort means a newer run replaced this one and will answer in its place; nothing has
      // been settled yet, so `searched` stays where it is.
      if (err instanceof DOMException && err.name === 'AbortError') return
      // On a failed append, roll back the page increment so the next loadMore
      // retries the same page rather than skipping it.
      if (append) page -= 1
      error.set(err instanceof Error ? err.message : String(err))
      // A failed run has still finished; this tracks that, not whether it succeeded. Explore
      // shows the error card rather than the empty state while `error` is set.
      searched.set(true)
      loading.set(false)
    }
  }

  function search(next: string): void {
    query = next
    lastRan = next
    page = 1
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void run(false), debounceMs)
  }

  function setQuery(value: string): void {
    // An empty query means "browse everything": the API treats "*" as the
    // full catalog listing, still honoring instrument/difficulty filters.
    const next = value.trim() || '*'
    // Browse re-applies the global query from an $effect, so this runs again on
    // every mount, and Explore is unmounted by every sidebar navigation and by
    // opening a chart detail. Re-asking a question we already asked would throw
    // away the pages loaded so far and spend one of the API's 50 requests per
    // minute on each click. Nothing changed, so nothing to do.
    //
    // "Already asked" is deliberately not inferred from results/error. A query
    // that found nothing has an empty result set, and a failed one has an error
    // while its earlier pages are still on screen. Both are answers we hold.
    // In particular, re-running the failed case on every mount is how a
    // rate-limited client stays rate-limited. retry() is the one path that
    // forces a fresh run, and the error card's Retry button is the way to it.
    if (next === lastRan) return
    search(next)
  }

  function retry(): void {
    search(query)
  }

  function setFilters(nextInstrument: string | null, nextDifficulty: string | null): void {
    instrument = nextInstrument
    difficulty = nextDifficulty
    filters.set({ instrument, difficulty })
    page = 1
    // A filter change is a click, not typing: skip the debounce.
    if (timer) clearTimeout(timer)
    void run(false)
  }

  function toggleExpanded(songId: number): void {
    const collapsing = get(expanded).has(songId)
    expanded.update((prev) => {
      const next = new Set(prev)
      if (!next.delete(songId)) next.add(songId)
      return next
    })
    if (collapsing) deselectAlternates(songId)
  }

  /**
   * Collapsing a group takes its alternate rows/cards off the screen. Anything
   * ticked among them would stay in the selection with no checkbox left to show
   * it and no way to reach it, so the count in the selection bar would stop
   * matching what the user can see, and a bulk download would then fetch a
   * chart they cannot point at. The primary stays: it is still on screen.
   */
  function deselectAlternates(songId: number): void {
    const group = get(groups).find((g) => g.primary.songId === songId)
    if (!group?.others.length) return
    const picked = get(selected)
    if (!group.others.some((c) => picked.has(c.chartId))) return
    const next = new Set(picked)
    for (const chart of group.others) next.delete(chart.chartId)
    selected.set(next)
  }

  function toggleSelected(chartId: number): void {
    selected.update((prev) => {
      const next = new Set(prev)
      if (!next.delete(chartId)) next.add(chartId)
      return next
    })
  }

  function clearSelected(): void {
    selected.set(new Set())
  }

  function setMode(next: BrowseMode): void {
    mode.set(next)
  }

  function saveScroll(px: number): void {
    scrollTop = px
  }

  function savedScroll(): number {
    return scrollTop
  }

  /**
   * Fetch the next page and append it.
   *
   * The loading guard is what keeps one request in flight: `run` sets `loading` before its first
   * await, so a second call made in the same turn (a scroll that crosses the sentinel twice, a
   * double click on the button) sees it already true and returns having spent nothing.
   *
   * Called both by the sentinel below the cap and by the button at it, and raising the cap here
   * rather than in the button is what keeps that one path. Below the cap the raise cannot fire;
   * at it, the only caller left is a deliberate click, and a click is the user asking for another
   * cap's worth.
   */
  async function loadMore(): Promise<void> {
    if (get(loading) || get(exhausted) || get(results).length >= get(found)) return
    const held = get(results).length
    if (held >= get(autoCap)) autoCap.set(held + AUTO_APPEND_CAP)
    page += 1
    await run(true)
  }

  function setAdvancedDraft(next: AdvancedQuery): void {
    advancedDraft.set(cloneAdvanced(next))
  }

  function applyAdvanced(): void {
    advancedApplied.set(cloneAdvanced(get(advancedDraft)))
    page = 1
    // A press of Search, like a filter change, is a click rather than typing.
    if (timer) clearTimeout(timer)
    void run(false)
  }

  function clearAdvanced(): void {
    const wasNarrowed = get(activeCount) > 0
    advancedApplied.set(emptyAdvanced())
    advancedDraft.set(emptyAdvanced())
    // Clearing a form that was not narrowing anything changes no answer, and re-asking the same
    // question would spend one of the 50 requests a minute to get the rows already on screen.
    if (!wasNarrowed) return
    page = 1
    if (timer) clearTimeout(timer)
    void run(false)
  }

  function setAdvancedOpen(open: boolean): void {
    advancedOpen.set(open)
  }

  return {
    results,
    groups,
    found,
    loading,
    error,
    searched: { subscribe: searched.subscribe },
    filters,
    expanded,
    selected: { subscribe: selected.subscribe },
    mode: { subscribe: mode.subscribe },
    advanced: { subscribe: advancedApplied.subscribe },
    advancedDraft: { subscribe: advancedDraft.subscribe },
    advancedCount: activeCount,
    advancedOpen: { subscribe: advancedOpen.subscribe },
    hasMore,
    atAutoCap,
    setQuery,
    setFilters,
    setAdvancedDraft,
    applyAdvanced,
    clearAdvanced,
    setAdvancedOpen,
    toggleExpanded,
    toggleSelected,
    clearSelected,
    setMode,
    saveScroll,
    savedScroll,
    retry,
    loadMore
  }
}

/**
 * The Explore view's search state.
 *
 * Module-scoped rather than per-component: App unmounts Browse on every sidebar
 * navigation and whenever a chart Detail opens, so a component-owned store
 * would reset to page 1 and re-query the API on every one of those trips.
 * Constructing it is inert: nothing is requested until setQuery runs.
 */
export const browseSearch = createSearch()
