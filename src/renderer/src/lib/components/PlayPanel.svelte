<script lang="ts">
  import { onMount } from 'svelte'
  import type { PlayDataStatus, PlayStats, TopChart } from '../../../../shared/play'
  import { playedOn } from '../../../../shared/format'
  import { encore } from '../stores/bridge'

  /**
   * Home's panel over Clone Hero's own play data.
   *
   * The one thing this component exists to get right is that its numbers are NOT the user's
   * lifetime totals. Clone Hero's scorestats.json holds exactly one play, the most recent, so
   * Encore's history begins the first time it saw that file change and there is no way to
   * recover what came before (see shared/play.ts and main/play/scorestats.ts). Someone with a
   * decade of Clone Hero behind them and a week of Encore reads "4 full combos" here, and
   * unless the panel says what window that covers, they read it as a claim about themselves.
   *
   * So the window is stated once, in prose, directly under the heading and above every figure,
   * anchored to `firstPlayedAt` because that is the date the record actually starts. Once, not
   * per tile: a caveat repeated six times is a caveat nobody finishes reading.
   */

  let status = $state<PlayDataStatus | null>(null)
  let stats = $state<PlayStats | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)

  async function load(): Promise<void> {
    try {
      const next = await encore().playStatus()
      status = next
      // The gate the preload comment asks every consumer to ask first. `playStats` on a machine
      // with no Clone Hero answers with a zeroed object, which is correct and indistinguishable
      // from "installed, played nothing", and those are two different things to say to a user.
      stats = next.available ? await encore().playStats() : null
      error = null
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
    // A play recorded while Home is open moves every number below. The event carries no payload
    // by design, so this re-reads rather than patching. The subscription is this component's:
    // nothing in App owns one, and it is dropped when Home is.
    try {
      return encore().onPlayRecorded(() => void load())
    } catch {
      // A bridge without the event still draws the panel, just without live updates.
      return undefined
    }
  })

  /** The empty-cell placeholder, the one piece of typography format.ts keeps. */
  const EMPTY = '—'

  const count = (value: number | null): string => (value === null ? EMPTY : value.toLocaleString())

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
        value: accuracy === null ? EMPTY : `${(accuracy * 100).toFixed(1)}%`,
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

  /** Artist and charter under a top-ten row, whichever of them Clone Hero recorded. */
  function topMeta(chart: TopChart): string {
    return [chart.artistName, chart.charterName].filter(Boolean).join(' · ')
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
</script>

<section class="row-block" aria-labelledby="row-plays">
  <header class="row-head">
    <h2 id="row-plays">YOUR PLAYS</h2>
  </header>

  {#if loading}
    <p class="status" role="status">LOADING…</p>
  {:else if error}
    <p class="err" role="status">Encore could not read your play history: {error}</p>
  {:else if stats && status?.available}
    <!-- Above every number, deliberately. A user who reads one tile and stops has still read
         this, and a user who reads only this has not been misled about anything. -->
    <p class="caveat">
      {#if since}
        These are not your lifetime totals. Encore counts a play only while it is running, and your
        first recorded play was {since}, so nothing you played before that is here.
      {:else}
        These are not your lifetime totals. Encore counts a play only while it is running, so
        nothing you played before you installed it is here.
      {/if}
    </p>
    <div class="tiles">
      {#each tiles as tile (tile.label)}
        <div class="tile" title={tile.title}>
          <span class="t-label">{tile.label}</span>
          <span class="t-value mono">{tile.value}</span>
          <span class="t-note">{tile.note}</span>
        </div>
      {/each}
    </div>

    {#if stats.topCharts.length > 0}
      <h3 id="row-most-played">MOST PLAYED</h3>
      <!-- These names are the ones Clone Hero wrote alongside the play, not the catalog's, so a
           chart deleted since still has its row and its name here. That is on purpose: it is
           history, and dropping it would quietly shrink the user's own record. -->
      <p class="sub-note">
        Named as Clone Hero recorded them at the time, so a chart you have since deleted is still on
        this list.
      </p>
      <ol class="top">
        {#each stats.topCharts as chart, index (chart.checksum)}
          <li class="top-row">
            <span class="rank mono">{index + 1}</span>
            <span class="song">
              <span class="name">{chart.songName ?? 'Unnamed chart'}</span>
              <span class="meta">{topMeta(chart)}</span>
            </span>
            <span class="plays mono">
              {chart.timesPlayed.toLocaleString()}
              {chart.timesPlayed === 1 ? 'play' : 'plays'}
            </span>
            <span class="score mono">{count(chart.bestScore)}</span>
          </li>
        {/each}
      </ol>
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
</section>

<style>
  /* The row heading, .status and .err match Home's other rows exactly: this is one more block
     on that page, and a panel with its own heading treatment would read as a different app. */
  .row-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 10px;
  }
  h2 {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
  }
  h3 {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
    margin-top: 18px;
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
    margin: 0 0 12px;
    max-width: 72ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .sub-note {
    margin: 6px 0 10px;
    max-width: 72ch;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  /* auto-fit rather than a fixed count: this page is a single column that follows the window,
     and five tiles wrapping to two rows beats five tiles squeezed under a narrow one. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    background: var(--surface-1);
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

  .top {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--hairline);
  }
  /* The same five-column-ish discipline the Installed list uses, one column shorter: rank,
     the song, its count and its best score. */
  .top-row {
    display: grid;
    grid-template-columns: 24px 1fr 90px 110px;
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
  .plays,
  .score {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .score {
    text-align: right;
  }
</style>
