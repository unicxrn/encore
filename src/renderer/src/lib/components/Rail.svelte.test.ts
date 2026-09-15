import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Rail from './Rail.svelte'
import type { ChartRecord } from '../../../../shared/schemas'
import type { ChartData } from '../api/enchor'
import { get } from 'svelte/store'
import { closePreview, viewportMounted, viewportOwner } from '../stores/preview-controller'

/**
 * What these can and cannot check.
 *
 * jsdom applies no stylesheet and computes no layout, so nothing here can see that the rail is
 * a 374px column, that it sits between the top bar and the player, or that its art box is
 * square. All of that is measured instead by `scripts/measure-play-stats.mjs`, which drives the
 * built renderer in an offscreen Electron window; the numbers are in the commit that added it.
 *
 * What IS pinnable is what the rail SAYS, which is the half of it that can be wrong while
 * looking right: that it names the chart, that it never restates a missing asset as a known
 * one, and that its empty state is the one a session sees once and never again.
 */

const record = (over: Partial<ChartRecord> = {}): ChartRecord =>
  ({
    path: '/library/Rush - YYZ',
    chartType: 'folder',
    name: 'YYZ',
    artist: 'Rush',
    charter: 'someone',
    albumArtMd5: null,
    hasVideo: false,
    hasBackground: false,
    hasAlbumArt: false,
    hasLyrics: false,
    noteCounts: [],
    ...over
  }) as ChartRecord

const chart = (over: Partial<ChartData> = {}): ChartData =>
  ({
    name: 'YYZ',
    artist: 'Rush',
    charter: 'someone',
    md5: 'a'.repeat(32),
    albumArtMd5: null,
    hasVideoBackground: false,
    ...over
  }) as ChartData

beforeEach(() => {
  vi.stubGlobal('encore', { chartReadFiles: vi.fn().mockResolvedValue([]) })
})
afterEach(() => vi.unstubAllGlobals())

/** The state word beside one health row, read off the row that carries the label. */
function healthState(label: string): string {
  const row = screen.getByText(label).closest('.health-row')
  if (row === null) throw new Error(`no health row for ${label}`)
  return row.querySelector('.health-state')?.textContent?.trim() ?? ''
}

describe('Rail: nothing selected', () => {
  it('draws one empty state and no chart fields', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: null } })
    expect(screen.getByText('Open a chart and it stays here.')).toBeTruthy()
    // No viewport, so the controller has nothing to register and no preview can be opened
    // from a rail that has no chart.
    expect(document.querySelector('.viewport')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Play preview' })).toBeNull()
  })
})

describe('Rail: a chart from the library', () => {
  it('names the song, the artist and the charter', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(screen.getByText('YYZ')).toBeTruthy()
    expect(screen.getByText('Rush')).toBeTruthy()
    expect(screen.getByText('Charted by someone')).toBeTruthy()
  })

  // Deliberately not a heading: the content pane already headlines the same song, and two
  // <h2>s reading "YYZ" is one song with two headings as far as a screen reader is concerned.
  it('does not add a second heading for the song the content pane is already showing', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(screen.queryByRole('heading', { name: 'YYZ' })).toBeNull()
  })

  it('reports each asset the scan read, as read', () => {
    const target = { kind: 'local' as const, record: record({ hasAlbumArt: true }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(healthState('Album art')).toBe('OK')
    expect(healthState('Lyrics')).toBe('MISSING')
  })

  it('offers the instruments the chart actually carries', () => {
    const target = {
      kind: 'local' as const,
      record: record({
        noteCounts: [
          { instrument: 'guitar', difficulty: 'expert', count: 1420 },
          { instrument: 'drums', difficulty: 'hard', count: 900 }
        ]
      })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const options = [...document.querySelectorAll('.picks select')][0].querySelectorAll('option')
    expect([...options].map((o) => o.textContent?.trim())).toEqual(['Guitar', 'Drums'])
  })

  // A chart scanned before the catalog stored note counts has an empty matrix. An empty select
  // would be worse than the guess: the chart may well hold a guitar track nothing recorded.
  it('falls back to guitar rather than to an empty instrument list', () => {
    render(Rail, {
      props: {
        onOpenDetail: () => {},
        target: { kind: 'local', record: record({ noteCounts: [] }) }
      }
    })
    const options = [...document.querySelectorAll('.picks select')][0].querySelectorAll('option')
    expect([...options].map((o) => o.textContent?.trim())).toEqual(['Guitar'])
  })
})

describe('Rail: a chart from Chorus', () => {
  // The rail is entitled to say "missing" about a chart somebody has read, and only then. The
  // API reports the cover and the video and says nothing at all about the other two.
  it('says unknown for the two assets the API does not report', () => {
    render(Rail, {
      props: {
        onOpenDetail: () => {},
        target: { kind: 'remote', chart: chart({ hasVideoBackground: true }) }
      }
    })
    expect(healthState('Video')).toBe('OK')
    expect(healthState('Album art')).toBe('MISSING')
    expect(healthState('Background')).toBe('UNKNOWN')
    expect(healthState('Lyrics')).toBe('UNKNOWN')
  })
})

describe('Rail: the head when a chart ships no cover', () => {
  // The box is 88px and used to be empty, which read as a gap in the head rather than as a
  // chart with no art. What it must NOT do is claim anything: the health list below says
  // whether there is a cover, and this letter is decorative.
  it('draws the initial of the song rather than an empty box', () => {
    render(Rail, {
      props: {
        onOpenDetail: () => {},
        target: { kind: 'local', record: record({ albumArtMd5: null }) }
      }
    })
    const box = document.querySelector('.art.placeholder')
    expect(box?.textContent?.trim()).toBe('Y')
    expect(box?.getAttribute('aria-hidden')).toBe('true')
  })

  it('skips the leading punctuation a title can start with', () => {
    render(Rail, {
      props: {
        onOpenDetail: () => {},
        target: { kind: 'local', record: record({ name: '...Rebirth' }) }
      }
    })
    expect(document.querySelector('.art.placeholder')?.textContent?.trim()).toBe('R')
  })

  // A cover that 404s or fails to decode is the same state as never having had one, and the
  // fallback has to be reached by that route too or the head shows a broken-image glyph.
  it('falls back to the letter when the cover fails to load', async () => {
    const target = { kind: 'local' as const, record: record({ albumArtMd5: 'f'.repeat(32) }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const img = document.querySelector('img.art')
    if (img === null) throw new Error('no art image')
    await fireEvent.error(img)
    expect(document.querySelector('.art.placeholder')?.textContent?.trim()).toBe('Y')
  })
})

/** The value under one stats label, read off the cell that carries it. */
function stat(label: string): string {
  const cell = screen.getByText(label).closest('.stat')
  if (cell === null) throw new Error(`no stat cell for ${label}`)
  return cell.querySelector('.stat-value')?.textContent?.trim() ?? ''
}

const COUNTS = [
  { instrument: 'guitar', difficulty: 'expert', count: 1420 },
  { instrument: 'guitar', difficulty: 'hard', count: 900 },
  { instrument: 'drums', difficulty: 'expert', count: 2317 }
]
const NPS = [
  { instrument: 'guitar', difficulty: 'expert', nps: 12.25 },
  { instrument: 'drums', difficulty: 'expert', nps: 9 }
]

describe('Rail: what the selected track is made of', () => {
  it('counts the notes and the peak rate of the instrument and difficulty on screen', () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, maxNps: NPS, songLength: 273_000 })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('NOTES')).toBe('1,420')
    expect(stat('PEAK NPS')).toBe('12.3')
    expect(stat('LENGTH')).toBe('4:33')
  })

  it('follows the instrument pick rather than totalling the chart', async () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, maxNps: NPS, songLength: 273_000 })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const instrument = document.querySelectorAll('.picks select')[0] as HTMLSelectElement
    await fireEvent.change(instrument, { target: { value: 'drums' } })
    expect(stat('NOTES')).toBe('2,317')
    expect(stat('PEAK NPS')).toBe('9.0')
  })

  it('follows the difficulty pick too', async () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, maxNps: NPS, songLength: 273_000 })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const difficulty = document.querySelectorAll('.picks select')[1] as HTMLSelectElement
    await fireEvent.change(difficulty, { target: { value: 'hard' } })
    expect(stat('NOTES')).toBe('900')
    // Nothing measured a peak rate for Hard, and a chart with 900 notes on it plainly has one.
    // The dash is the only honest answer; a 0 would be a number nobody took.
    expect(stat('PEAK NPS')).toBe('—')
  })

  it('answers with a dash where the scan read nothing, never with a zero', () => {
    const target = { kind: 'local' as const, record: record({ noteCounts: [], maxNps: [] }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('NOTES')).toBe('—')
    expect(stat('PEAK NPS')).toBe('—')
    expect(stat('LENGTH')).toBe('—')
  })

  it("reads a remote chart's length from the field the API names it with", () => {
    const target = { kind: 'remote' as const, chart: chart({ song_length: 187_000 }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('LENGTH')).toBe('3:07')
  })

  // The flag is about the drum chart, so it is shown against the drum chart and nowhere else.
  // It is the only one of the six booleans kept; see the comment on the block that derives it.
  it('flags a double pedal only while drums is the selected instrument', async () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, has2xKick: true })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(screen.queryByText('2X KICK')).toBeNull()
    const instrument = document.querySelectorAll('.picks select')[0] as HTMLSelectElement
    await fireEvent.change(instrument, { target: { value: 'drums' } })
    expect(screen.getByText('2X KICK')).toBeTruthy()
  })

  it('does not flag a drum chart that uses one pedal', async () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, has2xKick: false })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const instrument = document.querySelectorAll('.picks select')[0] as HTMLSelectElement
    await fireEvent.change(instrument, { target: { value: 'drums' } })
    expect(screen.queryByText('2X KICK')).toBeNull()
  })
})

describe('Rail: the actions a chart can actually answer', () => {
  it('offers a library chart the one action that takes a path, and no download', async () => {
    const chartReveal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('encore', { chartReveal, chartReadFiles: vi.fn().mockResolvedValue([]) })
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(chartReveal).toHaveBeenCalledWith('/library/Rush - YYZ')
  })

  it('offers a Chorus chart the download, and neither of the two that need a path', async () => {
    const downloadAdd = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('encore', { downloadAdd })
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'remote', chart: chart() } } })
    expect(screen.queryByRole('button', { name: 'Show in folder' })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(downloadAdd).toHaveBeenCalledWith({
      md5: 'a'.repeat(32),
      hasVideoBackground: false,
      meta: { name: 'YYZ', artist: 'Rush', charter: 'someone' }
    })
    // Deliberately no confirmation line: the player bar under this column shows the queue, and
    // two places saying the same download landed is one of them guessing.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The design drew a favourite and an add-to-setlist button. Neither exists behind the app:
  // the contract has three chart actions and none of them is either of those. The row holds
  // the one this chart can answer and the way through to its page, in that order, and nothing
  // else; the order is what keeps the action the row's first button.
  it('draws no control for a feature the app does not have', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    const labels = [...document.querySelectorAll('.actions button')].map((b) =>
      (b.textContent ?? '').trim()
    )
    expect(labels).toEqual(['Show in folder', 'All details'])
  })

  // `chartReveal` rejects for a path outside the configured library folders, which is a real
  // answer and not a crash. Silence there would read as a button that does nothing.
  it('says why a reveal was refused', async () => {
    const chartReveal = vi.fn().mockRejectedValue(new Error('Path is outside your library'))
    vi.stubGlobal('encore', { chartReveal })
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Path is outside your library'
    )
  })
})

/**
 * The viewport hand-over, which is the one part of the rail that can break something outside it.
 *
 * `viewportMounted` is what PlayerBar reads to decide whether to cede its own transport, so a
 * rail that holds the viewport when it should not takes the bar's play button away. These pin
 * both ends of that: the rail takes the viewport on its first Play, and gives it back when the
 * window narrows past the point where the rail is drawn at all.
 *
 * `openPreview` gets as far as setting the stores and then fails on the player module, which
 * jsdom cannot load. That is after `registerViewport`, which is the call under test here.
 */
describe('Rail: who holds the preview viewport', () => {
  afterEach(() => {
    closePreview()
    viewportMounted.set(false)
    viewportOwner.set(null)
  })

  it('claims the viewport on the first Play and not before', async () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(get(viewportMounted)).toBe(false)
    await fireEvent.click(screen.getByRole('button', { name: 'Play preview' }))
    await waitFor(() => {
      if (!get(viewportMounted)) throw new Error('viewport not claimed')
    })
    expect(get(viewportOwner)).toBe(document.querySelector('.viewport'))
  })

  /**
   * Step two documented this and left it: below the shell's breakpoint the rail is
   * `display: none`, so a window dragged under it while the rail was previewing left a chart
   * playing behind a hidden column, with the player bar still ceding its transport to it and
   * nothing on screen able to stop it.
   */
  it('gives the viewport back when the window narrows past the rail', async () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Play preview' }))
    await waitFor(() => {
      if (!get(viewportMounted)) throw new Error('viewport not claimed')
    })

    // What App.svelte's media query does to this element under 1120px. jsdom applies no
    // stylesheet, so the state is set directly; the rail reads `display` rather than a width,
    // which is why one line here stands in for the whole query.
    const rail = document.querySelector('.rail') as HTMLElement
    rail.style.display = 'none'
    window.dispatchEvent(new Event('resize'))

    expect(get(viewportMounted)).toBe(false)
    expect(get(viewportOwner)).toBeNull()
  })

  // The other half of the same rule: a resize that leaves the rail on screen changes nothing,
  // so dragging a wide window a little wider must not stop the preview playing in it.
  it('keeps the viewport through a resize that leaves the rail drawn', async () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Play preview' }))
    await waitFor(() => {
      if (!get(viewportMounted)) throw new Error('viewport not claimed')
    })

    window.dispatchEvent(new Event('resize'))

    expect(get(viewportMounted)).toBe(true)
  })
})

/**
 * The one way through from the rail to the chart page.
 *
 * Explore's rows no longer navigate: a click fills this column, so without this control the
 * four things only the chart page carries (the full difficulty matrix, the version check, the
 * ABOUT table and the chips that search on a charter or an album) would be unreachable from
 * Explore altogether. One control, in the rail rather than on every row, because a route per row
 * is thirty invitations to leave the list.
 *
 * jsdom applies no stylesheet, so nothing here can see that it is the quiet half of the action
 * row. `scripts/measure-play-stats.mjs` prints both buttons' widths.
 */
describe('Rail: the way through to the chart page', () => {
  it('hands over the chart the rail is showing', async () => {
    const onOpenDetail = vi.fn()
    const target = { kind: 'local', record: record() } as const
    render(Rail, { props: { onOpenDetail, target } })

    await fireEvent.click(screen.getByRole('button', { name: 'All details' }))

    expect(onOpenDetail).toHaveBeenCalledWith(target)
  })

  // The route exists for Explore, where a row hands over a remote chart and nothing else opens
  // the page at all, so the remote case is the one that must not be missing.
  it('offers it for a chart from Chorus too', async () => {
    const onOpenDetail = vi.fn()
    const target = { kind: 'remote', chart: chart() } as const
    render(Rail, { props: { onOpenDetail, target } })

    await fireEvent.click(screen.getByRole('button', { name: 'All details' }))

    expect(onOpenDetail).toHaveBeenCalledWith(target)
  })

  // A real button, which is what carries Enter and Space and what puts it in the tab order.
  // The rail is a landmark full of static text otherwise, so this is the only thing in it a
  // keyboard reaches on the way to the chart page.
  it('is a button, reachable by keyboard', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })

    const through = screen.getByRole('button', { name: 'All details' })
    expect(through.tagName).toBe('BUTTON')
    expect(through.hasAttribute('disabled')).toBe(false)
  })

  // Nothing to open before the first chart of the session, and a route to a page about no chart
  // would be a button that cannot work.
  it('is absent while the rail is empty', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: null } })

    expect(screen.queryByRole('button', { name: 'All details' })).toBeNull()
  })
})
