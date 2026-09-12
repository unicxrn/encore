<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from 'svelte/store'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import type {
    CatalogFacets,
    CatalogSortField,
    ChartRecord,
    SortDirection
  } from '../../../../shared/schemas'
  import type {
    ChartLifetime,
    ChartPlaySummary,
    LifetimeScoreStatus,
    PlayDataStatus
  } from '../../../../shared/play'
  import { artUrl } from '../../../../shared/art'
  import {
    msToTime,
    instrumentDiff,
    fallbackChartName,
    playedOn,
    stripRichText
  } from '../../../../shared/format'
  import { cancelScan, scanProgress, startScan } from '../stores/scan'
  import { encore } from '../stores/bridge'
  import { settings } from '../stores/settings'
  import { refreshVerdicts, verdicts } from '../stores/updates'
  import {
    activeFilterCount,
    clearedFilters,
    libraryFilter,
    toCatalogFilter,
    type LibraryFilterState
  } from '../stores/library-filter'
  import { libraryGap } from '../empty-state'
  import type { ChartTarget } from './Home.svelte'

  // Rows open the full Detail page (local variant), same as Explore rows do for
  // remote charts; the old inline preview strip is retired.
  let { onOpenChart }: { onOpenChart: (target: ChartTarget) => void } = $props()

  let charts = $state<ChartRecord[]>([])
  let total = $state(0)
  /**
   * Charts in the catalog with the filter box ignored. `total` alone cannot tell "you own
   * nothing" from "you own 207 and typed a word none of them contain", and the empty state used
   * to answer both by telling the user to go add a library folder.
   *
   * Fetched separately from `load()` rather than as a third promise inside it: this number only
   * moves when the catalog does, so it costs one query on mount and one per finished scan
   * instead of one per keystroke.
   */
  let libraryTotal = $state(0)
  let timer: ReturnType<typeof setTimeout> | null = null

  const PAGE = 100

  /**
   * The values the pickers offer, read from the catalog on mount and after every scan.
   *
   * Empty until the first answer arrives, and empty for good if the call fails: the pickers then
   * offer only their "any" option, which leaves the view exactly as capable as it was before
   * this bar existed. Best effort, like the version badges, because a filter bar that cannot be
   * populated must not take the list down with it.
   */
  let facets = $state<CatalogFacets>({ artists: [], genres: [], charters: [], years: [] })

  /**
   * The sorts on offer, each with the words for its two directions.
   *
   * The direction pair is named per field rather than as one "ascending / descending" toggle:
   * "ascending" on a length column is a claim the user has to decode, and "shortest first" is
   * not. Explore's layout toggle makes the same argument for two labelled buttons over one
   * button whose label names either the state you are in or the one you are going to.
   */
  const SORTS: {
    value: CatalogSortField
    label: string
    asc: string
    desc: string
  }[] = [
    { value: 'title', label: 'Title', asc: 'A to Z', desc: 'Z to A' },
    { value: 'artist', label: 'Artist', asc: 'A to Z', desc: 'Z to A' },
    { value: 'album', label: 'Album', asc: 'A to Z', desc: 'Z to A' },
    { value: 'charter', label: 'Charter', asc: 'A to Z', desc: 'Z to A' },
    { value: 'year', label: 'Year', asc: 'Oldest first', desc: 'Newest first' },
    { value: 'length', label: 'Length', asc: 'Shortest first', desc: 'Longest first' }
  ]

  /**
   * A picker's options, with whatever it is currently set to guaranteed to be among them.
   *
   * Two moments need this. On a remount the restored value is set before the facets have been
   * fetched, and a select whose value matches no option falls back to showing its first one, so
   * the bar would read "any artist" while filtering by Rush. And a rescan can retire a value the
   * filter is still set to, which would do the same thing permanently. Keeping the value visible
   * means the control always says what the list is actually narrowed by.
   */
  function withCurrent(values: string[], current: string): string[] {
    return current && !values.includes(current) ? [current, ...values] : values
  }

  function withCurrentYear(values: number[], current: string): string[] {
    return withCurrent(
      values.map((year) => String(year)),
      current
    )
  }

  const currentSort = $derived(SORTS.find((s) => s.value === $libraryFilter.sort) ?? null)
  const activeFilters = $derived(activeFilterCount($libraryFilter))

  // The art protocol answers 404 when a row's md5 has no cached file (cache cleared, or a
  // sweep raced the catalog row) and 400 when the md5 is malformed; both arrive here as a
  // failed load. Remembering the md5s that failed lets the row fall back to the placeholder
  // instead of the browser's broken-image glyph. Since an error response carries no
  // Cache-Control, it also keeps a rebuilt list (a reload, a new filter) from re-requesting a
  // URL already known to be dead. The set is per-visit: App destroys this view on navigation,
  // so coming back retries everything.
  const artFailed = new SvelteSet<string>()

  /**
   * Play summaries for the rows on screen, keyed by Clone Hero checksum.
   *
   * Fetched one request per PAGE, never one per row: `playSummaries` takes a batch precisely so
   * a hundred badges cost a hundred rows' worth of one round trip, and the cap it enforces
   * (PLAY_SUMMARY_MAX, 500) is above this view's page size for the same reason.
   *
   * A checksum with no play is OMITTED from the answer rather than returned as zeroes, so an
   * absent entry here means Encore has watched no play of that chart. It also means "not fetched
   * yet" for the moment between a page landing and its summaries arriving, which is the same
   * thing on screen: nothing. It does NOT mean the row grows no badge, since Clone Hero's own
   * table is consulted as well; see badgeFor.
   *
   * A SvelteMap rather than a reassigned plain one, so "Load more" adds this page's entries
   * without rebuilding the map the rows already on screen are reading from.
   */
  const plays = new SvelteMap<string, ChartPlaySummary>()

  /**
   * What Clone Hero's OWN table says about the rows on screen, keyed the same way.
   *
   * The second of the two records behind a row's badge, fetched the same way and for the same
   * reason: one request per page, capped at the same 500. This one reaches back before Encore
   * was installed, which is why a row can now carry a count for a chart Encore never watched
   * being played.
   */
  const lifetimes = new SvelteMap<string, ChartLifetime>()

  /**
   * Whether the score files were readable, held once for the visit.
   *
   * Its own status rather than `playStatus`, because it is its own source: a machine can have a
   * full score table and an empty Encore log, or the other way round. Null until the first page
   * answers, or for good if the channel is not there.
   */
  let lifetimeStatus = $state<LifetimeScoreStatus | null>(null)

  /**
   * What `playStatus` said, asked once per mount and shared by every page.
   *
   * The gate the preload comment asks for. Null means the question has not been answered yet or
   * could not be; either way nothing is drawn, which is also what a machine with no Clone Hero
   * gets. Held as a promise so the pages that load concurrently on mount queue behind one
   * request instead of firing one each.
   */
  let playStatus = $state<PlayDataStatus | null>(null)
  let playStatusRequest: Promise<PlayDataStatus | null> | null = null

  function requestPlayStatus(): Promise<PlayDataStatus | null> {
    playStatusRequest ??= (async () => {
      try {
        const status = await encore().playStatus()
        playStatus = status
        return status
      } catch {
        // Best effort, like the facets and the version badges: this column is an addition to a
        // list that is complete without it, and nothing here may take the list down.
        return null
      }
    })()
    return playStatusRequest
  }

  /**
   * Summaries for one page of rows.
   *
   * `append` decides whether this extends the map or replaces it, matching what `load()` just
   * did to `charts`: a fresh page one is a new list, and keeping the previous filter's entries
   * would grow the map for the life of the visit with rows nothing can show.
   *
   * Charts with no `cloneHeroChecksum` are dropped before the request. Nothing can ever join a
   * play to them, and sending them would only spend the request's cap.
   */
  async function loadPlays(rows: ChartRecord[], append: boolean): Promise<void> {
    const status = await requestPlayStatus()
    if (!status?.available) return
    const checksums = [
      ...new Set(rows.map((row) => row.cloneHeroChecksum).filter((sum) => sum !== null))
    ]
    if (checksums.length === 0) {
      if (!append) plays.clear()
      return
    }
    try {
      const summaries = await encore().playSummaries(checksums)
      // Cleared after the answer arrives, not before it is asked for: clearing up front would
      // blank the badges already on screen for as long as the round trip takes.
      if (!append) plays.clear()
      for (const summary of summaries) plays.set(summary.checksum, summary)
    } catch {
      // See requestPlayStatus.
    }
  }

  /**
   * Clone Hero's own rows for one page, fetched beside the summaries above.
   *
   * Not behind `playStatus`: the score files are a separate record with a separate status, and
   * gating them on Encore's log would hide a year of play counts from exactly the user who has
   * just installed Encore and has no log at all. Skipped on later pages once the first answer
   * has said there is nothing to read.
   */
  async function loadLifetime(rows: ChartRecord[], append: boolean): Promise<void> {
    if (lifetimeStatus && !lifetimeStatus.available) return
    const checksums = [
      ...new Set(rows.map((row) => row.cloneHeroChecksum).filter((sum) => sum !== null))
    ]
    try {
      // Asked even for a page where no row carries a checksum: the answer's `status` is what the
      // "No plays recorded" caveat below the filter bar adapts to, and that sentence has to be
      // right whether or not this particular page had anything to look up.
      const answer = await encore().playLifetime(checksums)
      lifetimeStatus = answer.status
      if (!append) lifetimes.clear()
      for (const row of answer.charts) lifetimes.set(row.checksum, row)
    } catch {
      // Best effort, exactly like the summaries: an addition to a list that is complete without
      // it. A bridge with no lifetime channel lands here and the rows fall back to the log.
    }
  }

  function playFor(chart: ChartRecord): ChartPlaySummary | null {
    return chart.cloneHeroChecksum ? (plays.get(chart.cloneHeroChecksum) ?? null) : null
  }

  function lifetimeFor(chart: ChartRecord): ChartLifetime | null {
    return chart.cloneHeroChecksum ? (lifetimes.get(chart.cloneHeroChecksum) ?? null) : null
  }

  /** What a row's badge says, and which of the two records it came from. */
  interface PlayBadge {
    /** The count to draw, or null for a record that exists without a number behind it. */
    count: number | null
    lifetime: boolean
    title: string
  }

  /**
   * One badge per row, never two.
   *
   * A row is already carrying a title, a version badge, a charter, five difficulty cells, a year
   * and a length. A second count beside the first would be two numbers a reader has to tell
   * apart at a glance in a list they are scanning, and the obvious reading of two numbers side
   * by side is the one thing this feature must not invite: they are not addends. The lifetime
   * count already contains the observed one.
   *
   * So the badge shows the LIFETIME count whenever Clone Hero has one, because it is the superset
   * and the number the user recognises as theirs, and falls back to Encore's log when it does
   * not. The hover says which record answered and, when both did, how much of the count Encore
   * saw for itself, worded as a share of the total rather than as a figure beside it.
   */
  function badgeFor(chart: ChartRecord): PlayBadge | null {
    const life = lifetimeFor(chart)
    const seen = playFor(chart)
    if (life && life.lifetimePlays > 0) {
      return { count: life.lifetimePlays, lifetime: true, title: lifetimeTitle(life, seen) }
    }
    // A score row with a zero play count: Clone Hero knows the chart and has no number for it.
    // "0 PLAYS" would be a claim, and dropping the badge would throw away the one thing the
    // record does say, so the badge says that and no more.
    if (life?.everPlayed) return { count: null, lifetime: true, title: lifetimeTitle(life, seen) }
    if (seen) return { count: seen.timesPlayed, lifetime: false, title: playTitle(seen) }
    return null
  }

  /** The hover for a badge drawn from Clone Hero's own table. */
  function lifetimeTitle(life: ChartLifetime, seen: ChartPlaySummary | null): string {
    const parts: string[] = [
      life.lifetimePlays > 0
        ? "Clone Hero's own count, over every play you have made of this chart."
        : 'Clone Hero has a record of this chart but no play count for it.'
    ]
    if (life.best !== null) {
      parts.push(`Best score ${life.best.score.toLocaleString()} at ${life.best.percent}%.`)
    }
    // Said whenever there is one, whether or not a confirmed best was found: a chart with both
    // kinds of row is showing the best of the ones Encore can read, and a hover that stayed
    // quiet about that would be presenting a partial best as the whole one.
    if (life.unconfirmedRows > 0) {
      parts.push(
        'Clone Hero also keeps a score for it on a scale Encore cannot read, so no best score is shown for that one. The play count is unaffected.'
      )
    }
    // A share of the count above it, never a second figure beside it.
    if (life.observedPlays > 0) {
      parts.push(`Encore watched ${life.observedPlays.toLocaleString()} of them happen.`)
      if (seen?.lastPlayedAt) parts.push(`The last was ${playedOn(seen.lastPlayedAt)}.`)
    }
    return parts.join(' ')
  }

  /**
   * The badge's hover text: what the count is worth, in one line.
   *
   * `bestAccuracy` belongs to the best-SCORING play rather than the most accurate one (see
   * main/play/store.ts), so the two sit together in one sentence instead of reading as two
   * independent bests.
   */
  function playTitle(play: ChartPlaySummary): string {
    const parts: string[] = []
    if (play.bestScore !== null) {
      const accuracy =
        play.bestAccuracy !== null ? ` at ${(play.bestAccuracy * 100).toFixed(1)}%` : ''
      parts.push(`Best score ${play.bestScore.toLocaleString()}${accuracy}.`)
    }
    if (play.everFc) parts.push('Full combo at least once.')
    if (play.lastPlayedAt) parts.push(`Last played ${playedOn(play.lastPlayedAt)}.`)
    parts.push('Counted only from when Encore started watching Clone Hero.')
    return parts.join(' ')
  }

  /** True once either record has answered with something to draw. */
  const anyPlayRecord = $derived(
    playStatus?.available === true || lifetimeStatus?.available === true
  )

  /**
   * The three difficulty columns of a row, with the ones this chart does not chart removed.
   *
   * Dropping absent instruments here rather than rendering an empty span keeps the `.d + .d`
   * spacing between whichever columns survive. The keys are the scanner's instrument names,
   * which is what `chart.instruments` is compared against.
   */
  function diffCells(chart: ChartRecord): { letter: string; text: string }[] {
    const columns: [letter: string, key: string, diff: number | null][] = [
      ['G', 'guitar', chart.diffGuitar],
      ['B', 'bass', chart.diffBass],
      ['D', 'drums', chart.diffDrums]
    ]
    return columns
      .map(([letter, key, diff]) => ({
        letter,
        text: instrumentDiff(chart.instruments, key, diff)
      }))
      .filter((cell) => cell.text !== '')
  }

  /**
   * The row's second line: artist, album and genre, in that order, separated by a middle dot.
   *
   * All three are filterable, and a filter on something the row does not show is a filter on
   * something the user cannot see. They share one line because the row is fixed at two: a third
   * would make every row taller, and the density of this list is the reason it is usable at two
   * hundred charts. Empty fields drop out with their separator rather than leaving a gap.
   */
  function metaLine(chart: ChartRecord): string {
    return [chart.artist, chart.album, chart.genre]
      .map(stripRichText)
      .filter(Boolean)
      .join(' \u00b7 ')
  }

  function coverFor(chart: ChartRecord): string | null {
    return chart.albumArtMd5 && !artFailed.has(chart.albumArtMd5) ? artUrl(chart.albumArtMd5) : null
  }

  /**
   * A catalog query that failed, in the words it failed with.
   *
   * Kept apart from the scan's error: a scan that fails leaves the catalog as it was, while a
   * query that fails leaves THIS LIST empty, and an empty list under a 0 count is exactly what
   * the empty state below reads as "you own nothing". Cleared on the next successful load.
   */
  let loadError = $state<string | null>(null)

  async function load(append = false): Promise<void> {
    const offset = append ? charts.length : 0
    // Read straight from the store rather than from a copy: the sort has to reach the query,
    // because the list is paged and the page the database picks depends on the order it is in.
    const filter = toCatalogFilter(get(libraryFilter), { offset, limit: PAGE })
    try {
      const [rows, count] = await Promise.all([
        encore().catalogQuery(filter),
        encore().catalogCount(filter)
      ])
      charts = append ? [...charts, ...rows] : rows
      total = count
      loadError = null
      // One batch for the page that just landed, not one per row, and not awaited: the list is
      // complete without badges and must not wait on them to paint.
      void loadPlays(rows, append)
      void loadLifetime(rows, append)
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
    }
  }

  async function loadLibraryTotal(): Promise<void> {
    libraryTotal = await encore().catalogCount({ search: '', offset: 0, limit: PAGE })
  }

  async function loadFacets(): Promise<void> {
    try {
      facets = await encore().catalogFacets()
    } catch {
      // Best effort: the pickers keep whatever they had, which on a cold start is nothing but
      // their "any" option. Nothing here is allowed to empty the list.
    }
  }

  /**
   * Apply a change to the filter bar and re-query.
   *
   * `debounce` is for the typed controls only. A picker or a toggle is one decision the user has
   * already made, so waiting 200ms to act on it is just lag; a text box is mid-sentence on every
   * keystroke. Any change resets the list to page one, which `load()` does by ignoring the rows
   * already on screen when it is not appending.
   */
  function setFilter(patch: Partial<LibraryFilterState>, debounce = false): void {
    libraryFilter.update((prev) => ({ ...prev, ...patch }))
    if (timer) clearTimeout(timer)
    if (debounce) timer = setTimeout(() => void load(), 200)
    else void load()
  }

  function clearFilters(): void {
    libraryFilter.update(clearedFilters)
    if (timer) clearTimeout(timer)
    void load()
  }

  function setDirection(direction: SortDirection): void {
    setFilter({ direction })
  }

  // A scan that has stopped is the only thing that changes the catalog under this view.
  //
  // 'canceled' counts as much as 'done' does: a cancelled scan keeps every row it wrote, so the
  // catalog really has moved and a list that refreshed only on 'done' would sit there stale with
  // nothing on screen explaining why.
  $effect(() => {
    const status = $scanProgress?.status
    if (status === 'done' || status === 'canceled') {
      void load()
      void loadLibraryTotal()
      // A scan is the only thing that can add an artist or a genre the pickers have never
      // offered, so this is the one place they need refreshing.
      void loadFacets()
    }
  })

  const gap = $derived(
    libraryGap({
      folderCount: $settings.libraryFolders.length,
      libraryTotal,
      // Session-scoped: nothing records that an earlier launch scanned, which is why the
      // 'empty-catalog' wording below does not claim the user never ran one.
      //
      // 'done' only, unlike the reload above. This flag is what lets the empty state say "that
      // scan found no charts in your library folder", and a cancelled scan stopped looking
      // before it could establish that.
      scanFinished: $scanProgress?.status === 'done'
    })
  )

  onMount(() => {
    void load()
    void loadLibraryTotal()
    void loadFacets()
    // Replayed from main's memory, never checked from here: see stores/updates.ts. On mount is
    // enough, since App recreates this view on every navigation and a check runs from Detail,
    // which is a navigation away.
    void refreshVerdicts()
    return () => {
      if (timer) clearTimeout(timer)
    }
  })
</script>

<div class="library">
  <div class="bar">
    <input
      placeholder="Filter library…"
      aria-label="Filter library by title, artist, album or charter"
      value={$libraryFilter.search}
      oninput={(e) => setFilter({ search: e.currentTarget.value }, true)}
    />
    <!-- Matched against the whole catalog, not matched alone: "12 charts" reads as a small
         library until you notice the filters, and the number the user is checking against is
         the one they started with. Only while something is narrowing the list, so an unfiltered
         library does not carry a ratio of itself to itself. -->
    <span class="count">
      {#if activeFilters > 0}
        {total.toLocaleString()} OF {libraryTotal.toLocaleString()} CHARTS
      {:else}
        {total.toLocaleString()} CHARTS
      {/if}
    </span>
    <button
      class="scan"
      disabled={$scanProgress?.status === 'running'}
      onclick={() => void startScan()}
    >
      {#if $scanProgress?.status === 'running'}
        Scanning… <span class="mono-num">{$scanProgress.percent ?? 0}</span>%
      {:else}
        Scan library
      {/if}
    </button>
    <!-- Only while a scan is in flight, matching the Issues tab: a permanently present Cancel
         would be a control that does nothing most of the time, and the button beside it already
         says "Scanning…". -->
    {#if $scanProgress?.status === 'running'}
      <button class="cancel" onclick={() => void cancelScan()}>Cancel</button>
    {/if}
  </div>
  <!-- Every picker is a native <select> holding only values the catalog actually has, so no
       choice can ever return nothing and Chromium's own type-to-jump handles a long list.
       Only the option's LABEL is stripped: the value is what the query filters on, and the
       catalog stores what the chart says, so a stripped value would match no row at all. A
       name that is nothing but tags keeps its raw label, because a blank option in a list of
       charters is a choice the user cannot tell from the next one.
       Album is the exception and is typed: at 154 distinct albums across 222 charts it is
       close to unique per chart, so a dropdown of them is a dropdown of the library. -->
  <div class="filters">
    <select
      class="chip"
      aria-label="Filter by artist"
      value={$libraryFilter.artist}
      onchange={(e) => setFilter({ artist: e.currentTarget.value })}
    >
      <option value="">Any artist</option>
      {#each withCurrent(facets.artists, $libraryFilter.artist) as artist (artist)}
        <option value={artist}>{stripRichText(artist) || artist}</option>
      {/each}
    </select>
    <input
      class="text-filter"
      placeholder="Album"
      aria-label="Filter by album"
      value={$libraryFilter.album}
      oninput={(e) => setFilter({ album: e.currentTarget.value }, true)}
    />
    <select
      class="chip"
      aria-label="Filter by genre"
      value={$libraryFilter.genre}
      onchange={(e) => setFilter({ genre: e.currentTarget.value })}
    >
      <option value="">Any genre</option>
      {#each withCurrent(facets.genres, $libraryFilter.genre) as genre (genre)}
        <option value={genre}>{stripRichText(genre) || genre}</option>
      {/each}
    </select>
    <select
      class="chip"
      aria-label="Filter by charter"
      value={$libraryFilter.charter}
      onchange={(e) => setFilter({ charter: e.currentTarget.value })}
    >
      <option value="">Any charter</option>
      {#each withCurrent(facets.charters, $libraryFilter.charter) as charter (charter)}
        <option value={charter}>{stripRichText(charter) || charter}</option>
      {/each}
    </select>
    <!-- Year is a range of pickers rather than one exact year: picking 1994 answers a question
         almost nobody has, and "the eighties" is the one people ask. -->
    <span class="range">
      <span class="range-label">Year</span>
      <select
        class="chip narrow"
        aria-label="Earliest year"
        value={$libraryFilter.yearMin}
        onchange={(e) => setFilter({ yearMin: e.currentTarget.value })}
      >
        <option value="">Any</option>
        {#each withCurrentYear(facets.years, $libraryFilter.yearMin) as year (year)}
          <option value={year}>{year}</option>
        {/each}
      </select>
      <span class="range-to">to</span>
      <select
        class="chip narrow"
        aria-label="Latest year"
        value={$libraryFilter.yearMax}
        onchange={(e) => setFilter({ yearMax: e.currentTarget.value })}
      >
        <option value="">Any</option>
        {#each withCurrentYear(facets.years, $libraryFilter.yearMax) as year (year)}
          <option value={year}>{year}</option>
        {/each}
      </select>
    </span>
    <!-- Length is typed, never picked: 217 distinct lengths across 220 charts means every
         entry in a picker would select one chart. Minutes, because that is how anyone says it. -->
    <span class="range">
      <span class="range-label">Length</span>
      <input
        class="num"
        type="number"
        min="0"
        inputmode="numeric"
        placeholder="0"
        aria-label="Shortest length, in minutes"
        value={$libraryFilter.lengthMinMin}
        oninput={(e) => setFilter({ lengthMinMin: e.currentTarget.value }, true)}
      />
      <span class="range-to">to</span>
      <input
        class="num"
        type="number"
        min="0"
        inputmode="numeric"
        placeholder="any"
        aria-label="Longest length, in minutes"
        value={$libraryFilter.lengthMaxMin}
        oninput={(e) => setFilter({ lengthMaxMin: e.currentTarget.value }, true)}
      />
      <span class="range-to">min</span>
    </span>
    <!-- "No plays recorded", never "never played". Two records are consulted, Encore's own log
         and Clone Hero's score files, and neither covers a play made on another machine. The
         sentence below the bar says so whenever the filter is on; see shared/schemas.ts. -->
    <button
      class="toggle"
      aria-pressed={$libraryFilter.neverPlayed}
      onclick={() => setFilter({ neverPlayed: !$libraryFilter.neverPlayed })}
    >
      No plays recorded
    </button>
    {#if activeFilters > 0}
      <button class="clear" onclick={() => clearFilters()}>
        Clear filters ({activeFilters})
      </button>
    {/if}
    <!-- At the far end, like Explore's layout toggle: a sort is a control about the list, not
         another thing narrowing it, and Clear leaves it alone for the same reason. -->
    <span class="sort">
      <span class="range-label">Sort by</span>
      <select
        class="chip"
        aria-label="Sort by"
        value={$libraryFilter.sort}
        onchange={(e) => setFilter({ sort: e.currentTarget.value as CatalogSortField | '' })}
      >
        <option value="">Default order</option>
        {#each SORTS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
      {#if currentSort}
        <span class="dirs" role="group" aria-label="Sort direction">
          <button
            class="dir"
            aria-pressed={$libraryFilter.direction === 'asc'}
            onclick={() => setDirection('asc')}>{currentSort.asc}</button
          >
          <button
            class="dir"
            aria-pressed={$libraryFilter.direction === 'desc'}
            onclick={() => setDirection('desc')}>{currentSort.desc}</button
          >
        </span>
      {/if}
    </span>
  </div>
  {#if $libraryFilter.neverPlayed}
    <!-- The caveat the schema's own comment asks any UI offering this filter to state. It is
         shown beside the list rather than hidden in a tooltip because a user reading a short
         list has already drawn a conclusion by the time they would hover anything.

         Two wordings, because the filter consults two records and the weaker answer is not the
         one to give when the stronger is available. With the score files read, the list really
         is "no play on either record". Without them it is only Encore's log, which on a machine
         where Clone Hero has been played for years is a list of almost everything, and a
         sentence that did not say so would be the misleading half of the feature. -->
    <p class="caveat">
      {#if lifetimeStatus?.available}
        Encore checked its own play log and Clone Hero's own score files, which reach back before
        Encore was installed. A chart played on another machine, or one Encore cannot identify, is
        in this list too.
      {:else}
        Encore could not read Clone Hero's own score files, so this list is only what Encore's log
        has seen. A chart you played before you installed Encore, or on another machine, or that
        Encore cannot identify, is in this list too.
      {/if}
    </p>
  {:else if anyPlayRecord}
    <!-- The same fact from the other side, and it earns the same line for the same reason: a
         row with no badge is "no play on record", never "you have never played this". Only one
         of the two is ever on screen, since the filter's wording above already says it. -->
    <p class="caveat">
      {#if lifetimeStatus?.available}
        Play counts are Clone Hero's own, over every play you have made. A chart it has no record of
        carries no count, which is still not the same as never played.
      {:else}
        Play counts start from when Encore began watching Clone Hero. A chart you played before that
        carries no count here.
      {/if}
    </p>
  {/if}
  <!-- One line of scope, so Installed and Asset Studio don't read as the same list twice. -->
  <p class="intro">
    Every chart in your library, as Clone Hero sees it. To fill in missing art, video or lyrics, use
    Asset Studio.
  </p>
  {#if loadError}
    <!-- Home's sentence for the same failure, reused verbatim. Without this branch a catalog
         that cannot be read drew the empty state below ("that scan found no charts") over a
         library that is intact, because a rejected query and an empty answer both leave
         `total` at 0. role="alert" because the list it replaces went blank without a sound. -->
    <div class="error" role="alert">Encore could not read the catalog: {loadError}</div>
  {:else if $scanProgress?.status === 'error'}
    <div class="error" role="alert">Scan failed: {$scanProgress.message}</div>
  {:else if $scanProgress?.status === 'canceled'}
    <!-- The second sentence is the part that matters. The list below is a real, partial catalog:
         the charts the scan reached are indexed and the rest were never opened, and without
         saying so the user reads a short library as their whole library. -->
    <div class="warn">
      Scan stopped at {$scanProgress.percent ?? 0}%. The charts it had read are listed below. Run it
      again to finish the rest.
    </div>
  {:else if $scanProgress?.status === 'done' && $scanProgress.message}
    <div class="warn">{$scanProgress.message}</div>
  {/if}
  <div class="table selectable">
    {#each charts as chart (chart.path)}
      {@const art = coverFor(chart)}
      {@const play = badgeFor(chart)}
      <button class="row" onclick={() => onOpenChart({ kind: 'local', record: chart })}>
        {#if art}
          <!-- Decorative: the title and artist beside it already name the chart, so alt text
               here would only repeat them to a screen reader. -->
          <img
            class="thumb"
            src={art}
            alt=""
            loading="lazy"
            onerror={() => chart.albumArtMd5 && artFailed.add(chart.albumArtMd5)}
          />
        {:else}
          <span class="thumb placeholder" aria-hidden="true"></span>
        {/if}
        <span class="song">
          <span class="title-line">
            <!-- title fallback is the file/folder name, not the full path: paths are unreadable
                 in a list, and a chart can legitimately have no parsed title. -->
            <span class="title" title={chart.path}>
              {stripRichText(chart.name) || fallbackChartName(chart.path)}
            </span>
            <!-- Only for an `alternate` verdict already in main's memory. `current` earns no ink
                 in a list, and a chart nobody has checked must not look checked. The words are
                 Detail's: "different version", never "newer", because nothing in the Chorus API
                 orders two uploads of a chart. -->
            {#if $verdicts.get(chart.path)?.kind === 'alternate'}
              <span
                class="badge mono"
                title="Chorus Encore has a different version of this chart. Open it to compare."
              >
                DIFFERENT VERSION
              </span>
            {/if}
            <!-- Inside the title line rather than as a column of its own: the grid has no room
                 to spare, and a seventh track would be empty down its whole length for the
                 many users with no play data at all. Absent when there is no record, so it
                 costs nothing on a row that has none. -->
            {#if play}
              <span class="badge mono plays" title={play.title}>
                {#if play.count === null}
                  PLAYED
                {:else}
                  {play.count.toLocaleString()}
                  {play.count === 1 ? 'PLAY' : 'PLAYS'}
                {/if}
              </span>
            {/if}
          </span>
          <span class="meta">{metaLine(chart)}</span>
        </span>
        <span class="charter">{stripRichText(chart.charter)}</span>
        <!-- One grid child: the each block stays inside this span so the row's five columns
             keep matching .row's five tracks. -->
        <span class="diffs mono">
          {#each diffCells(chart) as cell (cell.letter)}
            <span class="d">{cell.letter}{cell.text}</span>
          {/each}
        </span>
        <!-- Year and length sit together at the end, and both are sortable columns: the user
             has to be able to see the thing they just ordered the list by. An empty cell for a
             chart with no year, not a placeholder glyph: the length beside it already spends
             one, and two in a row reads as an error. -->
        <span class="year mono">{chart.year ?? ''}</span>
        <span class="len mono">{msToTime(chart.songLength)}</span>
      </button>
    {/each}
    {#if charts.length < total}
      <button class="more" onclick={() => void load(true)}>Load more</button>
    {/if}
    {#if total === 0 && loadError === null}
      <p class="empty">
        {#if gap === 'no-folder'}
          No library folder yet. Add your Clone Hero Songs folder in Settings, then use Scan library
          above.
        {:else if gap === 'empty-catalog'}
          Nothing scanned yet. Scan library above reads every chart in your library folder.
        {:else if gap === 'scan-found-nothing'}
          That scan found no charts in your library folder. A chart is a folder holding notes.chart,
          notes.mid or song.ini, or a .sng file.
        {:else}
          <!-- gap is null, so the catalog holds charts and the filter bar is what emptied the
               list. Deliberately does not quote the filters back: they are all still on screen
               above, and Clear filters is the control this sentence is pointing at. -->
          No charts match these filters. Clear them to see all {libraryTotal.toLocaleString()} charts.
        {/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .library {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 10px;
  }
  .intro {
    padding: 0 16px 10px;
    margin: 0;
    max-width: 72ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  input {
    flex: 0 1 320px;
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
  .count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    white-space: nowrap;
  }
  /* Wraps rather than scrolls or overflows. There are eleven controls here at the widest, and
     the window has no minimum width worth designing against, so the row has to be allowed to
     become two. NOT VERIFIED BY ANY TEST: jsdom computes no layout, so nothing below can tell
     you where this bar breaks or whether it fits on one line at any given width. */
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 0 16px 10px;
  }
  /* Explore's filter chip, verbatim, including the drawn caret: `appearance: none` takes the
     platform's own away, and a select with no caret does not read as one. */
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
    max-width: 200px;
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
  /* Wide enough for a four-digit year and the caret, and no wider. */
  .chip.narrow {
    padding-right: 22px;
    padding-left: 9px;
  }
  /* A range is one control made of parts, so its parts are grouped and its label sits inside
     the group. Two bare selects with nothing between them are two filters. */
  .range,
  .sort {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .range-label,
  .range-to {
    font-size: var(--fs-caption);
    color: var(--text-3);
    white-space: nowrap;
  }
  /* The typed filters. Same box as the search input above, at the chip's height so the row
     does not step up and down along its length. */
  .text-filter,
  .num {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    padding: 4px 11px;
    color: var(--text-1);
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    transition: border-color var(--t-fast) var(--ease);
  }
  .text-filter {
    flex: 0 1 150px;
    min-width: 90px;
  }
  .num {
    width: 62px;
  }
  .text-filter:focus,
  .num:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Explore's pressed-mode treatment: the lit one is the only lit thing in the row, which is
     what makes "on" readable at a glance rather than by comparison. */
  .toggle,
  .dir,
  .clear {
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
  .toggle:hover,
  .dir:hover,
  .clear:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .toggle[aria-pressed='true'],
  .dir[aria-pressed='true'] {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text-1);
  }
  /* The one control in the bar that undoes the others, so it is the one that is allowed to
     stand out: accent text on the same quiet box. It appears only when there is something to
     clear, which is also what makes its presence the signal that the list is narrowed. */
  .clear {
    color: var(--accent-text);
    border-color: var(--accent);
  }
  .dirs {
    display: flex;
    gap: 4px;
  }
  .sort {
    margin-left: auto;
  }
  /* Same quiet card as the scan outcome lines, one step down: it qualifies a filter rather than
     reporting on a job. */
  .caveat {
    margin: 0 16px 10px;
    max-width: 72ch;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  /* Primary action of this view: accent gradient, same treatment as Detail's
     Download button. */
  .scan {
    background: var(--accent-grad);
    border: 0;
    border-radius: 7px;
    color: #fff;
    font-size: var(--fs-secondary);
    font-weight: 600;
    padding: 7px 15px;
    cursor: pointer;
    font-family: var(--font-ui);
    transition: filter var(--t-fast) var(--ease);
  }
  .scan:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .scan:disabled {
    opacity: 0.6;
    cursor: default;
  }
  /* Quiet next to .scan's accent gradient: stopping a job is never the action being encouraged. */
  .cancel {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    color: var(--text-2);
    font-size: var(--fs-secondary);
    padding: 6px 13px;
    cursor: pointer;
    font-family: var(--font-ui);
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .cancel:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .mono-num {
    font-family: var(--font-mono);
  }
  /* Scan outcome lines: quiet mono cards, no accent-coloured status copy. */
  .error,
  .warn {
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
  .warn {
    color: var(--text-3);
  }
  .table {
    flex: 1;
    overflow-y: auto;
    border-top: 1px solid var(--hairline);
  }
  .row {
    display: grid;
    grid-template-columns: 32px 1fr 140px 110px 40px 56px;
    gap: 10px;
    align-items: center;
    width: 100%;
    text-align: left;
    padding: 7px 16px;
    background: none;
    border: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
    cursor: pointer;
    color: inherit;
    font-family: inherit;
    user-select: text;
    /* On the row, not on `:hover`: declared only under the hover rule, the fade played on the
       way in and snapped on the way out. */
    transition: background var(--t-fast) var(--ease);
  }
  .row:hover {
    background: var(--surface-1);
  }
  /* The row is as wide as its scroller, so the app's outward 2px ring lost both sides to the
     scroller's clipping, seen as two hairlines above and below the row and nothing at either
     end. Drawn just inside the row instead, where all four sides survive. */
  .row:focus-visible {
    outline-offset: -2px;
  }
  /* Cover and placeholder share the box so a row's height and the column below it don't
     shift depending on whether art was cached. */
  .thumb {
    width: 32px;
    height: 32px;
    border-radius: 5px;
    object-fit: cover;
    background: var(--surface-2);
  }
  .thumb.placeholder {
    display: block;
    border: 1px solid var(--hairline);
  }
  .song {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* The row's three levels. They are separated on all three axes at once (size,
     weight and colour) because size alone at these steps (14 against 13) is not
     enough to tell a song from its artist at a glance. */
  /* The title and, when there is one, the badge, on one line. The title gives way first: it
     ellipsises, the badge does not shrink. Sized on the title so a badged row is exactly as
     tall as its neighbours; the badge's box is kept under that height below. */
  .title-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .title {
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Micro-label, in the same mono caption the difficulty codes use, with a hairline box so it
     reads as a chip rather than a stray word. --lh-flat plus 1px padding and border comes to
     16px, under the title's 17.5px (14px at --lh-tight), so the line, and the row, never grow.
     --accent-text rather than --text-3: it is the one thing in the list that asks for a look, and
     that token is the readable accent (7.2:1 on --bg). Both classes in the selector because the
     `.mono` rule below sets --text-3 and is declared later; at equal specificity it won, and the
     badge rendered grey on screen while this comment promised violet. */
  .badge.mono {
    flex: none;
    line-height: var(--lh-flat);
    padding: 1px 5px;
    border: 1px solid var(--hairline);
    border-radius: 3px;
    color: var(--accent-text);
    white-space: nowrap;
  }
  /* Quieter than the version badge above, and declared after it so that at equal specificity
     this wins the colour. The version badge is asking for a decision; a play count is only
     telling you something, and two accent chips on one line would make neither of them stand
     out. Same box, so the row's height is unchanged either way. */
  .badge.plays {
    color: var(--text-3);
  }
  /* Artist, album and genre on one line. Kept to one line and one size: the row is two lines
     tall and that is what holds it at its current height. */
  .meta {
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
  /* Difficulty codes. Caption size and tracked out, so a dense run of glyphs
     like "G2B1D3" stays countable rather than becoming one word. */
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  /* Spacing lives between the columns that rendered, so a chart missing an instrument loses
     the gap with it instead of leaving a hole where the column would have been. */
  .diffs .d + .d {
    margin-left: 8px;
  }
  .year,
  .len {
    text-align: right;
  }
  .more {
    display: block;
    margin: 12px auto;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    color: var(--text-2);
    padding: 7px 18px;
    font-size: var(--fs-secondary);
    cursor: pointer;
    font-family: var(--font-ui);
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .more:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .empty {
    padding: 24px 16px;
    color: var(--text-3);
    font-size: var(--fs-secondary);
    /* The copy is now two sentences at most; a measure keeps it from running the full
       width of a maximised window. */
    line-height: var(--lh-prose);
    max-width: 60ch;
  }
</style>
