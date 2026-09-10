import type { ChartPreviewPlayer, Difficulty, Instrument } from 'chart-preview'

export interface PreviewSource {
  kind: 'url' | 'files'
  url?: string
  files?: { fileName: string; data: Uint8Array }[]
}

export interface PreviewConfig {
  source: PreviewSource
  instrument: string
  difficulty: string
  volume: number // 0-100
  seekPercent?: number // 0-1
  /** Highway note animations; omitted leaves the element's own default in place. */
  animations?: boolean
}

export interface PreviewProgress {
  percent: number // 0-100 (our convention; the element reports 0-1)
  currentMs: number
  totalMs: number
}

/** A `[section]` marker from the chart's event track, at its chart-time position. */
export interface ChartSection {
  msTime: number
  name: string
}

/**
 * The shape of a chart, for drawing on a seek bar. Distilled from the parsed
 * chart at load time and kept instead of it: the full `ParsedChart` holds every
 * note of every instrument at every difficulty (megabytes on a long chart) and
 * the seek bar needs a few hundred numbers.
 */
export interface ChartMap {
  /** Section markers, ascending by `msTime`. Empty when the chart has none. */
  sections: ChartSection[]
  /** Note counts in `density.length` equal buckets spanning 0…`lengthMs`. */
  density: number[]
  /** The largest single-bucket count; 0 when the track has no notes at all. */
  peak: number
  /**
   * The span `density` covers, in the same chart-time base as
   * `PreviewProgress.currentMs`. This is an estimate of the player's own
   * `chartEndTimeMs`, which is not knowable until the audio has decoded. A
   * consumer that has a live `totalMs` should scale the histogram by
   * `lengthMs / totalMs` rather than assume the two agree.
   */
  lengthMs: number
}

/**
 * Buckets across the whole chart. The seek bar is a few hundred CSS pixels wide,
 * so this is roughly one bucket per pixel at the narrow end and the SVG scales
 * the rest; finer buckets would only add noise the bar cannot resolve.
 */
const DENSITY_BUCKETS = 192

export interface PreviewHandle {
  element: HTMLElement
  /** Loads a chart and returns its seek-bar map (see `ChartMap`). */
  load(config: PreviewConfig): Promise<ChartMap>
  play(): Promise<void>
  pause(): Promise<void>
  setVolume(volume: number): void
  /** Seeks to `percent` (0-100, our convention; converted to the element's 0-1 range). */
  seek(percent: number): Promise<void>
  /** Toggles the element's own fullscreen mode (the app has no other way in). */
  toggleFullscreen(): void
  dispose(): void
  onState(cb: (state: string) => void): () => void
  onError(cb: (message: string) => void): () => void
  /**
   * Subscribes to `player-progress` events. The element's detail carries
   * `percent` in 0-1; it is normalized to 0-100 here to match the rest of the
   * app (downloads, scan) before reaching the callback.
   */
  onProgress(cb: (p: PreviewProgress) => void): () => void
  /**
   * Subscribes to volume changes the element makes on its own. Its keyboard
   * shortcuts (↑/↓/M) go straight to `setVolume` without telling anyone, and a
   * slider that ignored them would drift out of step with what you hear.
   * Reports 0-100.
   */
  onVolume(cb: (volume: number) => void): () => void
}

/**
 * Hides the web component's own transport while it is embedded in the app.
 *
 * `<chart-preview-player>` renders a 40px bar with play, volume, timestamp, seek
 * and fullscreen below its highway, and the preview pane renders its own
 * transport 13px underneath that, which is two seek bars for one player and
 * 40px of the highway spent on the redundant one. The app's transport wins because it is the
 * one that matches the rest of Encore and the one the persistent player bar
 * mirrors.
 *
 * Not hidden in fullscreen: there the app's transport is off-screen, so the
 * component's bar becomes the only transport there is. The `.fullscreen` class
 * is put on `.player-container` by the element's own fullscreenchange handler.
 *
 * The element attaches its shadow root with `{ mode: 'open' }`, so a stylesheet
 * appended after the component's own `<style>` wins on document order at equal
 * specificity. Injecting before the element is connected matters: `ChartPreview`
 * measures its container once when it is created and only re-measures on an
 * explicit `resize()`, so hiding the bar after a load would leave the canvas
 * sized for a viewport 40px shorter than the one it is now in.
 *
 * Nothing becomes unreachable. play/pause/seek/setVolume/toggleFullscreen are
 * public methods, and the keyboard shortcuts are bound to the host element
 * rather than to the hidden bar.
 */
function hideEmbeddedControls(element: ChartPreviewPlayer): void {
  const shadow = element.shadowRoot
  // The shadow root is attached in the element's constructor, so this is only
  // null if a future version stops exposing it, in which case the built-in bar
  // stays visible rather than the preview failing to open.
  if (!shadow) return
  const style = document.createElement('style')
  style.textContent = '.player-container:not(.fullscreen) .controls { display: none; }'
  shadow.appendChild(style)
}

/** Counts notes into `DENSITY_BUCKETS` buckets and keeps the section markers. */
export function buildChartMap(
  sections: readonly ChartSection[],
  noteTimesMs: readonly number[],
  lengthMs: number
): ChartMap {
  const density = new Array<number>(DENSITY_BUCKETS).fill(0)
  const span = Math.max(lengthMs, 1)
  for (const msTime of noteTimesMs) {
    // Charts do run past their audio, and a negative [Song] Offset can put a note
    // before zero; both are clamped into the end buckets rather than dropped, so
    // the histogram never loses notes it cannot place.
    const bucket = Math.floor((msTime / span) * DENSITY_BUCKETS)
    density[Math.min(DENSITY_BUCKETS - 1, Math.max(0, bucket))]++
  }
  return {
    sections: sections.map((s) => ({ msTime: s.msTime, name: s.name })),
    density,
    peak: density.reduce((max, n) => Math.max(max, n), 0),
    lengthMs: span
  }
}

/**
 * Creates a wrapped `<chart-preview-player>` element.
 *
 * The 'chart-preview' module is imported lazily here (not at the top of this
 * file) because it declares `class ChartPreviewPlayer extends HTMLElement` at
 * module scope, and importing it eagerly crashes non-browser environments (node,
 * vitest). The lazy import keeps this module safely importable anywhere; the
 * import itself registers the custom element (double-registration guarded).
 */
export async function createPreview(): Promise<PreviewHandle> {
  const { fetchSngFile, extractSngFile, prepareChartData } = await import('chart-preview')
  const element = document.createElement('chart-preview-player') as ChartPreviewPlayer
  hideEmbeddedControls(element)
  let disposed = false
  // Aborts the .sng download of a load that has been superseded or disposed.
  // The element runs one of these internally for `loadFromUrl`, which the load
  // below deliberately does not use.
  let fetching: AbortController | null = null

  /**
   * Wraps a listener so events the element emits after it has left the DOM are
   * dropped.
   *
   * `<chart-preview-player>` disposes itself in `disconnectedCallback`, and its
   * dispose emits one last `player-statechange`. Svelte runs
   * `disconnectedCallback` synchronously while it removes the DOM of a block
   * effect, so anything that callback publishes lands in the middle of Svelte's
   * render phase. A store write there reaches the `$store` signal Svelte
   * created for the player bar and throws `state_unsafe_mutation`, which aborts
   * the rest of the unmount. Verified in Chromium: the viewport cleanup never
   * ran, the player bar stayed on the previous song, and the view area was left
   * blank. The element is already detached at that point, and its dying state
   * carries nothing the UI wants, so drop it.
   */
  const whileConnected =
    (listener: (event: Event) => void) =>
    (event: Event): void => {
      if (!element.isConnected) return
      listener(event)
    }

  return {
    element,
    /**
     * Loads a chart the long way round.
     *
     * `loadFromUrl`/`loadFromChartFiles` are one-liners, but they parse the
     * chart into a local and drop it, and the parse is the only place the
     * section list and note times exist. So this runs the same three steps
     * those methods run (the "pre-processed data" path the package documents)
     * and keeps the result: fetch (url sources only), extract, prepare, then
     * hand the prepared data to the element's public `loadChart`.
     *
     * One behaviour change falls out of it: a failure while fetching, extracting
     * or preparing now rejects instead of being swallowed into the element's own
     * in-canvas error text. The controller turns the rejection into the same
     * `playerError` the element's `player-error` event would have produced, so
     * the message still reaches the pane's status line.
     */
    async load(config: PreviewConfig): Promise<ChartMap> {
      const { source, volume, seekPercent, animations } = config
      const instrument = config.instrument as Instrument
      const difficulty = config.difficulty as Difficulty

      let files: { fileName: string; data: Uint8Array }[]
      if (source.kind === 'url') {
        if (!source.url) throw new Error('Preview source of kind "url" requires a url')
        // Aborting the previous controller is a no-op once its fetch has
        // settled, so it is left in place rather than cleared on success.
        fetching?.abort()
        fetching = new AbortController()
        files = await extractSngFile(await fetchSngFile(source.url, fetching.signal))
      } else {
        if (!source.files) throw new Error('Preview source of kind "files" requires files')
        files = source.files
      }

      const prepared = await prepareChartData(
        files,
        instrument,
        difficulty,
        seekPercent ?? 0,
        animations === undefined ? {} : { animationsEnabled: animations }
      )
      await element.loadChart(prepared)
      element.setVolume(volume)

      const track = prepared.parsedChart.trackData.find(
        (t) => t.instrument === instrument && t.difficulty === difficulty
      )
      // prepareChartData throws when the requested track is missing, so this is
      // only defensive: an absent track means an empty histogram, not a failure.
      const noteTimes = track?.noteEventGroups.flatMap((group) => group.map((n) => n.msTime)) ?? []
      // Mirrors the player's own chartEndTimeMs, minus the decoded-audio length
      // it cannot know before the audio lands (see ChartMap.lengthMs).
      const lengthMs = Math.max(
        prepared.startDelayMs + prepared.audioLengthMs,
        prepared.audioLengthMs
      )
      return buildChartMap(prepared.parsedChart.sections, noteTimes, lengthMs)
    },
    play: (): Promise<void> => element.play(),
    pause: (): Promise<void> => element.pause(),
    setVolume: (volume: number): void => element.setVolume(volume),
    seek: (percent: number): Promise<void> => element.seek(percent / 100),
    toggleFullscreen: (): void => void element.toggleFullscreen(),
    dispose(): void {
      if (disposed) return
      disposed = true
      fetching?.abort()
      fetching = null
      element.dispose()
      // remove() is a no-op when the element has no parent
      element.remove()
    },
    onState(cb: (state: string) => void): () => void {
      const listener = whileConnected((event) => {
        cb((event as CustomEvent<{ state: string }>).detail.state)
      })
      element.addEventListener('player-statechange', listener)
      return () => element.removeEventListener('player-statechange', listener)
    },
    onError(cb: (message: string) => void): () => void {
      const listener = whileConnected((event) => {
        const { error } = (event as CustomEvent<{ error: unknown }>).detail
        cb(error instanceof Error ? error.message : String(error))
      })
      element.addEventListener('player-error', listener)
      return () => element.removeEventListener('player-error', listener)
    },
    onProgress(cb: (p: PreviewProgress) => void): () => void {
      const listener = whileConnected((event) => {
        const detail = (
          event as CustomEvent<{ percent: number; currentMs: number; totalMs: number }>
        ).detail
        cb({ percent: detail.percent * 100, currentMs: detail.currentMs, totalMs: detail.totalMs })
      })
      element.addEventListener('player-progress', listener)
      return () => element.removeEventListener('player-progress', listener)
    },
    onVolume(cb: (volume: number) => void): () => void {
      // The element has no volume event; its `volume` attribute is the only
      // thing that moves when a keyboard shortcut changes it, and it writes that
      // attribute from setVolume, the slider and the mute toggle alike.
      const observer = new MutationObserver(() => {
        const parsed = Number(element.getAttribute('volume'))
        if (Number.isFinite(parsed)) cb(Math.min(100, Math.max(0, parsed)))
      })
      observer.observe(element, { attributes: true, attributeFilter: ['volume'] })
      return () => observer.disconnect()
    }
  }
}
