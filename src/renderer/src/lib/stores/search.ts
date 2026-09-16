import { derived, get, writable, type Readable, type Writable } from 'svelte/store'
import { searchCharts, sortFor, type ChartData } from '../api/enchor'
import {
  advancedBody,
  advancedCount,
  cloneAdvanced,
  emptyAdvanced,
  type AdvancedQuery
} from '../api/advanced'
import { globalQuery } from './global-search'

export interface SearchConfig {
  fetchFn?: typeof fetch
  debounceMs?: number
  retryDelayMs?: number
}

/**
 * How many results Explore appends on its own before it stops and asks.
 *
 * The catalog holds tens of thousands of charts and grows, so "append until the end" has no end:
 * thousands of requests, that many cards and
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
  /** How many the panel is holding, applied or not. What `restoreAdvanced` would put back. */
  advancedDraftCount: Readable<number>
  /**
   * Changes whenever the store replaces the draft itself instead of being told what it holds.
   *
   * The panel binds its inputs to a local copy of the draft, because `bind:value` needs one, and
   * it seeds that copy when it mounts. Nothing here can reach into it, so `clearAdvanced` called
   * from outside the panel (the chip beside the Advanced button, which is on screen while the
   * panel is open) emptied the store and left the boxes showing filters nothing was filtering by,
   * one keystroke from writing all of them back. This is the panel's cue to seed again. The
   * number itself means nothing.
   */
  advancedDraftReset: Readable<number>
  /**
   * How many applied filters the last plain search dropped, or 0 with nothing to report.
   *
   * A search term and the advanced filters cannot both narrow one query (see `setQuery`), so
   * typing drops the filters. Results changing under a user for a reason they did not ask for is
   * the whole defect, and a count that silently falls to zero is not telling them; this is what
   * Explore says it out loud from. Reset by applying or clearing, and by the user dismissing it.
   */
  advancedDropped: Readable<number>
  /** Whether the panel is open. Survives a remount for the same reason `mode` does. */
  advancedOpen: Readable<boolean>
  /**
   * Whether another page exists.
   *
   * Songs against songs. `found` counts SONGS, and a page carries every version of each one it
   * lists, so rows and `found` are different units and comparing them ended a query before its
   * end. Measured against `/search "metallica"`, which answers `found=511` and delivers 26 rows
   * for 25 distinct songs on most pages: the extra row per page accumulated until 525 rows
   * covering 475 songs read as past the count, the button disappeared, and the last 36 songs were
   * unreachable. The same measurement is what says grouping is the right unit: distinct songs
   * accumulate 25 a page with no repeats across pages and land on 511 exactly, on page 21.
   *
   * A page that comes back empty is the other end and stays, because it is the only terminator
   * that does not depend on `found` being right. It costs one request past the last page, and
   * only on a query where `found` undercounts the songs the pages actually carry; on the measured
   * one the group count stops paging at page 21 and page 22 is never asked for.
   */
  hasMore: Readable<boolean>
  /**
   * Whether Explore has appended as much as it will without being asked. See `AUTO_APPEND_CAP`.
   */
  atAutoCap: Readable<boolean>
  /**
   * The sentence over the list when the rows were handed to the store instead of searched for,
   * and null the rest of the time.
   *
   * Explore's rows normally answer a question the header is still showing: the term in the box,
   * the filters, the order. A handed-over set answers none of them, so without a line saying
   * where it came from the list is five charts with an empty search box over it, which reads as
   * a bug. Holding the line here rather than in the caller is what makes it go away at the right
   * moment: the store already knows when a real run replaces the rows, and nothing else does.
   */
  presented: Readable<string | null>
  /**
   * Put a note over the list, and with it the rows it describes.
   *
   * `charts` null means the note is about something still being fetched, or something that
   * failed: the rows on screen are left exactly as they were, because a surprise that could not
   * be found is no reason to throw away what the user was looking at.
   *
   * With rows, this takes the list over. Anything in flight or waiting out the debounce is
   * cancelled first, or it would answer a moment later and replace them.
   */
  present: (note: string, charts: ChartData[] | null) => void
  /**
   * Which of `SORT_OPTIONS` the results were asked for, by its `value`. Empty is the service's
   * own order.
   *
   * Here rather than in the header for the reason the filters are: Explore is destroyed by every
   * navigation, and a header-owned choice would go back to "Best match" while the rows it
   * ordered stayed on screen.
   */
  sort: Readable<string>
  setQuery: (value: string) => void
  setFilters: (instrument: string | null, difficulty: string | null) => void
  /** Re-runs in a different order. One of `SORT_OPTIONS`' values; anything else is that order. */
  setSort: (value: string) => void
  /**
   * Sets both ends of the intensity band and re-runs.
   *
   * The same two advanced fields the panel's Intensity row edits, not a second copy of them:
   * this writes `minIntensity` and `maxIntensity` into the applied query and the draft together,
   * so the header and the panel can never disagree about what is being filtered by. Empty
   * strings mean that end is not bounded, exactly as a blank box in the panel does.
   */
  setIntensity: (min: string, max: string) => void
  /**
   * Edits the applied advanced query in place from the filter header, and re-runs.
   *
   * The header's band and its chips are views of fields the panel already holds, so neither one
   * may keep a value of its own: `edit` is applied to the applied query and to the draft
   * together, which is what stops a chip and a panel row from disagreeing about one filter.
   *
   * The draft takes the same edit on top of what it is holding rather than being replaced, so a
   * form that was filled in and never searched keeps its typing. Nothing happens at all when the
   * edit would send the same request body, because that is one of the 50 requests a minute the
   * API allows spent on the rows already on screen.
   */
  setAdvancedField: (edit: (query: AdvancedQuery) => void) => void
  /** Records what the panel holds. Changes no results; `applyAdvanced` is what searches. */
  setAdvancedDraft: (next: AdvancedQuery) => void
  /** Runs the draft as the query. */
  applyAdvanced: () => void
  /** Empties both the draft and the applied query, and re-runs if anything was narrowing. */
  clearAdvanced: () => void
  /** Puts the draft back as the applied query. The same act as pressing Search in the panel. */
  restoreAdvanced: () => void
  /** Stops reporting the drop. Changes no results; the filters stay dropped. */
  dismissAdvancedDropped: () => void
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

/**
 * A run that has been asked for and has not started.
 *
 * Typing schedules a run one debounce out, and for that window the previous query's rows are
 * still on screen and still the only thing anything can act on. So nothing a run changes about
 * the store is done when the run is asked for: it is recorded here and applied when the run
 * starts, and `loadMore` refuses while one is waiting.
 *
 * Setting `query`, `page` and the applied filters at schedule time instead left the store
 * describing the new query while the old query's rows were up, and `loadMore` reads all three:
 * it asked for page 2 of a query whose page 1 had not been fetched yet (so the top 25 matches
 * were never loaded and two requests both went to page 2), and it appended an unfiltered page
 * under a filtered one.
 */
interface PendingRun {
  /** The term the run will ask for. */
  query: string
  /** Whether starting it drops the applied advanced filters; see `setQuery`. */
  dropsAdvanced: boolean
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
  // The service's own order until asked otherwise, which is what a search engine's first answer
  // should be: `sort: null` is what the endpoint does when nobody sends one.
  const sortKey = writable('')
  const activeCount = derived(advancedApplied, advancedCount)
  const draftCount = derived(advancedDraft, advancedCount)
  const advancedDropped = writable(0)
  const draftReset = writable(0)
  // Raised a cap's worth at a time by an explicit loadMore; see AUTO_APPEND_CAP and loadMore.
  const autoCap = writable(AUTO_APPEND_CAP)
  const atAutoCap = derived([results, autoCap], ([rows, cap]) => rows.length >= cap)
  const exhausted = writable(false)
  const presented = writable<string | null>(null)
  const hasMore = derived(
    [groups, results, found, exhausted],
    ([songs, rows, total, done]) => !done && rows.length > 0 && songs.length < total
  )
  // The query the rows on screen were asked for. Written when a run STARTS, never when one is
  // scheduled; see `PendingRun`.
  let query = '*'
  // The last query a run was asked for, or null before the first one. This is
  // what "already answered" means, independent of whether the answer was rows,
  // no rows, or an error. Moves at schedule time rather than at run time,
  // because what it answers is "has this question been put to us", and a
  // question waiting out the debounce has been.
  let lastRan: string | null = null
  let page = 1
  let instrument: string | null = null
  let difficulty: string | null = null
  // Read at request time rather than subscribed to, like `instrument` and `difficulty` beside
  // it: nothing renders from this copy, the store is what the header renders from.
  let sort = sortFor('')
  let pending: PendingRun | null = null
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
        { search: query, page, instrument, difficulty, sort, advanced: get(advancedApplied) },
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
        // These rows are a search's own answer, so whatever note described the last handed-over
        // set no longer describes anything on screen. Cleared here rather than when a run starts:
        // a run that fails leaves the previous rows up, and the note that explains them has to
        // stay up with them.
        presented.set(null)
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

  /** The drop half of the rule in `setQuery`, done when the run that causes it starts. */
  function dropAppliedAdvanced(): void {
    const dropping = get(activeCount)
    if (dropping === 0) return
    advancedApplied.set(emptyAdvanced())
    advancedDropped.set(dropping)
  }

  /** Forget a scheduled run without applying any of it. */
  function cancelPending(): void {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }

  /**
   * Apply what a scheduled run was going to apply, and cancel it.
   *
   * Every immediate path (a filter change, Search in the panel, Clear) goes through this rather
   * than throwing the pending run away, because a click lands on what is in the boxes, including
   * a keystroke still inside the debounce window. Discarding it would answer the click with the
   * term before that keystroke.
   */
  function takePending(): void {
    const next = pending
    cancelPending()
    if (!next) return
    query = next.query
    if (next.dropsAdvanced) dropAppliedAdvanced()
  }

  function startPending(): void {
    if (!pending) return
    takePending()
    page = 1
    void run(false)
  }

  function schedule(next: PendingRun): void {
    cancelPending()
    pending = next
    lastRan = next.query
    timer = setTimeout(startPending, debounceMs)
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
    // A term and the advanced filters are alternatives, not a pair. `/search/advanced` ignores
    // `search` outright (measured; see `searchCharts`), so with filters applied a typed term
    // changed nothing about the answer while the results moved for unrelated reasons. Typing
    // wins, because it is the thing the user just did, and it is the one of the two that has no
    // other way to be expressed.
    //
    // Only what is APPLIED is dropped. `advancedDraft` is left exactly as it was, so the panel
    // still holds every field the user filled in and one press of Search (or of Restore, below)
    // asks the same question again. A rule that destroyed the form instead would make an
    // accidental keystroke in the title bar cost a filter set someone built.
    //
    // The drop happens when the run starts, not here: for the debounce window the filtered rows
    // are still the ones on screen, and a count that had already fallen to zero described neither
    // the rows above it nor the request that had not been made yet.
    schedule({ query: next, dropsAdvanced: true })
  }

  function retry(): void {
    // The question last put to us, which is the pending one if the debounce is still running.
    schedule({ query: lastRan ?? query, dropsAdvanced: false })
  }

  function setFilters(nextInstrument: string | null, nextDifficulty: string | null): void {
    instrument = nextInstrument
    difficulty = nextDifficulty
    filters.set({ instrument, difficulty })
    // Intensity is measured per instrument and is a no-op without one; see ADVANCED_RANGES.
    // Going back to "Any instrument" therefore takes the band with it, in the same click and
    // the same request, and the header's own control visibly returns to Any as it does. Leaving
    // the numbers set would leave a filter on screen that the answer was not narrowed by.
    if (instrument === null) clearIntensityFields()
    // A filter change is a click, not typing: skip the debounce, and carry any term still inside
    // it into this run rather than dropping it.
    takePending()
    page = 1
    void run(false)
  }

  /** Empties both ends of the band in the applied query and in the draft, without running. */
  function clearIntensityFields(): void {
    const applied = get(advancedApplied)
    const draft = get(advancedDraft)
    const bounded =
      applied.numbers.minIntensity !== '' ||
      applied.numbers.maxIntensity !== '' ||
      draft.numbers.minIntensity !== '' ||
      draft.numbers.maxIntensity !== ''
    if (!bounded) return
    advancedApplied.set(withIntensity(applied, '', ''))
    advancedDraft.set(withIntensity(draft, '', ''))
    draftReset.update((n) => n + 1)
  }

  function withIntensity(query: AdvancedQuery, min: string, max: string): AdvancedQuery {
    const next = cloneAdvanced(query)
    next.numbers.minIntensity = min
    next.numbers.maxIntensity = max
    return next
  }

  function setSort(value: string): void {
    if (value === get(sortKey)) return
    sortKey.set(value)
    sort = sortFor(value)
    // A click, like a filter change: no debounce, and any term still inside one comes along.
    takePending()
    page = 1
    void run(false)
  }

  function setIntensity(min: string, max: string): void {
    setAdvancedField((query) => {
      query.numbers.minIntensity = min
      query.numbers.maxIntensity = max
    })
  }

  function setAdvancedField(edit: (query: AdvancedQuery) => void): void {
    const applied = get(advancedApplied)
    const next = cloneAdvanced(applied)
    edit(next)
    // Compared as request bodies rather than as forms, the way the panel decides whether it is
    // holding an unsearched edit: an edit the endpoint would not be told about is not a question.
    if (JSON.stringify(advancedBody(next)) === JSON.stringify(advancedBody(applied))) return
    // Written into the draft as well as the applied query, so an open panel shows what the header
    // just set rather than what it used to hold. `draftReset` is what tells the panel to re-seed
    // the local copy its inputs are bound to; see `advancedDraftReset`.
    const draft = cloneAdvanced(get(advancedDraft))
    edit(draft)
    advancedDraft.set(draft)
    draftReset.update((n) => n + 1)
    applyQuery(next)
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
   * The pending guard is the same idea one step earlier. A scheduled run has not touched
   * `loading` yet, and the button stays live through the whole debounce window, so without this
   * the next page of a query that is about to be replaced gets fetched and thrown away. What it
   * cost before it was thrown away is in `PendingRun`.
   *
   * `hasMore` rather than a count of its own, so the store refuses exactly what the button and
   * the sentinel are hidden for; a second opinion here is a second place for the end of the data
   * to be wrong.
   *
   * Called both by the sentinel below the cap and by the button at it, and raising the cap here
   * rather than in the button is what keeps that one path. Below the cap the raise cannot fire;
   * at it, the only caller left is a deliberate click, and a click is the user asking for another
   * cap's worth.
   */
  async function loadMore(): Promise<void> {
    if (pending || get(loading) || !get(hasMore)) return
    const held = get(results).length
    if (held >= get(autoCap)) autoCap.set(held + AUTO_APPEND_CAP)
    page += 1
    await run(true)
  }

  /**
   * Show rows the store did not fetch, under a note saying what they are.
   *
   * The header's own controls are deliberately left alone. The instrument, the difficulty, the
   * order and the advanced panel all describe the next question rather than these rows, and
   * clearing them would either lie to a mounted Explore (which seeds its selects once, on mount)
   * or spend a request putting them back. The note is what says these five did not come from
   * them.
   *
   * `exhausted` is what stops the list asking for more. `found` is the number of rows and there
   * is no page 2 of a handed-over set, so without it a set whose charts share a songId would
   * group to fewer than `found` and arm the sentinel, which would append page 2 of the wildcard
   * under five charts that had nothing to do with it.
   *
   * The wildcard is recorded as already answered for the same reason `applyQuery` records it:
   * Explore re-applies the global query from an `$effect` on every mount, and a remount that
   * found the question unasked would run it and replace these rows.
   */
  function present(note: string, charts: ChartData[] | null): void {
    presented.set(note)
    if (charts === null) return
    cancelPending()
    controller?.abort()
    controller = null
    results.set(charts)
    found.set(charts.length)
    expanded.set(new Set())
    selected.set(new Set())
    scrollTop = 0
    autoCap.set(AUTO_APPEND_CAP)
    exhausted.set(true)
    error.set(null)
    // An aborted run returns without touching this, so nothing else would put it back.
    loading.set(false)
    searched.set(true)
    query = '*'
    lastRan = '*'
    page = 1
    globalQuery.set('')
  }

  function setAdvancedDraft(next: AdvancedQuery): void {
    advancedDraft.set(cloneAdvanced(next))
  }

  function applyAdvanced(): void {
    const next = cloneAdvanced(get(advancedDraft))
    // A form with nothing in it, submitted while nothing was applied, is not a question. The
    // panel is a `<form>`, so Enter in any of its thirty controls submits it, and taking the term
    // over for a query that ends up narrowed by nothing threw away what was typed in the search
    // box with nothing left to say so: `advancedDropped` counts filters and there were none.
    if (advancedCount(next) === 0 && get(activeCount) === 0) return
    applyQuery(next)
  }

  /**
   * Make one advanced query the applied one and run it.
   *
   * Shared by the panel's Search button and by the header's intensity band, because both are the
   * same act: a set of advanced fields becoming the question. Anything that only one of them
   * needs stays in its own caller, which is why the empty-form guard is in `applyAdvanced` and
   * the draft write is in `setIntensity`.
   */
  function applyQuery(next: AdvancedQuery): void {
    const narrowing = advancedCount(next) > 0
    // A press of Search, like a filter change, is a click rather than typing, and it carries any
    // term still inside the debounce window with it.
    takePending()
    advancedApplied.set(next)
    advancedDropped.set(0)
    if (narrowing) {
      // The other half of the rule in `setQuery`, and the reason neither search box has to be
      // disabled: the endpoint about to answer ignores the term, so the box is emptied rather
      // than left showing a word that had no part in the results. `lastRan` moves with it, so
      // Explore's mount effect finds the wildcard already answered instead of spending a second
      // request on the rows this run is fetching. Only when something is actually narrowing:
      // with an empty form the endpoint is `/search`, which honours the term.
      query = '*'
      lastRan = '*'
      globalQuery.set('')
    }
    page = 1
    void run(false)
  }

  function restoreAdvanced(): void {
    // Offered only while the draft holds something (Explore gates the button on
    // `advancedDraftCount`), so it never lands on the empty-form case `applyAdvanced` returns on.
    applyAdvanced()
  }

  function dismissAdvancedDropped(): void {
    advancedDropped.set(0)
  }

  function clearAdvanced(): void {
    const wasNarrowed = get(activeCount) > 0
    advancedApplied.set(emptyAdvanced())
    advancedDraft.set(emptyAdvanced())
    // The one place the store replaces the draft rather than being handed one; see
    // `advancedDraftReset`. Bumped whether or not anything was narrowing, because an open panel
    // full of boxes is the thing being cleared either way.
    draftReset.update((n) => n + 1)
    // Cleared on purpose, so there is nothing left to offer to put back.
    advancedDropped.set(0)
    // Clearing a form that was not narrowing anything changes no answer, and re-asking the same
    // question would spend one of the 50 requests a minute to get the rows already on screen.
    if (!wasNarrowed) return
    takePending()
    page = 1
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
    advancedDraftCount: draftCount,
    advancedDraftReset: { subscribe: draftReset.subscribe },
    advancedDropped: { subscribe: advancedDropped.subscribe },
    advancedOpen: { subscribe: advancedOpen.subscribe },
    hasMore,
    atAutoCap,
    sort: { subscribe: sortKey.subscribe },
    presented: { subscribe: presented.subscribe },
    present,
    setQuery,
    setFilters,
    setSort,
    setIntensity,
    setAdvancedField,
    setAdvancedDraft,
    applyAdvanced,
    clearAdvanced,
    restoreAdvanced,
    dismissAdvancedDropped,
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
