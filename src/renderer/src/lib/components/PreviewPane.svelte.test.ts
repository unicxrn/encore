import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChartRecordSchema, type ChartRecord } from '../../../../shared/schemas'
import type { LyricLinesResult } from '../../../../main/catalog/lyric-lines'
import { get } from 'svelte/store'
import { nowPlaying, progress } from '../stores/preview-controller'
import type { ChartTarget } from './Home.svelte'
import { TAGGED_CHARTER, TAGGED_CHARTER_TEXT } from '../../../../../test/helpers/marked-up-names'
import PreviewPane from './PreviewPane.svelte'

/** Through the real schema, so the fields the pane reads are the catalog's own. */
function localRecord(overrides: Partial<ChartRecord> = {}): ChartTarget {
  return {
    kind: 'local',
    record: ChartRecordSchema.parse({
      path: '/library/Rush - YYZ',
      chartType: 'folder',
      folderHash: 'h',
      modifiedTime: 0,
      songLength: 273_000,
      name: 'YYZ',
      artist: 'Rush',
      ...overrides
    })
  }
}

const LINES: LyricLinesResult = {
  lines: [
    { ms: 1000, endMs: 2000, text: 'Hello world' },
    { ms: 3000, endMs: 4000, text: 'Second line' }
  ]
}

/**
 * The stores are module singletons that survive between tests. Reset them the way
 * `closePreview()` does, so one test's open preview cannot leak into the next.
 */
afterEach(() => {
  nowPlaying.set(null)
  progress.set(null)
  vi.unstubAllGlobals()
})

/** Stub only what the pane calls: the lyric read at mount. Play is never pressed here. */
function renderPane(
  target: ChartTarget,
  result: Promise<LyricLinesResult> = Promise.resolve(LINES)
): { chartLyricLines: ReturnType<typeof vi.fn>; toggle: () => HTMLButtonElement } {
  const chartLyricLines = vi.fn(() => result)
  vi.stubGlobal('encore', { chartLyricLines })
  render(PreviewPane, { props: { target, instruments: [] } })
  return { chartLyricLines, toggle: lyricsToggle }
}

const lyricsToggle = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Lyrics' }) as HTMLButtonElement

/** What the player does on every frame, minus the player: the controller's progress store. */
function playingAt(currentMs: number): void {
  nowPlaying.set({ title: 'YYZ', artist: 'Rush', artUrl: null })
  progress.set({ percent: (currentMs / 10_000) * 100, currentMs, totalMs: 10_000 })
}

describe('PreviewPane lyrics overlay', () => {
  it("reads the chart's lyrics at mount and offers the toggle, off by default", async () => {
    const { chartLyricLines, toggle } = renderPane(localRecord())
    expect(chartLyricLines).toHaveBeenCalledWith({
      path: '/library/Rush - YYZ',
      chartType: 'folder'
    })
    await waitFor(() => expect(toggle().disabled).toBe(false))
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    playingAt(1500)
    await tick()
    expect(screen.queryByText('Hello world')).toBeNull()
  })

  it('shows the line under the playhead once toggled on, and nothing between lines', async () => {
    const { toggle } = renderPane(localRecord())
    await waitFor(() => expect(toggle().disabled).toBe(false))
    await fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-pressed')).toBe('true')

    playingAt(1500)
    await tick()
    expect(screen.getByText('Hello world')).toBeTruthy()

    playingAt(2500)
    await tick()
    expect(screen.queryByText('Hello world')).toBeNull()
    expect(screen.queryByText('Second line')).toBeNull()

    playingAt(3000)
    await tick()
    expect(screen.getByText('Second line')).toBeTruthy()
  })

  it('shows nothing while no preview is open, whatever the toggle says', async () => {
    const { toggle } = renderPane(localRecord())
    await waitFor(() => expect(toggle().disabled).toBe(false))
    await fireEvent.click(toggle())
    progress.set({ percent: 15, currentMs: 1500, totalMs: 10_000 })
    await tick()
    expect(screen.queryByText('Hello world')).toBeNull()
  })

  it("disables the toggle with the chart's own reason when it has no lyrics", async () => {
    const { toggle } = renderPane(
      localRecord({ chartType: 'sng', path: '/library/x.sng' }),
      Promise.resolve({ none: 'No vocals track in this chart' })
    )
    await waitFor(() => expect(toggle().title).toBe('No vocals track in this chart'))
    expect(toggle().disabled).toBe(true)
  })

  it('says the read is in flight until it lands', () => {
    const { toggle } = renderPane(localRecord(), new Promise(() => {}))
    expect(toggle().disabled).toBe(true)
    expect(toggle().title).toBe('Reading lyrics')
  })

  // A remote chart is streamed by the player itself; main never has its files to read.
  it('does not read lyrics for a remote chart and says why the toggle is off', () => {
    const { chartLyricLines, toggle } = renderPane({
      kind: 'remote',
      chart: {
        chartId: 1,
        songId: null,
        md5: 'd'.repeat(32),
        albumArtMd5: null,
        hasVideoBackground: false,
        name: 'YYZ',
        artist: 'Rush',
        album: null,
        genre: null,
        year: null,
        charter: null,
        song_length: 273_000,
        diff_guitar: 4,
        diff_bass: null,
        diff_drums: null,
        diff_keys: null,
        diff_vocals: null
      }
    })
    expect(chartLyricLines).not.toHaveBeenCalled()
    expect(toggle().disabled).toBe(true)
    expect(toggle().title).toBe('Lyrics are only read from charts in your library')
  })

  // The read is async and the pane can be re-targeted before it lands: a slow answer for the
  // previous chart must not be shown under the next one.
  it('ignores a lyric read that lands after the chart changed', async () => {
    let resolveFirst: (r: LyricLinesResult) => void = () => {}
    const first = new Promise<LyricLinesResult>((resolve) => (resolveFirst = resolve))
    const chartLyricLines = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(Promise.resolve({ none: 'No lyrics in this chart' }))
    vi.stubGlobal('encore', { chartLyricLines })
    const { rerender } = render(PreviewPane, {
      props: { target: localRecord(), instruments: [] }
    })
    await rerender({ target: localRecord({ path: '/library/Other' }), instruments: [] })
    resolveFirst(LINES)
    await tick()
    const toggle = lyricsToggle()
    await waitFor(() => expect(toggle.title).toBe('No lyrics in this chart'))
    expect(toggle.disabled).toBe(true)
  })
})

/**
 * The pane does not draw the name itself: it hands it to `openPreview`, which sets `nowPlaying`,
 * which is the only thing the player bar reads. So stripping here is what puts a readable name
 * in the bar, and this is where it can be pinned. PlayerBar itself needs no change and gets no
 * test: it renders the store verbatim, and a test of that would pass with or without this.
 */
describe('PreviewPane hands the player bar a name it can read', () => {
  it('strips the markup out of the title and artist it opens with', async () => {
    vi.stubGlobal('encore', {
      chartLyricLines: () => Promise.resolve(LINES),
      chartReadFiles: () => Promise.resolve([])
    })
    render(PreviewPane, {
      props: {
        target: localRecord({ name: '<b>YYZ</b>', artist: TAGGED_CHARTER }),
        instruments: []
      }
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Play preview' }))

    // `openPreview` sets the store before it awaits the player module, which jsdom has no way to
    // load; the name is already through by then, and the failure that follows is caught by the
    // pane's own error handling.
    await waitFor(() => {
      if (get(nowPlaying) === null) throw new Error('nothing playing yet')
    })
    expect(get(nowPlaying)).toMatchObject({ title: 'YYZ', artist: TAGGED_CHARTER_TEXT })
  })
})
