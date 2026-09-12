<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { ChartRecord } from '../../../../shared/schemas'
  import { artUrl } from '../../../../shared/art'
  import { fallbackChartName, stripRichText } from '../../../../shared/format'
  import { assetJobs } from '../stores/assets'
  import { encore } from '../stores/bridge'
  import { scanProgress } from '../stores/scan'
  import { settings } from '../stores/settings'
  import { libraryGap } from '../empty-state'
  import { generateBackground } from '../background/generate'
  import AssetPicker from './AssetPicker.svelte'
  import Icon from './Icon.svelte'

  type MissingKind = 'video' | 'background' | 'albumArt' | 'lyrics'
  type PickerMode = 'video' | 'art' | 'lyrics'

  /** The four assets this view manages, in row order. Drives both the chips and the row pills. */
  const ASSET_KINDS: { kind: MissingKind; label: string; has: (c: ChartRecord) => boolean }[] = [
    { kind: 'video', label: 'Video', has: (c) => c.hasVideo },
    { kind: 'albumArt', label: 'Art', has: (c) => c.hasAlbumArt },
    { kind: 'background', label: 'Background', has: (c) => c.hasBackground },
    { kind: 'lyrics', label: 'Lyrics', has: (c) => c.hasLyrics }
  ]
  const ALL_KINDS = ASSET_KINDS.map((a) => a.kind)

  const PAGE = 100

  let charts = $state<ChartRecord[]>([])
  let total = $state(0)
  /**
   * Charts in the catalog with this view's scope, chips and search box all ignored.
   *
   * Without it the default scope ("charts missing at least one asset") answers an empty library
   * with "every chart in your library already has all four assets", a claim about charts that
   * do not exist. One count on mount is what tells the two apart.
   */
  let libraryTotal = $state(0)
  let query = $state('')
  // Default scope is the work queue, not the whole library. A list of "charts that still
  // need something" is what makes this view read differently from Installed.
  let scope = $state<'needs' | 'all'>('needs')
  let missing = $state<MissingKind[]>([])
  let selected = $state<ChartRecord | null>(null)
  let openPicker = $state<PickerMode | null>(null)
  let ytdlpInstalled = $state<boolean | null>(null)

  let timer: ReturnType<typeof setTimeout> | null = null

  /**
   * Explicit chips narrow to charts missing every kind picked (AND). With no chips, the
   * "Needs assets" scope asks for charts missing at least one of the four (OR), and the
   * "All charts" scope drops the constraint entirely.
   */
  function buildFilter(offset: number): {
    search: string
    offset: number
    limit: number
    missing?: MissingKind[]
    missingMode?: 'all' | 'any'
  } {
    // Spread copies: $state arrays are proxies, which structured clone (IPC) rejects
    // with DataCloneError.
    const base = { search: query, offset, limit: PAGE }
    if (missing.length) return { ...base, missing: [...missing] }
    if (scope === 'needs') return { ...base, missing: [...ALL_KINDS], missingMode: 'any' as const }
    return base
  }

  /**
   * A catalog query that failed, in the words it failed with. Same reasoning as Installed's:
   * a rejected query leaves `total` at 0, and 0 is what the empty state below reads as "no
   * charts", which, over a library that is merely unreadable right now, is a lie.
   */
  let loadError = $state<string | null>(null)

  async function load(append = false): Promise<void> {
    const filter = buildFilter(append ? charts.length : 0)
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

  const gap = $derived(
    libraryGap({
      folderCount: $settings.libraryFolders.length,
      libraryTotal,
      // Session-scoped, like Installed's: nothing on disk records that an earlier launch scanned.
      scanFinished: $scanProgress?.status === 'done'
    })
  )

  function onSearch(value: string): void {
    query = value
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void load(), 200)
  }

  function toggleMissing(kind: MissingKind): void {
    missing = missing.includes(kind) ? missing.filter((k) => k !== kind) : [...missing, kind]
    // A kind chip is by definition a "needs assets" question, so asking one implies the scope.
    if (missing.length) scope = 'needs'
    void load()
  }

  function setScope(next: 'needs' | 'all'): void {
    if (scope === next) return
    scope = next
    // "All charts" means no asset constraint at all; leaving chips on would contradict it.
    if (next === 'all') missing = []
    void load()
  }

  const missingCount = (chart: ChartRecord): number =>
    ASSET_KINDS.filter((a) => !a.has(chart)).length

  // The art protocol answers 404 when a row's md5 has no cached file (cache cleared, or a
  // sweep raced the catalog row) and 400 when the md5 is malformed; both arrive here as a
  // failed load. Remembering the md5s that failed lets the row fall back to the placeholder
  // instead of the browser's broken-image glyph. Since an error response carries no
  // Cache-Control, it also keeps a rebuilt list (a reload, a new filter) from re-requesting a
  // URL already known to be dead. The set is per-visit: App destroys this view on navigation,
  // so coming back retries everything.
  const artFailed = new SvelteSet<string>()

  function coverFor(chart: ChartRecord): string | null {
    return chart.albumArtMd5 && !artFailed.has(chart.albumArtMd5) ? artUrl(chart.albumArtMd5) : null
  }

  function select(chart: ChartRecord): void {
    if (selected?.path === chart.path) return
    selected = chart
    openPicker = null
    bgState = null
  }

  function togglePicker(mode: PickerMode): void {
    openPicker = openPicker === mode ? null : mode
  }

  // ── background generation ──────────────────────────────────────────────────
  let bgBusy = $state(false)
  let bgState = $state<string | null>(null)

  async function generateBg(): Promise<void> {
    const chart = selected
    if (!chart || bgBusy) return
    bgBusy = true
    bgState = 'GENERATING…'
    try {
      const files = await encore().chartReadFiles({ path: chart.path, chartType: chart.chartType })
      // Same album-art name rule as the scanner (ALBUM_ART_RE).
      const art = files.find((f) => /^album\.(png|jpe?g)$/i.test(f.fileName))
      // Not "in the chart folder": a .sng has no folder, and chartReadFiles has just listed
      // the archive's own entries.
      if (!art) throw new Error('This chart has no album.png or album.jpg to build from')
      const png = await generateBackground(art.data)
      await encore().writeBackground({
        chartPath: chart.path,
        chartType: chart.chartType,
        data: png
      })
      // Selection may have moved on while generating, so don't attach this
      // chart's result line to another chart's checklist.
      if (selected?.path === chart.path) bgState = 'BACKGROUND SAVED'
      await refreshRows([chart.path])
    } catch (err) {
      if (selected?.path === chart.path) {
        bgState = `ERROR: ${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      bgBusy = false
    }
  }

  // ── batch "Complete missing" ───────────────────────────────────────────────
  // The batch covers video + art + lyrics; background generation runs in this
  // renderer (OffscreenCanvas), so it stays the per-chart Generate action.
  const BATCH_CAP = 100

  const batchJob = $derived($assetJobs.get('asset-batch'))
  const batchRunning = $derived(batchJob?.status === 'running')
  let batchError = $state<string | null>(null)
  // The paths the running batch was handed, kept so the terminal refresh can re-index exactly
  // those charts. The progress events carry only a phase string, so this is the only record of
  // which charts changed.
  let batchPaths: string[] = []

  async function startBatch(paths: string[]): Promise<void> {
    batchError = null
    batchPaths = paths
    try {
      await encore().assetCompleteCharts(paths)
    } catch (err) {
      batchError = err instanceof Error ? err.message : String(err)
    }
  }

  async function toggleBatch(): Promise<void> {
    if (batchRunning) {
      batchError = null
      await encore().assetBatchCancel()
      return
    }
    await startBatch(charts.slice(0, BATCH_CAP).map((c) => c.path))
  }

  // Refresh once the batch reaches a terminal state. A cancelled batch is refreshed too: it
  // stopped after finishing a chart, so the charts it did reach still have new assets.
  let lastBatchStatus: string | null = null
  $effect(() => {
    const status = batchJob?.status ?? null
    if (lastBatchStatus === 'running' && status !== null && status !== 'running') {
      void refreshAfterBatch(batchPaths)
    }
    lastBatchStatus = status
  })

  // ── refresh after asset writes ─────────────────────────────────────────────
  // Every asset flag the pills and the checklist read (hasVideo, hasAlbumArt, hasBackground,
  // hasLyrics) is written by the scanner, and an asset write does not touch the catalog row.
  // So after a successful write the UI still says the asset is missing, which reads as the
  // write having silently failed. The library watcher does eventually rescan, but only after
  // its ~2s debounce plus a walk of the whole library; a `.sng` repack alone can run for
  // seconds, so no fixed delay is safe to guess at.
  //
  // Instead main re-indexes just the charts we changed and hands their rows back. The scanner
  // stays the single authority on what the flags mean. The alternative, flipping the pill
  // optimistically, is a lie the moment a write lands something the scanner would not count.
  let refreshError = $state<string | null>(null)

  function applyRow(row: ChartRecord): void {
    charts = charts.map((c) => (c.path === row.path ? row : c))
    if (selected?.path === row.path) selected = row
  }

  /**
   * Re-index `paths` and patch the rows in place.
   *
   * The list is deliberately NOT re-queried here: a chart that has just gained its last missing
   * asset would drop straight out of the "Needs assets" filter, taking the selection and the
   * open picker with it while the user is still working on it. `total` is the cost: it keeps
   * counting a chart that no longer needs anything until the next query.
   */
  async function refreshRows(paths: string[]): Promise<void> {
    refreshError = null
    // Main rejects an empty list at the IPC boundary; nothing to refresh must not surface as
    // a refresh failure.
    if (paths.length === 0) return
    try {
      for (const row of await encore().rescanCharts(paths)) applyRow(row)
    } catch (err) {
      // Not phrased as a write failure: the write already succeeded, and only the catalog
      // refresh behind it did not.
      const message = err instanceof Error ? err.message : String(err)
      refreshError = `COULD NOT REFRESH THIS CHART. SCAN THE LIBRARY AGAIN (${message})`
    }
  }

  const refreshChart = (chartPath: string): void => {
    void refreshRows([chartPath])
  }

  /**
   * After a batch: re-index the charts it ran on, then re-query the list.
   *
   * The list reload IS wanted here, because the point of "Complete missing" is to shrink the
   * queue and the user is not mid-edit on one chart. Reselecting by path keeps the detail pane
   * pointed at the same chart when the reload drops it from the filtered list.
   */
  async function refreshAfterBatch(paths: string[]): Promise<void> {
    const current = selected
    await refreshRows(paths)
    await load()
    if (!current) return
    let updated = charts.find((r) => r.path === current.path) ?? null
    if (!updated) {
      // The catalog stores what the chart says, so this one searches on the raw name. Handing
      // it the stripped name would find nothing for exactly the charts this task is about.
      const rows = await encore().catalogQuery({
        search: current.name ?? '',
        offset: 0,
        limit: PAGE
      })
      updated = rows.find((r) => r.path === current.path) ?? null
    }
    if (updated && selected?.path === current.path) selected = updated
  }

  onMount(() => {
    void load()
    void loadLibraryTotal()
    encore()
      .sidecarStatus('ytdlp')
      .then((s) => {
        ytdlpInstalled = s.installed
      })
      .catch(() => {
        ytdlpInstalled = false
      })
    return () => {
      if (timer) clearTimeout(timer)
    }
  })

  const videoDisabled = $derived(ytdlpInstalled !== true)
  const bgDisabled = $derived(bgBusy || selected?.hasAlbumArt !== true)
</script>

<div class="assets">
  <div class="left">
    <p class="intro">
      Asset Studio adds the extras Clone Hero can use to charts you already have: video backgrounds,
      album art, generated backgrounds and synced lyrics.
    </p>
    <div class="bar">
      <input placeholder="Filter charts…" oninput={(e) => onSearch(e.currentTarget.value)} />
      <span class="count">
        {total.toLocaleString()}
        {scope === 'needs' ? 'NEED ASSETS' : 'CHARTS'}
      </span>
    </div>
    <!-- Scope first: this view opens on the work queue, and showing everything is opt-in. -->
    <div class="scope" role="group" aria-label="Which charts to show">
      <!-- Which of the two is active was carried by the `.on` class alone, so it
           existed only for people who can see the accent. `aria-pressed` matches
           the missing-asset chips below rather than reaching for radio
           semantics: to a screen reader these are two toggle buttons in a named
           group, which is what they are. -->
      <button
        class="seg"
        class:on={scope === 'needs'}
        aria-pressed={scope === 'needs'}
        onclick={() => setScope('needs')}
      >
        Needs assets
      </button>
      <button
        class="seg"
        class:on={scope === 'all'}
        aria-pressed={scope === 'all'}
        onclick={() => setScope('all')}
      >
        All charts
      </button>
    </div>
    <div class="chips">
      <span class="chips-label mono">MISSING</span>
      {#each ASSET_KINDS as chip (chip.kind)}
        <button
          class="chip"
          class:on={missing.includes(chip.kind)}
          aria-pressed={missing.includes(chip.kind)}
          onclick={() => toggleMissing(chip.kind)}
        >
          {chip.label}
        </button>
      {/each}
    </div>
    <div class="batch">
      <button
        class="hairline"
        disabled={!batchRunning && total === 0}
        onclick={() => void toggleBatch()}
      >
        {batchRunning ? 'Cancel batch' : `Complete missing (${Math.min(total, 100)})`}
      </button>
      {#if !batchRunning && total > 100}
        <span class="b-hint mono">FIRST 100</span>
      {/if}
    </div>
    {#if batchJob}
      <p class="b-line mono">
        {batchJob.status === 'running'
          ? `${batchJob.phase}${batchJob.percent != null ? ` · ${batchJob.percent}%` : ''}`
          : (batchJob.message ?? batchJob.phase)}
      </p>
    {/if}
    {#if batchError}
      <p class="b-line mono" role="alert">ERROR: {batchError}</p>
    {/if}
    <!-- Beside the batch line rather than in the detail pane: a failed re-index means the asset
         state shown for every listed chart may be stale, not just the selected one. Both panes
         are on screen at once, so it is still next to the action that triggered it. -->
    {#if refreshError}
      <p class="b-line mono" role="alert">{refreshError}</p>
    {/if}
    {#if loadError}
      <!-- Home's sentence for the same failure, reused verbatim. -->
      <p class="b-line mono" role="alert">Encore could not read the catalog: {loadError}</p>
    {/if}
    <div class="list selectable">
      {#each charts as chart (chart.path)}
        {@const art = coverFor(chart)}
        <button class="row" class:sel={selected?.path === chart.path} onclick={() => select(chart)}>
          {#if art}
            <!-- Decorative: the title beside it already names the chart, so alt text here
                 would only repeat it to a screen reader. -->
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
          <!-- The four asset states are the point of the row, so they lead; the song is
               a quiet single line rather than the two-line stack Installed uses. -->
          <span class="pills">
            {#each ASSET_KINDS as asset (asset.kind)}
              {@const present = asset.has(chart)}
              <span class="pill" class:present>
                <!-- 10px, not the 12 of the caption text beside it: the mark sits on the
                     x-height, and every pixel here is paid four times over on the pills line
                     (see the narrow-pane arithmetic below). -->
                <Icon name={present ? 'check' : 'plus'} size={10} />
                {asset.label}
              </span>
            {/each}
          </span>
          <span class="song">
            <span class="title" title={chart.path}
              >{stripRichText(chart.name) || fallbackChartName(chart.path)}</span
            >
            {#if chart.artist}<span class="artist">{stripRichText(chart.artist)}</span>{/if}
          </span>
          <span class="need mono">
            {missingCount(chart) === 0 ? 'COMPLETE' : `${missingCount(chart)} MISSING`}
          </span>
        </button>
      {/each}
      {#if charts.length < total}
        <button class="more" onclick={() => void load(true)}>Load more</button>
      {/if}
      {#if total === 0 && loadError === null}
        <p class="empty">
          <!-- The library gap is asked first: "every chart already has all four assets" and "no
               charts match" are both statements about charts, and neither is true of a library
               that holds none. -->
          {#if gap === 'no-folder'}
            No library folder yet. Add your Clone Hero Songs folder in Settings, then scan it, and
            Asset Studio can fill in art, video, backgrounds and lyrics for the charts it finds.
          {:else if gap === 'empty-catalog'}
            Nothing scanned yet. Run Scan library from Installed or Home first.
          {:else if gap === 'scan-found-nothing'}
            That scan found no charts in your library folder. A chart is a folder holding
            notes.chart, notes.mid or song.ini, or a .sng file.
          {:else if scope === 'needs' && missing.length === 0 && query === ''}
            Nothing to do. Every chart in your library already has all four assets.
          {:else}
            No charts match. Change the filters, or switch to All charts.
          {/if}
        </p>
      {/if}
    </div>
  </div>

  <aside class="detail selectable">
    {#if selected}
      <div class="head">
        <div class="head-text">
          <div class="d-title" title={selected.path}>
            {stripRichText(selected.name) || fallbackChartName(selected.path)}
          </div>
          <div class="d-artist">{stripRichText(selected.artist)}</div>
        </div>
        <button
          class="btn-primary"
          disabled={batchRunning}
          title="Fill missing video, art and lyrics automatically"
          onclick={() => selected && void startBatch([selected.path])}
        >
          Complete
        </button>
      </div>

      <div class="check">
        <!-- VIDEO -->
        <div class="c-row">
          <span class="c-label mono">VIDEO</span>
          <span class="c-state mono" class:present={selected.hasVideo}>
            {#if selected.hasVideo}<Icon name="check" size={12} /> PRESENT{:else}MISSING{/if}
          </span>
          <button
            class="hairline"
            disabled={videoDisabled}
            onclick={() => togglePicker('video')}
            aria-expanded={openPicker === 'video'}
          >
            Find video
          </button>
        </div>
        {#if ytdlpInstalled === false}
          <p class="c-hint mono">INSTALL YT-DLP IN SETTINGS</p>
        {/if}
        {#if openPicker === 'video'}
          <AssetPicker mode="video" chart={selected} onAction={refreshChart} />
        {/if}

        <!-- ALBUM ART -->
        <div class="c-row">
          <span class="c-label mono">ALBUM ART</span>
          <span class="c-state mono" class:present={selected.hasAlbumArt}>
            {#if selected.hasAlbumArt}<Icon name="check" size={12} /> PRESENT{:else}MISSING{/if}
          </span>
          <button
            class="hairline"
            onclick={() => togglePicker('art')}
            aria-expanded={openPicker === 'art'}
          >
            Find art
          </button>
        </div>
        {#if openPicker === 'art'}
          <AssetPicker mode="art" chart={selected} onAction={refreshChart} />
        {/if}

        <!-- BACKGROUND -->
        <div class="c-row">
          <span class="c-label mono">BACKGROUND</span>
          <span class="c-state mono" class:present={selected.hasBackground}>
            {#if selected.hasBackground}<Icon name="check" size={12} /> PRESENT{:else}MISSING{/if}
          </span>
          <button
            class="hairline"
            disabled={bgDisabled}
            title={selected.hasAlbumArt ? undefined : 'Needs album art'}
            onclick={() => void generateBg()}
          >
            {bgBusy ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {#if !selected.hasAlbumArt}
          <p class="c-hint mono">NEEDS ALBUM ART. FIND ART FIRST</p>
        {/if}
        {#if bgState}
          <p class="c-hint mono">{bgState}</p>
        {/if}

        <!-- LYRICS -->
        <div class="c-row">
          <span class="c-label mono">LYRICS</span>
          <span class="c-state mono" class:present={selected.hasLyrics}>
            {#if selected.hasLyrics}<Icon name="check" size={12} /> PRESENT{:else}MISSING{/if}
          </span>
          <button
            class="hairline"
            onclick={() => togglePicker('lyrics')}
            aria-expanded={openPicker === 'lyrics'}
          >
            Find lyrics
          </button>
        </div>
        {#if openPicker === 'lyrics'}
          <AssetPicker mode="lyrics" chart={selected} onAction={refreshChart} />
        {/if}
      </div>
    {:else}
      <p class="empty">Select a chart to add its missing assets.</p>
    {/if}
  </aside>
</div>

<style>
  .assets {
    display: flex;
    height: 100%;
    /* Container for the narrow-pane rules at the bottom of this file. Queried on `.assets`
       rather than on `.left`, whose width is what the row actually cares about: that query
       would change `.detail`, `.left`'s width is what is left over after `.detail`, and an
       element cannot be sized by a query it feeds. `.assets` is sized by the shell alone
       (window minus the 240px sidebar), so it is a stable thing to ask. */
    container-type: inline-size;
  }
  .left {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* Purpose line: states what this view adds, so it can't be mistaken for Installed. */
  .intro {
    padding: 12px 16px 0;
    margin: 0;
    max-width: 72ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px 10px;
  }
  .scope {
    display: flex;
    gap: 4px;
    padding: 0 16px 10px;
  }
  .seg {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 5px 12px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .seg:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Active scope carries the accent: it changes what the list means, unlike the chips. */
  .seg.on {
    color: var(--text-1);
    background: var(--accent-dim);
    border-color: var(--accent);
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
  .chips {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 10px;
  }
  .chips-label {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .chip {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .chip:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Chip-on: brighter text + border on surface-2, with no accent (informational filter). */
  .chip.on {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.25);
    background: var(--surface-2);
  }
  .batch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 6px;
  }
  .b-hint {
    letter-spacing: var(--ls-caps);
    font-size: var(--fs-caption);
  }
  .b-line {
    padding: 0 16px 8px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list {
    flex: 1;
    overflow-y: auto;
    border-top: 1px solid var(--hairline);
  }
  .row {
    display: grid;
    /* Thumb, pills, song, need-count: one track each. The row's ::before selection tick is
       absolutely positioned, so it takes no track. Below a 900px pane this becomes two lines;
       see the @container block at the end of this file. */
    grid-template-columns: 32px auto 1fr auto;
    gap: 12px;
    align-items: center;
    width: 100%;
    text-align: left;
    padding: 8px 16px;
    background: none;
    border: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
    cursor: pointer;
    position: relative;
    color: inherit;
    font-family: inherit;
  }
  .row:hover:not(.sel) {
    background: var(--surface-1);
    transition: background var(--t-fast) var(--ease);
  }
  /* Selection reads as an accent wash that fades out across the row, with the
     accent tick on the leading edge. Same vocabulary as the sidebar's active
     item, without filling the row with accent. */
  .row.sel {
    background: linear-gradient(90deg, var(--accent-dim), rgba(139, 92, 246, 0));
  }
  .row.sel::before {
    content: '';
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
  }
  /* Cover and placeholder share the box so row height doesn't depend on whether art was
     cached. */
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
  /* Asset state leads the row and carries the contrast. A missing asset is the actionable
     one, so it reads brightest; a satisfied one recedes to a quiet tick. */
  .pills {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 5px;
    padding: 3px 7px;
    font-family: var(--font-ui);
    font-size: var(--fs-caption);
    line-height: var(--lh-flat);
    color: var(--text-1);
    background: var(--surface-2);
    white-space: nowrap;
  }
  .pill.present {
    border-color: var(--hairline);
    background: transparent;
    color: var(--text-3);
  }
  /* Song identity is context here, not the headline: one muted line, not Installed's stack. */
  .song {
    display: flex;
    align-items: baseline;
    gap: 7px;
    min-width: 0;
  }
  .title {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artist {
    font-size: var(--fs-caption);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
    max-width: 40%;
  }
  .need {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    white-space: nowrap;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
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
    line-height: var(--lh-prose);
  }
  .detail {
    width: 400px;
    flex-shrink: 0;
    border-left: 1px solid var(--hairline);
    overflow-y: auto;
    padding: 16px;
  }
  /* Header and checklist are both surface-1 cards, matching Detail's layout. */
  .head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 12px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 12px 14px;
  }
  .head-text {
    flex: 1;
    min-width: 0;
  }
  .d-title {
    font-size: var(--fs-emphasis);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
    overflow-wrap: anywhere;
  }
  .d-artist {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    margin-top: 2px;
  }
  .check {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 2px 14px 8px;
  }
  .c-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
  }
  .c-row:last-child {
    border-bottom: 0;
  }
  .c-label {
    /* Was 92px when `body` was 13px. These labels inherit the body size, which is
       now --fs-body (14px); measured, the longest needs 99px before it wraps. */
    width: 104px;
    flex-shrink: 0;
    letter-spacing: var(--ls-caps);
  }
  .c-state {
    flex: 1;
    /* Flex so the PRESENT tick sits on the word's centre line rather than its baseline. */
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-3);
  }
  .c-state.present {
    color: var(--text-2);
  }
  .c-hint {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    padding: 4px 0 8px;
  }
  .hairline {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    font-family: var(--font-ui);
    flex-shrink: 0;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  /* Inside the checklist card the ghost buttons sit one surface up so they
     don't disappear into the card. */
  .check .hairline {
    background: var(--surface-2);
  }
  .hairline:hover:not(:disabled) {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .hairline:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Primary action for the selected chart. */
  .btn-primary {
    border: 0;
    border-radius: 6px;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
    font-size: var(--fs-secondary);
    padding: 5px 12px;
    cursor: pointer;
    font-family: var(--font-ui);
    flex-shrink: 0;
    transition: filter var(--t-fast) var(--ease);
  }
  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .btn-primary:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* ── narrow pane: the row becomes two lines ────────────────────────────────
     The first responsive rule in the renderer, so the reasoning is here rather than assumed.
     "Pane" below means the queried container, `.assets`, which is the window minus the
     240px sidebar.

     One line does not fit a small window. The four pills never compress (`flex-shrink: 0`,
     because a clipped pill would misstate which assets a chart is missing, which is the whole
     point of the row); the thumb, the need-count and the three gaps, the row's 32px of padding
     and `.detail`'s fixed width all come off the pane before the `1fr` `.song` track gets what is
     left. So `.song` is `pane − (everything else)`, and it hits zero on a small window.

     Every number below was re-measured after the type scale landed, because the scale moved
     both sides of the arithmetic: the pills went from 240.7px to 271.0px worst-case
     (--fs-caption is 12px where they were 10.5px) and `.need` from 55.1px to 73.5px. The
     threshold and the layout underneath it both had to move with them. Re-measured again
     when the marks became icons: a 10px SVG is wider than the mono `✓` it replaced, and the
     tick and the plus are now the same width, so there is one worst case instead of two.

     Worst case for the pills line: measured by cloning a real `.pills` into an unconstrained
     probe, all four pills measure 274.5px whether present or missing (they were 271.0px with
     the `✓ ` glyph and 258.5px with `+ `). 274.5 is the number this layout has to clear, at
     any width. A 12px icon would have made it 282.5px, which at the 344px inspector below
     clears the 285.0px line by 2.5px, a rounding margin rather than a real one.

     Below a 960px pane (a ~1200px window, where the single line is down to ~100px of song)
     the row reflows: the pills keep a full-width line of their own and the title and
     need-count take a second. Measured at the 960px window minimum, rows go 49px → 59px and
     the song track measures 199.5px instead of 0.

     The threshold moved from 900px to 960px for the same reason the rest of these numbers
     did: the single line runs out ~60px earlier now that the pills and the need-count are
     both wider.

     `.detail` gives up 56px rather than the 40px it used to, and that last 16px is what keeps
     the pills honest. The pills line here spans columns 2..-1, so it measures
     `1fr + gap + need`. At a 720px pane with `.detail` at 360px that came to exactly 269.0px
     against a then-271.0px worst case, i.e. the one element that must never clip was clipping
     by 2px. At 344px the line measures 285.0px, which clears today's 274.5px by 10.5px. That
     is a real margin rather than a rounding one: the pill vocabulary is fixed at four labels,
     so 274.5px is the worst case for all time, not the worst case seen so far.

     The cost is the video picker's result title, which shares the inspector, and the art grid,
     which re-flows from 3 columns to 2. Measured: nothing in the inspector overflows at 344px.

     Rejected: letting `.pills` wrap in place. Grid hands an `auto` track its min-content
     width, and a wrapping flex row's min-content is one pill. Measured, that stacks all four
     vertically and takes the row to 103px for a narrower title than this gives. Rejected:
     truncating or hiding pills, which misreports asset status, the one thing the row exists
     to state. Rejected: spanning the pills across all three columns so they get the full
     313.0px and `.detail` keeps its 360px. It removes the track-sizing squeeze at the source
     and needs no margin at all, but the thumb then has to leave the first line, and measured
     it sets the second line's height instead (`.song` is one baseline-aligned line here, not
     Installed's stack, so it is 18px against the thumb's 32px). Rows reach 75px, half again
     the single-line height, and about five fewer charts per screen at the 960px minimum. */
  @container (max-width: 960px) {
    .detail {
      width: 344px;
    }
    .row {
      grid-template-columns: 32px minmax(0, 1fr) auto;
      row-gap: 6px;
    }
    /* Spans both lines so the 32px thumb sits inside the text height rather than setting it. */
    .thumb {
      grid-column: 1;
      grid-row: 1 / span 2;
      align-self: center;
    }
    /* Still leading, still uncompressed, now with the whole line to itself. */
    .pills {
      grid-column: 2 / -1;
      grid-row: 1;
    }
    .song {
      grid-column: 2;
      grid-row: 2;
    }
    .need {
      grid-column: 3;
      grid-row: 2;
    }
  }
</style>
