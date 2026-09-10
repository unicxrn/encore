import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { artUrl } from '../../../../shared/art'

// The player wrapper lazily imports 'chart-preview' (extends HTMLElement at
// import time and crashes in node). Mock the three loader helpers it pulls out
// of the module. The wrapper drives the package's "pre-processed data" path so
// it can keep the parsed chart, rather than the one-call loadFromUrl.
const fetchSngFile = vi.fn(async () => new Uint8Array([1, 2, 3]))
const extractSngFile = vi.fn(async () => [{ fileName: 'notes.chart', data: new Uint8Array() }])
const prepareChartData = vi.fn(async () => preparedChart)
vi.mock('chart-preview', () => ({
  fetchSngFile: (...args: unknown[]) => fetchSngFile(...(args as [])),
  extractSngFile: (...args: unknown[]) => extractSngFile(...(args as [])),
  prepareChartData: (...args: unknown[]) => prepareChartData(...(args as []))
}))

/** Stands in for `prepareChartData`'s result: two sections, four notes, 100 s long. */
const preparedChart = {
  parsedChart: {
    sections: [
      { tick: 0, name: 'Intro', msTime: 0, msLength: 0 },
      { tick: 1, name: 'Chorus', msTime: 50_000, msLength: 0 }
    ],
    trackData: [
      {
        instrument: 'guitar',
        difficulty: 'expert',
        noteEventGroups: [
          [{ msTime: 0 }, { msTime: 0 }],
          [{ msTime: 50_000 }],
          [{ msTime: 99_999 }]
        ]
      }
    ]
  },
  textures: null,
  audioFiles: [],
  instrument: 'guitar',
  difficulty: 'expert',
  startDelayMs: 0,
  audioLengthMs: 100_000,
  initialSeekPercent: 0
}

interface FakeElement {
  isConnected: boolean
  shadowRoot: { appendChild: ReturnType<typeof vi.fn>; children: { textContent: string }[] }
  loadChart: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
  seek: ReturnType<typeof vi.fn>
  toggleFullscreen: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  getAttribute: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  attributes: Record<string, string>
  fire(type: string, detail: unknown): void
  /** Mimics the element writing its `volume` attribute (setVolume, ↑/↓, mute). */
  setVolumeAttribute(value: string): void
}

/** Records observers so a test can drive the wrapper's volume-attribute watcher. */
let observers: { target: unknown; notify: () => void }[]

function makeFakeElement(): FakeElement {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const shadowChildren: { textContent: string }[] = []
  const el: FakeElement = {
    // Set by the fake viewport's appendChild, cleared when the element is
    // removed. It is the real DOM property the player wrapper gates its listeners on.
    isConnected: false,
    shadowRoot: {
      appendChild: vi.fn((child: { textContent: string }) => shadowChildren.push(child)),
      children: shadowChildren
    },
    loadChart: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    setVolume: vi.fn(),
    seek: vi.fn().mockResolvedValue(undefined),
    toggleFullscreen: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener)
    }),
    attributes: {},
    getAttribute: vi.fn((name: string) => el.attributes[name] ?? null),
    remove: vi.fn(),
    fire(type: string, detail: unknown): void {
      for (const listener of listeners.get(type) ?? []) listener({ detail })
    },
    setVolumeAttribute(value: string): void {
      el.attributes.volume = value
      for (const observer of observers) if (observer.target === el) observer.notify()
    }
  }
  return el
}

/**
 * Detaches the element the way Svelte does when the pane unmounts: the DOM
 * removal runs first, and `<chart-preview-player>`'s disconnectedCallback then
 * disposes itself, emitting one last state change while the controller is
 * still subscribed.
 */
function simulateDomRemoval(el: FakeElement): void {
  el.isConnected = false
  el.fire('player-statechange', { state: 'idle', previousState: 'playing' })
}

let elements: FakeElement[]
let settingsSet: ReturnType<typeof vi.fn>

function makeViewport(): { el: HTMLElement; appendChild: ReturnType<typeof vi.fn> } {
  const appendChild = vi.fn((child: FakeElement) => {
    child.isConnected = true
  })
  return { el: { appendChild } as unknown as HTMLElement, appendChild }
}

const request = {
  title: 'Song',
  artist: 'Artist',
  artUrl: 'https://art.example/x.jpg',
  source: { kind: 'url' as const, url: 'https://files.enchor.us/abc.sng' },
  instrument: 'guitar',
  difficulty: 'expert'
}

beforeEach(() => {
  elements = []
  observers = []
  settingsSet = vi.fn().mockResolvedValue(undefined)
  ;(globalThis as Record<string, unknown>).document = {
    createElement: vi.fn((tag: string) => {
      // The wrapper also creates a <style> for the shadow root; only the player
      // element goes on the list the tests reach for.
      if (tag === 'style') return { textContent: '' }
      const el = makeFakeElement()
      elements.push(el)
      return el
    })
  }
  ;(globalThis as Record<string, unknown>).window = {
    encore: {
      settingsGet: vi.fn().mockResolvedValue({}),
      settingsSet
    }
  }
  // Node has no MutationObserver; the wrapper watches the element's `volume`
  // attribute with one because the element has no volume event.
  ;(globalThis as Record<string, unknown>).MutationObserver = class {
    private entries: { target: unknown; notify: () => void }[] = []
    constructor(private callback: () => void) {}
    observe(target: unknown): void {
      const entry = { target, notify: this.callback }
      this.entries.push(entry)
      observers.push(entry)
    }
    disconnect(): void {
      observers = observers.filter((o) => !this.entries.includes(o))
      this.entries = []
    }
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).MutationObserver
  vi.resetModules()
  vi.restoreAllMocks()
  fetchSngFile.mockClear()
  extractSngFile.mockClear()
  prepareChartData.mockClear()
})

async function importController(): Promise<typeof import('./preview-controller')> {
  return import('./preview-controller')
}

describe('preview controller', () => {
  it('openPreview appends into the registered viewport, loads, plays and wires stores', async () => {
    const ctl = await importController()
    const viewport = makeViewport()
    ctl.registerViewport(viewport.el)
    await ctl.openPreview(request)

    expect(elements).toHaveLength(1)
    const el = elements[0]
    expect(viewport.appendChild).toHaveBeenCalledWith(el)
    expect(fetchSngFile).toHaveBeenCalledWith(request.source.url, expect.anything())
    expect(prepareChartData).toHaveBeenCalledWith(
      await extractSngFile.mock.results[0].value,
      'guitar',
      'expert',
      0,
      {}
    )
    expect(el.loadChart).toHaveBeenCalledWith(preparedChart)
    // Volume comes from the settings store default (50).
    expect(el.setVolume).toHaveBeenCalledWith(50)
    expect(el.play).toHaveBeenCalledTimes(1)
    expect(get(ctl.nowPlaying)).toEqual({
      title: 'Song',
      artist: 'Artist',
      artUrl: 'https://art.example/x.jpg'
    })

    el.fire('player-statechange', { state: 'playing', previousState: 'ready' })
    expect(get(ctl.playerState)).toBe('playing')

    el.fire('player-progress', { percent: 0.25, currentMs: 30000, totalMs: 120000 })
    expect(get(ctl.progress)).toEqual({ percent: 25, currentMs: 30000, totalMs: 120000 })

    el.fire('player-error', { error: new Error('boom') })
    expect(get(ctl.playerState)).toBe('error')
  })

  it("carries a local chart's art-protocol URL into nowPlaying unchanged", async () => {
    // The player bar renders $nowPlaying.artUrl verbatim, so anything the controller does to
    // the URL (normalising, stripping the custom scheme) would silently blank the cover for
    // every local chart. Pins the pass-through.
    const ctl = await importController()
    ctl.registerViewport(makeViewport().el)
    const cover = artUrl('b'.repeat(32))
    await ctl.openPreview({ ...request, artUrl: cover })

    expect(get(ctl.nowPlaying)?.artUrl).toBe(cover)
  })

  it('openPreview rejects when no viewport is registered', async () => {
    const ctl = await importController()
    await expect(ctl.openPreview(request)).rejects.toThrow(/viewport/i)
    expect(get(ctl.nowPlaying)).toBeNull()
    expect(get(ctl.playerState)).toBe('idle')
  })

  it('a second openPreview disposes the first handle before starting the next', async () => {
    const ctl = await importController()
    const viewport = makeViewport()
    ctl.registerViewport(viewport.el)
    await ctl.openPreview(request)
    await ctl.openPreview({ ...request, title: 'Other' })

    expect(elements).toHaveLength(2)
    expect(elements[0].dispose).toHaveBeenCalledTimes(1)
    expect(elements[1].dispose).not.toHaveBeenCalled()
    expect(viewport.appendChild).toHaveBeenLastCalledWith(elements[1])
    expect(get(ctl.nowPlaying)?.title).toBe('Other')
  })

  it('unregistering the viewport closes the active preview (view-bound playback)', async () => {
    const ctl = await importController()
    const viewport = makeViewport()
    const unregister = ctl.registerViewport(viewport.el)
    await ctl.openPreview(request)

    unregister()
    expect(elements[0].dispose).toHaveBeenCalledTimes(1)
    expect(get(ctl.nowPlaying)).toBeNull()
    expect(get(ctl.playerState)).toBe('idle')
    expect(get(ctl.progress)).toBeNull()
    // With the viewport gone, a new open must reject again.
    await expect(ctl.openPreview(request)).rejects.toThrow(/viewport/i)
  })

  it('registering a new viewport flushes a stale preview even without unregistering the old one', async () => {
    // Svelte can mount the replacement viewport BEFORE destroying the old one,
    // in which case the old unregister no-ops on its container guard. The new
    // registration must still flush the handle, whose element the DOM already
    // disposed on disconnect.
    const ctl = await importController()
    const a = makeViewport()
    ctl.registerViewport(a.el)
    await ctl.openPreview(request)
    elements[0].fire('player-statechange', { state: 'playing', previousState: 'ready' })
    elements[0].fire('player-progress', { percent: 0.5, currentMs: 60000, totalMs: 120000 })

    const b = makeViewport()
    ctl.registerViewport(b.el)

    expect(elements[0].dispose).toHaveBeenCalledTimes(1)
    expect(get(ctl.nowPlaying)).toBeNull()
    expect(get(ctl.playerState)).toBe('idle')
    expect(get(ctl.progress)).toBeNull()

    // B is the live container: the next open lands there, not in A.
    await ctl.openPreview(request)
    expect(b.appendChild).toHaveBeenCalledWith(elements[1])
    expect(a.appendChild).toHaveBeenCalledTimes(1)
  })

  it('publishes whether a viewport is mounted, so the bar can cede its transport to the pane', async () => {
    // PlayerBar reads this to drop its play/seek while PreviewPane is on screen: the pane's
    // transport is the richer one (density strip, section markers, fullscreen), and two live
    // transports over one handle is the duplication this store exists to end. A handle can
    // only exist while a viewport is registered, so this is also exactly when the bar's own
    // transport could have done anything.
    const ctl = await importController()
    expect(get(ctl.viewportMounted)).toBe(false)

    const unregister = ctl.registerViewport(makeViewport().el)
    expect(get(ctl.viewportMounted)).toBe(true)

    unregister()
    expect(get(ctl.viewportMounted)).toBe(false)
  })

  it('a stale unregister does not report the replacement viewport as gone', async () => {
    // Same lifecycle ordering as the flush test above: the new pane registers before the old
    // pane's cleanup runs. The old unregister already no-ops on its container guard; it must
    // no-op on this flag too, or the bar's transport would come back under the live pane.
    const ctl = await importController()
    const unregisterA = ctl.registerViewport(makeViewport().el)
    const unregisterB = ctl.registerViewport(makeViewport().el)
    expect(get(ctl.viewportMounted)).toBe(true)

    unregisterA()
    expect(get(ctl.viewportMounted)).toBe(true)

    unregisterB()
    expect(get(ctl.viewportMounted)).toBe(false)
  })

  it('the player bar follows the chart you switch to after going back', async () => {
    // The reported bug: preview chart A, press Back, open chart B, press Play,
    // and the bottom bar stayed on A. Going Back removes the pane's DOM, and the
    // element's disconnectedCallback emits a final state change from inside
    // Svelte's removal pass. Publishing that event there threw
    // `state_unsafe_mutation`, which aborted the unmount before the viewport
    // cleanup could call closePreview: nowPlaying kept chart A forever.
    const ctl = await importController()
    const a = makeViewport()
    const unregisterA = ctl.registerViewport(a.el)
    await ctl.openPreview({ ...request, title: 'Chart A' })
    elements[0].fire('player-statechange', { state: 'playing', previousState: 'ready' })
    expect(get(ctl.nowPlaying)?.title).toBe('Chart A')

    simulateDomRemoval(elements[0])
    expect(get(ctl.playerState)).toBe('playing')
    unregisterA()
    expect(get(ctl.nowPlaying)).toBeNull()
    expect(get(ctl.playerState)).toBe('idle')

    const b = makeViewport()
    ctl.registerViewport(b.el)
    await ctl.openPreview({ ...request, title: 'Chart B', artist: 'Other' })
    expect(get(ctl.nowPlaying)).toEqual({
      title: 'Chart B',
      artist: 'Other',
      artUrl: request.artUrl
    })
    expect(b.appendChild).toHaveBeenCalledWith(elements[1])
  })

  it('togglePlay pauses while playing and plays otherwise', async () => {
    const ctl = await importController()
    const viewport = makeViewport()
    ctl.registerViewport(viewport.el)
    await ctl.openPreview(request)
    const el = elements[0]
    expect(el.play).toHaveBeenCalledTimes(1)

    el.fire('player-statechange', { state: 'playing', previousState: 'ready' })
    ctl.togglePlay()
    expect(el.pause).toHaveBeenCalledTimes(1)

    el.fire('player-statechange', { state: 'paused', previousState: 'playing' })
    ctl.togglePlay()
    expect(el.play).toHaveBeenCalledTimes(2)
  })

  it('seekTo forwards our 0-100 percent to the element 0-1 seek', async () => {
    const ctl = await importController()
    const viewport = makeViewport()
    ctl.registerViewport(viewport.el)
    await ctl.openPreview(request)
    ctl.seekTo(37)
    expect(elements[0].seek).toHaveBeenCalledWith(0.37)
  })

  it('setPlayerVolume adjusts the handle and persists previewVolume', async () => {
    const ctl = await importController()
    const viewport = makeViewport()
    ctl.registerViewport(viewport.el)
    await ctl.openPreview(request)
    ctl.setPlayerVolume(80)
    expect(elements[0].setVolume).toHaveBeenCalledWith(80)
    expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ previewVolume: 80 }))
  })

  it('setPlayerVolume can skip persistence for live drag updates', async () => {
    const ctl = await importController()
    const viewport = makeViewport()
    ctl.registerViewport(viewport.el)
    await ctl.openPreview(request)
    ctl.setPlayerVolume(65, { persist: false })
    expect(elements[0].setVolume).toHaveBeenCalledWith(65)
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it("hides the element's own control bar everywhere but fullscreen", async () => {
    // The component ships a play/volume/seek/fullscreen bar of its own, which
    // used to sit 13px above the pane's transport. Scoping the rule to
    // `:not(.fullscreen)` is the whole point: in fullscreen the pane's transport
    // is off-screen, so the component's bar has to come back.
    const ctl = await importController()
    ctl.registerViewport(makeViewport().el)
    await ctl.openPreview(request)

    const styles = elements[0].shadowRoot.children.map((c) => c.textContent)
    expect(styles).toHaveLength(1)
    expect(styles[0]).toContain('.player-container:not(.fullscreen) .controls')
    expect(styles[0]).toContain('display: none')
  })

  it("publishes the chart's sections and note density for the seek bar", async () => {
    const ctl = await importController()
    ctl.registerViewport(makeViewport().el)
    await ctl.openPreview(request)

    const map = get(ctl.chartMap)
    expect(map?.sections).toEqual([
      { msTime: 0, name: 'Intro' },
      { msTime: 50_000, name: 'Chorus' }
    ])
    // Four notes over a 100 s chart: two at 0, one at the halfway mark, one just
    // shy of the end. The buckets are uniform, so they land at 0, half and last.
    expect(map?.density.reduce((sum, n) => sum + n, 0)).toBe(4)
    expect(map?.peak).toBe(2)
    expect(map?.lengthMs).toBe(100_000)
    const buckets = map?.density ?? []
    expect(buckets[0]).toBe(2)
    expect(buckets[buckets.length / 2]).toBe(1)
    expect(buckets[buckets.length - 1]).toBe(1)
  })

  it('follows volume the element changes on its own (its ↑/↓/M shortcuts)', async () => {
    // The element owns keyboard shortcuts that call its own setVolume. Nothing
    // is dispatched, so the app's sliders would silently drift away from what
    // you hear; the `volume` attribute it writes is the only signal.
    const ctl = await importController()
    ctl.registerViewport(makeViewport().el)
    await ctl.openPreview(request)
    expect(get(ctl.playerVolume)).toBe(50)

    elements[0].setVolumeAttribute('70')
    expect(get(ctl.playerVolume)).toBe(70)

    // Out-of-range values are clamped rather than trusted.
    elements[0].setVolumeAttribute('400')
    expect(get(ctl.playerVolume)).toBe(100)
  })

  it('toggleFullscreen forwards to the element and no-ops while idle', async () => {
    const ctl = await importController()
    ctl.toggleFullscreen()
    ctl.registerViewport(makeViewport().el)
    await ctl.openPreview(request)
    ctl.toggleFullscreen()
    expect(elements[0].toggleFullscreen).toHaveBeenCalledTimes(1)
  })

  it('closePreview disposes and resets the stores to idle', async () => {
    const ctl = await importController()
    const viewport = makeViewport()
    ctl.registerViewport(viewport.el)
    await ctl.openPreview(request)
    const el = elements[0]
    el.fire('player-statechange', { state: 'playing', previousState: 'ready' })
    el.fire('player-progress', { percent: 0.5, currentMs: 60000, totalMs: 120000 })

    ctl.closePreview()
    expect(el.dispose).toHaveBeenCalledTimes(1)
    expect(get(ctl.nowPlaying)).toBeNull()
    expect(get(ctl.playerState)).toBe('idle')
    expect(get(ctl.progress)).toBeNull()
    expect(get(ctl.chartMap)).toBeNull()
    expect(get(ctl.playerVolume)).toBeNull()

    // Stale events from the disposed element no longer reach the stores.
    el.fire('player-statechange', { state: 'ended', previousState: 'playing' })
    expect(get(ctl.playerState)).toBe('idle')
  })
})
