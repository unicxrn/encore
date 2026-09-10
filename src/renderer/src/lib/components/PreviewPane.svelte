<script lang="ts">
  import { untrack } from 'svelte'
  import { albumArtUrl, chartDownloadUrl } from '../api/enchor'
  import { artUrl } from '../../../../shared/art'
  import { msToTime, fallbackChartName } from '../../../../shared/format'
  import type { LyricLine, LyricLinesResult } from '../../../../main/catalog/lyric-lines'
  import type { MatrixRow, DiffKey } from '../matrix'
  import type { PreviewSource } from '../preview/player'
  import { encore } from '../stores/bridge'
  import {
    chartMap,
    nowPlaying,
    playerError,
    playerState,
    playerVolume,
    progress,
    openPreview,
    registerViewport,
    seekTo,
    setPlayerVolume,
    toggleFullscreen,
    togglePlay
  } from '../stores/preview-controller'
  import { settings } from '../stores/settings'
  import type { ChartTarget } from './Home.svelte'

  let { target, instruments }: { target: ChartTarget; instruments: MatrixRow[] } = $props()

  interface DiffOption {
    value: string
    label: string
    key: DiffKey
  }

  // Difficulty labels carry the matrix letter so the select and the E/M/H/X
  // matrix on the Overview tab read as the same vocabulary.
  const DIFFICULTY_OPTIONS: readonly DiffOption[] = [
    { value: 'expert', label: 'Expert (X)', key: 'X' },
    { value: 'hard', label: 'Hard (H)', key: 'H' },
    { value: 'medium', label: 'Medium (M)', key: 'M' },
    { value: 'easy', label: 'Easy (E)', key: 'E' }
  ]

  // Playable instruments. Remote charts get the API's per-difficulty matrix; local charts
  // stay on their song.ini difficulty columns even though `instruments` is now populated for
  // them too, because a row scanned before the catalog stored note counts has an empty
  // matrix, and switching would silently strip its instrument list down to the guitar fallback
  // below until the user rescans. (Vocals is metadata-only, never playable.)
  const instrumentOptions = $derived.by<{ value: string; label: string }[]>(() => {
    if (target.kind === 'remote') {
      return instruments.map((row) => ({ value: row.instrument, label: row.label }))
    }
    const record = target.record
    return [
      { value: 'guitar', label: 'Guitar', diff: record.diffGuitar },
      { value: 'bass', label: 'Bass', diff: record.diffBass },
      { value: 'drums', label: 'Drums', diff: record.diffDrums },
      { value: 'keys', label: 'Keys', diff: record.diffKeys }
    ]
      .filter((entry) => entry.diff !== null)
      .map((entry) => ({ value: entry.value, label: entry.label }))
  })

  // Falls back to guitar when nothing is known. The chart may still contain a
  // guitar track the metadata never recorded, so an empty select would be worse.
  const instrumentList = $derived(
    instrumentOptions.length > 0 ? instrumentOptions : [{ value: 'guitar', label: 'Guitar' }]
  )

  let instrument = $state('guitar')
  let difficulty = $state('expert')
  let animations = $state(true)
  let readingFiles = $state(false)
  let opening = $state(false)
  // Errors raised before the controller owns a preview (reading local files).
  let openError = $state<string | null>(null)

  // Difficulties actually charted for the selected instrument, and for local charts too, now
  // that the catalog stores note counts. Deliberately NOT gated on the source: a missing row
  // already means the matrix has nothing to say about this instrument (an unscanned local
  // chart, or the guitar fallback above), and that path offers every difficulty rather than
  // none. Narrowing is safe because the $effect below re-validates the current selection
  // whenever this list changes.
  const difficultyList = $derived.by(() => {
    const row = instruments.find((r) => r.instrument === instrument)
    if (!row) return DIFFICULTY_OPTIONS
    const present = DIFFICULTY_OPTIONS.filter((opt) => row.diffs[opt.key])
    return present.length > 0 ? present : DIFFICULTY_OPTIONS
  })

  // Reset the selection whenever the chart changes, and keep it valid when the
  // instrument switch drops the currently selected difficulty.
  $effect(() => {
    const list = instrumentList
    untrack(() => {
      if (!list.some((opt) => opt.value === instrument)) instrument = list[0].value
    })
  })
  $effect(() => {
    const list = difficultyList
    untrack(() => {
      if (!list.some((opt) => opt.value === difficulty)) difficulty = list[0].value
    })
  })

  // The live volume while a preview owns one, the stored volume otherwise; both are written only
  // by the controller. Writable so a drag lands at once, and re-derived the moment either source
  // moves: the player's own shortcuts (↑/↓/M) change the live value behind this slider's back,
  // settings load asynchronously after mount, and PlayerBar's slider sits beside this one and
  // commits through the controller into settings. A pane that stopped listening once touched
  // would sit at its own last value while the bar moved on.
  let volume = $derived($playerVolume ?? $settings.previewVolume)

  let viewportEl = $state<HTMLDivElement | null>(null)
  $effect(() => {
    const el = viewportEl
    // registerViewport flushes any stale preview, so remounts are safe; its
    // returned unregister closes the preview when this pane goes away.
    return el ? registerViewport(el) : undefined
  })

  const title = $derived(
    target.kind === 'remote'
      ? target.chart.name
      : (target.record.name ?? fallbackChartName(target.record.path))
  )
  const artist = $derived(
    target.kind === 'remote' ? target.chart.artist : (target.record.artist ?? '')
  )
  // Named `coverUrl` locally so it doesn't shadow the imported `artUrl` helper. Remote charts
  // point at the API's CDN; local ones at the cached-art protocol, which is why the player bar
  // can show a cover for a chart that was never downloaded from Enchor.
  const coverUrl = $derived.by(() => {
    if (target.kind === 'local') return artUrl(target.record.albumArtMd5)
    return target.chart.albumArtMd5 ? albumArtUrl(target.chart.albumArtMd5) : null
  })

  async function buildSource(): Promise<PreviewSource> {
    if (target.kind === 'remote') {
      const chart = target.chart
      return { kind: 'url', url: chartDownloadUrl(chart.md5, chart.hasVideoBackground) }
    }
    const record = target.record
    readingFiles = true
    try {
      const files = await encore().chartReadFiles({
        path: record.path,
        chartType: record.chartType
      })
      return { kind: 'files', files }
    } finally {
      readingFiles = false
    }
  }

  async function open(): Promise<void> {
    if (opening) return
    opening = true
    openError = null
    try {
      const source = await buildSource()
      await openPreview({
        title,
        artist,
        artUrl: coverUrl,
        source,
        instrument,
        difficulty,
        animations
      })
    } catch (err) {
      openError = err instanceof Error ? err.message : String(err)
    } finally {
      opening = false
    }
  }

  // Changing a load-time option only means something once a preview exists: the
  // controller has no "reconfigure"; it reloads. So re-open with the new
  // selection when one is open, and otherwise just keep the local state for the
  // next Play press.
  function reopenIfOpen(): void {
    if ($nowPlaying === null) return
    void open()
  }

  function onPlayClick(): void {
    if ($nowPlaying === null) void open()
    else togglePlay()
  }

  function seekFraction(e: MouseEvent): number | null {
    // Same click-to-seek math as PlayerBar (three lines; a shared helper would
    // be more indirection than the arithmetic is worth).
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (rect.width === 0) return null
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  }

  function onSeekClick(e: MouseEvent): void {
    if ($nowPlaying === null) return
    const fraction = seekFraction(e)
    if (fraction !== null) seekTo(fraction * 100)
  }

  function onVolumeInput(value: number): void {
    volume = value
    setPlayerVolume(value, { persist: false })
  }

  const isPlaying = $derived($playerState === 'playing')
  const percent = $derived($progress?.percent ?? 0)
  const currentMs = $derived($progress?.currentMs ?? 0)
  const totalMs = $derived($progress?.totalMs ?? 0)

  // ─── seek-bar overlays ────────────────────────────────────────────────────
  // Everything below reads `totalMs`, which only becomes non-zero once the
  // player emits its first progress event, so every overlay is hidden for the
  // moment between the chart landing and playback starting.

  // Where the hovered point sits along the bar, 0-1; null when not hovering.
  let hoverFraction = $state<number | null>(null)

  function onSeekMove(e: MouseEvent): void {
    hoverFraction = seekFraction(e)
  }

  // The chart's own timeline can be shorter than the player's, which runs
  // to the end of the longest audio stem, whose length is only known once it has
  // decoded. The histogram is therefore drawn across the fraction of the bar its
  // buckets actually cover, rather than being stretched to fill it.
  const densityWidth = $derived(
    $chartMap && totalMs > 0 ? Math.min(100, ($chartMap.lengthMs / totalMs) * 100) : 100
  )
  // How far the playhead has got THROUGH THE HISTOGRAM, which is only
  // `densityWidth` of the bar. Clipping the played copy by `percent` directly
  // would run it ahead of the playhead on any chart that ends before its audio.
  const densityPlayed = $derived(Math.min(100, (percent / densityWidth) * 100))

  /**
   * The density histogram as one filled path in a `0 0 buckets 1` viewBox, so
   * the SVG stretches to whatever width the bar happens to be. Bars hang down
   * from y=0, and every bucket is emitted as its own step, so a silent stretch
   * stays visibly silent instead of being smoothed into its neighbours.
   */
  const densityPath = $derived.by(() => {
    const map = $chartMap
    if (!map || map.peak === 0) return ''
    const parts: string[] = ['M0,0']
    for (let i = 0; i < map.density.length; i++) {
      const y = (map.density[i] / map.peak).toFixed(4)
      parts.push(`L${i},${y}`, `L${i + 1},${y}`)
    }
    parts.push(`L${map.density.length},0`, 'Z')
    return parts.join('')
  })

  // Section markers that actually land on the bar. A chart whose sections run
  // past the audio would otherwise draw ticks outside the track.
  const sectionMarks = $derived.by(() => {
    const map = $chartMap
    if (!map || totalMs <= 0) return []
    return map.sections
      .map((s, i) => ({
        key: `${i}:${s.msTime}`,
        name: s.name,
        percent: (s.msTime / totalMs) * 100
      }))
      .filter((s) => s.percent >= 0 && s.percent <= 100)
  })

  // What the two overlays are showing, spelled out. A bare histogram gives no
  // clue whether a chart genuinely has no sections or the markers just failed to
  // draw. `density` totals the notes because it counts every one of them.
  const chartSummary = $derived.by(() => {
    const map = $chartMap
    if (!map || $nowPlaying === null) return null
    const notes = map.density.reduce((sum, n) => sum + n, 0)
    const sections =
      map.sections.length > 0 ? `${map.sections.length} SECTIONS` : 'NO SECTION MARKERS'
    return `${sections} · ${notes} NOTES`
  })

  // The section under the cursor: the last one that starts at or before it.
  // `sections` is ascending by msTime, so the first one past the cursor ends it.
  const hoveredSection = $derived.by(() => {
    const at = hoverFraction
    if (at === null || totalMs <= 0) return null
    const hoverMs = at * totalMs
    let found: string | null = null
    for (const section of $chartMap?.sections ?? []) {
      if (section.msTime > hoverMs) break
      found = section.name
    }
    return found
  })

  // ─── lyrics overlay ───────────────────────────────────────────────────────
  // Off by default: the highway is the thing being previewed, and a line of text
  // over it is a choice. The toggle is disabled, never hidden, when a chart has
  // none, with the reader's reason as its title: 220 of the owner's charts are
  // .chart files and 56 .mid, and a blank overlay that could not say which
  // format or which track it failed on was the outcome this exists to avoid.

  const REMOTE_LYRICS_REASON = 'Lyrics are only read from charts in your library'
  const READING_LYRICS = 'Reading lyrics'

  let showLyrics = $state(false)
  // null while the read is in flight; the reader's own union once it lands.
  let lyrics = $state<LyricLinesResult | null>(null)
  // Bumped per target so a slow read for the previous chart cannot land under this one.
  let lyricsToken = 0

  // Read at mount rather than at Play: the toggle's state, and its reason, are worth
  // showing before playback starts, and the read is a header and one file even for
  // a .sng with a video in it. A remote chart is streamed by the player itself, so
  // main has no files to read for it.
  $effect(() => {
    if (target.kind !== 'local') {
      lyrics = null
      return
    }
    const { path, chartType } = target.record
    const token = ++lyricsToken
    lyrics = null
    encore()
      .chartLyricLines({ path, chartType })
      .then(
        (result) => {
          if (token === lyricsToken) lyrics = result
        },
        (err: unknown) => {
          if (token === lyricsToken) {
            lyrics = { none: err instanceof Error ? err.message : String(err) }
          }
        }
      )
  })

  const lyricLines = $derived(lyrics !== null && 'lines' in lyrics ? lyrics.lines : null)
  // Why the toggle is disabled, or null when it is not.
  const lyricsReason = $derived.by(() => {
    if (target.kind !== 'local') return REMOTE_LYRICS_REASON
    if (lyrics === null) return READING_LYRICS
    return 'none' in lyrics ? lyrics.none : null
  })

  /**
   * The line under `ms`, or null in the gap between two. Lines are ascending by
   * start and the player reports progress on every frame, so this is a binary
   * search for the last line that has started, then a check that it has not
   * ended. Both sides are chart time: the reader converts ticks through the same
   * tempo map the highway's notes went through, and `player-progress` reports
   * the chart clock, not the audio's.
   */
  function lineAt(lines: LyricLine[], ms: number): LyricLine | null {
    let lo = 0
    let hi = lines.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (lines[mid].ms <= ms) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (found < 0) return null
    const line = lines[found]
    return ms < line.endMs ? line : null
  }

  const currentLyric = $derived.by(() => {
    const lines = lyricLines
    if (!showLyrics || lines === null || $nowPlaying === null || $progress === null) return null
    return lineAt(lines, currentMs)
  })

  const stateLine = $derived.by(() => {
    if (readingFiles) return 'READING CHART FILES…'
    if (openError) return `ERROR: ${openError}`
    if ($playerError) return `ERROR: ${$playerError}`
    switch ($playerState) {
      case 'loading':
      case 'seeking':
        return 'LOADING…'
      case 'playing':
        return 'PLAYING'
      case 'paused':
        return 'PAUSED'
      case 'ready':
        return 'READY'
      case 'ended':
        return 'ENDED'
      case 'error':
        return 'ERROR'
      default:
        return opening ? 'LOADING…' : 'IDLE'
    }
  })
</script>

<div class="pane">
  <section class="card options">
    <h2 class="card-head mono">PREVIEW OPTIONS</h2>

    <label class="field">
      <span class="label mono">INSTRUMENT</span>
      <!-- Disabled while a load is in flight: changing the selection mid-open
           would re-enter open() against a preview that hasn't landed yet. -->
      <select
        value={instrument}
        disabled={opening}
        onchange={(e) => {
          instrument = e.currentTarget.value
          reopenIfOpen()
        }}
      >
        {#each instrumentList as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>

    <label class="field">
      <span class="label mono">DIFFICULTY</span>
      <select
        value={difficulty}
        disabled={opening}
        onchange={(e) => {
          difficulty = e.currentTarget.value
          reopenIfOpen()
        }}
      >
        {#each difficultyList as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>

    <label class="toggle">
      <span class="label mono">ANIMATIONS</span>
      <input
        type="checkbox"
        checked={animations}
        disabled={opening}
        onchange={(e) => {
          animations = e.currentTarget.checked
          reopenIfOpen()
        }}
      />
      <span class="switch" aria-hidden="true"></span>
    </label>

    <div class="field">
      <span class="label mono">VOLUME <span class="volnum">{volume}</span></span>
      <input
        class="vol"
        type="range"
        min="0"
        max="100"
        step="1"
        value={volume}
        aria-label="Preview volume"
        oninput={(e) => onVolumeInput(Number(e.currentTarget.value))}
        onchange={() => setPlayerVolume(volume)}
      />
    </div>
  </section>

  <div class="stage">
    <div class="screen">
      <div class="viewport" bind:this={viewportEl}></div>
      {#if currentLyric !== null}
        <!-- Keyed on the line so a new line remounts and replays the fade-in;
             the global reduced-motion rule in tokens.css turns that off. -->
        {#key currentLyric}
          <p class="lyric">{currentLyric.text}</p>
        {/key}
      {/if}
    </div>

    <div class="transport">
      <button
        class="play"
        class:accent={$nowPlaying !== null}
        disabled={opening}
        onclick={onPlayClick}
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
      <span class="time mono">{totalMs > 0 ? msToTime(currentMs) : '0:00'}</span>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="seek"
        class:disabled={$nowPlaying === null}
        onclick={onSeekClick}
        onmousemove={onSeekMove}
        onmouseleave={() => (hoverFraction = null)}
      >
        {#if densityPath}
          <!-- preserveAspectRatio="none": the viewBox is bucket-index by
               normalised-count, so it is meant to be stretched on both axes.
               The histogram is drawn twice, the second copy clipped to the
               played portion, so the bar reads as one object rather than a grey
               decoration sitting above a purple one. -->
          <svg
            class="density"
            style:width="{densityWidth}%"
            viewBox="0 0 {$chartMap?.density.length ?? 0} 1"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path class="rest" d={densityPath} />
            <path
              class="past"
              d={densityPath}
              style:clip-path="inset(0 {100 - densityPlayed}% 0 0)"
            />
          </svg>
        {/if}
        {#each sectionMarks as mark (mark.key)}
          <span class="mark" style:left="{mark.percent}%"></span>
        {/each}
        <div class="track">
          <div class="fill" style:width="{percent}%"></div>
        </div>
        {#if hoveredSection !== null && hoverFraction !== null}
          <span class="tip mono" style:left="{hoverFraction * 100}%">{hoveredSection}</span>
        {/if}
      </div>
      <span class="time mono">{totalMs > 0 ? msToTime(totalMs) : '0:00'}</span>
      <button
        class="chip"
        disabled={$nowPlaying === null}
        onclick={toggleFullscreen}
        title="Fullscreen (F)"
        aria-label="Toggle fullscreen preview"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"
          ><path
            d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 1-1 0v-4A1.5 1.5 0 0 1 1.5 0h4a.5.5 0 0 1 0 1h-4zM10 .5a.5.5 0 0 1 .5-.5h4A1.5 1.5 0 0 1 16 1.5v4a.5.5 0 0 1-1 0v-4a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 1-.5-.5zM.5 10a.5.5 0 0 1 .5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 1 0 1h-4A1.5 1.5 0 0 1 0 14.5v-4a.5.5 0 0 1 .5-.5zm15 0a.5.5 0 0 1 .5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a.5.5 0 0 1 0-1h4a.5.5 0 0 0 .5-.5v-4a.5.5 0 0 1 .5-.5z"
          /></svg
        >
      </button>
      <button
        class="chip lyrics"
        class:on={showLyrics}
        disabled={lyricsReason !== null}
        aria-pressed={showLyrics}
        title={lyricsReason ?? (showLyrics ? 'Hide lyrics' : 'Show lyrics')}
        onclick={() => (showLyrics = !showLyrics)}
      >
        Lyrics
      </button>
    </div>

    <div class="status">
      <p class="state mono">{stateLine}</p>
      {#if chartSummary}
        <p class="legend mono">{chartSummary}</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .pane {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 18px;
    align-items: start;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px;
  }
  .card-head {
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .volnum {
    color: var(--text-2);
    margin-left: 4px;
  }
  select {
    appearance: none;
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    color: var(--text-1);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 7px 10px;
    cursor: pointer;
    transition: border-color var(--t-fast) var(--ease);
  }
  select:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  select:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Checkbox styled as a switch: the input stays in the DOM (and focusable),
     the visual track/knob is the sibling span. */
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    cursor: pointer;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .switch {
    position: relative;
    width: 32px;
    height: 18px;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    transition: background var(--t-fast) var(--ease);
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-3);
    transition:
      transform var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .toggle input:checked + .switch {
    background: var(--accent);
    border-color: transparent;
  }
  .toggle input:checked + .switch::after {
    background: #fff;
    transform: translateX(14px);
  }
  /* The checkbox is 0×0 and transparent, so the app's global focus ring would be
     drawn on nothing. It moves to the sibling that IS the control on screen,
     with the same colour and offset as everywhere else and just a different target. */
  .toggle input:focus-visible + .switch {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .vol {
    width: 100%;
    accent-color: var(--accent);
    /* Like the bar's own slider: the one control in the options card without the hand. */
    cursor: pointer;
  }

  .stage {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .screen {
    position: relative;
  }
  .viewport {
    aspect-ratio: 16 / 9;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    overflow: hidden;
  }
  /* Over the lower part of the highway, where the notes have already been hit,
     rather than the top where they appear. A scrim rather than a text shadow:
     the highway behind it is busy and coloured, and a shadow alone did not hold
     up over a full-width chord. Inert to the pointer so the player's own
     shortcuts and clicks still land. */
  .lyric {
    position: absolute;
    /* Centred by margins inside an inset box, not by left: 50% and a transform:
       an absolute box's available width stops at its own left edge, so that
       pairing capped the line at half the viewport (measured: 201px of 402
       at a 960 window, wrapping one line into four). */
    inset-inline: 6%;
    bottom: 12%;
    width: fit-content;
    margin-inline: auto;
    padding: 6px 14px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-family: var(--font-ui);
    font-size: var(--fs-heading);
    font-weight: 500;
    line-height: var(--lh-display);
    text-align: center;
    overflow-wrap: anywhere;
    pointer-events: none;
    animation: lyric-in var(--t-fast) var(--ease);
  }
  @keyframes lyric-in {
    from {
      opacity: 0;
    }
  }
  .viewport :global(chart-preview-player) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .play {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border: 1px solid var(--hairline);
    border-radius: 50%;
    background: var(--surface-1);
    color: var(--text-2);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      opacity var(--t-fast) var(--ease);
  }
  .play.accent {
    border-color: transparent;
    background: var(--accent);
    color: var(--bg);
  }
  .play:hover:not(:disabled) {
    color: var(--text-1);
  }
  .play.accent:hover:not(:disabled) {
    background: var(--accent-hi);
    color: var(--bg);
  }
  .play:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .play svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }
  .time {
    font-size: var(--fs-caption);
    color: var(--text-3);
    min-width: 4ch;
    text-align: center;
  }
  /* The only way into fullscreen now that the component's own bar is hidden
     while embedded (its F shortcut still works, but nothing advertises it). */
  .chip {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border: 1px solid var(--hairline);
    border-radius: 7px;
    background: var(--surface-1);
    color: var(--text-3);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .chip:hover:not(:disabled) {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .chip:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .chip svg {
    width: 12px;
    height: 12px;
    fill: currentColor;
  }
  /* The one chip with a word in it: a glyph for "lyrics" would need a legend. */
  .chip.lyrics {
    width: auto;
    padding: 0 9px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
  }
  .chip.lyrics.on {
    color: var(--accent-text);
    border-color: var(--accent);
  }
  /* Taller than the bare 4px track it used to be: the density histogram sits in
     the padding above the track, inside the same click/hover target. */
  .seek {
    position: relative;
    flex: 1;
    min-width: 0;
    padding: 20px 0 8px;
    cursor: pointer;
  }
  .seek.disabled {
    cursor: default;
  }
  .density {
    position: absolute;
    left: 0;
    bottom: 8px;
    height: 18px;
    display: block;
    /* Not interactive: clicks and hovers belong to .seek underneath. */
    pointer-events: none;
  }
  .density .rest {
    fill: var(--text-3);
    opacity: 0.32;
    transition: opacity var(--t-fast) var(--ease);
  }
  .density .past {
    fill: var(--accent);
    opacity: 0.85;
  }
  .seek:hover .density .rest {
    opacity: 0.55;
  }
  .track {
    height: 4px;
    border-radius: 2px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--t-fast) linear;
  }
  /* Section boundaries. They live on the histogram rather than on the 4px track:
     a chart with 30-odd sections puts a tick every few pixels, and on the track
     that reads as a dashed progress bar rather than as structure. */
  .mark {
    position: absolute;
    bottom: 8px;
    width: 1px;
    height: 18px;
    background: var(--hairline);
    pointer-events: none;
  }
  .tip {
    position: absolute;
    bottom: 26px;
    transform: translateX(-50%);
    /* Centred on the cursor, so it hangs half its width past the ends of the
       bar. The transport's furniture is fixed-width, leaving 82px of stage to
       the left of the bar (play button, gap, time) and 80px to the right (time,
       gap, fullscreen) at every pane width, measured at 520/900/1400, so
       capping at 2×80 keeps the label inside the stage even at 0% and 100%.
       The Lyrics chip added since only widens the right side.
       Longer section names ellipsise. */
    max-width: 160px;
    padding: 3px 7px;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--surface-2);
    color: var(--text-1);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }

  .status {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .state {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .legend {
    flex-shrink: 0;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
</style>
