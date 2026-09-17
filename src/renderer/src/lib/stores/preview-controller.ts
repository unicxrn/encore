import { get, writable, type Writable } from 'svelte/store'
import {
  createPreview,
  type ChartMap,
  type PreviewHandle,
  type PreviewProgress,
  type PreviewSource
} from '../preview/player'
import { patchSettings, settings } from './settings'

export interface NowPlaying {
  title: string
  artist: string
  artUrl: string | null
  /**
   * The track the open preview loaded, in the words a reader uses: "Expert Guitar".
   *
   * Carried rather than derived from `instrument` and `difficulty` below, because those are the
   * keys the chart format uses ('guitarghl', 'expert') and turning them into words means owning
   * the label list a second time. The surface that opened the preview already has that list, and
   * both of them build this string from it, so the player bar names the track in the same words
   * the rail's badge and the pane's selects do.
   */
  track: string
}

export interface PreviewRequest extends NowPlaying {
  source: PreviewSource
  instrument: string
  difficulty: string
  /** Highway note animations; omitted leaves the player's own default. */
  animations?: boolean
}

/** Metadata of the preview currently owned by the controller (null when idle). */
export const nowPlaying: Writable<NowPlaying | null> = writable(null)
/** Raw player state string ('idle' | 'loading' | 'ready' | 'playing' | 'paused' | …). */
export const playerState: Writable<string> = writable('idle')
/** Progress with percent in 0-100 (see PreviewHandle.onProgress), null when idle. */
export const progress: Writable<PreviewProgress | null> = writable(null)
/** Last error message from the active preview, cleared on close/state recovery. */
export const playerError: Writable<string | null> = writable(null)
/** Section markers and note density of the loaded chart, for the seek bar. */
export const chartMap: Writable<ChartMap | null> = writable(null)
/**
 * The volume the player is actually at, 0-100.
 *
 * Not the same thing as `settings.previewVolume`: the preview element's own
 * keyboard shortcuts (↑/↓/M) change the volume without going through the app,
 * and only this store follows them. Sliders should show this while a preview is
 * open and fall back to the setting when none is.
 */
export const playerVolume: Writable<number | null> = writable(null)
/**
 * Whether a viewport is registered, which in practice means whether PreviewPane is on screen.
 *
 * PlayerBar cedes its play/pause and seek while this is true: the pane carries the richer
 * transport (note density, section markers, fullscreen) right under the thing being played, and
 * two live transports over one handle was the last visible duplication in the app. Because a
 * handle can only exist while a viewport is registered, this is also exactly the window in which
 * the bar's transport could have driven anything at all; everywhere else it is idle.
 */
export const viewportMounted: Writable<boolean> = writable(false)
/**
 * The element previews are currently appended into, or null when none is registered.
 *
 * `viewportMounted` cannot answer the question this one exists for. The app has two places a
 * highway can live now, the rail and the chart page's preview pane, and when the pane registers
 * over the rail's viewport the flag above stays true through the whole hand-over: nothing in it
 * distinguishes "still mine" from "someone else took it". A viewport that needs to know whether
 * it is still the live one compares this against its own element.
 */
export const viewportOwner: Writable<HTMLElement | null> = writable(null)
/**
 * Whether a preview that reaches its end starts again.
 *
 * Repeat one, and there is no other kind to offer: the controller holds a single handle and
 * nothing in the app hands it a list of charts, so "repeat all" would need a sequence that does
 * not exist. See PlayerBar for the same reason spelled out against shuffle.
 *
 * A mode rather than track state, so `closePreview` leaves it alone: it says how the transport
 * should behave, and the chart under it changes every time the rail is pointed somewhere new.
 * Not in settings either. `previewVolume` is stored because the volume you left is the volume
 * you want back next week; looping is a decision about the chart in front of you this minute.
 */
export const playerRepeat: Writable<boolean> = writable(false)

let handle: PreviewHandle | null = null
let unsubs: (() => void)[] = []
let container: HTMLElement | null = null
// Bumped by every open/close so a slow in-flight open can detect it was superseded.
let openToken = 0

/**
 * Registers the DOM container the preview element is appended into.
 *
 * Playback is VIEW-BOUND: `<chart-preview-player>` disposes itself in
 * disconnectedCallback, so its element cannot be moved between parents or
 * survive its viewport unmounting. The controller therefore closes the active
 * preview when the registering viewport unregisters, so navigating away stops
 * playback. This is a documented consequence of the component, not a bug.
 *
 * Registering also flushes any still-open preview up front: Svelte may mount a
 * replacement viewport BEFORE destroying the old one, and in that order the old
 * unregister no-ops on its container guard. Closing here means a stale handle
 * (whose element the DOM already disposed on disconnect) can never survive into
 * the new viewport, regardless of lifecycle ordering.
 */
export function registerViewport(el: HTMLElement): () => void {
  closePreview()
  container = el
  viewportMounted.set(true)
  viewportOwner.set(el)
  return () => {
    // The guard covers the flag too: when the replacement pane registered first, its viewport
    // is the live one, and reporting it gone would hand the bar's transport back under it.
    if (container !== el) return
    closePreview()
    container = null
    viewportMounted.set(false)
    viewportOwner.set(null)
  }
}

/** Opens a preview, replacing any existing one. Requires a registered viewport. */
export async function openPreview(req: PreviewRequest): Promise<void> {
  if (!container) throw new Error('Cannot open a preview: no viewport is registered')
  closePreview()
  const token = ++openToken
  const target = container

  nowPlaying.set({
    title: req.title,
    artist: req.artist,
    artUrl: req.artUrl,
    track: req.track
  })
  playerState.set('loading')

  const h = await createPreview()
  if (token !== openToken) {
    // Superseded (or closed) while the player module was loading.
    h.dispose()
    return
  }
  handle = h
  unsubs.push(
    h.onState((state) => {
      playerState.set(state)
      if (state !== 'error') playerError.set(null)
      // Repeat lives on the handle, not in a component: the bar is not the only surface with a
      // transport, and a chart must loop whether the bar, the rail's or the pane's is the one on
      // screen. `unsubs` is torn down by `closePreview`, so a preview handed back when the rail
      // hides cannot keep looping behind a column that is gone.
      if (state === 'ended' && get(playerRepeat)) play(h)
    }),
    h.onError((message) => {
      playerError.set(message)
      playerState.set('error')
    }),
    h.onProgress((p) => progress.set(p)),
    h.onVolume((v) => playerVolume.set(v))
  )
  // The container is an empty element Svelte never renders into; appending the
  // player's custom element there is outside Svelte's managed DOM.
  target.appendChild(h.element)

  const volume = get(settings).previewVolume
  playerVolume.set(volume)
  try {
    const map = await h.load({
      source: req.source,
      instrument: req.instrument,
      difficulty: req.difficulty,
      volume,
      ...(req.animations === undefined ? {} : { animations: req.animations })
    })
    if (token !== openToken) return
    chartMap.set(map)
    await h.play()
  } catch (err) {
    if (token !== openToken) return
    playerError.set(err instanceof Error ? err.message : String(err))
    playerState.set('error')
  }
}

/** Plays `h`, reporting a refusal the way every other transport call here does. */
function play(h: PreviewHandle): void {
  void h.play().catch((err: unknown) => {
    playerError.set(err instanceof Error ? err.message : String(err))
    playerState.set('error')
  })
}

export function togglePlay(): void {
  const h = handle
  if (!h) return
  const action = get(playerState) === 'playing' ? h.pause() : h.play()
  void action.catch((err: unknown) => {
    playerError.set(err instanceof Error ? err.message : String(err))
    playerState.set('error')
  })
}

/** Seeks the active preview; `percent` is 0-100. */
export function seekTo(percent: number): void {
  const h = handle
  if (!h) return
  const clamped = Math.min(100, Math.max(0, percent))
  // Optimistic update so the scrubber tracks the click immediately; the next
  // player-progress event overwrites it with the real position.
  progress.update((p) =>
    p ? { ...p, percent: clamped, currentMs: (clamped / 100) * p.totalMs } : p
  )
  void h.seek(clamped).catch(() => {})
}

/**
 * Turns repeat on or off.
 *
 * Turning it on after a chart has already ended starts it again at once. The alternative is a
 * control that lights up and does nothing until the next chart, which is the state the button
 * was pressed to leave.
 */
export function toggleRepeat(): void {
  const on = !get(playerRepeat)
  playerRepeat.set(on)
  if (on && handle && get(playerState) === 'ended') play(handle)
}

/** Toggles the preview's fullscreen mode; no-op when nothing is playing. */
export function toggleFullscreen(): void {
  handle?.toggleFullscreen()
}

/** Sets the preview volume (0-100); persists to settings unless `persist` is false. */
export function setPlayerVolume(volume: number, opts: { persist?: boolean } = {}): void {
  if (handle) {
    handle.setVolume(volume)
    // Synchronously, rather than waiting for the attribute observer: that only
    // fires when the attribute's value actually changes, and it is async.
    playerVolume.set(volume)
  }
  if (opts.persist === false) return
  void patchSettings({ previewVolume: volume })
}

/**
 * Disposes the active preview and resets every store to the idle state.
 *
 * `playerRepeat` is deliberately not among them: it is a transport mode, not a fact about the
 * chart that just went away, and every navigation runs through here.
 */
export function closePreview(): void {
  openToken++
  for (const unsub of unsubs) unsub()
  unsubs = []
  handle?.dispose()
  handle = null
  nowPlaying.set(null)
  playerState.set('idle')
  progress.set(null)
  playerError.set(null)
  chartMap.set(null)
  playerVolume.set(null)
}
