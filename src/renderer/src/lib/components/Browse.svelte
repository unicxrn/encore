<script lang="ts">
  import { tick } from 'svelte'
  import { get } from 'svelte/store'
  import { SvelteSet } from 'svelte/reactivity'
  import { browseSearch } from '../stores/search'
  import { globalQuery } from '../stores/global-search'
  import { settings } from '../stores/settings'
  import { INSTRUMENTS, DIFFICULTIES, albumArtUrl, type ChartData } from '../api/enchor'
  import { msToTime, diffDisplay } from '../../../../shared/format'
  import { encore } from '../stores/bridge'
  import AdvancedSearch from './AdvancedSearch.svelte'
  import type { ChartTarget } from './Home.svelte'

  // Rows open the full Detail page (the old inline side panel is retired).
  let { onOpenChart }: { onOpenChart: (target: ChartTarget) => void } = $props()

  // Shared module-scoped store: this view is remounted by every navigation and
  // by opening a chart Detail, and a per-instance store would re-query the API
  // (and drop the pages already loaded) each time.
  const search = browseSearch
  const { results, groups, found, loading, error, searched, expanded, mode, selected } = search
  const { advancedCount, advancedOpen, hasMore, atAutoCap } = search
  let inputEl = $state<HTMLInputElement | null>(null)
  let advToggleEl = $state<HTMLButtonElement | null>(null)
  // Seeded from the shared store so a remount restores the chips the user set.
  let instrument = $state<string | null>(get(search.filters).instrument)
  let difficulty = $state<string | null>(get(search.filters).difficulty)

  // Which songId groups show their alternate versions also lives in the shared
  // store; see its comment. It used to be a per-instance SvelteSet, which
  // collapsed every open group on the way back from a chart Detail.

  let tableEl = $state<HTMLDivElement | null>(null)
  let sentinelEl = $state<HTMLButtonElement | null>(null)

  /** How far past the edge of the scrolling box the end of the list still counts as reached. */
  const LOOKAHEAD_PX = 400

  /**
   * The box the results scroll in, found rather than assumed.
   *
   * `.table` is that box today, measured in the desktop app: 609px of box around 1219px of rows
   * at 1280x800. The observer's root, the restore below and the scroll listener all have to name
   * the same element, and a layout change that moved the overflow to an ancestor would leave all
   * three pointing at one that clips nothing. That fails quietly rather than visibly, so the
   * element is looked up instead of written down. `tableEl` is the fallback for a document with
   * no scrolling ancestor at all, which is every jsdom test: they apply no CSS.
   */
  function scrollBox(): HTMLElement | null {
    for (let node: HTMLElement | null = tableEl; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node)
      if (overflowY === 'auto' || overflowY === 'scroll') return node
    }
    return tableEl
  }

  /**
   * The offset the restore below wrote, until a scroll event accounts for it.
   *
   * Setting `scrollTop` makes the browser fire a scroll event of its own, and treating that one
   * as the user's would arm auto-append at exactly the offset they left. On a list they had
   * scrolled to the bottom, that is one unasked-for request on every trip back from a chart
   * Detail, spent fetching a page nobody looked for. A scroll to any other offset is theirs.
   */
  let restoredTo: number | null = null
  /**
   * Whether reaching the bottom may fetch.
   *
   * True from the first paint, and false only while a restored offset is still unaccounted for:
   * the thing it guards against is the restore fetching a page nobody asked for, and a list with
   * an offset to restore is by definition long enough to scroll, so a scroll event is a signal
   * that exists there.
   *
   * It used to start false on every mount and wait for a scroll event, which is the defect this
   * replaces. Measured in the desktop app: at 1920x1080 the first 25 charts are 889px of grid in
   * a box 889px tall, and at 2560x1440 1249px in a box 1249px tall. Nothing overflows, so nothing
   * can be scrolled, so no scroll event is ever fired and Explore stopped at one page with the
   * end of the list already on screen. At 1280x800 the same page is 1219px in a 609px box and
   * auto-append worked, which is how this shipped.
   */
  let armed = $state(search.savedScroll() <= 0)
  /** Whether the sentinel is on screen, as the observer last saw it. */
  let atBottom = $state(false)

  // Put the list back where the user left it. Runs once, when bind:this fills
  // tableEl on mount; the rows are already in the DOM by then because the
  // results live in the shared store, so there is nothing to wait for.
  //
  // Not covered by any test: jsdom performs no layout, so scrollTop there is always 0 and a test
  // could only assert that this line ran. Measured in the desktop app instead: a list scrolled to
  // 900px, a chart Detail opened from it and left again, comes back at 900px.
  $effect(() => {
    const box = scrollBox()
    if (!box) return
    const saved = search.savedScroll()
    if (saved <= 0) return
    restoredTo = saved
    box.scrollTop = saved
  })

  // The scroll listener goes on whichever element turns out to scroll, for the reason
  // `scrollBox` exists. In the markup it could only name `.table`.
  $effect(() => {
    const box = scrollBox()
    if (!box) return undefined
    const onScroll = (): void => onTableScroll(box.scrollTop)
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
  })

  function onTableScroll(top: number): void {
    if (restoredTo !== null && top === restoredTo) restoredTo = null
    else armed = true
    search.saveScroll(top)
  }

  /**
   * Watch the button at the end of the list and record whether it is in view.
   *
   * The decision is not taken here, because the callback is not where the guards are; the effect
   * below takes it. `rootMargin` starts the next page a screenful early, so the rows arrive
   * before the user reaches the end rather than after they have stared at the bottom of the list.
   *
   * Held in `observer` so `fillToTheEnd` can ask it again. Not covered by any test as written:
   * jsdom ships no IntersectionObserver and computes no layout, so the tests stub the observer
   * and drive it by hand. What the real one does with this root and this margin was measured in
   * the desktop app: with the first page not filling the box it reports the sentinel visible on
   * the first paint, and reports it gone once an appended page has pushed it past the margin.
   */
  let observer: IntersectionObserver | null = null

  $effect(() => {
    const el = sentinelEl
    if (!el || !tableEl || typeof IntersectionObserver === 'undefined') return undefined
    const watching = new IntersectionObserver(
      (entries) => {
        atBottom = entries.some((entry) => entry.isIntersecting)
      },
      { root: scrollBox(), rootMargin: `${LOOKAHEAD_PX}px 0px` }
    )
    watching.observe(el)
    observer = watching
    return () => {
      watching.disconnect()
      if (observer === watching) observer = null
    }
  })

  /**
   * Load the next page when the end of the list is in view.
   *
   * Every guard here is about spending requests the user did not ask for. `armed` keeps a restored
   * scroll position from fetching; `$loading` keeps one request in flight at a time (the store
   * checks it again, so a scroll that crosses the sentinel twice in a turn still costs one);
   * `$error` stops a failed page being asked for over and over, which is how a rate-limited client
   * stays rate-limited, and leaves the error card's Retry as the way back; `$atAutoCap` is where
   * appending stops and the button takes over.
   */
  $effect(() => {
    if (!armed || !atBottom || $loading || $error || !$hasMore || $atAutoCap) return
    void fillToTheEnd()
  })

  /**
   * One page, then ask the observer where the sentinel is now.
   *
   * The decision is consumed rather than left standing. Left standing it would fire again the
   * instant `$loading` went back to false, which is before the observer has had a chance to say
   * the sentinel moved, and a scroll to the end of a 95,262 chart catalog would then run pages
   * off as fast as the network answered.
   *
   * That alone stops too early. An observer only speaks when the sentinel crosses the edge of its
   * root, and a page that lands with the end of the list still on screen crosses nothing, so the
   * consumed decision would never be retaken and the list would sit one page long with its end in
   * view. Observing a target again delivers its current state, which is what re-observing here is
   * for: it keeps filling until the sentinel is genuinely past the margin, which is also the point
   * at which there is something to scroll. Every guard above still applies to each page, and the
   * cap still stops it at 500.
   */
  async function fillToTheEnd(): Promise<void> {
    atBottom = false
    await search.loadMore()
    // After the rows are in the DOM: the observer answers from layout, and the page that just
    // landed is what moves the sentinel.
    await tick()
    const el = sentinelEl
    if (!el || !observer) return
    observer.unobserve(el)
    observer.observe(el)
  }

  // chartIds whose name+artist+charter match a local catalog row. A metadata
  // match means "this song by this charter is in your library", not
  // necessarily this exact chart version.
  const inLibraryIds = new SvelteSet<number>()
  let metaGeneration = 0

  $effect(() => {
    const snapshot = $results
    const gen = ++metaGeneration
    if (!snapshot.length) {
      inLibraryIds.clear()
      return
    }
    const keys = snapshot.map((c) => ({ name: c.name, artist: c.artist, charter: c.charter }))
    // The IPC boundary caps batches at 250 keys; loadMore can grow results past
    // that, so chunk and reassemble in order.
    const chunks: Promise<boolean[]>[] = []
    for (let i = 0; i < keys.length; i += 250) {
      chunks.push(encore().existsByMeta(keys.slice(i, i + 250)))
    }
    Promise.all(chunks)
      .then((parts) => parts.flat())
      .then((flags) => {
        // Results changed while the call was in flight: discard the stale response.
        if (gen !== metaGeneration) return
        inLibraryIds.clear()
        flags.forEach((hit, i) => {
          if (hit) inLibraryIds.add(snapshot[i].chartId)
        })
      })
      .catch(() => {
        // Non-fatal: badges are a best-effort enhancement.
      })
  })

  // The global top-bar search drives the query: this runs once on mount (empty
  // query = wildcard browse-all) and again whenever the global query changes.
  // setQuery ignores a query it already answered, which is what makes the
  // on-mount run a no-op, including for the expansion and scroll state the
  // store discards only when a new result set actually replaces the rows.
  $effect(() => {
    search.setQuery($globalQuery)
  })

  function onQueryInput(value: string): void {
    // Sync the local input back to the global store; the $effect above applies
    // it to the search.
    globalQuery.set(value)
  }

  function onFilterChange(kind: 'instrument' | 'difficulty', value: string): void {
    const next = value || null
    if (kind === 'instrument') instrument = next
    else difficulty = next
    search.setFilters(instrument, difficulty)
  }

  export function focusSearch(): void {
    // The box is disabled while advanced filters are on, and a disabled input cannot take focus,
    // so this would otherwise do nothing at all. The panel is where a title goes in that state.
    if (inputEl?.disabled) advToggleEl?.focus()
    else inputEl?.focus()
  }

  function openChart(chart: ChartData): void {
    onOpenChart({ kind: 'remote', chart })
  }

  // Album art that 404'd or failed to decode, keyed by md5 the way Home's
  // Latest Charts row keys its own set, so the card falls back to the
  // surface-2 placeholder instead of a broken icon and the dead URL is not
  // requested again.
  //
  // The set is per-visit: Explore is unmounted by every navigation, so a URL
  // that failed is tried once more on the way back. M7 recorded the same about
  // the list views' failure sets: self-healing beats a stale cache of
  // failures, and the cost is one request per remount.
  const artFailed = new SvelteSet<string>()

  function artFor(chart: ChartData): string | null {
    if (!chart.albumArtMd5 || artFailed.has(chart.albumArtMd5)) return null
    return albumArtUrl(chart.albumArtMd5)
  }

  // A row (and a grid card) is a plain container, not a button, so it can hold
  // controls of its own, since a button may not contain one. Enter and Space come
  // from the real <button> around the title inside it; this handler only widens
  // the mouse target back out to the whole row or card, which is what it was
  // when the row itself was the button.
  //
  // Widening it that far means clicks a control inside has already answered
  // arrive here too, so this is the single place that stands aside for them.
  // Without it the title button would open a chart twice, and the version
  // toggle would expand a group and then navigate away from it.
  function onRowClick(chart: ChartData, e: MouseEvent): void {
    if (e.target instanceof Element && e.target.closest('button, input, a, select')) return
    openChart(chart)
  }

  // Every alternate version of a song repeats its title and artist, so a name
  // that stopped at the title would announce them identically. The charter is
  // what distinguishes them.
  function openLabel(chart: ChartData): string {
    const attribution = [
      chart.artist ? `by ${chart.artist}` : '',
      chart.charter ? `charted by ${chart.charter}` : ''
    ]
      .filter(Boolean)
      .join(', ')
    return attribution ? `${chart.name} ${attribution}` : chart.name
  }

  // The selected rows, and the subset of them a bulk download would actually
  // fetch. Every selected chartId is in `$results` by construction: the
  // selection is cleared exactly when a run replaces the rows.
  //
  // Nothing here filters out charts already in the download queue. The manager
  // ignores an md5 it is already holding (queued, running, done or errored),
  // so re-adding one is a no-op, and a second copy of that rule in the renderer
  // would be a second place for it to be wrong. What the queue cannot know is
  // what an earlier session downloaded, which is exactly what `inLibraryIds`
  // answers, so that is the one thing left out here.
  const picked = $derived($results.filter((c) => $selected.has(c.chartId)))
  const toQueue = $derived(picked.filter((c) => !inLibraryIds.has(c.chartId)))
  const alreadyOwned = $derived(picked.length - toQueue.length)

  let bulkError = $state<string | null>(null)
  let queueing = $state(false)

  // The message is about the batch that was on screen when Download was
  // pressed, so changing the batch retires it rather than leaving a sentence
  // that describes a selection the user has since edited.
  $effect(() => {
    void $selected
    bulkError = null
  })

  async function downloadSelected(): Promise<void> {
    if (queueing || toQueue.length === 0) return
    bulkError = null
    // `downloadAdd` resolves whether or not a library folder is configured: the
    // rejection lives in the download runner, which runs once per queued chart.
    // Enqueuing regardless would therefore put N identical failures in the
    // queue instead of answering the question once, here, having queued
    // nothing. Explore is reachable in this state: the first-run welcome's
    // "Explore charts instead" leads straight to it.
    if ($settings.libraryFolders.length === 0) {
      bulkError =
        'No library folder yet, so there is nowhere to put these charts. Add one in Settings.'
      return
    }
    queueing = true
    const batch = toQueue
    const outcomes = await Promise.allSettled(
      batch.map((c) =>
        encore().downloadAdd({
          md5: c.md5,
          hasVideoBackground: c.hasVideoBackground,
          meta: { name: c.name, artist: c.artist, charter: c.charter }
        })
      )
    )
    queueing = false
    const failed = outcomes.filter((o) => o.status === 'rejected').length
    if (failed > 0) {
      // One sentence for the batch, not one per chart. The selection stays so a
      // retry does not mean picking everything again; the queue's md5 dedupe
      // makes re-adding the ones that did get through harmless.
      bulkError = `Encore could not queue ${failed} of ${batch.length} charts. Try Download again.`
      return
    }
    // Handed over: the download panel is where this batch lives now, and ticks
    // left standing invite a second click the queue would silently swallow.
    search.clearSelected()
  }

  // Gated on `searched` rather than on the rows alone: the store debounces for 300ms before it
  // requests anything, and during that window an unasked question looks exactly like one that
  // came back empty. `error` has its own card above the table and speaks for itself.
  const showEmpty = $derived($searched && !$loading && !$error && $results.length === 0)
  const activeQuery = $derived($globalQuery.trim())
</script>

<div class="browse">
  <div class="main">
    <div class="searchbar">
      <input
        bind:this={inputEl}
        value={$globalQuery}
        placeholder="Search charts…"
        aria-label="Search charts"
        disabled={$advancedCount > 0}
        aria-describedby={$advancedCount > 0 ? 'adv-takeover' : undefined}
        oninput={(e) => onQueryInput(e.currentTarget.value)}
      />
      <span class="count">
        {#if $loading}SEARCHING…{:else if $found}{$found.toLocaleString()} RESULTS{/if}
      </span>
    </div>
    <!-- Said rather than left to be worked out. Chorus Encore's advanced endpoint takes no search
         term (measured: a term sent with it answers with the whole catalog), so a box that still
         accepted typing would look broken instead of being off. -->
    {#if $advancedCount > 0}
      <p class="takeover" id="adv-takeover">
        Advanced filters are on, and Chorus Encore does not take a search term alongside them. Put a
        title in the panel's Name field, or clear the filters.
      </p>
    {/if}
    <div class="filters">
      <select
        class="chip"
        aria-label="Filter by instrument"
        value={instrument ?? ''}
        onchange={(e) => onFilterChange('instrument', e.currentTarget.value)}
      >
        {#each INSTRUMENTS as opt (opt.label)}
          <option value={opt.value ?? ''}>{opt.label}</option>
        {/each}
      </select>
      <select
        class="chip"
        aria-label="Filter by difficulty"
        value={difficulty ?? ''}
        onchange={(e) => onFilterChange('difficulty', e.currentTarget.value)}
      >
        {#each DIFFICULTIES as opt (opt.label)}
          <option value={opt.value ?? ''}>{opt.label}</option>
        {/each}
      </select>
      <!-- The count is on the button, not only inside the panel, because the panel is shut most
           of the time and a list narrowed by filters nobody can see is a list that looks wrong.
           Clear sits beside it for the same reason: the way out has to be where the evidence is. -->
      <button
        bind:this={advToggleEl}
        class="adv"
        class:on={$advancedCount > 0}
        aria-expanded={$advancedOpen}
        aria-controls="advanced-panel"
        aria-label={$advancedCount > 0
          ? `Advanced search, ${$advancedCount} ${$advancedCount === 1 ? 'filter' : 'filters'} applied`
          : 'Advanced search'}
        onclick={() => search.setAdvancedOpen(!$advancedOpen)}
      >
        Advanced{#if $advancedCount > 0}<span class="adv-count">{$advancedCount}</span>{/if}
      </button>
      {#if $advancedCount > 0}
        <button class="adv-clear" onclick={() => search.clearAdvanced()}>Clear filters</button>
      {/if}
      <!-- Two buttons rather than one that toggles: the label of a toggle names
           the state you are leaving or the one you are going to, and which of
           those it means is a coin flip. Here each button names a layout and
           says whether it is the one you are in. -->
      <div class="modes" role="group" aria-label="Result layout">
        <button class="mode" aria-pressed={$mode === 'list'} onclick={() => search.setMode('list')}
          >List</button
        >
        <button class="mode" aria-pressed={$mode === 'grid'} onclick={() => search.setMode('grid')}
          >Grid</button
        >
      </div>
    </div>
    {#if $advancedOpen}
      <AdvancedSearch {search} />
    {/if}
    <!-- Only while there is a selection: an empty selection is the state this
         list is in nearly all the time, and a bar that is always there would
         charge every visit for an occasional action. -->
    {#if $selected.size > 0}
      <div class="selbar">
        <span class="sel-count">{$selected.size} selected</span>
        {#if alreadyOwned > 0}
          <!-- Named rather than quietly dropped: a batch that downloads fewer
               charts than were ticked has to say so, and re-fetching a chart
               the user already owns is the alternative nobody asked for. -->
          <span class="sel-note"
            >{alreadyOwned} already in your library, so left out of the download</span
          >
        {/if}
        <div class="sel-actions">
          <button
            class="sel-btn primary"
            disabled={toQueue.length === 0 || queueing}
            onclick={() => void downloadSelected()}
          >
            {toQueue.length > 0 ? `Download ${toQueue.length}` : 'Nothing to download'}
          </button>
          <button
            class="sel-btn"
            aria-label="Clear selection"
            onclick={() => search.clearSelected()}>Clear</button
          >
        </div>
        {#if bulkError}
          <span class="sel-error">{bulkError}</span>
        {/if}
      </div>
    {/if}
    {#if $error}
      <!-- role="alert": a failed search replaces the list with this card and nothing else moves,
           so a screen reader that is not told is left with a list that quietly stopped. -->
      <div class="error" role="alert">
        {$error} <button onclick={() => search.retry()}>Retry</button>
      </div>
    {/if}
    <!-- One definition for the row's checkbox and the card's: the two differ
         only in where they sit, and a second copy is how the accessible name on
         one drifts from the other. -->
    {#snippet pick(c: ChartData)}
      <input
        class="pick"
        type="checkbox"
        aria-label="Select {openLabel(c)}"
        checked={$selected.has(c.chartId)}
        onchange={() => search.toggleSelected(c.chartId)}
      />
    {/snippet}
    <!-- Primary and alternate cards differ only in the version chip and the
         badge, so they share one snippet: two near-identical blocks is how the
         accessible name on one of them drifts from the other. -->
    {#snippet card(c: ChartData, alternates: number, isExpanded: boolean, isAlt: boolean)}
      {@const art = artFor(c)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions
           (As on .row: this widens the mouse target to the whole card, and the
           keyboard path is the .open button inside it.) -->
      <div class="card" class:alt={isAlt} onclick={(e) => onRowClick(c, e)}>
        {@render pick(c)}
        {#if art}
          <img
            class="art"
            src={art}
            alt=""
            loading="lazy"
            onerror={() => c.albumArtMd5 && artFailed.add(c.albumArtMd5)}
          />
        {:else}
          <div class="art placeholder"></div>
        {/if}
        <span class="c-title">
          <button class="open" aria-label={openLabel(c)} onclick={() => openChart(c)}
            >{c.name}</button
          >
          {#if alternates > 0 && c.songId !== null}
            <button
              class="ver-chip"
              onclick={() => search.toggleExpanded(c.songId as number)}
              aria-expanded={isExpanded}
              aria-label="{alternates + 1} versions">+{alternates}</button
            >
          {/if}
          {#if isAlt}
            <span class="alt-badge">OTHER VERSION</span>
          {/if}
        </span>
        <span class="c-artist">{c.artist}</span>
        <span class="c-charter">
          {c.charter}
          {#if inLibraryIds.has(c.chartId)}
            <span class="lib-badge">IN LIBRARY</span>
          {/if}
        </span>
      </div>
    {/snippet}
    <!-- No `onscroll` here: the listener is attached to the element that actually scrolls, which
         is this one today and is looked up rather than assumed. See `scrollBox`. -->
    <div class="table selectable" bind:this={tableEl}>
      {#if $mode === 'grid'}
        <div class="grid">
          {#each $groups as group (group.primary.songId !== null ? group.primary.songId : `c:${group.primary.chartId}`)}
            {@const chart = group.primary}
            {@const isExpanded = chart.songId !== null && $expanded.has(chart.songId)}
            {@render card(chart, group.others.length, isExpanded, false)}
            {#if isExpanded}
              <!-- A card cannot expand in place the way a row does, so the
                   alternates become cards of their own, straight after the one
                   they belong to and marked as versions of it. They are the same
                   `expanded` set the list uses, so a group opened in one layout
                   is open in the other. -->
              {#each group.others as alt (alt.chartId)}
                {@render card(alt, 0, false, true)}
              {/each}
            {/if}
          {/each}
        </div>
      {:else}
        {#each $groups as group, i (group.primary.songId !== null ? group.primary.songId : `c:${group.primary.chartId}`)}
          {@const chart = group.primary}
          {@const hasVersions = group.others.length > 0}
          {@const isExpanded = chart.songId !== null && $expanded.has(chart.songId)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions
             (This handler only widens the mouse target; the keyboard path is the .open
             button inside, and giving the container a widget role would put that button
             inside a widget again, which is what this task exists to undo.) -->
          <div class="row" onclick={(e) => onRowClick(chart, e)}>
            {@render pick(chart)}
            <span class="num">{String(i + 1).padStart(2, '0')}</span>
            <span class="song">
              <span class="title">
                <button class="open" aria-label={openLabel(chart)} onclick={() => openChart(chart)}
                  >{chart.name}</button
                >
                {#if hasVersions && chart.songId !== null}
                  <button
                    class="ver-chip"
                    onclick={() => search.toggleExpanded(chart.songId as number)}
                    aria-expanded={isExpanded}
                    aria-label="{group.others.length + 1} versions">+{group.others.length}</button
                  >
                {/if}
              </span>
              <span class="artist">{chart.artist}{chart.album ? ` · ${chart.album}` : ''}</span>
            </span>
            <span class="charter">
              {chart.charter}
              {#if inLibraryIds.has(chart.chartId)}
                <span class="lib-badge">IN LIBRARY</span>
              {/if}
            </span>
            <span class="diffs">
              {#if chart.diff_guitar != null}<span class="diff"
                  >G{diffDisplay(chart.diff_guitar)}</span
                >{/if}
              {#if chart.diff_bass != null}<span class="diff">B{diffDisplay(chart.diff_bass)}</span
                >{/if}
              {#if chart.diff_drums != null}<span class="diff"
                  >D{diffDisplay(chart.diff_drums)}</span
                >{/if}
            </span>
            <span class="len">{msToTime(chart.song_length)}</span>
          </div>
          {#if isExpanded}
            {#each group.others as alt (alt.chartId)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions
                 (Same as the primary row above.) -->
              <div class="row sub-row" onclick={(e) => onRowClick(alt, e)}>
                {@render pick(alt)}
                <span class="num"></span>
                <span class="song song-indented">
                  <span class="title text-2"
                    ><button class="open" aria-label={openLabel(alt)} onclick={() => openChart(alt)}
                      >{alt.name}</button
                    ></span
                  >
                  <span class="artist">{alt.charter}</span>
                </span>
                <span class="charter">
                  {alt.charter}
                  {#if inLibraryIds.has(alt.chartId)}
                    <span class="lib-badge">IN LIBRARY</span>
                  {/if}
                </span>
                <span class="diffs">
                  {#if alt.diff_guitar != null}<span class="diff"
                      >G{diffDisplay(alt.diff_guitar)}</span
                    >{/if}
                  {#if alt.diff_bass != null}<span class="diff">B{diffDisplay(alt.diff_bass)}</span
                    >{/if}
                  {#if alt.diff_drums != null}<span class="diff"
                      >D{diffDisplay(alt.diff_drums)}</span
                    >{/if}
                </span>
                <span class="len">{msToTime(alt.song_length)}</span>
              </div>
            {/each}
          {/if}
        {/each}
      {/if}
      <!-- One control, two jobs. Reaching it loads the next page on its own until the cap, and
           pressing it loads one past the cap, so a keyboard or screen-reader user who never makes
           a scroll gesture reaches the same rows by tabbing to it and pressing Enter.

           Deliberately not disabled while a page is in flight: disabling the control that has
           focus throws focus back to the document, which loses a keyboard user their place in the
           list every time a page lands. The store ignores a call made while one is already
           running, so a press during a load costs nothing. -->
      {#if !$error && $hasMore}
        <div class="more-row">
          <button bind:this={sentinelEl} class="more" onclick={() => void search.loadMore()}>
            {#if $loading}Loading more…{:else if $atAutoCap}Keep loading{:else}Load more{/if}
          </button>
          {#if $atAutoCap && !$loading}
            <p class="more-note">
              {$results.length.toLocaleString()} of {$found.toLocaleString()} loaded. Explore stops adding
              them on its own here, because everything loaded stays on screen and a list this long is
              what slows down next, not the search.
            </p>
          {/if}
        </div>
      {/if}
      <!-- The rows appear below the fold, so nothing about an appended page is announced without
           this. Rendered from the first paint rather than when the first page lands: a live region
           added to the page at the same moment as its text is not reliably read out. -->
      <p class="sr-only" role="status">
        {#if $loading}
          Loading more charts
        {:else if $results.length}
          {$results.length.toLocaleString()} of {$found.toLocaleString()} charts loaded
        {/if}
      </p>
      {#if showEmpty}
        <p class="empty">
          {#if activeQuery && (instrument || difficulty)}
            Nothing matches "{activeQuery}" with those filters on. Try clearing the instrument or
            difficulty first.
          {:else if activeQuery}
            Nothing on Chorus Encore matches "{activeQuery}". Try the artist on its own, or fewer
            words.
          {:else if instrument || difficulty}
            No charts match those filters. Set both back to Any to see everything.
          {:else}
            <!-- No query and no filters is the wildcard listing of the whole remote catalog, so an
                 empty answer is the service's, not the user's. Retry is the only useful action. -->
            Chorus Encore returned no charts at all. It may be having trouble.
            <button class="retry" onclick={() => search.retry()}>Retry</button>
          {/if}
        </p>
      {/if}
    </div>
  </div>
</div>

<style>
  .browse {
    display: flex;
    height: 100%;
  }
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .searchbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 10px;
  }
  input {
    flex: 0 1 380px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    padding: 7px 11px;
    color: var(--text-1);
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    transition: border-color var(--t-fast) var(--ease);
  }
  input:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  .filters {
    display: flex;
    gap: 8px;
    padding: 0 16px 10px;
  }
  .chip {
    appearance: none;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 24px 4px 11px;
    cursor: pointer;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10' fill='none'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' stroke='%238a8a99' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
  }
  .chip:hover,
  .chip:focus {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Sits at the far end of the filter row: it is a control about the results,
     not another thing to narrow them by. */
  .modes {
    display: flex;
    margin-left: auto;
    gap: 4px;
  }
  .mode {
    appearance: none;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 12px;
    cursor: pointer;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .mode:hover,
  .mode:focus {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* The pressed one is the only lit thing in the row, which is what makes the
     pair readable as "you are here" rather than as two buttons. */
  .mode[aria-pressed='true'] {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text-1);
  }
  .count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  /* Error is a quiet card, not accent-coloured text: the accent budget is spent
     on primary actions and active states, not on status copy. */
  .error {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 16px 10px;
    padding: 9px 12px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .error button {
    margin-left: auto;
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .error button:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Matches Installed's and Asset Studio's empty line, so the three read as one idea. */
  .empty {
    padding: 24px 16px;
    color: var(--text-3);
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    max-width: 60ch;
  }
  .retry {
    margin-left: 8px;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 3px 10px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .retry:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .table {
    flex: 1;
    overflow-y: auto;
    border-top: 1px solid var(--hairline);
  }
  .row {
    display: grid;
    /* Leading 16px track is the select checkbox, sized to match `.pick`; charter
       column is 160px, not 130, because the IN LIBRARY badge sits next to the
       charter name and grew with the small-text floor. */
    grid-template-columns: 16px 26px 1fr 160px 120px 64px;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 7px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
    cursor: pointer;
    position: relative;
    /* On the row, not on `:hover`: declared only under the hover rule, the fade played on the
       way in and snapped on the way out. */
    transition: background var(--t-fast) var(--ease);
  }
  .row:hover {
    background: var(--surface-1);
  }
  .sub-row {
    background: rgba(255, 255, 255, 0.015);
  }
  /* auto-fill rather than a declared track count: the window is resizable, so a
     fixed number of columns would either strand a gutter or overflow. None of
     this has been seen: jsdom computes no layout, so the tests say nothing
     about how it lands. */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 12px;
    padding: 14px 16px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 6px;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background var(--t-fast) var(--ease);
    /* Anchors the checkbox, which is taken out of flow below. */
    position: relative;
  }
  /* Always visible rather than revealed on hover: a card is 148px of album art
     and there is nowhere in its flow to put a checkbox without pushing the
     title down, so it sits over the art's corner. Revealing it on hover would
     hide it from the keyboard and from anyone who does not think to hover, and
     none of this layout has been seen; see the note on .grid. */
  .card .pick {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: var(--z-raised);
  }
  /* 16px, not the UA's 13: the tick has to be readable over album art, and 13px was the
     smallest target in the app. */
  .pick {
    margin: 0;
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  /* Sits above the results, not in the filter row: it is about the rows the
     user has picked, not about which rows are shown. */
  .selbar {
    display: flex;
    align-items: center;
    /* Wraps so the error, which is a sentence rather than a chip, drops to its
       own line instead of squeezing the buttons off the end. */
    flex-wrap: wrap;
    gap: 10px;
    margin: 0 16px 10px;
    padding: 7px 12px;
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
  }
  .sel-count {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-1);
  }
  .sel-note {
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  /* Full width, so it always lands under the row it explains. */
  .sel-error {
    flex-basis: 100%;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .sel-actions {
    display: flex;
    margin-left: auto;
    gap: 8px;
  }
  .sel-btn {
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .sel-btn:hover:not(:disabled) {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .sel-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* The one action the bar exists for; Clear stays a ghost beside it. Same
     gradient and weight as Detail's Download, because it is the same action. */
  .sel-btn.primary {
    border: 0;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
  }
  .sel-btn.primary:hover:not(:disabled) {
    color: #fff;
    filter: brightness(1.12);
  }
  .card:hover {
    background: var(--surface-1);
  }
  /* The tint .sub-row gives an alternate row, so both layouts mark the same
     thing the same way. */
  .card.alt {
    background: rgba(255, 255, 255, 0.015);
  }
  /* The background fills the box both for `.placeholder` (no art, or art that
     failed) and for a lazy image that has not decoded yet, so a card never
     flashes a transparent square as the grid scrolls. */
  .art {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 7px;
    object-fit: cover;
    display: block;
    margin-bottom: 6px;
    background: var(--surface-2);
  }
  .c-title {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
  }
  .c-artist {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-charter {
    font-size: var(--fs-caption);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Same quiet mono family as .lib-badge and .ver-chip: it labels the card, it
     is not something to click. */
  .alt-badge {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 1px 4px;
    line-height: var(--lh-snug);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .num {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .song {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .song-indented {
    padding-left: 14px;
  }
  .title {
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  /* The title is the row's own button, and the row around it is a plain container,
     because a button cannot hold the version toggle beside it. Reset to look like
     the text it replaced, and keep the ellipsis rules that were on that text: they
     are what makes a long title truncate instead of pushing the version chip out
     of the flex row. */
  .open {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 0 1 auto;
  }
  /* Sub-row title is slightly quieter */
  .title.text-2 {
    font-size: var(--fs-secondary);
    font-weight: 400;
    color: var(--text-2);
  }
  .artist {
    font-size: var(--fs-secondary);
    line-height: var(--lh-tight);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .charter {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Version chip: mono, quiet (text-3 + hairline), same family as lib-badge.
     A real <button> since the row stopped being one; appearance:none so the
     platform does not draw its own control underneath, as on .chip above, and
     font-weight:inherit because the UA's `font: 400 …` shorthand would otherwise
     lighten it off the 500 it inherited from .title as a <span>. */
  .ver-chip {
    appearance: none;
    display: inline-flex;
    font-weight: inherit;
    align-items: center;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 1px 4px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    cursor: pointer;
    line-height: var(--lh-snug);
    vertical-align: middle;
    flex-shrink: 0;
  }
  .ver-chip:hover {
    border-color: rgba(255, 255, 255, 0.2);
    color: var(--text-2);
  }
  /* Deliberately quiet (text-3 + hairline, no accent): informational, not a call to action. */
  .lib-badge {
    display: inline-block;
    margin-left: 5px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 1px 4px;
    vertical-align: middle;
    line-height: var(--lh-snug);
  }
  .diffs {
    display: flex;
    gap: 4px;
  }
  .diff {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-2);
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 2px 5px;
  }
  .len {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
    text-align: right;
  }
  .more-row {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 16px 20px;
  }
  .more {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    color: var(--text-2);
    padding: 7px 18px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .more:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .more-note {
    margin: 0;
    max-width: 52ch;
    text-align: center;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  /* Advanced sits with the filter chips because it is one, and lights the same way the mode
     buttons and Installed's toggles do when it is on. */
  .adv,
  .adv-clear {
    appearance: none;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 12px;
    cursor: pointer;
    white-space: nowrap;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .adv:hover,
  .adv:focus,
  .adv-clear:hover,
  .adv-clear:focus {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .adv.on {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text-1);
  }
  /* A number, not a dot: "filters are on" is useful, "three filters are on" is what tells someone
     whether they have found all of them again. */
  .adv-count {
    display: inline-block;
    margin-left: 6px;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: 16px;
    text-align: center;
  }
  /* Full width under the search box, so it lands against the control it is about. */
  .takeover {
    margin: 0 16px 8px;
    max-width: 68ch;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  input:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Off screen rather than `display: none`, which takes an element out of the accessibility tree
     along with the layout and would silence the live region entirely. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
