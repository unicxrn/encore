<script lang="ts">
  import { onMount } from 'svelte'
  import type {
    CharterPlays,
    LifetimeScores,
    LifetimeTotals,
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
   * What you have played, as a page, out of two records that do not cover the same span.
   *
   * Clone Hero's scorestats.json holds exactly one play, the most recent, so Encore's history
   * begins the first time it saw that file change and nothing before it can be recovered. Its
   * scoredata.bin and scoresext.bin are the other record: a play count and a best score per
   * chart, kept since long before Encore was installed, with no date on any of it (see
   * shared/play.ts).
   *
   * The page used to open with one caveat saying that nothing on it was a lifetime total, which
   * was true of every figure. It is now true of some of them, and a blanket caveat over a page
   * where half the numbers really are lifetime is itself the lie it was written to prevent.
   *
   * So the distinction is carried structurally instead, by a source tag on every section
   * heading: ALL TIME for the blocks drawn from Clone Hero's own table, SINCE <date> for the
   * blocks drawn from Encore's log. One sentence under the title defines the two, and after
   * that a reader tells which is which by looking at the heading above the number rather than
   * by remembering a caveat from six sections ago. The tags appear only when both records are
   * on the page: with one source there is nothing to distinguish, and the single caveat the
   * page has always shown is the right shape for that state.
   *
   * The two counts are never added and the page says so where they sit closest. A chart's
   * lifetime count ALREADY includes every play Encore watched, so their sum means nothing.
   *
   * Every name drawn here goes through `stripRichText`. Charters style their own names in the
   * game and song.ini carries the markup verbatim; one charter in a real history is eight colour
   * tags, one per letter.
   */

  let status = $state<PlayDataStatus | null>(null)
  let stats = $state<PlayStats | null>(null)
  let insights = $state<PlayInsights | null>(null)
  let lifetime = $state<LifetimeScores | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)

  /**
   * The lifetime read, which fails on its own rather than taking the page with it.
   *
   * An empty checksum list rather than no argument at all: this page draws `totals` and nothing
   * per chart, and omitting the list would ship one row for every chart the score files know
   * of, for nothing to read. A bridge without the channel lands in the catch and the page draws
   * what Encore itself watched, which is the page exactly as it was before the files were read.
   */
  async function loadLifetime(): Promise<LifetimeScores | null> {
    try {
      return await encore().playLifetime([])
    } catch {
      return null
    }
  }

  async function load(): Promise<void> {
    try {
      // Two independent records, read at once: neither gates the other, and a page that asked
      // for the second only after the first had answered would take twice as long to draw.
      const [next, nextLifetime] = await Promise.all([encore().playStatus(), loadLifetime()])
      status = next
      lifetime = nextLifetime
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

  /**
   * Clone Hero's own totals, or null when there is no lifetime record to draw.
   *
   * `available` is main's own "there is something to show" test, not "a file exists": a Clone
   * Hero that has never finished a song has both files and nothing in them (see main/index.ts).
   */
  const lifetimeTotals = $derived.by((): LifetimeTotals | null =>
    lifetime?.status.available ? lifetime.totals : null
  )

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
        note: `across ${stats.chartsPlayed.toLocaleString()} ${stats.chartsPlayed === 1 ? 'chart' : 'charts'}`,
        // The one figure on the page a reader is most likely to try to add to another, so the
        // hover says what the block below the tiles says: it is a part of the lifetime count,
        // not a second count beside it.
        title: lifetimeTotals
          ? 'Plays Encore watched happen. Clone Hero counted every one of them too, so these are already inside the lifetime total above and are never added to it.'
          : undefined
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
        // Not "BEST SCORE": once the lifetime block is on the page there are two best scores,
        // drawn from two records, and two tiles with one label is the confusion the tags are
        // there to prevent. The label carries the distinction even when the tile is read alone.
        label: 'BEST SCORE SEEN',
        value: count(stats.bestScore),
        note: 'highest single play Encore watched'
      },
      {
        label: 'LONGEST STREAK',
        value: count(stats.longestStreak),
        note: 'notes without a miss'
      }
    ]
  })

  /**
   * The lifetime block's figures, from Clone Hero's own table.
   *
   * Three tiles, not five: the table holds a play count, a chart count and a score, and there is
   * no accuracy, no streak and no combo count in it to draw. A tile per missing thing showing a
   * dash would imply Clone Hero half-recorded them.
   */
  const lifetimeTiles = $derived.by((): Tile[] => {
    const totals = lifetimeTotals
    if (!totals) return []
    return [
      {
        label: 'LIFETIME PLAYS',
        value: totals.lifetimePlays.toLocaleString(),
        note: `across ${totals.charts.toLocaleString()} ${totals.charts === 1 ? 'chart' : 'charts'}`,
        title:
          "Clone Hero's own running count for every chart it has a record of, added up. It already includes every play Encore watched, so the two counts on this page are never added together."
      },
      {
        label: 'CHARTS PLAYED',
        value: totals.charts.toLocaleString(),
        note:
          totals.chartsNotInLibrary === 0
            ? 'all of them still in your library'
            : `${totals.chartsInLibrary.toLocaleString()} still in your library`,
        title:
          'Charts Clone Hero has ever recorded a play for. A chart you have since deleted, moved or never scanned still has its record here.'
      },
      {
        label: 'BEST SCORE',
        value: count(totals.bestScore),
        // The qualifier only when there is something to qualify. With no unconfirmed rows this
        // is simply the best score in the table, and hedging it would invent a doubt.
        note:
          totals.chartsWithUnconfirmedRows > 0
            ? 'of the scores Encore can read'
            : 'highest in the table',
        title:
          'The highest score Clone Hero kept, out of the rows whose scoring Encore has checked against a real play.'
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

  /** Encore's own log has something to draw. The gate the preload comment asks for. */
  const observed = $derived(Boolean(stats && status?.available))

  /** Either record has something. Below this the page draws its empty states instead. */
  const anything = $derived(observed || lifetimeTotals !== null)

  /**
   * Whether section headings carry a source tag.
   *
   * Only with both records on the page. A tag distinguishing one source from nothing is noise,
   * and the single caveat the page shows in that state already covers every figure on it.
   */
  const tagged = $derived(observed && lifetimeTotals !== null)

  /**
   * The observed tag's text, carrying the date the record actually starts.
   *
   * A date rather than the word "recent": the whole point of the tag is that the reader can see
   * how far back the block beside it reaches without hovering anything.
   */
  const observedTag = $derived(since ? `SINCE ${since}` : "ENCORE'S LOG")

  const LIFETIME_HINT =
    "Clone Hero's own score table. Every play you have made, from before Encore existed, with no date attached to any of it."

  const observedHint = $derived(
    since
      ? `Encore's own log, which begins at the first play it saw, on ${since}.`
      : "Encore's own log of the plays it watched happen."
  )

  /** Charts that carry no Clone Hero checksum, so no play can ever be joined to them. */
  const unidentified = $derived(
    insights ? insights.coverage.inLibrary - insights.coverage.identified : 0
  )

  /** Identified charts with nothing on record. Not "never played"; the page says which. */
  const unplayed = $derived(
    insights ? insights.coverage.identified - insights.coverage.withPlay : 0
  )

  /**
   * Identified charts Clone Hero's own table has never recorded a play for.
   *
   * The lifetime counterpart of `unplayed`, and the honest shortfall once the score files are
   * readable: it is the count that a user who played for a year before installing Encore would
   * recognise as their own. Still not "never played", for the reason the sentence beside it
   * gives.
   */
  const unrecorded = $derived(
    insights && lifetimeTotals
      ? Math.max(insights.coverage.identified - lifetimeTotals.chartsInLibrary, 0)
      : 0
  )
</script>

<!--
  The source tag a section heading carries once the page draws both records.

  Rendered as a snippet rather than copied into seven headings so the wording cannot drift apart
  between them, which is the failure mode a labelling scheme has: six sections saying the same
  thing six slightly different ways stops being a scheme and goes back to being prose.
-->
{#snippet source(kind: 'lifetime' | 'observed' | 'both')}
  {#if tagged}
    <span
      class="src {kind}"
      title={kind === 'lifetime'
        ? LIFETIME_HINT
        : kind === 'observed'
          ? observedHint
          : `Both records. ${LIFETIME_HINT} ${observedHint}`}
    >
      {kind === 'lifetime' ? 'ALL TIME' : kind === 'observed' ? observedTag : 'BOTH RECORDS'}
    </span>
  {/if}
{/snippet}

<!--
  Why Encore's own log has nothing, in the words the state calls for.

  One copy, rendered either inside the log's own section (when the lifetime block is carrying
  the page) or on its own (when neither record has anything). None of the four is a fault the
  user has to fix, so none of them is worded as one.
-->
{#snippet logEmpty()}
  {#if status?.reason === 'unknownPlatform'}
    Encore has no established location for Clone Hero's score file on this system, so it is not
    counting plays here.
  {:else if status?.reason === 'noFile'}
    Nothing to show yet. Clone Hero writes a score file when it finishes a song, and there is none
    at
    <span class="mono path">{where}</span>. Encore starts counting as soon as one appears.
  {:else if status?.reason === 'unreadable'}
    Something is at <span class="mono path">{where}</span>
    but Encore could not read it. A file caught mid-save looks exactly like this and fixes itself on the
    next song.
  {:else}
    Encore is watching <span class="mono path">{where}</span>
    and has recorded no play yet. Finish a song in Clone Hero and your totals start here.
  {/if}
{/snippet}

<div class="stats selectable">
  <h1>Your plays</h1>

  {#if loading}
    <p class="status" role="status">LOADING…</p>
  {:else if error}
    <p class="err" role="status">Encore could not read your play history: {error}</p>
  {:else if anything}
    <!-- Above every number on the page, deliberately. A user who reads one figure and stops has
         still read this, and a user who reads only this has not been misled about anything.
         Which sentence it is depends on how many records are behind the page: with two, this is
         the legend for the tags on the headings and nothing more; with one, it is the same
         blanket caveat the page has always carried, which is correct when everything below it
         does come from the one place. -->
    <p class="caveat">
      {#if tagged}
        Two records feed this page and they do not reach back the same distance. Clone Hero keeps
        its own play counts and best scores from long before Encore existed, and puts no date on any
        of them. Encore's log knows when you played, and only since {since}. Every block below is
        labelled with the record it was drawn from.
      {:else if lifetimeTotals}
        These are Clone Hero's own counts, kept since long before Encore was installed. They carry
        no dates, so nothing here can be placed on a calendar. Encore has watched no play of its own
        yet.
      {:else if since}
        These are not your lifetime totals. Encore counts a play only while it is running, and your
        first recorded play was {since}, so nothing you played before that is here.
      {:else}
        These are not your lifetime totals. Encore counts a play only while it is running, so
        nothing you played before you installed it is here.
      {/if}
    </p>

    {#if lifetimeTotals}
      <!-- First on the page, because it is the bigger and the older of the two records and the
           one a reader means by "how much have I played this". -->
      <section aria-labelledby="stats-lifetime">
        <h2 id="stats-lifetime">WHAT CLONE HERO KEPT {@render source('lifetime')}</h2>
        <div class="tiles">
          {#each lifetimeTiles as tile (tile.label)}
            <div class="tile lifetime" title={tile.title}>
              <span class="t-label">{tile.label}</span>
              <span class="t-value mono">{tile.value}</span>
              <span class="t-note">{tile.note}</span>
            </div>
          {/each}
        </div>
        <p class="sub-note">
          Clone Hero keeps one record per chart: how many times you played it and what you scored.
          It keeps no dates at all, so none of this can appear in the history below.
        </p>
        {#if lifetimeTotals.chartsWithUnconfirmedRows > 0}
          <!-- Not an error, and the wording works hard not to read as one. The rows are real
               records of real plays; what Encore cannot do is put a number on them. So the play
               counts above stand and only the score is withheld, which is the opposite of the
               usual "something is wrong with your data" note. -->
          <p class="sub-note">
            {lifetimeTotals.chartsWithUnconfirmedRows.toLocaleString()} of those charts also carry a score
            of a kind Encore cannot read. It scores far more per note than Clone Hero's own scoring reaches,
            which points at a score carried over from a version of the game before the scoring was settled.
            The play counts above are unaffected and correct. What is left out is a best score Encore
            cannot vouch for, and nothing is wrong with your files.
          </p>
        {/if}
      </section>
    {/if}

    {#if stats && observed}
      <section aria-labelledby="stats-totals">
        <h2 id="stats-totals">WHAT ENCORE HAS WATCHED {@render source('observed')}</h2>
        <div class="tiles">
          {#each tiles as tile (tile.label)}
            <div class="tile" title={tile.title}>
              <span class="t-label">{tile.label}</span>
              <span class="t-value mono">{tile.value}</span>
              <span class="t-note">{tile.note}</span>
            </div>
          {/each}
        </div>
        {#if lifetimeTotals}
          <!-- The sentence that stops the two blocks being added. It sits here, between them,
               rather than in the caveat at the top, because the addition is a thing a reader
               does with two figures in front of them. -->
          <p class="sub-note">
            These plays are already inside the lifetime count above, not in addition to it: Clone
            Hero counted every one of them as it happened. Adding the two would count them twice.
          </p>
        {/if}
      </section>
    {:else}
      <!-- The lifetime block is carrying the page on its own. Saying why the other half is
           missing beats leaving a reader to wonder whether the page failed to load. -->
      <section aria-labelledby="stats-nolog">
        <h2 id="stats-nolog">WHAT ENCORE HAS WATCHED</h2>
        <p class="err">{@render logEmpty()}</p>
      </section>
    {/if}

    {#if stats && chart}
      <section aria-labelledby="stats-when">
        <h2 id="stats-when">WHEN YOU PLAY {@render source('observed')}</h2>
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

    {#if stats && (stats.byInstrument.length > 0 || stats.byDifficulty.length > 0)}
      <section class="two-up" aria-labelledby="stats-what">
        <h2 id="stats-what">WHAT YOU PLAY {@render source('observed')}</h2>
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
      {#if stats && stats.topCharts.length > 0}
        <section aria-labelledby="stats-most">
          <!-- The heading a reader is most likely to take for a lifetime list, and the one the
               tag beside it is most load-bearing on: these are the charts played most SINCE
               Encore started watching, which need not be the charts played most. -->
          <h2 id="stats-most">MOST PLAYED {@render source('observed')}</h2>
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
          <h2 id="stats-recent">RECENTLY PLAYED {@render source('observed')}</h2>
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
        <h2 id="stats-library">YOUR LIBRARY, PLAYED {@render source('both')}</h2>
        <!-- The one place on this page where the difference between "Encore has not seen you
             play this" and "you have never played this" can be lost, so it is written out. The
             two shortfalls have unrelated causes: one is a chart Encore cannot identify, and no
             amount of playing fixes it.

             This block's coverage numbers were built when Encore's log was the only record, and
             with the lifetime one beside it the lead sentence would now be understating the
             library badly: the owner's log covers 15 plays and Clone Hero's table covers 144.
             So Clone Hero's count leads and Encore's follows as the subset it is. -->
        <p class="coverage">
          {#if insights.coverage.identified === 0}
            <!-- Nothing scanned, or nothing scanned since Encore started recording Clone Hero's
                 identity for a chart. Either way there is no ratio to state, and stating one
                 against a zero would read as "you have played none of your library". -->
            Nothing in your library can be matched to a play yet. Scan your library and the charts you
            play start appearing here.
          {:else if lifetimeTotals}
            <!-- Both figures are counted out of `identified` and neither is stated as a share of
                 the other. They overlap almost entirely and one is almost always the larger, but
                 "of them" would be a subset claim, and the two counts come from tables nothing
                 joins. -->
            Of the
            <span class="mono">{insights.coverage.identified.toLocaleString()}</span>
            charts in your library Encore can match a play to, Clone Hero has a record of playing
            <span class="mono">{lifetimeTotals.chartsInLibrary.toLocaleString()}</span>
            and Encore has watched
            <span class="mono">{insights.coverage.withPlay.toLocaleString()}</span>
            played.
            {#if unrecorded > 0}
              The other {unrecorded.toLocaleString()} have nothing in Clone Hero's table, which is still
              not the same as never played: a play made on another machine reaches neither record.
            {/if}
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
            {#if lifetimeTotals}
              The counts are Encore's own, not Clone Hero's: its table keeps no charter beside a
              score, so this is the one block here that cannot reach back before Encore.
            {/if}
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
    <!-- Neither record has anything, which is the ordinary state for most users rather than a
         failure. Four ways for Encore's log to be empty and four for the score files, and none
         of the eight is a fault the user has to fix, so none is worded as one. -->
    <p class="err" role="status">{@render logEmpty()}</p>
    {#if lifetime && !lifetime.status.available}
      <!-- Only when the channel actually answered. A bridge that has no lifetime read at all
           leaves `lifetime` null, and inventing a sentence about files nothing looked for would
           be reporting on a search that never happened. -->
      <p class="sub-note">
        Clone Hero's own score table holds what you played before Encore, and there is nothing from
        it either:
        {#if lifetime.status.reason === 'unknownPlatform'}
          no location for it has been established on this system.
        {:else if lifetime.status.reason === 'noFile'}
          there is none at <span class="mono path">{lifetime.status.scoreDataPath}</span>.
        {:else if lifetime.status.reason === 'unreadable'}
          what is at <span class="mono path">{lifetime.status.scoreDataPath}</span>
          could not be read.
        {:else}
          Encore read it and it holds no score yet.
        {/if}
      </p>
    {/if}
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
  /* The source tag, which is the whole of how this page says which record a block came from.
     Same mono micro-caps register as the heading it sits in, boxed so it reads as a label ON
     the heading rather than as more of the heading. nowrap on the tag and a normal wrap on the
     heading, so a narrow pane drops the tag to its own line intact instead of breaking the date
     across two. */
  .src {
    display: inline-block;
    white-space: nowrap;
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 2px 5px;
    margin-left: 8px;
    line-height: var(--lh-flat);
    color: var(--text-3);
  }
  /* The lifetime tag takes the accent, the same one the FC tag takes and for the same reason:
     it is the rarer of the two and the one a reader is scanning the page to find again. The
     observed tag stays in the hairline register, because it is the page's default and a page
     where both tags shout has no emphasis left. */
  .src.lifetime {
    color: var(--accent-text);
    border-color: var(--accent);
  }
  /* A second, quieter signal on the figures themselves, for a tile read without its heading in
     view. One hairline edge, no fill: the tiles have to stay comparable at a glance, and a
     lifetime block in a different colour would read as a different kind of thing rather than
     the same kind of thing over a longer span. */
  .tile.lifetime {
    border-left: 2px solid var(--accent);
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
