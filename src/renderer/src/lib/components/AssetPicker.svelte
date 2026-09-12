<script lang="ts">
  import type { ChartRecord } from '../../../../shared/schemas'
  import { msToTime, stripRichText } from '../../../../shared/format'
  import { assetJobs } from '../stores/assets'
  import { encore, type Encore } from '../stores/bridge'

  type Mode = 'video' | 'art' | 'lyrics'
  // Result shapes come from the preload surface so they stay in sync with main.
  type VideoResult = Awaited<ReturnType<Encore['videoSearch']>>[number]
  type ArtResult = Awaited<ReturnType<Encore['artSearch']>>[number]
  type LyricsResult = Awaited<ReturnType<Encore['lyricsSearch']>>[number]

  // onAction is handed the chart path rather than left to read the parent's selection: a write
  // resolves long after the user may have selected something else, and this component is
  // destroyed on that change while its in-flight promise still settles.
  let {
    mode,
    chart,
    onAction
  }: { mode: Mode; chart: ChartRecord; onAction: (chartPath: string) => void } = $props()

  // Seeds are stripped, and this is one of the places where stripping helps the search rather
  // than only the screen: iTunes, YouTube and LRCLIB have never heard of a TextMeshPro tag, so
  // a query carrying one returns nothing. The user sees these in editable inputs, so the box
  // and the request agree.
  const joinSeed = (...parts: (string | null)[]): string =>
    parts.map(stripRichText).filter(Boolean).join(' ').trim()

  // A picker instance is created fresh per open (keyed {#if} in Assets), so
  // seeding from the chart prop at init is safe.
  // svelte-ignore state_referenced_locally
  let query = $state(
    mode === 'art'
      ? joinSeed(chart.artist, chart.album ?? chart.name)
      : joinSeed(chart.artist, chart.name)
  )
  // svelte-ignore state_referenced_locally
  let lyricsArtist = $state(stripRichText(chart.artist))
  // svelte-ignore state_referenced_locally
  let lyricsTrack = $state(stripRichText(chart.name))

  let searching = $state(false)
  let searched = $state(false)
  let errorMsg = $state<string | null>(null)
  let doneMsg = $state<string | null>(null)
  let actionBusy = $state(false)
  // Set from the moment the user asks to cancel until the download's own promise settles. A
  // cancelled download rejects exactly like a failed one, so without this the picker would show
  // the user their own click back as ERROR.
  let canceling = $state(false)
  let canceledMsg = $state<string | null>(null)

  let videoResults = $state<VideoResult[]>([])
  let artResults = $state<ArtResult[]>([])
  let lyricsResults = $state<LyricsResult[]>([])

  // Main keys the video download job `video:<chartPath>`. While that job runs,
  // EVERY download button in this picker stays disabled: yt-dlp writes
  // video.<ext> into the chart folder, so concurrent downloads would race on
  // the same destination. actionBusy covers the gap before the first progress
  // event arrives (the invoke itself only resolves at job end).
  const videoJob = $derived($assetJobs.get(`video:${chart.path}`))
  const videoJobRunning = $derived(videoJob?.status === 'running')
  const busy = $derived(actionBusy || (mode === 'video' && videoJobRunning))

  const canSearch = $derived(
    mode === 'lyrics' ? lyricsTrack.trim().length > 0 : query.trim().length > 0
  )
  const resultCount = $derived(
    mode === 'video'
      ? videoResults.length
      : mode === 'art'
        ? artResults.length
        : lyricsResults.length
  )

  function fail(err: unknown): void {
    errorMsg = err instanceof Error ? err.message : String(err)
  }

  async function search(): Promise<void> {
    if (searching || !canSearch) return
    searching = true
    errorMsg = null
    doneMsg = null
    try {
      if (mode === 'video') videoResults = await encore().videoSearch(query.trim())
      else if (mode === 'art') artResults = await encore().artSearch(query.trim())
      else
        lyricsResults = await encore().lyricsSearch({
          artist: lyricsArtist.trim(),
          track: lyricsTrack.trim()
        })
      searched = true
    } catch (err) {
      fail(err)
    } finally {
      searching = false
    }
  }

  function onEnter(e: KeyboardEvent): void {
    if (e.key === 'Enter') void search()
  }

  async function act(run: () => Promise<void>, done: string): Promise<void> {
    if (busy) return
    actionBusy = true
    errorMsg = null
    doneMsg = null
    canceledMsg = null
    canceling = false
    try {
      await run()
      doneMsg = done
      onAction(chart.path)
    } catch (err) {
      // The cancel is attributed on the same terms main uses to report the job canceled rather
      // than failed: the click, not the error text. A download that failed on its own in the
      // same instant is therefore called cancelled, which is the better of the two ways to be
      // wrong here. Neither branch calls onAction, since a rejected write changed nothing to
      // re-index.
      if (canceling) canceledMsg = 'DOWNLOAD CANCELED'
      else fail(err)
    } finally {
      actionBusy = false
      canceling = false
    }
  }

  // Not gated on `busy`: `busy` is true for the whole of the download this button exists to stop.
  async function cancelVideo(): Promise<void> {
    canceling = true
    try {
      await encore().videoCancel(chart.path)
    } catch (err) {
      canceling = false
      fail(err)
    }
  }

  const downloadVideo = (id: string): Promise<void> =>
    act(
      () =>
        encore().videoDownload({
          chartPath: chart.path,
          chartType: chart.chartType,
          videoId: id
        }),
      'VIDEO SAVED'
    )

  const useArt = (url: string): Promise<void> =>
    act(async () => {
      await encore().artDownload({ chartPath: chart.path, chartType: chart.chartType, url })
    }, 'ART SAVED')

  const inject = (r: LyricsResult): Promise<void> =>
    act(
      () =>
        encore().lyricsInject({
          chartPath: chart.path,
          chartType: chart.chartType,
          syncedLyrics: r.syncedLyrics ?? ''
        }),
      'LYRICS ADDED'
    )
</script>

<div class="picker selectable">
  <div class="search">
    {#if mode === 'lyrics'}
      <input class="half" placeholder="Artist" bind:value={lyricsArtist} onkeydown={onEnter} />
      <input class="half" placeholder="Track" bind:value={lyricsTrack} onkeydown={onEnter} />
    {:else}
      <input
        placeholder={mode === 'video' ? 'Search YouTube…' : 'Search albums…'}
        bind:value={query}
        onkeydown={onEnter}
      />
    {/if}
    <button class="btn-primary" disabled={searching || !canSearch} onclick={() => void search()}>
      Search
    </button>
  </div>

  {#if mode === 'video'}
    {#each videoResults as r (r.id)}
      <div class="v-row">
        {#if r.thumbnailUrl}
          <img class="thumb" src={r.thumbnailUrl} alt="" loading="lazy" />
        {:else}
          <span class="thumb ph"></span>
        {/if}
        <span class="meta">
          <span class="m-title">{r.title}</span>
          <span class="m-sub">{r.channel ?? ''}</span>
        </span>
        <span class="dur mono">
          {r.durationSeconds !== null ? msToTime(r.durationSeconds * 1000) : '—'}
        </span>
        <!-- One "Download" per result row, and the row's title is the only
             thing that distinguishes them. Same for Use and Inject below. -->
        <button
          class="hairline"
          disabled={busy}
          aria-label="Download {r.title}"
          onclick={() => void downloadVideo(r.id)}
        >
          Download
        </button>
      </div>
    {/each}
    {#if videoJobRunning}
      <!-- Same affordance as the batch's "Cancel batch": one hairline button beside the line
           reporting the job it stops. -->
      <div class="running">
        <p class="state mono">
          {#if canceling}
            CANCELING…
          {:else}
            DOWNLOADING {videoJob?.percent != null ? `${videoJob.percent}%` : '…'}
          {/if}
        </p>
        <button class="hairline" disabled={canceling} onclick={() => void cancelVideo()}>
          Cancel download
        </button>
      </div>
    {/if}
  {:else if mode === 'art'}
    {#if artResults.length}
      <div class="grid">
        {#each artResults as r (r.fullUrl)}
          <div class="cell">
            <img src={r.thumbUrl} alt="{r.album} by {r.artist}" loading="lazy" />
            <span class="caption" title="{r.album} by {r.artist}">{r.album}</span>
            <button
              class="hairline"
              disabled={busy}
              aria-label="Use {r.album} by {r.artist}"
              onclick={() => void useArt(r.fullUrl)}
            >
              Use
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    {#each lyricsResults as r (r.id)}
      <div class="l-row">
        <span class="meta">
          <span class="m-title">{r.trackName}</span>
          <span class="m-sub">{r.artistName}</span>
        </span>
        <span class="tag mono">{r.synced ? 'SYNCED' : 'PLAIN'}</span>
        <button
          class="hairline"
          disabled={busy || !r.synced}
          aria-label="Add lyrics for {r.trackName} by {r.artistName}"
          title={r.synced ? undefined : 'Only synced lyrics can be added'}
          onclick={() => void inject(r)}
        >
          Add
        </button>
      </div>
    {/each}
  {/if}

  <!-- Everything the picker has to say about a search or a download it is
       running, in one polite live region. One region rather than a role on each
       line: they replace each other as a single piece of state, and four
       independent regions would announce a transition twice. -->
  <div role="status">
    {#if searching}
      <p class="state mono">SEARCHING…</p>
    {:else if searched && resultCount === 0 && !errorMsg}
      <p class="state mono">NO RESULTS</p>
    {/if}
    {#if errorMsg}
      <p class="state mono">ERROR: {errorMsg}</p>
    {/if}
    {#if doneMsg && !errorMsg}
      <p class="state mono">{doneMsg}</p>
    {/if}
    {#if canceledMsg && !errorMsg}
      <p class="state mono">{canceledMsg}</p>
    {/if}
  </div>
</div>

<style>
  /* Nested inside the Assets checklist card, so it sits one surface up. */
  .picker {
    margin: 6px 0 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: 10px;
  }
  .search {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  input {
    flex: 1;
    min-width: 0;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    padding: 6px 10px;
    color: var(--text-1);
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    transition: border-color var(--t-fast) var(--ease);
  }
  input:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  input.half {
    flex: 1 1 0;
  }
  .hairline {
    background: none;
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
  .hairline:hover:not(:disabled) {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .hairline:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Search is the form-level primary; the per-result actions stay ghost so a
     grid of results doesn't turn into a wall of accent. */
  .btn-primary {
    border: 0;
    border-radius: 6px;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
    font-size: var(--fs-secondary);
    padding: 5px 13px;
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
  .v-row,
  .l-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.035);
  }
  .thumb {
    width: 64px;
    height: 36px;
    object-fit: cover;
    border-radius: 4px;
    background: var(--surface-2);
    flex-shrink: 0;
  }
  .thumb.ph {
    display: inline-block;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .m-title {
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-sub {
    font-size: var(--fs-caption);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dur {
    flex-shrink: 0;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .tag {
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 1px 4px;
    letter-spacing: var(--ls-caps);
    font-size: var(--fs-caption);
    flex-shrink: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
    gap: 10px;
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 0;
    min-width: 0;
  }
  .cell img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 6px;
    background: var(--surface-2);
  }
  .caption {
    font-size: var(--fs-caption);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The running line and its cancel button share a row, so the button sits with the job it
     stops rather than under the last result. */
  .running {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .running .state {
    flex: 1;
    min-width: 0;
  }
  /* Inline state line, same register as Preview's status text: text-2 mono. */
  .state {
    padding: 6px 0 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
  }
</style>
