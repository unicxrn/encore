<script lang="ts">
  import { onMount } from 'svelte'
  import type {
    CharterPlays,
    PlayBreakdown,
    PlayDataStatus,
    PlayInsights,
    PlayStats,
    RecentPlay,
    TopChart
  } from '../../../../shared/play'
  import { playedOn, stripRichText } from '../../../../shared/format'
  import { activity, localDay } from '../play-activity'
  import { encore } from '../stores/bridge'

  /**
   * Encore's own record of what you have played, as a page.
   *
   * The one thing this view exists to get right is that its numbers are NOT the user's lifetime
   * totals, and a page makes that harder rather than easier: the more of a report a surface
   * looks like, the more readily it is read as the whole record. Clone Hero's scorestats.json
   * holds exactly one play, the most recent, so Encore's history begins the first time it saw
   * that file change and there is no way to recover what came before (see shared/play.ts and
   * main/play/scorestats.ts).
   *
   * So the window is stated once, in prose, directly under the page title and above every
   * figure, anchored to `firstPlayedAt` because that is the date the record actually starts.
   * Once, not per block: a caveat repeated in six sections is a caveat nobody finishes reading.
   * What each section carries instead is the same distinction where it would otherwise be lost:
   * "no play on record" is never written as "never played", because they are different claims
   * and only one of them is supported.
   *
   * Every name drawn here goes through `stripRichText`. Charters style their own names in the
   * game and song.ini carries the markup verbatim; one charter in a real history is eight colour
   * tags, one per letter.
   */

  let status = $state<PlayDataStatus | null>(null)
  let stats = $state<PlayStats | null>(null)
  let insights = $state<PlayInsights | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)

  async function load(): Promise<void> {
    try {
      const next = await encore().playStatus()
      status = next
      // The gate the preload comment asks every consumer to ask first. The two reads below on a
      // machine with no Clone Hero answer with zeroes and empty lists, which is correct and
      // indistinguishable from "installed, played nothing", and those are two different things
      // to say to a user.
      if (next.available) {
        // Both, in parallel: they are independent reads of one file, and a page that waited for
        // the first before asking for the second would take twice as long to draw for nothing.
        const [nextStats, nextInsights] = await Promise.all([
          encore().playStats(),
          encore().playInsights()
        ])
        stats = nextStats
        insights = nextInsights
      } else {
        stats = null
        insights = null
      }
      error = null
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
    // A play recorded while this tab is open moves every number on it. The event carries no
    // payload by design, so this re-reads rather than patching.
    try {
      return encore().onPlayRecorded(() => void load())
    } catch {
      // A bridge without the event still draws the page, just without live updates.
      return undefined
    }
  })

  /** The empty-cell placeholder, the one piece of typography format.ts keeps. */
  const EMPTY = '—'

  const count = (value: number | null): string => (value === null ? EMPTY : value.toLocaleString())

  const pluralPlays = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'play' : 'plays'}`

  /** A name after the game's markup is removed, or a stand-in when nothing is left of it. */
  const named = (value: string | null, fallback: string): string => {
    const text = stripRichText(value)
    return text === '' ? fallback : text
  }

  /**
   * Accuracy as one ratio of two sums, never an average of per-play accuracies.
   *
   * Those are different numbers, and the sum-of-sums is the only one this data supports: a play
   * row carries its own notes, so weighting a short chart's 100% the same as a long chart's 96%
   * would be inventing a statistic. Null when no notes were recorded at all, which is both the
   * empty table and the divide-by-zero guard.
   */
  const accuracy = $derived.by(() => {
    if (!stats || stats.totalNotes <= 0) return null
    return stats.notesHit / stats.totalNotes
  })

  const percent = (ratio: number | null): string =>
    ratio === null ? EMPTY : `${(ratio * 100).toFixed(1)}%`

  interface Tile {
    label: string
    value: string
    note: string
    /** Hover text for a figure whose label cannot carry its whole definition. */
    title?: string
  }

  const tiles = $derived.by((): Tile[] => {
    if (!stats) return []
    return [
      {
        label: 'PLAYS RECORDED',
        value: stats.totalPlays.toLocaleString(),
        note: `across ${stats.chartsPlayed.toLocaleString()} ${stats.chartsPlayed === 1 ? 'chart' : 'charts'}`
      },
      {
        label: 'ACCURACY',
        value: percent(accuracy),
        note:
          accuracy === null
            ? 'no notes recorded'
            : `${stats.notesHit.toLocaleString()} of ${stats.totalNotes.toLocaleString()} notes`,
        title:
          'Every note hit divided by every note played, added up over all recorded plays. This is one ratio of two totals, not the average of what each play scored.'
      },
      {
        label: 'FULL COMBOS',
        value: stats.fcCount.toLocaleString(),
        note: `${stats.pfcCount.toLocaleString()} of them perfect`,
        title:
          'Plays that dropped no note. A perfect full combo hit every note on the front of its window, which Clone Hero records separately.'
      },
      {
        label: 'BEST SCORE',
        value: count(stats.bestScore),
        note: 'highest single play'
      },
      {
        label: 'LONGEST STREAK',
        value: count(stats.longestStreak),
        note: 'notes without a miss'
      }
    ]
  })

  /** Artist and charter under a chart's name, whichever of them was recorded. */
  function chartMeta(chart: TopChart | RecentPlay): string {
    return [stripRichText(chart.artistName), stripRichText(chart.charterName)]
      .filter((part) => part !== '')
      .join(' · ')
  }

  /** Instrument and difficulty of one play, as the game recorded them. */
  function playedAs(play: RecentPlay): string {
    return [play.instrument, play.difficulty].filter(Boolean).join(' · ')
  }

  /**
   * The chart of the history, rebuilt whenever the history moves.
   *
   * `today` is read here rather than inside `activity` so that function stays pure and testable.
   * A tab left open across midnight keeps yesterday's window until the next play or navigation,
   * which costs an empty day at the right-hand end and nothing else.
   */
  const chart = $derived(insights ? activity(insights.days, localDay(new Date())) : null)

  /** What one bar covers, for the line that has to say it before the bars mean anything. */
  const blockLabel = $derived.by(() => {
    if (!chart) return ''
    if (chart.blockDays === 1) return 'One bar per day'
    if (chart.blockDays === 7) return 'One bar per week'
    return `One bar per ${chart.blockDays} days`
  })

  /** A bar's height, as a percentage of the busiest bar. Zero stays zero: no minimum stub. */
  const barHeight = (plays: number): string =>
    chart && chart.peak > 0 ? `${(plays / chart.peak) * 100}%` : '0%'

  const blockRange = (start: string, end: string): string =>
    start === end ? playedOn(start) : `${playedOn(start)} to ${playedOn(end)}`

  /** The chart as one sentence, which is all a screen reader can be given of a row of bars. */
  const chartSummary = $derived.by(() => {
    if (!chart || !stats) return ''
    const from = stats.firstPlayedAt ? playedOn(stats.firstPlayedAt) : 'the first recorded play'
    return `Recorded plays from ${from} to today. ${blockLabel}, busiest bar ${pluralPlays(chart.peak)}.`
  })

  /** The longest bar in a breakdown, which the rest are drawn against. */
  const widest = (rows: PlayBreakdown[]): number =>
    rows.reduce((max, row) => (row.plays > max ? row.plays : max), 0)

  const charterWidest = $derived.by(() =>
    (insights?.topCharters ?? []).reduce((max, row) => (row.plays > max ? row.plays : max), 0)
  )

  const barWidth = (plays: number, max: number): string =>
    max > 0 ? `${Math.max((plays / max) * 100, 2)}%` : '0%'

  function charterName(row: CharterPlays): string {
    return named(row.charter, 'Unnamed charter')
  }

  /**
   * The sentence that keeps the figures honest, anchored to the first play on record.
   *
   * `firstPlayedAt` is null only when nothing is recorded, which this branch never renders, but
   * the wording still works without the date rather than printing "since null".
   */
  const since = $derived(stats?.firstPlayedAt ? playedOn(stats.firstPlayedAt) : null)

  /** Where Encore looked, for the states where saying so is the useful part. */
  const where = $derived(status?.path)

  /** Charts that carry no Clone Hero checksum, so no play can ever be joined to them. */
  const unidentified = $derived(
    insights ? insights.coverage.inLibrary - insights.coverage.identified : 0
  )

  /** Identified charts with nothing on record. Not "never played"; the page says which. */
  const unplayed = $derived(
    insights ? insights.coverage.identified - insights.coverage.withPlay : 0
  )
</script>

<div class="stats selectable">
  <h1>Your plays</h1>

  {#if loading}
    <p class="status" role="status">LOADING…</p>
  {:else if error}
    <p class="err" role="status">Encore could not read your play history: {error}</p>
  {:else if stats && status?.available}
    <!-- Above every number on the page, deliberately. A user who reads one figure and stops has
         still read this, and a user who reads only this has not been misled about anything. -->
    <p class="caveat">
      {#if since}
        These are not your lifetime totals. Encore counts a play only while it is running, and your
        first recorded play was {since}, so nothing you played before that is here.
      {:else}
        These are not your lifetime totals. Encore counts a play only while it is running, so
        nothing you played before you installed it is here.
      {/if}
    </p>

    <section aria-labelledby="stats-totals">
      <h2 id="stats-totals">TOTALS</h2>
      <div class="tiles">
        {#each tiles as tile (tile.label)}
          <div class="tile" title={tile.title}>
            <span class="t-label">{tile.label}</span>
            <span class="t-value mono">{tile.value}</span>
            <span class="t-note">{tile.note}</span>
          </div>
        {/each}
      </div>
    </section>

    {#if chart}
      <section aria-labelledby="stats-when">
        <h2 id="stats-when">WHEN YOU PLAY</h2>
        <!-- The axis starts at the first recorded play and not a day earlier: an empty week
             before it would be drawing a silence that is Encore's, not the user's. -->
        <p class="sub-note">
          {blockLabel}, from your first recorded play to today.
          {#if chart.blocks.at(-1)?.partial}
            The last bar covers the days so far.
          {/if}
        </p>
        <div class="chart" role="img" aria-label={chartSummary}>
          {#each chart.blocks as block (block.start)}
            <div
              class="col"
              title={`${blockRange(block.start, block.end)}: ${pluralPlays(block.plays)}`}
            >
              <div class="fill" style={`height: ${barHeight(block.plays)}`}></div>
            </div>
          {/each}
        </div>
        <!-- Both ends are dates rather than a date and the word "today": the window runs to
             today in every ordinary case, and to a play stamped later than today in the one
             case a wrong clock produces, where "today" would be the wrong word. -->
        <div class="axis">
          <span class="mono">{playedOn(chart.blocks[0].start)}</span>
          <span class="mono">{playedOn(chart.blocks.at(-1)?.end ?? null)}</span>
        </div>
        <p class="sub-note">
          {#if chart.busiest}
            Busiest day on record: {pluralPlays(chart.busiest.plays)} on {playedOn(
              chart.busiest.day
            )}.
          {/if}
          You played on {chart.activeDays.toLocaleString()} of the
          {chart.windowDays.toLocaleString()} days since the record started.
        </p>
      </section>
    {/if}

    {#if stats.byInstrument.length > 0 || stats.byDifficulty.length > 0}
      <section class="two-up" aria-labelledby="stats-what">
        <h2 id="stats-what">WHAT YOU PLAY</h2>
        <div class="columns">
          {#each [{ title: 'Instrument', rows: stats.byInstrument }, { title: 'Difficulty', rows: stats.byDifficulty }] as group (group.title)}
            {#if group.rows.length > 0}
              <div class="breakdown">
                <h3>{group.title}</h3>
                {#each group.rows as row (row.key)}
                  <div class="bd-row">
                    <span class="bd-key">{row.key}</span>
                    <span class="bd-track">
                      <span
                        class="bd-fill"
                        style={`width: ${barWidth(row.plays, widest(group.rows))}`}
                      ></span>
                    </span>
                    <span class="bd-count mono">{row.plays.toLocaleString()}</span>
                  </div>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
        <!-- Clone Hero writes these per play, and a play it wrote neither for is in the totals
             above but in neither list here. Saying so beats two lists that quietly disagree
             with the count at the top of the page. -->
        <p class="sub-note">
          Counted from the plays where Clone Hero recorded an instrument and a difficulty.
        </p>
      </section>
    {/if}

    <div class="columns">
      {#if stats.topCharts.length > 0}
        <section aria-labelledby="stats-most">
          <h2 id="stats-most">MOST PLAYED</h2>
          <!-- These names are the ones Clone Hero wrote alongside the play, not the catalog's,
               so a chart deleted since still has its row and its name here. That is on purpose:
               it is history, and dropping it would quietly shrink the user's own record. -->
          <p class="sub-note">
            Named as Clone Hero recorded them at the time, so a chart you have since deleted is
            still on this list.
          </p>
          <ol class="top">
            {#each stats.topCharts as chartRow, index (chartRow.checksum)}
              <li class="top-row">
                <span class="rank mono">{index + 1}</span>
                <span class="song">
                  <span class="name">{named(chartRow.songName, 'Unnamed chart')}</span>
                  <span class="meta">{chartMeta(chartRow)}</span>
                </span>
                <span class="plays mono">{pluralPlays(chartRow.timesPlayed)}</span>
                <span class="score mono">{count(chartRow.bestScore)}</span>
              </li>
            {/each}
          </ol>
        </section>
      {/if}

      {#if insights && insights.recent.length > 0}
        <section aria-labelledby="stats-recent">
          <h2 id="stats-recent">RECENTLY PLAYED</h2>
          <p class="sub-note">The last plays Encore saw, newest first.</p>
          <ol class="top">
            {#each insights.recent as play (play.checksum + play.playedAt)}
              <li class="recent-row">
                <span class="song">
                  <span class="name">{named(play.songName, 'Unnamed chart')}</span>
                  <span class="meta">{chartMeta(play)}</span>
                </span>
                <span class="played">
                  <span class="when mono">{playedOn(play.playedAt)}</span>
                  <span class="as">{playedAs(play)}</span>
                </span>
                <span class="numbers">
                  <span class="score mono">{count(play.score)}</span>
                  <span class="acc mono">
                    {percent(play.accuracy)}
                    {#if play.isPfc}
                      <span class="tag" title="Perfect full combo">PFC</span>
                    {:else if play.isFc}
                      <span class="tag" title="Full combo">FC</span>
                    {/if}
                  </span>
                </span>
              </li>
            {/each}
          </ol>
        </section>
      {/if}
    </div>

    {#if insights}
      <section aria-labelledby="stats-library">
        <h2 id="stats-library">YOUR LIBRARY, PLAYED</h2>
        <!-- The one place on this page where the difference between "Encore has not seen you
             play this" and "you have never played this" can be lost, so it is written out. The
             two shortfalls have unrelated causes: one is a chart Encore cannot identify, and no
             amount of playing fixes it. -->
        <p class="coverage">
          {#if insights.coverage.identified === 0}
            <!-- Nothing scanned, or nothing scanned since Encore started recording Clone Hero's
                 identity for a chart. Either way there is no ratio to state, and stating one
                 against a zero would read as "you have played none of your library". -->
            Nothing in your library can be matched to a play yet. Scan your library and the charts you
            play start appearing here.
          {:else}
            Encore has seen you play
            <span class="mono">{insights.coverage.withPlay.toLocaleString()}</span>
            of the
            <span class="mono">{insights.coverage.identified.toLocaleString()}</span>
            charts in your library it can match a play to.
            {#if unplayed > 0}
              The other {unplayed.toLocaleString()} have no play on record, which is not the same as never
              played: anything you played before Encore was watching is not here.
            {/if}
          {/if}
        </p>
        {#if unidentified > 0}
          <p class="sub-note">
            {unidentified.toLocaleString()} of your
            {insights.coverage.inLibrary.toLocaleString()} charts carry no Clone Hero checksum yet, so
            no play can ever be matched to them. A rescan gives them one.
          </p>
        {/if}
        {#if insights.coverage.playsOffLibrary > 0}
          <p class="sub-note">
            {pluralPlays(insights.coverage.playsOffLibrary)} on record are of charts your library does
            not hold: deleted, moved, or never scanned.
          </p>
        {/if}

        {#if insights.topCharters.length > 0}
          <h3>Charters you play</h3>
          <!-- Counted off the catalog rather than off the plays, which is the opposite of the
               most-played list above and has the opposite consequence: a charter whose charts
               are all deleted is not here, because "of theirs you own" would have nothing to
               count. -->
          <p class="sub-note">
            From the charts in your library, so a charter you have played but no longer own is not
            listed. The second figure counts every chart of theirs you hold, including any Encore
            cannot match a play to.
          </p>
          <ul class="charters">
            {#each insights.topCharters as row (row.charter)}
              <li class="ch-row">
                <span class="name">{charterName(row)}</span>
                <span class="bd-track">
                  <span class="bd-fill" style={`width: ${barWidth(row.plays, charterWidest)}`}
                  ></span>
                </span>
                <span class="plays mono">{pluralPlays(row.plays)}</span>
                <span class="owned mono">
                  {row.played.toLocaleString()} of {row.owned.toLocaleString()} played
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {:else}
    <!-- Four ways to have nothing, and they call for four different sentences. None of them is
         a fault the user has to fix, so none of them is worded as one. -->
    <p class="err" role="status">
      {#if status?.reason === 'unknownPlatform'}
        Encore has no established location for Clone Hero's score file on this system, so it is not
        counting plays here.
      {:else if status?.reason === 'noFile'}
        Nothing to show yet. Clone Hero writes a score file when it finishes a song, and there is
        none at
        <span class="mono path">{where}</span>. Encore starts counting as soon as one appears.
      {:else if status?.reason === 'unreadable'}
        Something is at <span class="mono path">{where}</span>
        but Encore could not read it. A file caught mid-save looks exactly like this and fixes itself
        on the next song.
      {:else}
        Encore is watching <span class="mono path">{where}</span>
        and has recorded no play yet. Finish a song in Clone Hero and your totals start here.
      {/if}
    </p>
  {/if}
</div>

<style>
  /* The page follows Settings' shape rather than Home's: a title, then labelled cards down one
     column. Unlike Settings it is not capped at 660px, because the chart and the two lists are
     wide things and a narrow column would make the bars a stripe. */
  .stats {
    padding: 22px 24px 30px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    /* What the two-column rule below asks about. Queried on the page rather than on `.columns`,
       which is the element that rule sizes: an element cannot be sized by a query it feeds. */
    container-type: inline-size;
  }
  h1 {
    font-size: var(--fs-heading);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
    margin-bottom: 2px;
  }
  /* Card head: mono uppercase micro-caps, the register Settings, Home's rows and Detail's cards
     all use for the same job. */
  h2 {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 10px;
  }
  h3 {
    font-size: var(--fs-secondary);
    font-weight: 600;
    color: var(--text-2);
    margin: 14px 0 8px;
  }
  section {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 14px 16px 16px;
    min-width: 0;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .status {
    font-family: var(--font-mono);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    font-size: var(--fs-secondary);
    padding: 10px 0;
  }
  .err {
    font-size: var(--fs-secondary);
    padding: 10px 0;
    color: var(--text-2);
    line-height: var(--lh-prose);
    max-width: 72ch;
  }
  /* The path is the useful half of every "nothing here" sentence: a user who keeps Clone Hero
     somewhere unusual can only act on it if they can see where Encore looked. */
  .path {
    font-size: var(--fs-caption);
    color: var(--text-3);
    word-break: break-all;
  }
  /* The caveat is prose, not a chip, and it is not dimmed into decoration either: --text-2 is
     the same weight the app gives a row's artist line, which is text people read. */
  .caveat {
    margin: 0 0 4px;
    max-width: 72ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .sub-note {
    margin: 6px 0 10px;
    max-width: 78ch;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .coverage {
    margin: 0;
    max-width: 78ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }

  /* auto-fit rather than a fixed count: the pane follows the window, and five tiles wrapping to
     two rows beats five tiles squeezed under a narrow one. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 12px 14px;
    min-width: 0;
  }
  .t-label {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .t-value {
    font-size: var(--fs-heading);
    line-height: var(--lh-display);
    letter-spacing: var(--ls-tight);
    color: var(--text-1);
  }
  .t-note {
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
  }

  /* The activity chart. Plain boxes rather than an SVG: the bars have to follow the pane's
     width, which flex does for free and a viewBox does by stretching the bars' own geometry. */
  .chart {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 110px;
    padding-bottom: 1px;
    border-bottom: 1px solid var(--hairline);
  }
  .col {
    flex: 1 1 0;
    min-width: 2px;
    height: 100%;
    display: flex;
    align-items: flex-end;
  }
  .fill {
    width: 100%;
    background: var(--accent);
    border-radius: 2px 2px 0 0;
    transition: background var(--t-fast) var(--ease);
  }
  .col:hover .fill {
    background: var(--accent-hi);
  }
  .axis {
    display: flex;
    justify-content: space-between;
    padding-top: 5px;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }

  /* Two panes side by side while there is room for both, one column under that. The breakpoint
     is a container query because the pane's width is the window minus a 240px sidebar, and a
     media query would be answering about the wrong box. */
  .columns {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
    min-width: 0;
  }
  @container (min-width: 760px) {
    .columns {
      grid-template-columns: 1fr 1fr;
    }
  }
  .two-up .columns {
    gap: 10px 26px;
  }

  .breakdown {
    min-width: 0;
  }
  .bd-row {
    display: grid;
    grid-template-columns: 90px 1fr 56px;
    gap: 10px;
    align-items: center;
    padding: 4px 0;
  }
  .bd-key {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bd-track {
    display: block;
    height: 8px;
    border-radius: 4px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bd-fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
  }
  .bd-count {
    font-size: var(--fs-caption);
    color: var(--text-3);
    text-align: right;
  }

  .top {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hairline);
  }
  /* The same column discipline the Installed list uses: rank, the song, its count and its best
     score. */
  .top-row {
    display: grid;
    grid-template-columns: 24px 1fr 90px 110px;
    gap: 10px;
    align-items: center;
    padding: 7px 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
  }
  .recent-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 10px;
    align-items: center;
    padding: 7px 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
  }
  .rank {
    font-size: var(--fs-caption);
    color: var(--text-3);
    text-align: right;
  }
  .song {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: var(--fs-secondary);
    line-height: var(--lh-tight);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .played,
  .numbers {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    min-width: 0;
  }
  .when,
  .as {
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
    white-space: nowrap;
  }
  .plays,
  .score,
  .acc,
  .owned {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .score {
    text-align: right;
    color: var(--text-2);
  }
  .acc {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  /* A full combo is the one thing in a play row worth a colour: it is rare, and it is the
     difference between two plays with the same score. */
  .tag {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-flat);
    color: var(--accent-text);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 2px 4px;
  }

  .charters {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hairline);
  }
  .ch-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 120px 90px 130px;
    gap: 10px;
    align-items: center;
    padding: 6px 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
  }
  .ch-row .name {
    font-weight: 500;
  }
  .owned {
    text-align: right;
  }
</style>
