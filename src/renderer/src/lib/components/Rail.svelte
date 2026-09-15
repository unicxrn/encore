<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { albumArtUrl } from '../api/enchor'
  import { artUrl } from '../../../../shared/art'
  import { msToTime, fallbackChartName, stripRichText } from '../../../../shared/format'
  import { localHealth, remoteHealth, healthSummary } from '../chart-health'
  import { diffMatrix, instrumentColorVar, type DiffKey } from '../matrix'
  import { encore } from '../stores/bridge'
  import {
    nowPlaying,
    playerError,
    playerState,
    progress,
    closePreview,
    openPreview,
    registerViewport,
    seekTo,
    togglePlay,
    viewportOwner
  } from '../stores/preview-controller'
  import type { ChartTarget } from './Home.svelte'
  import type { PreviewSource } from '../preview/player'

  let { target }: { target: ChartTarget | null } = $props()

  const chart = $derived(target?.kind === 'remote' ? target.chart : null)
  const record = $derived(target?.kind === 'local' ? target.record : null)

  const title = $derived.by(() => {
    if (chart) return stripRichText(chart.name)
    if (record) return stripRichText(record.name) || fallbackChartName(record.path)
    return ''
  })
  const artist = $derived(stripRichText(chart?.artist ?? record?.artist))
  const charter = $derived(stripRichText(chart?.charter ?? record?.charter))

  let artFailed = $state(false)
  const coverUrl = $derived.by<string | null>(() => {
    if (artFailed) return null
    if (chart?.albumArtMd5) return albumArtUrl(chart.albumArtMd5)
    return artUrl(record?.albumArtMd5)
  })

  const health = $derived(record ? localHealth(record) : chart ? remoteHealth(chart) : [])
  const summary = $derived(healthSummary(health))

  // Same source, same shape, same helper as the chart page's matrix: the catalog stores note
  // counts under the field names the API returns, so one call covers both kinds of target.
  const noteCounts = $derived(chart?.notesData?.noteCounts ?? record?.noteCounts)
  const matrixRows = $derived(diffMatrix(noteCounts))

  interface DiffOption {
    value: string
    label: string
    key: DiffKey
  }

  // The letters the difficulty matrix uses, so the rail's selector and the chart page's grid
  // read as one vocabulary rather than two.
  const DIFFICULTY_OPTIONS: readonly DiffOption[] = [
    { value: 'expert', label: 'Expert (X)', key: 'X' },
    { value: 'hard', label: 'Hard (H)', key: 'H' },
    { value: 'medium', label: 'Medium (M)', key: 'M' },
    { value: 'easy', label: 'Easy (E)', key: 'E' }
  ]

  const instrumentList = $derived.by<{ value: string; label: string }[]>(() => {
    const rows = matrixRows.map((row) => ({ value: row.instrument, label: row.label }))
    if (rows.length > 0) return rows
    // A chart scanned before the catalog stored note counts has no matrix, and an empty select
    // would be worse than a guess: the chart may well hold a guitar track nothing recorded.
    return [{ value: 'guitar', label: 'Guitar' }]
  })

  const difficultyList = $derived.by<readonly DiffOption[]>(() => {
    const row = matrixRows.find((r) => r.instrument === instrument)
    if (!row) return DIFFICULTY_OPTIONS
    const present = DIFFICULTY_OPTIONS.filter((opt) => row.diffs[opt.key])
    return present.length > 0 ? present : DIFFICULTY_OPTIONS
  })

  let instrument = $state('guitar')
  const instrumentVar = $derived(instrumentColorVar(instrument))
  let difficulty = $state('expert')

  // Keep the two selections answerable by the chart in front of us. Written the way the chart
  // page's preview pane writes them, for the same reason: switching instrument can drop the
  // difficulty that was selected, and a select showing a value it no longer offers is a lie.
  $effect(() => {
    const list = instrumentList
    if (!list.some((opt) => opt.value === instrument)) instrument = list[0].value
  })
  $effect(() => {
    const list = difficultyList
    if (!list.some((opt) => opt.value === difficulty)) difficulty = list[0].value
  })

  $effect(() => {
    void target
    artFailed = false
  })

  // ─── the highway ──────────────────────────────────────────────────────────
  /**
   * The rail claims the preview viewport only while it is actually previewing.
   *
   * It cannot hold it permanently. `registerViewport` closes whatever preview is open, and
   * `viewportMounted` is what the player bar reads to decide whether to cede its transport, so
   * a rail that registered on mount would take the bar's play button away for the whole session
   * and would close the chart page's preview the moment the rail re-rendered. Claiming on the
   * first Play and letting go on close keeps both of those exactly as they were.
   *
   * `viewportOwner` is how the rail finds out it has been superseded: the chart page's pane
   * registers over this one without the mounted flag ever going false.
   *
   * One known limit, reasoned rather than measured. Below the shell's breakpoint the rail is
   * `display: none`, and a window resized under it WHILE the rail is previewing leaves a live
   * preview the player bar has ceded its transport to and the rail cannot show. The user is not
   * stuck there (Space still reaches `togglePlay`, and opening any chart's preview pane closes
   * it), and the state is unreachable except through that resize, since the rail's Play button
   * does not exist while the rail is hidden.
   */
  let viewportEl = $state<HTMLDivElement | null>(null)
  let unregister: (() => void) | null = null
  let owns = $state(false)
  let opening = $state(false)
  let openError = $state<string | null>(null)

  onMount(() => {
    const stop = viewportOwner.subscribe((owner) => {
      owns = owner !== null && owner === viewportEl
      // Superseded. The stored unregister is already a no-op against the controller's own
      // guard, so it is dropped rather than called.
      if (!owns && owner !== null) unregister = null
    })
    return () => {
      stop()
      unregister?.()
      unregister = null
    }
  })

  async function buildSource(t: ChartTarget): Promise<PreviewSource> {
    if (t.kind === 'remote') {
      const { chartDownloadUrl } = await import('../api/enchor')
      return { kind: 'url', url: chartDownloadUrl(t.chart.md5, t.chart.hasVideoBackground) }
    }
    const files = await encore().chartReadFiles({
      path: t.record.path,
      chartType: t.record.chartType
    })
    return { kind: 'files', files }
  }

  async function play(): Promise<void> {
    const t = target
    if (t === null || opening) return
    if (owns && $nowPlaying !== null) {
      togglePlay()
      return
    }
    opening = true
    openError = null
    try {
      const source = await buildSource(t)
      const el = viewportEl
      if (el === null) return
      unregister = registerViewport(el)
      await openPreview({
        title,
        artist,
        artUrl: coverUrl,
        source,
        instrument,
        difficulty
      })
    } catch (err) {
      openError = err instanceof Error ? err.message : String(err)
    } finally {
      opening = false
    }
  }

  /**
   * A new subject closes the rail's own preview.
   *
   * Without this the rail would name one chart and play another: the rail outlives every
   * navigation, so a preview it started keeps running while the user opens something else, and
   * the art, the title and the health beside it would all have moved on. Closing matches what
   * the rest of the app already does, where playback is bound to the pane that started it and
   * navigating away ends it.
   *
   * Only the rail's own preview: `owns` is false while the chart page's pane holds the
   * viewport, and reaching into that one from here would stop the highway the user is watching.
   */
  $effect(() => {
    void target
    untrack(() => {
      if (owns) closePreview()
    })
  })

  // Changing either selection reloads: the controller has no reconfigure, only an open.
  function reopenIfPlaying(): void {
    if (!owns || $nowPlaying === null) return
    void play()
  }

  const live = $derived(owns && $nowPlaying !== null)
  const isPlaying = $derived(live && $playerState === 'playing')
  const percent = $derived(live ? ($progress?.percent ?? 0) : 0)
  const currentMs = $derived(live ? ($progress?.currentMs ?? 0) : 0)
  const totalMs = $derived(live ? ($progress?.totalMs ?? 0) : 0)

  function onSeekClick(e: MouseEvent): void {
    if (!live) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (rect.width === 0) return
    seekTo(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * 100)
  }

  const stateLine = $derived.by(() => {
    if (openError !== null) return `ERROR: ${openError}`
    if (live && $playerError !== null) return `ERROR: ${$playerError}`
    if (opening) return 'OPENING…'
    if (!owns && $viewportOwner !== null) return 'PREVIEW IS ON THE CHART PAGE'
    if (live) return $playerState.toUpperCase()
    return 'READY'
  })
</script>

<!-- A complementary landmark, not a second `main`: the rail is about whatever the content pane
     is about, and a screen reader that offers it as its own region has said enough. -->
<aside class="rail" aria-label="Chart detail">
  {#if target === null}
    <!-- The rail's only empty state, and it ends for good at the first chart of the session.
         See App's `railChart` for why it is not re-entered by navigating to Settings. -->
    <div class="empty">
      <div class="empty-mark" aria-hidden="true"></div>
      <p class="empty-line">Open a chart and it stays here.</p>
      <p class="empty-note">Art, instruments, the highway and what the chart is missing.</p>
    </div>
  {:else}
    <!-- Cover beside the name rather than above it. Measured: a full-width square cover put the
         rail's content at about 920px against the 680 a default 1280x800 window gives it, so
         the column scrolled on the size most users open. Side by side it is 632px and fits,
         and the box that gets the height instead is the highway, which is the thing being
         previewed. -->
    <div class="head">
      {#if coverUrl}
        <img class="art" src={coverUrl} alt="Album art" onerror={() => (artFailed = true)} />
      {:else}
        <div class="art placeholder"></div>
      {/if}
      <div class="ident selectable">
        <!-- Deliberately not a heading. The rail restates the chart the content pane is
             already headlining, and a second <h2> carrying the same words gives a screen reader
             two headings for one song. The landmark's own label is what names this column. -->
        <p class="title" {title}>{title}</p>
        <p class="artist" title={artist}>{artist || '—'}</p>
        <p class="charter" title={charter}>{charter ? `Charted by ${charter}` : '—'}</p>
      </div>
    </div>

    <section class="preview" aria-label="Preview">
      <!-- The controller appends `<chart-preview-player>` here; Svelte never renders into it. -->
      <div class="viewport" bind:this={viewportEl}></div>
      <div class="transport">
        <button
          class="play"
          onclick={() => void play()}
          disabled={opening}
          aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
        >
          {#if isPlaying}
            <svg viewBox="0 0 24 24" aria-hidden="true"
              ><rect x="8" y="7" width="3" height="10" /><rect
                x="13"
                y="7"
                width="3"
                height="10"
              /></svg
            >
          {:else}
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5 17.5 12 9 17.5Z" /></svg>
          {/if}
        </button>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="seek" onclick={onSeekClick}>
          <div class="seek-fill" style="width:{percent}%"></div>
        </div>
        <span class="time mono">{msToTime(currentMs)} / {msToTime(totalMs)}</span>
      </div>
      <p class="state mono" role="status">{stateLine}</p>
    </section>

    <section class="picks" aria-label="Preview track">
      <label class="pick">
        <span class="pick-label mono">
          <!-- The part's colour, from the one mapping that owns it (instrumentColorVar). A
               swatch rather than a coloured label: the word has to stay readable at
               --fs-caption, and an instrument hue is chosen to be told apart from four other
               hues, not to carry 12px text. Decorative; the word beside it is the label. -->
          {#if instrumentVar}
            <span class="swatch" style="background: var({instrumentVar})" aria-hidden="true"></span>
          {/if}
          INSTRUMENT
        </span>
        <select bind:value={instrument} onchange={reopenIfPlaying}>
          {#each instrumentList as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
      <label class="pick">
        <span class="pick-label mono">DIFFICULTY</span>
        <select bind:value={difficulty} onchange={reopenIfPlaying}>
          {#each difficultyList as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
    </section>

    <section class="health" aria-label="Chart health">
      <div class="health-head">
        <span class="mono">CHART HEALTH</span>
        {#if summary}
          <span class="mono count">{summary.present}/{summary.known}</span>
        {/if}
      </div>
      <ul>
        {#each health as item (item.key)}
          <li class="health-row" data-state={item.state}>
            <span class="dot" aria-hidden="true"></span>
            <span class="health-label">{item.label}</span>
            <!-- The word, not only the dot: colour is the second signal here, never the only
                 one, and "unknown" has no colour that could carry it on its own. -->
            <span class="health-state mono"
              >{item.state === 'present'
                ? 'OK'
                : item.state === 'missing'
                  ? 'MISSING'
                  : 'UNKNOWN'}</span
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</aside>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px 16px 20px;
    border-left: 1px solid var(--hairline);
    background: var(--ground-1);
    overflow-y: auto;
  }
  .empty {
    margin: auto 0;
    text-align: center;
    padding: 0 8px;
  }
  .empty-mark {
    width: 64px;
    height: 64px;
    margin: 0 auto 14px;
    border-radius: var(--radius-lg);
    border: 1px dashed var(--border-2);
    background: var(--ground-0);
  }
  .empty-line {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    line-height: var(--lh-prose);
  }
  .empty-note {
    margin-top: 4px;
    font-size: var(--fs-caption);
    color: var(--text-3);
    line-height: var(--lh-prose);
  }
  .head {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .art {
    width: 88px;
    height: 88px;
    flex-shrink: 0;
    display: block;
    object-fit: cover;
    border-radius: var(--radius);
    background: var(--ground-2);
    box-shadow: var(--elev-2);
  }
  .art.placeholder {
    border: 1px solid var(--border-1);
  }
  .ident {
    min-width: 0;
    flex: 1;
  }
  .title {
    font-size: var(--fs-emphasis);
    font-weight: 600;
    line-height: var(--lh-snug);
    color: var(--text-1);
    /* Two lines, then ellipsis: a rail this narrow will meet titles that do not fit, and a
       title that wraps without limit pushes the highway off the bottom of the column. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .artist,
  .charter {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .charter {
    font-size: var(--fs-caption);
    color: var(--text-3);
    margin-top: 2px;
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .viewport {
    width: 100%;
    aspect-ratio: 16 / 10;
    border-radius: var(--radius);
    border: 1px solid var(--border-1);
    background: var(--ground-0);
    overflow: hidden;
  }
  .viewport :global(chart-preview-player) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .play {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--ground-1);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .play svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
  }
  .play:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .seek {
    flex: 1;
    min-width: 0;
    height: 4px;
    border-radius: 999px;
    background: var(--ground-3);
    cursor: pointer;
  }
  .seek-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
  }
  .time {
    font-size: var(--fs-caption);
    color: var(--text-3);
    flex-shrink: 0;
  }
  .state {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picks {
    display: flex;
    gap: 10px;
  }
  .pick {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pick-label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .pick select {
    width: 100%;
    background: var(--ground-0);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 5px 6px;
    cursor: pointer;
  }
  .swatch {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .health {
    background: var(--ground-2);
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    padding: 10px 12px;
    box-shadow: var(--elev-2);
  }
  .health-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .health-head .count {
    color: var(--text-2);
  }
  .health ul {
    list-style: none;
  }
  .health-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  .health-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .health-state {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-3);
  }
  .health-row[data-state='present'] .dot {
    background: var(--success);
  }
  .health-row[data-state='missing'] .dot {
    background: var(--warning);
  }
  /* Unknown keeps the neutral dot and the neutral word. It is not a warning: nobody has
     looked, and colouring it amber would send the user to the Asset Studio after a chart that
     may want nothing at all. */
  .health-row[data-state='unknown'] .dot {
    background: var(--ground-5);
    border: 1px solid var(--border-2);
  }
  .mono {
    font-family: var(--font-mono);
  }
</style>
