<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { ChartRecord } from '../../../../shared/schemas'
  import { artUrl } from '../../../../shared/art'
  import { msToTime, instrumentDiff, fallbackChartName } from '../../../../shared/format'
  import { cancelScan, scanProgress, startScan } from '../stores/scan'
  import { encore } from '../stores/bridge'
  import { settings } from '../stores/settings'
  import { refreshVerdicts, verdicts } from '../stores/updates'
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
  let query = $state('')
  let timer: ReturnType<typeof setTimeout> | null = null

  const PAGE = 100

  // The art protocol answers 404 when a row's md5 has no cached file (cache cleared, or a
  // sweep raced the catalog row) and 400 when the md5 is malformed; both arrive here as a
  // failed load. Remembering the md5s that failed lets the row fall back to the placeholder
  // instead of the browser's broken-image glyph. Since an error response carries no
  // Cache-Control, it also keeps a rebuilt list (a reload, a new filter) from re-requesting a
  // URL already known to be dead. The set is per-visit: App destroys this view on navigation,
  // so coming back retries everything.
  const artFailed = new SvelteSet<string>()

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
    const filter = { search: query, offset, limit: PAGE }
    try {
      const [rows, count] = await Promise.all([
        encore().catalogQuery(filter),
        encore().catalogCount(filter)
      ])
      charts = append ? [...charts, ...rows] : rows
      total = count
      loadError = null
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
    }
  }

  async function loadLibraryTotal(): Promise<void> {
    libraryTotal = await encore().catalogCount({ search: '', offset: 0, limit: PAGE })
  }

  function onSearch(value: string): void {
    query = value
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void load(), 200)
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
    <input placeholder="Filter library…" oninput={(e) => onSearch(e.currentTarget.value)} />
    <span class="count">{total.toLocaleString()} CHARTS</span>
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
              {chart.name ?? fallbackChartName(chart.path)}
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
          </span>
          <span class="artist">{chart.artist ?? ''}</span>
        </span>
        <span class="charter">{chart.charter ?? ''}</span>
        <!-- One grid child: the each block stays inside this span so the row's five columns
             keep matching .row's five tracks. -->
        <span class="diffs mono">
          {#each diffCells(chart) as cell (cell.letter)}
            <span class="d">{cell.letter}{cell.text}</span>
          {/each}
        </span>
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
          <!-- gap is null, so the catalog holds charts and the filter box is what emptied the
               list. Deliberately does not quote the query: this branch is only reachable with
               one typed in, and repeating it adds nothing the input above does not already show. -->
          No charts match that filter. Clear it to see all {libraryTotal.toLocaleString()} charts.
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
    grid-template-columns: 32px 1fr 140px 110px 56px;
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
