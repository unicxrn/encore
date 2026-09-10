import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChartMap, createPreview } from './player'

// The wrapper lazily imports 'chart-preview' (the real module extends
// HTMLElement at import time and crashes in node). Mock the three loader
// helpers it pulls out: it drives the package's documented "pre-processed data"
// path (fetch, extract, prepare, then the element's own loadChart) because
// that is the only way to keep hold of the parsed chart.
type ChartFile = { fileName: string; data: Uint8Array }
const fetchSngFile = vi.fn<(url: string, signal?: AbortSignal) => Promise<Uint8Array>>(
  async () => SNG_BYTES
)
const extractSngFile = vi.fn<(data: Uint8Array) => Promise<ChartFile[]>>(async () => EXTRACTED)
const prepareChartData = vi.fn<
  (
    files: ChartFile[],
    instrument: string,
    difficulty: string,
    seekPercent?: number,
    textureOptions?: Record<string, unknown>
  ) => Promise<typeof preparedChart>
>(async () => preparedChart)
vi.mock('chart-preview', () => ({
  fetchSngFile: (url: string, signal?: AbortSignal) => fetchSngFile(url, signal),
  extractSngFile: (data: Uint8Array) => extractSngFile(data),
  prepareChartData: (
    files: ChartFile[],
    instrument: string,
    difficulty: string,
    seekPercent?: number,
    textureOptions?: Record<string, unknown>
  ) => prepareChartData(files, instrument, difficulty, seekPercent, textureOptions)
}))

const SNG_BYTES = new Uint8Array([0x53, 0x4e, 0x47, 0x50])
const EXTRACTED = [{ fileName: 'notes.chart', data: new Uint8Array([1, 2, 3]) }]

/** Stands in for `prepareChartData`'s result: one section, three notes, 100 s. */
const preparedChart = {
  parsedChart: {
    sections: [{ tick: 0, name: 'Intro', msTime: 0, msLength: 0 }],
    trackData: [
      {
        instrument: 'guitar',
        difficulty: 'expert',
        noteEventGroups: [[{ msTime: 0 }, { msTime: 0 }], [{ msTime: 50_000 }]]
      },
      { instrument: 'bass', difficulty: 'hard', noteEventGroups: [[{ msTime: 10_000 }]] }
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

// `isConnected` mirrors the real DOM property the listeners gate on: the
// element is appended to the viewport before anything is loaded, so every real
// event arrives while it is connected.
interface FakeElement extends Record<string, unknown> {
  isConnected: boolean
  shadowRoot: { appendChild: ReturnType<typeof vi.fn>; children: { textContent: string }[] }
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  loadChart: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
  seek: ReturnType<typeof vi.fn>
  toggleFullscreen: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  getAttribute: ReturnType<typeof vi.fn>
  attributes: Record<string, string>
}

const makeFakeElement = (): FakeElement => {
  const shadowChildren: { textContent: string }[] = []
  const el: FakeElement = {
    isConnected: true,
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
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
    attributes: {},
    getAttribute: vi.fn((name: string) => el.attributes[name] ?? null)
  }
  return el
}

let fakeElement: ReturnType<typeof makeFakeElement>
let createElement: ReturnType<typeof vi.fn>
let observers: { target: unknown; notify: () => void }[]

beforeEach(() => {
  fakeElement = makeFakeElement()
  observers = []
  createElement = vi.fn((tag: string) => (tag === 'style' ? { textContent: '' } : fakeElement))
  ;(globalThis as { document?: unknown }).document = { createElement }
  // Node has no MutationObserver; the wrapper watches the element's `volume`
  // attribute with one because the element publishes no volume event.
  ;(globalThis as { MutationObserver?: unknown }).MutationObserver = class {
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
  delete (globalThis as { document?: unknown }).document
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver
  vi.restoreAllMocks()
  fetchSngFile.mockClear()
  extractSngFile.mockClear()
  prepareChartData.mockClear()
})

const urlConfig = {
  source: { kind: 'url' as const, url: 'https://files.enchor.us/abc.sng' },
  instrument: 'guitar',
  difficulty: 'expert',
  volume: 80
}

describe('createPreview', () => {
  it('creates a chart-preview-player element', async () => {
    const handle = await createPreview()
    expect(createElement).toHaveBeenCalledWith('chart-preview-player')
    expect(handle.element).toBe(fakeElement)
  })

  it("hides the component's own control bar unless it is fullscreen", async () => {
    // The component renders a play/volume/seek/fullscreen bar of its own that
    // used to sit 13px above the pane's transport. It stays available in
    // fullscreen, where the pane's transport is off-screen.
    await createPreview()
    expect(fakeElement.shadowRoot.appendChild).toHaveBeenCalledTimes(1)
    const style = fakeElement.shadowRoot.children[0].textContent
    expect(style).toContain('.player-container:not(.fullscreen) .controls')
    expect(style).toContain('display: none')
  })

  it('leaves the built-in bar alone rather than failing when no shadow root is exposed', async () => {
    // Defensive: the element attaches its shadow root in its constructor with
    // { mode: 'open' }, so this only happens if a future version closes it.
    const noShadow = makeFakeElement()
    ;(noShadow as Record<string, unknown>).shadowRoot = null
    createElement.mockImplementation((tag: string) =>
      tag === 'style' ? { textContent: '' } : noShadow
    )
    await expect(createPreview()).resolves.toBeDefined()
  })

  it('load with a url source fetches, extracts, prepares, then loads the prepared data', async () => {
    const handle = await createPreview()
    await handle.load({ ...urlConfig, seekPercent: 0.25 })

    expect(fetchSngFile).toHaveBeenCalledWith(urlConfig.source.url, expect.anything())
    expect(extractSngFile).toHaveBeenCalledWith(SNG_BYTES)
    expect(prepareChartData).toHaveBeenCalledWith(EXTRACTED, 'guitar', 'expert', 0.25, {})
    expect(fakeElement.loadChart).toHaveBeenCalledWith(preparedChart)
    expect(fakeElement.setVolume).toHaveBeenCalledWith(80)
  })

  it('load with a files source skips the download and prepares the given files', async () => {
    const files = [{ fileName: 'notes.chart', data: new Uint8Array([1, 2, 3]) }]
    const handle = await createPreview()
    await handle.load({
      source: { kind: 'files', files },
      instrument: 'bass',
      difficulty: 'hard',
      volume: 50
    })
    expect(fetchSngFile).not.toHaveBeenCalled()
    expect(extractSngFile).not.toHaveBeenCalled()
    expect(prepareChartData).toHaveBeenCalledWith(files, 'bass', 'hard', 0, {})
  })

  it('forwards animations as the texture option prepareChartData takes', async () => {
    const handle = await createPreview()
    await handle.load({ ...urlConfig, animations: false })
    expect(prepareChartData).toHaveBeenLastCalledWith(EXTRACTED, 'guitar', 'expert', 0, {
      animationsEnabled: false
    })

    await handle.load({ ...urlConfig, animations: true })
    expect(prepareChartData).toHaveBeenLastCalledWith(EXTRACTED, 'guitar', 'expert', 0, {
      animationsEnabled: true
    })
  })

  it('omits animationsEnabled when animations is not set', async () => {
    const handle = await createPreview()
    await handle.load(urlConfig)
    expect(prepareChartData.mock.calls[0][4]).not.toHaveProperty('animationsEnabled')
  })

  it('load returns the chart map for the requested track', async () => {
    const handle = await createPreview()
    const map = await handle.load(urlConfig)
    expect(map.sections).toEqual([{ msTime: 0, name: 'Intro' }])
    // Guitar/expert only: the bass note at 10 s must not be counted.
    expect(map.density.reduce((sum, n) => sum + n, 0)).toBe(3)
    expect(map.peak).toBe(2)
    expect(map.lengthMs).toBe(100_000)
  })

  it('rejects when the source is missing its payload', async () => {
    const handle = await createPreview()
    await expect(
      handle.load({
        source: { kind: 'url' },
        instrument: 'guitar',
        difficulty: 'expert',
        volume: 50
      })
    ).rejects.toThrow('url')
    await expect(
      handle.load({
        source: { kind: 'files' },
        instrument: 'guitar',
        difficulty: 'expert',
        volume: 50
      })
    ).rejects.toThrow('files')
  })

  it('forwards play, pause, setVolume and toggleFullscreen to the element', async () => {
    const handle = await createPreview()
    await handle.play()
    await handle.pause()
    handle.setVolume(30)
    handle.toggleFullscreen()
    expect(fakeElement.play).toHaveBeenCalledTimes(1)
    expect(fakeElement.pause).toHaveBeenCalledTimes(1)
    expect(fakeElement.setVolume).toHaveBeenCalledWith(30)
    expect(fakeElement.toggleFullscreen).toHaveBeenCalledTimes(1)
  })

  it('onState subscribes to player-statechange and the returned fn unsubscribes', async () => {
    const handle = await createPreview()
    const cb = vi.fn()
    const unsubscribe = handle.onState(cb)
    expect(fakeElement.addEventListener).toHaveBeenCalledWith(
      'player-statechange',
      expect.any(Function)
    )
    const listener = fakeElement.addEventListener.mock.calls[0][1] as (event: unknown) => void
    listener({ detail: { state: 'playing', previousState: 'ready' } })
    expect(cb).toHaveBeenCalledWith('playing')
    unsubscribe()
    expect(fakeElement.removeEventListener).toHaveBeenCalledWith('player-statechange', listener)
  })

  it('onError maps an Error detail to its message and non-Errors to strings', async () => {
    const handle = await createPreview()
    const cb = vi.fn()
    handle.onError(cb)
    expect(fakeElement.addEventListener).toHaveBeenCalledWith('player-error', expect.any(Function))
    const listener = fakeElement.addEventListener.mock.calls[0][1] as (event: unknown) => void
    listener({ detail: { error: new Error('boom') } })
    expect(cb).toHaveBeenCalledWith('boom')
    listener({ detail: { error: 'plain failure' } })
    expect(cb).toHaveBeenCalledWith('plain failure')
  })

  it('onProgress maps player-progress detail, normalizing percent from 0-1 to 0-100', async () => {
    const handle = await createPreview()
    const cb = vi.fn()
    const unsubscribe = handle.onProgress(cb)
    expect(fakeElement.addEventListener).toHaveBeenCalledWith(
      'player-progress',
      expect.any(Function)
    )
    const listener = fakeElement.addEventListener.mock.calls.find(
      (call) => call[0] === 'player-progress'
    )?.[1] as (event: unknown) => void
    listener({ detail: { percent: 0.25, currentMs: 30000, totalMs: 120000 } })
    expect(cb).toHaveBeenCalledWith({ percent: 25, currentMs: 30000, totalMs: 120000 })
    // Unsubscribe detaches the exact same listener from the element.
    unsubscribe()
    expect(fakeElement.removeEventListener).toHaveBeenCalledWith('player-progress', listener)
  })

  it("onVolume reports the element's own volume changes, clamped, until unsubscribed", async () => {
    const handle = await createPreview()
    const cb = vi.fn()
    const unsubscribe = handle.onVolume(cb)
    expect(observers.map((o) => o.target)).toEqual([fakeElement])

    fakeElement.attributes.volume = '70'
    observers[0].notify()
    expect(cb).toHaveBeenLastCalledWith(70)

    fakeElement.attributes.volume = '-5'
    observers[0].notify()
    expect(cb).toHaveBeenLastCalledWith(0)

    // A removed attribute reads back as null, which Number() turns into 0. That
    // is ignored rather than reported as a silent mute.
    cb.mockClear()
    unsubscribe()
    expect(observers).toHaveLength(0)
  })

  it('drops events the element emits after it has left the DOM', async () => {
    // `<chart-preview-player>` calls dispose() from disconnectedCallback, and
    // dispose() emits a final player-statechange. Svelte fires
    // disconnectedCallback SYNCHRONOUSLY while it removes the DOM of a block
    // effect, so a store write from that callback throws
    // `state_unsafe_mutation` and aborts the rest of the unmount. Verified in
    // Chromium: the viewport cleanup never ran, the player bar kept the old
    // song, and the whole view area was left blank. The element is already
    // detached by then, so gate every listener on isConnected.
    const handle = await createPreview()
    const state = vi.fn()
    const error = vi.fn()
    const progress = vi.fn()
    handle.onState(state)
    handle.onError(error)
    handle.onProgress(progress)
    const listenerFor = (type: string): ((event: unknown) => void) =>
      fakeElement.addEventListener.mock.calls.find((call) => call[0] === type)?.[1] as (
        event: unknown
      ) => void

    fakeElement.isConnected = false
    listenerFor('player-statechange')({ detail: { state: 'idle', previousState: 'playing' } })
    listenerFor('player-error')({ detail: { error: new Error('teardown') } })
    listenerFor('player-progress')({ detail: { percent: 0, currentMs: 0, totalMs: 0 } })

    expect(state).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  })

  it('seek converts our 0-100 percent convention to the element 0-1 range', async () => {
    const handle = await createPreview()
    await handle.seek(40)
    expect(fakeElement.seek).toHaveBeenCalledWith(0.4)
    await handle.seek(0)
    expect(fakeElement.seek).toHaveBeenCalledWith(0)
    await handle.seek(100)
    expect(fakeElement.seek).toHaveBeenCalledWith(1)
  })

  it('dispose is idempotent: disposes the element once and removes it', async () => {
    const handle = await createPreview()
    handle.dispose()
    expect(() => handle.dispose()).not.toThrow()
    expect(fakeElement.dispose).toHaveBeenCalledTimes(1)
    expect(fakeElement.remove).toHaveBeenCalledTimes(1)
  })

  it('dispose aborts a .sng download that is still in flight', async () => {
    // The element runs its own AbortController for loadFromUrl, which this
    // wrapper no longer uses; without one of ours, navigating away mid-download
    // would leave the whole file transferring for a preview nobody can see.
    let seen: AbortSignal | undefined
    let release: (bytes: Uint8Array) => void = () => {}
    fetchSngFile.mockImplementationOnce((_url, signal) => {
      seen = signal
      return new Promise<Uint8Array>((resolve) => {
        release = resolve
      })
    })
    const handle = await createPreview()
    const pending = handle.load(urlConfig)
    await Promise.resolve()
    expect(seen?.aborted).toBe(false)

    handle.dispose()
    expect(seen?.aborted).toBe(true)
    // Let the stubbed fetch finish so the pending load does not outlive the test.
    release(SNG_BYTES)
    await pending
  })
})

describe('buildChartMap', () => {
  it('buckets notes uniformly across the chart length', () => {
    const map = buildChartMap([], [0, 500, 1000, 1000], 2000)
    expect(map.density).toHaveLength(192)
    expect(map.density.reduce((sum, n) => sum + n, 0)).toBe(4)
    // 0 → the first bucket, 500 → a quarter in, 1000 → halfway.
    expect(map.density[0]).toBe(1)
    expect(map.density[48]).toBe(1)
    expect(map.density[96]).toBe(2)
    expect(map.peak).toBe(2)
    expect(map.lengthMs).toBe(2000)
  })

  it('clamps notes outside the chart length into the end buckets', () => {
    // Charts really do run past their audio, and a negative [Song] Offset can
    // put a note before zero. Both have to be counted rather than dropped: a
    // histogram showing fewer notes than the chart holds would be a lie.
    const map = buildChartMap([], [-5000, 999_999], 1000)
    expect(map.density[0]).toBe(1)
    expect(map.density[191]).toBe(1)
    expect(map.density.reduce((sum, n) => sum + n, 0)).toBe(2)
  })

  it('reports a zero peak for a track with no notes rather than dividing by it', () => {
    const map = buildChartMap([{ msTime: 0, name: 'Intro' }], [], 60_000)
    expect(map.peak).toBe(0)
    expect(map.density.every((n) => n === 0)).toBe(true)
    expect(map.sections).toEqual([{ msTime: 0, name: 'Intro' }])
  })

  it('never divides by a zero length', () => {
    const map = buildChartMap([], [0], 0)
    expect(map.lengthMs).toBe(1)
    expect(map.density[0]).toBe(1)
  })

  it('keeps only msTime and name from the parsed sections', () => {
    // The parsed sections also carry tick and msLength, and the map is held for
    // as long as the preview is; the seek bar has no use for either.
    const map = buildChartMap(
      [{ msTime: 1234, name: 'Solo', tick: 99, msLength: 10 } as never],
      [],
      10_000
    )
    expect(map.sections).toEqual([{ msTime: 1234, name: 'Solo' }])
  })
})
