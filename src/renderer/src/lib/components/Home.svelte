<script lang="ts" module>
  import type { ChartData } from '../api/enchor'
  import type { ChartRecord } from '../../../../shared/schemas'

  /**
   * What a Home card click hands back to App. Task 5's Detail page accepts both
   * variants: remote charts come from the Enchor API, local ones from the
   * catalog (no ChartData exists for a scanned folder).
   */
  export type ChartTarget =
    { kind: 'remote'; chart: ChartData } | { kind: 'local'; record: ChartRecord }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { albumArtUrl } from '../api/enchor'
  import { artUrl } from '../../../../shared/art'
  import { msToTime, fallbackChartName } from '../../../../shared/format'
  import { encore } from '../stores/bridge'
  import { globalQuery } from '../stores/global-search'
  import { latestCharts, loadLatestCharts } from '../stores/latest-charts'
  import { cancelScan, scanProgress, startScan } from '../stores/scan'
  import { settings } from '../stores/settings'
  import { libraryGap } from '../empty-state'
  import PlayPanel from './PlayPanel.svelte'
  import type { ViewId } from './Sidebar.svelte'

  let {
    onNavigate,
    onOpenChart
  }: {
    onNavigate: (id: ViewId) => void
    onOpenChart: (target: ChartTarget) => void
  } = $props()

  const ARTIST_COUNT = 8

  // The latest-charts row lives in a module store: App recreates Home on every
  // navigation back to it, and a component-owned fetch spent one of the API's
  // 50 requests/minute on each visit.
  const latest = $derived($latestCharts.charts)
  const latestLoading = $derived($latestCharts.loading)
  const latestError = $derived($latestCharts.error)
  // Total charts the API reports for the wildcard query, which is the only honest
  // number for the hero sub-line. Stays null (and the number is omitted) when
  // the request fails or the field is missing.
  const totalCharts = $derived($latestCharts.total)

  let local = $state<ChartRecord[]>([])
  let localLoading = $state(true)
  let localError = $state<string | null>(null)

  // Art that 404'd or failed to decode; keyed by md5 so a failed image falls back to the
  // surface-2 placeholder instead of a broken icon.
  const artFailed = new SvelteSet<string>()
  // Local covers get their own set: the same md5 can name a remote cover on the CDN and a
  // cached local one, and the two are fetched from different places, so one being gone says
  // nothing about the other.
  const localArtFailed = new SvelteSet<string>()

  const scanning = $derived($scanProgress?.status === 'running')

  // This row queries the catalog unfiltered, so an empty `local` *is* an empty catalog, and no
  // second count is needed to tell the two apart the way Installed and Asset Studio need one.
  const gap = $derived(
    libraryGap({
      folderCount: $settings.libraryFolders.length,
      libraryTotal: local.length,
      scanFinished: $scanProgress?.status === 'done'
    })
  )

  // One entry per artist in first-seen order, carrying that artist's first
  // chart so the card can reuse its album art as the avatar.
  const artists = $derived.by(() => {
    // Plain array lookup rather than a Set: at most LATEST_COUNT entries, and a
    // Set here would be flagged as non-reactive state inside a derived.
    const seen: string[] = []
    const out: { name: string; chart: ChartData }[] = []
    for (const chart of latest) {
      const name = chart.artist?.trim()
      if (!name || seen.includes(name.toLowerCase())) continue
      seen.push(name.toLowerCase())
      out.push({ name, chart })
      if (out.length === ARTIST_COUNT) break
    }
    return out
  })

  async function loadLocal(): Promise<void> {
    localLoading = true
    localError = null
    try {
      local = await encore().catalogQuery({ search: '', offset: 0, limit: 10 })
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err)
    } finally {
      localLoading = false
    }
  }

  // A scan that has stopped changes the catalog under us; refresh just that row.
  // The `mounted` guard keeps a already-'done' scan status from firing a second
  // loadLocal() on top of the onMount one.
  //
  // 'canceled' counts too: a cancelled scan keeps every row it wrote, so the catalog really has
  // moved and this row would otherwise sit stale until the next full scan.
  let mounted = false
  $effect(() => {
    const status = $scanProgress?.status
    if (mounted && (status === 'done' || status === 'canceled')) void loadLocal()
  })

  onMount(() => {
    // Independent: a network failure must still leave the library row rendered.
    // loadLatestCharts is a no-op while its cached row is fresh.
    void loadLatestCharts()
    void loadLocal()
    mounted = true
  })

  function openArtist(name: string): void {
    globalQuery.set(name)
    onNavigate('browse')
  }

  function artFor(chart: ChartData): string | null {
    if (!chart.albumArtMd5 || artFailed.has(chart.albumArtMd5)) return null
    return albumArtUrl(chart.albumArtMd5)
  }

  // The art protocol answers 404 when a row's md5 has no cached file (cache cleared, or a
  // sweep raced the catalog row) and 400 when the md5 is malformed; both arrive here as a
  // failed load, so local covers need the same failure bookkeeping as remote ones.
  function localArtFor(record: ChartRecord): string | null {
    if (!record.albumArtMd5 || localArtFailed.has(record.albumArtMd5)) return null
    return artUrl(record.albumArtMd5)
  }
</script>

<div class="home selectable">
  <section class="hero">
    <div class="hero-inner">
      <h1>
        <span class="line">Your Music.</span>
        <span class="line">Your Performance.</span>
        <span class="line accent">Elevated.</span>
      </h1>
      <p class="sub">
        {#if totalCharts !== null}
          Search <span class="mono">{totalCharts.toLocaleString()}</span> community charts on Chorus Encore
          and preview them before you download. Then keep everything you own in order.
        {:else}
          Search community charts on Chorus Encore and preview them before you download. Then keep
          everything you own in order.
        {/if}
      </p>
      <div class="hero-actions">
        <button class="btn-primary" onclick={() => onNavigate('browse')}>Explore charts</button>
        <button class="btn-ghost" disabled={scanning} onclick={() => void startScan()}>
          {#if scanning}
            Scanning… <span class="mono">{$scanProgress?.percent ?? 0}</span>%
          {:else}
            Scan library
          {/if}
        </button>
        <!-- Only while a scan is in flight. This is the view a first-run user is on for the
             whole of their first scan (Welcome closes as soon as the scan has started), so it
             needs its own way out rather than sending them to the Installed tab to find one. -->
        {#if scanning}
          <button class="btn-ghost" onclick={() => void cancelScan()}>Cancel</button>
        {/if}
      </div>
    </div>
  </section>

  <!-- First block under the hero, because it is the only thing on this page about the user
       rather than about a catalog. It owns its own gate, its own empty states and its own
       caveat; Home neither fetches for it nor knows whether it has anything to draw. -->
  <PlayPanel />

  <!-- Each row is a labelled region. A <section> with no accessible name is not
       a landmark at all, so without this the page is one undifferentiated run of
       cards and the headings are decoration. -->
  <section class="row-block" aria-labelledby="row-latest">
    <header class="row-head">
      <h2 id="row-latest">LATEST CHARTS</h2>
      <button class="see-all" onclick={() => onNavigate('browse')}>See all</button>
    </header>
    <!-- These three swap for one another as an async request settles, with
         nothing on screen to tell you it happened. role="status" is the polite
         one: it waits for a gap rather than interrupting. -->
    {#if latestLoading}
      <p class="status" role="status">LOADING…</p>
    {:else if latestError}
      <p class="err" role="status">Encore could not load the latest charts: {latestError}</p>
    {:else if latest.length === 0}
      <!-- The request succeeded and the catalog answered with nothing, which for a wildcard
           query means the service, not the user. Retrying is automatic and worth saying:
           loadLatestCharts only holds a cached row when it has charts in it, so an empty one is
           re-requested on the next visit rather than kept for the five-minute TTL. -->
      <p class="err" role="status">
        Chorus Encore returned no charts just now. This row asks again each time you open Home.
      </p>
    {:else}
      <div class="scroller">
        {#each latest as chart (chart.chartId)}
          {@const art = artFor(chart)}
          <button class="card" onclick={() => onOpenChart({ kind: 'remote', chart })}>
            {#if art}
              <img
                class="art"
                src={art}
                alt=""
                loading="lazy"
                onerror={() => chart.albumArtMd5 && artFailed.add(chart.albumArtMd5)}
              />
            {:else}
              <div class="art placeholder"></div>
            {/if}
            <span class="c-name">{chart.name}</span>
            <span class="c-artist">{chart.artist}</span>
            <span class="c-len mono">{msToTime(chart.song_length)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  {#if artists.length > 0}
    <section class="row-block" aria-labelledby="row-artists">
      <header class="row-head">
        <h2 id="row-artists">ARTISTS</h2>
      </header>
      <div class="scroller">
        {#each artists as entry (entry.name)}
          {@const art = artFor(entry.chart)}
          <button class="artist-card" onclick={() => openArtist(entry.name)}>
            {#if art}
              <img
                class="avatar"
                src={art}
                alt=""
                loading="lazy"
                onerror={() => entry.chart.albumArtMd5 && artFailed.add(entry.chart.albumArtMd5)}
              />
            {:else}
              <div class="avatar placeholder"></div>
            {/if}
            <span class="a-name">{entry.name}</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <section class="row-block" aria-labelledby="row-library">
    <header class="row-head">
      <h2 id="row-library">IN YOUR LIBRARY</h2>
      <button class="see-all" onclick={() => onNavigate('library')}>See all</button>
    </header>
    {#if localLoading}
      <p class="status" role="status">LOADING…</p>
    {:else if localError}
      <p class="err" role="status">Encore could not read the catalog: {localError}</p>
    {:else if local.length === 0}
      <p class="err" role="status">
        {#if gap === 'no-folder'}
          No library folder yet. Add your Clone Hero Songs folder in Settings, then use Scan library
          above.
        {:else if gap === 'scan-found-nothing'}
          That scan found no charts in your library folder. A chart is a folder holding notes.chart,
          notes.mid or song.ini, or a .sng file.
        {:else}
          Nothing scanned yet. Scan library above reads every chart in your library folder.
        {/if}
      </p>
    {:else}
      <div class="scroller">
        {#each local as record (record.path)}
          {@const art = localArtFor(record)}
          <button class="card" onclick={() => onOpenChart({ kind: 'local', record })}>
            {#if art}
              <img
                class="art"
                src={art}
                alt=""
                loading="lazy"
                onerror={() => record.albumArtMd5 && localArtFailed.add(record.albumArtMd5)}
              />
            {:else}
              <div class="art placeholder"></div>
            {/if}
            <span class="c-name" title={record.path}
              >{record.name ?? fallbackChartName(record.path)}</span
            >
            <span class="c-artist">{record.artist ?? ''}</span>
            <span class="c-len mono">{msToTime(record.songLength)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  .home {
    padding: 18px 20px 26px;
    display: flex;
    flex-direction: column;
    gap: 26px;
  }
  .mono {
    font-family: var(--font-mono);
  }

  /* Hero: accent gradient with a left-weighted dark overlay so the headline
     (including the accent-hi line) keeps large-text contrast. */
  .hero {
    position: relative;
    border-radius: var(--radius);
    background: var(--accent-grad);
    overflow: hidden;
    isolation: isolate;
  }
  .hero::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(0, 0, 0, 0.62) 0%, rgba(0, 0, 0, 0.18) 100%);
    z-index: -1;
  }
  .hero-inner {
    padding: 40px 40px 38px;
    max-width: 620px;
  }
  h1 {
    display: flex;
    flex-direction: column;
    font-size: var(--fs-hero);
    line-height: var(--lh-display);
    letter-spacing: var(--ls-tighter);
    font-weight: 600;
    color: #fff;
  }
  h1 .line {
    display: block;
  }
  h1 .accent {
    font-weight: 700;
    color: var(--accent-hi);
  }
  .sub {
    margin-top: 16px;
    font-size: var(--fs-emphasis);
    line-height: var(--lh-prose);
    color: rgba(255, 255, 255, 0.78);
    max-width: 460px;
  }
  .hero-actions {
    display: flex;
    gap: 10px;
    margin-top: 22px;
  }
  .btn-primary,
  .btn-ghost {
    border-radius: 7px;
    padding: 9px 20px;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .btn-primary {
    background: var(--text-1);
    border: 1px solid var(--text-1);
    color: var(--bg);
    font-weight: 600;
  }
  .btn-primary:hover {
    background: #fff;
  }
  .btn-ghost {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.34);
    color: #fff;
  }
  .btn-ghost:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.55);
  }
  .btn-ghost:disabled {
    opacity: 0.6;
    cursor: default;
  }

  /* Rows */
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
  .see-all {
    margin-left: auto;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    color: var(--text-2);
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .see-all:hover {
    color: var(--accent-hi);
  }
  .status,
  .err {
    font-size: var(--fs-secondary);
    padding: 10px 0;
  }
  .status {
    font-family: var(--font-mono);
    /* Exception: 0.1em, wider than --ls-caps. A single mono status word set alone on a
       line, where the caps tracking used for inline labels reads too tight. */
    letter-spacing: 0.1em;
    color: var(--text-3);
  }
  .err {
    color: var(--text-2);
    line-height: var(--lh-prose);
    max-width: 60ch;
  }
  .scroller {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 8px;
    /* No scrollbar rules of its own: the thin, hairline-thumbed scrollbar is set once on
       `html` in tokens.css and inherits here. The `--surface-2` thumb this row used to paint
       measured 1.3:1 against --bg, a scrollbar that was there and could not be seen. */
  }

  .card {
    flex: 0 0 150px;
    width: 150px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 8px;
    color: inherit;
    font-family: var(--font-ui);
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .card:hover {
    background: var(--surface-2);
    border-color: rgba(255, 255, 255, 0.16);
  }
  /* The background fills the box both for `.placeholder` (no art) and for a lazy image that
     has not decoded yet, so a card never flashes a transparent square as the row scrolls. */
  .art {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 6px;
    object-fit: cover;
    display: block;
    margin-bottom: 5px;
    background: var(--surface-2);
  }
  .c-name {
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-artist {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-len {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }

  .artist-card {
    flex: 0 0 96px;
    width: 96px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    background: none;
    border: 0;
    padding: 4px 0;
    color: inherit;
    font-family: var(--font-ui);
    cursor: pointer;
  }
  .avatar {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    object-fit: cover;
    border: 1px solid var(--hairline);
    display: block;
    transition: border-color var(--t-fast) var(--ease);
  }
  .avatar.placeholder {
    background: var(--surface-2);
  }
  .artist-card:hover .avatar {
    border-color: var(--accent);
  }
  .a-name {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    text-align: center;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color var(--t-fast) var(--ease);
  }
  .artist-card:hover .a-name {
    color: var(--text-1);
  }
</style>
