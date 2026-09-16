import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Rail from './Rail.svelte'
import type { ChartRecord } from '../../../../shared/schemas'
import type { ChartData } from '../api/enchor'
import { get } from 'svelte/store'
import { closePreview, viewportMounted, viewportOwner } from '../stores/preview-controller'
import { favourites } from '../stores/favourites'
import { setlists } from '../stores/setlists'

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

/**
 * One health row, addressed by the asset it is about rather than by its words.
 *
 * The words are the thing under test: the row says "Album art", "No album art" or "Album art
 * unknown", so a helper that found the row BY its text could only ever find the state it was
 * already looking for. `data-key` is the asset kind, which does not move.
 */
function healthRow(key: string): { state: string; says: string } {
  const row = document.querySelector(`.health-row[data-key="${key}"]`)
  if (row === null) throw new Error(`no health row for ${key}`)
  return {
    state: row.getAttribute('data-state') ?? '',
    says: row.querySelector('.health-label')?.textContent?.trim() ?? ''
  }
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
    expect(healthRow('albumArt')).toEqual({ state: 'present', says: 'Album art' })
    expect(healthRow('lyrics')).toEqual({ state: 'missing', says: 'No lyrics' })
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
    expect(healthRow('video')).toEqual({ state: 'present', says: 'Video' })
    expect(healthRow('albumArt')).toEqual({ state: 'missing', says: 'No album art' })
    expect(healthRow('background')).toEqual({ state: 'unknown', says: 'Background unknown' })
    expect(healthRow('lyrics')).toEqual({ state: 'unknown', says: 'Lyrics unknown' })
  })
})

/**
 * The ring, which is the half of the health card a list cannot do.
 *
 * jsdom computes no layout, so nothing here sees a ring: what it sees is the arc's own numbers
 * and the label a screen reader is handed. Both can be wrong while the circle still looks
 * round, which is why they are pinned here and the geometry is measured in
 * `scripts/measure-rail-panel.mjs` instead.
 */
describe('Rail: the health ring', () => {
  const ring = (): SVGCircleElement => {
    const arc = document.querySelectorAll('.ring circle')[1] as SVGCircleElement | undefined
    if (!arc) throw new Error('no health ring')
    return arc
  }
  /** How much of the circle the arc covers, as a fraction, read off the dash attributes. */
  const swept = (): number => {
    const arc = ring()
    const length = Number(arc.getAttribute('stroke-dasharray'))
    const offset = Number(arc.getAttribute('stroke-dashoffset'))
    return (length - offset) / length
  }

  it('draws a full circle for a chart with nothing missing', () => {
    const target = {
      kind: 'local' as const,
      record: record({
        hasAlbumArt: true,
        hasBackground: true,
        hasVideo: true,
        hasLyrics: true,
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 9 }]
      })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(document.querySelector('.ring-value')?.textContent?.trim()).toBe('100')
    expect(swept()).toBeCloseTo(1, 6)
  })

  // Four of five is 80 and the arc is four fifths of the way round. A ring that printed the
  // number without moving the arc, or moved the arc without the number, is the failure here.
  it('moves the arc with the number', () => {
    const target = {
      kind: 'local' as const,
      record: record({
        hasAlbumArt: true,
        hasBackground: true,
        hasVideo: true,
        hasLyrics: false,
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 9 }]
      })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(document.querySelector('.ring-value')?.textContent?.trim()).toBe('80')
    expect(swept()).toBeCloseTo(0.8, 6)
  })

  // The number alone cannot say what it is a fraction of, and for a chart on Chorus it is a
  // fraction of two. The heading carries the denominator and the ring's own label repeats it,
  // because a ring reading 50 with no denominator invites "half the assets are missing".
  it('says what the number is a fraction of, for a chart nobody has read', () => {
    const target = {
      kind: 'remote' as const,
      chart: chart({ albumArtMd5: 'a'.repeat(32), hasVideoBackground: false })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(document.querySelector('.ring-value')?.textContent?.trim()).toBe('50')
    expect(screen.getByText('1 of 2 checks')).toBeTruthy()
    expect(document.querySelector('.ring')?.getAttribute('aria-label')).toBe(
      '50 out of 100: 1 of 2 checks passed'
    )
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
    expect(stat('Notes')).toBe('1,420')
    expect(stat('NPS peak')).toBe('12.3')
    expect(stat('Length')).toBe('4:33')
  })

  it('follows the instrument pick rather than totalling the chart', async () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, maxNps: NPS, songLength: 273_000 })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const instrument = document.querySelectorAll('.picks select')[0] as HTMLSelectElement
    await fireEvent.change(instrument, { target: { value: 'drums' } })
    expect(stat('Notes')).toBe('2,317')
    expect(stat('NPS peak')).toBe('9.0')
  })

  it('follows the difficulty pick too', async () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, maxNps: NPS, songLength: 273_000 })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const difficulty = document.querySelectorAll('.picks select')[1] as HTMLSelectElement
    await fireEvent.change(difficulty, { target: { value: 'hard' } })
    expect(stat('Notes')).toBe('900')
    // Nothing measured a peak rate for Hard, and a chart with 900 notes on it plainly has one.
    // The dash is the only honest answer; a 0 would be a number nobody took.
    expect(stat('NPS peak')).toBe('—')
  })

  it('answers with a dash where the scan read nothing, never with a zero', () => {
    const target = { kind: 'local' as const, record: record({ noteCounts: [], maxNps: [] }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('Notes')).toBe('—')
    expect(stat('NPS peak')).toBe('—')
    expect(stat('Length')).toBe('—')
  })

  it("reads a remote chart's length from the field the API names it with", () => {
    const target = { kind: 'remote' as const, chart: chart({ song_length: 187_000 }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('Length')).toBe('3:07')
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

/**
 * The statistics card, which is eight cells and has to stay eight.
 *
 * The design's own eight included sustains, chords, HOPO share and star power, none of which
 * Encore records. What went in instead has to be true of every chart the card can be shown for,
 * which is the half of it these pin: a cell with nothing behind it reads as a zero, and a zero
 * is a measurement.
 */
describe('Rail: the eight statistics', () => {
  const cellLabels = (): string[] =>
    [...document.querySelectorAll('.kv .stat-label')].map((el) => el.textContent?.trim() ?? '')

  const EIGHT = [
    'Notes',
    'Intensity',
    'NPS avg',
    'Difficulties',
    'NPS peak',
    'Tracks',
    'Length',
    'Solos'
  ]

  it('draws eight cells for a library chart', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(cellLabels()).toEqual(EIGHT)
  })

  // The same eight, so the card does not change shape when the user clicks from a search result
  // to a chart they own. Every one of them is answerable from both sources or dashes on both.
  it('draws the same eight for a chart from Chorus', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'remote', chart: chart() } } })
    expect(cellLabels()).toEqual(EIGHT)
  })

  // Nothing stores an average, so it is notes divided by the SONG's length: 1,420 over 273
  // seconds is 5.2. Over the charted span it would be higher, and the label says "of song"
  // nowhere, which is what the comment on `avgNps` is for.
  it('divides the selected track by the song length for the average', () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, maxNps: NPS, songLength: 273_000 })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('NPS avg')).toBe('5.2')
  })

  it('has no average for a chart with no length, rather than dividing by zero', () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, songLength: null })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('NPS avg')).toBe('—')
  })

  // song.ini's rating for the part on screen and no other part. The catalog carries ten of
  // these and the API five, so a rhythm track on a Chorus chart has none and must dash out
  // rather than borrowing the guitar's.
  it('shows the intensity of the selected instrument only', async () => {
    const target = {
      kind: 'local' as const,
      record: record({
        noteCounts: COUNTS,
        instruments: ['guitar', 'drums'],
        diffGuitar: 4,
        diffDrums: 2
      })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('Intensity')).toBe('4/6')
    const instrument = document.querySelectorAll('.picks select')[0] as HTMLSelectElement
    await fireEvent.change(instrument, { target: { value: 'drums' } })
    expect(stat('Intensity')).toBe('2/6')
  })

  // -1 is song.ini's "nobody wrote one down", and a chart rated 0 is a different claim. Both
  // are a dash here: the cell has one line and cannot hold the difference, and printing -1
  // would be the sentinel leaking onto the screen.
  it('dashes an unrated part rather than printing the sentinel', () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, instruments: ['guitar'], diffGuitar: -1 })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('Intensity')).toBe('—')
  })

  it('counts the tracks the chart has and the difficulties the selected one has', async () => {
    const target = { kind: 'local' as const, record: record({ noteCounts: COUNTS }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    // COUNTS holds guitar at two difficulties and drums at one.
    expect(stat('Tracks')).toBe('2')
    expect(stat('Difficulties')).toBe('2')
    const instrument = document.querySelectorAll('.picks select')[0] as HTMLSelectElement
    await fireEvent.change(instrument, { target: { value: 'drums' } })
    expect(stat('Difficulties')).toBe('1')
  })

  /**
   * `hasSoloSections` defaults to false on a record, so a chart nothing has read carries the
   * same false as a chart with no solos in it. The note counts are what separate the two, the
   * same test `chart-health` applies to the note counts themselves, and without it this cell
   * would tell every unscanned chart in the library that it has no solos.
   */
  it('does not report "No" for solos on a chart whose notes were never read', () => {
    render(Rail, {
      props: {
        onOpenDetail: () => {},
        target: { kind: 'local', record: record({ noteCounts: [], hasSoloSections: false }) }
      }
    })
    expect(stat('Solos')).toBe('—')
  })

  it('reports no solos once the notes have been read and there are none', () => {
    const target = { kind: 'local' as const, record: record({ noteCounts: COUNTS }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('Solos')).toBe('No')
  })

  it('reports solos when the notes carry them', () => {
    const target = {
      kind: 'local' as const,
      record: record({ noteCounts: COUNTS, hasSoloSections: true })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(stat('Solos')).toBe('Yes')
  })

  // The API leaves notesData off an unprocessed chart altogether, and undefined is "nobody
  // counted", not "none".
  it('dashes every counted cell for a Chorus chart nothing has processed', () => {
    render(Rail, {
      props: {
        onOpenDetail: () => {},
        target: { kind: 'remote', chart: chart({ notesData: null }) }
      }
    })
    expect(stat('Notes')).toBe('—')
    expect(stat('NPS avg')).toBe('—')
    expect(stat('NPS peak')).toBe('—')
    expect(stat('Tracks')).toBe('—')
    expect(stat('Solos')).toBe('—')
  })
})

/**
 * The line of context under the artist, which the design carries and the rail did not.
 *
 * Joined from the three fields that are present, so a chart with no album does not start its
 * third line with a separator, and a chart with none of the three has no third line at all.
 */
describe('Rail: album, year and genre', () => {
  it('joins the three the chart has', () => {
    const target = {
      kind: 'local' as const,
      record: record({ album: 'Moving Pictures', year: 1981, genre: 'Rock' })
    }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(screen.getByText('Moving Pictures · 1981 · Rock')).toBeTruthy()
  })

  it('leaves out the ones it does not have, separators included', () => {
    const target = { kind: 'local' as const, record: record({ album: null, year: 1981 }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(screen.getByText('1981')).toBeTruthy()
  })

  it('draws nothing at all for a chart with none of the three', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(document.querySelector('.context')?.textContent).toBe('')
  })

  // A remote chart's year is a string the API sends and a record's is a number the scanner
  // parsed. Both reach the same line.
  it("reads a remote chart's year from the field the API names it with", () => {
    const target = { kind: 'remote' as const, chart: chart({ album: 'Hemispheres', year: '1978' }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(screen.getByText('Hemispheres · 1978')).toBeTruthy()
  })
})

// The badge over the highway names the track Play would open, so it has to follow both picks.
// Nothing in the corner opposite it: the design draws a score and a multiplier there, and
// Encore's preview has no scoring engine to produce either.
describe('Rail: the badge over the highway', () => {
  it('names the instrument and difficulty the preview would play', async () => {
    const target = { kind: 'local' as const, record: record({ noteCounts: COUNTS }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    expect(document.querySelector('.hwt')?.textContent?.trim()).toBe('Expert · Guitar')
    const instrument = document.querySelectorAll('.picks select')[0] as HTMLSelectElement
    await fireEvent.change(instrument, { target: { value: 'drums' } })
    expect(document.querySelector('.hwt')?.textContent?.trim()).toBe('Expert · Drums')
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

  // The design drew a favourite and an add-to-setlist button, and both are here now. The ORDER is
  // what this pins: the action is the row's first button, the two icon buttons that do something
  // to the chart sit between, and the way out of the column is last.
  it('draws the action, the heart, the setlist button and the way out, in that order', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    const labels = [...document.querySelectorAll('.actions button')].map((b) =>
      (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()
    )
    expect(labels).toEqual(['Show in folder', 'Favourite', 'Add to setlist', 'All details'])
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
 * The heart, which is the one control here both kinds of subject can answer.
 *
 * A favourite is attached to the chart rather than to a copy of it (shared/favourites.ts), so
 * the rail can offer it over a Chorus result as readily as over a chart on disk, and the two
 * presses are the same row. What jsdom can check is exactly that: which chart the press names,
 * what state the button reports, and that a chart with no name of its own is refused rather
 * than attached to its folder name.
 */
describe('Rail: the heart', () => {
  afterEach(() => favourites.set([]))

  it('reads as off for a chart nothing has hearted', () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(screen.getByRole('button', { name: 'Favourite' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
  })

  it('reads as on for a chart the store already holds, whatever case it is spelled in', () => {
    favourites.set([{ name: 'yyz', artist: 'RUSH', charter: 'SomeOne', addedAt: 'now' }])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(screen.getByRole('button', { name: 'Favourite' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  it('hearts a library chart by the three fields it names itself by', async () => {
    const favouritesSet = vi.fn().mockResolvedValue([])
    vi.stubGlobal('encore', { favouritesSet })
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Favourite' }))
    expect(favouritesSet).toHaveBeenCalledWith({
      name: 'YYZ',
      artist: 'Rush',
      charter: 'someone',
      favourite: true
    })
  })

  it('hearts a chart on Chorus the same way, which is the whole point of the key', async () => {
    const favouritesSet = vi.fn().mockResolvedValue([])
    vi.stubGlobal('encore', { favouritesSet })
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'remote', chart: chart() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Favourite' }))
    expect(favouritesSet).toHaveBeenCalledWith({
      name: 'YYZ',
      artist: 'Rush',
      charter: 'someone',
      favourite: true
    })
  })

  it('un-hearts a chart that is already hearted', async () => {
    const favouritesSet = vi.fn().mockResolvedValue([])
    vi.stubGlobal('encore', { favouritesSet })
    favourites.set([{ name: 'YYZ', artist: 'Rush', charter: 'someone', addedAt: 'now' }])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Favourite' }))
    expect(favouritesSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'YYZ', favourite: false })
    )
  })

  it('takes the answer from main rather than guessing at it', async () => {
    const favouritesSet = vi
      .fn()
      .mockResolvedValue([{ name: 'YYZ', artist: 'Rush', charter: 'someone', addedAt: 'now' }])
    vi.stubGlobal('encore', { favouritesSet })
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Favourite' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Favourite' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    )
  })

  // A chart with no name is drawn from its folder name, which is a display fallback and not an
  // identity: two of them would be one favourite between them, and renaming a folder would move
  // it. Refused rather than attached to something that cannot hold it.
  it('refuses a chart that sets no name of its own, and says why where it was pressed', async () => {
    const favouritesSet = vi.fn()
    vi.stubGlobal('encore', { favouritesSet })
    const target = { kind: 'local' as const, record: record({ name: null }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const heart = screen.getByRole('button', { name: 'Favourite' })
    expect(heart.getAttribute('aria-disabled')).toBe('true')
    // aria-disabled rather than disabled, so the press still lands and the reason is a sentence
    // on screen: Chromium suppresses the tooltip on a disabled control along with everything else.
    await fireEvent.click(heart)
    expect(favouritesSet).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toContain('no name of its own')
  })

  it('says why a heart was refused, where the user pressed it', async () => {
    const favouritesSet = vi.fn().mockRejectedValue(new Error('The catalog is closed'))
    vi.stubGlobal('encore', { favouritesSet })
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Favourite' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The catalog is closed')
  })
})

/**
 * The rail's third action, which is the design's add-to-setlist button.
 *
 * jsdom applies no CSS, so nothing here says whether the row still fits at 374px with three
 * buttons in it; that is scripts/measure-rail-panel.mjs, which prints the action's width and
 * whether its word is clipped. What is pinned is the part that would be a defect: which setlists
 * the button says the chart is in, that adding it to one is a write keyed on the chart rather than
 * on its path, and that a chart with no name is refused with the reason on screen.
 */
describe('Rail: the setlist button', () => {
  const SETLIST = { id: 'a', name: 'Friday night', createdAt: 'now', entries: [] }
  const HOLDING = {
    ...SETLIST,
    entries: [{ name: 'yyz', artist: 'RUSH', charter: 'SomeOne', addedAt: 'now' }]
  }
  afterEach(() => setlists.set([]))

  const openPanel = async (): Promise<void> => {
    await fireEvent.click(screen.getByRole('button', { name: 'Add to setlist' }))
  }

  it('keeps the panel shut until it is pressed', () => {
    setlists.set([SETLIST])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    const button = screen.getByRole('button', { name: 'Add to setlist' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /Friday night/ })).toBeNull()
  })

  it('lists the setlists, ticking the ones this chart is already in', async () => {
    setlists.set([HOLDING, { ...SETLIST, id: 'b', name: 'Encores' }])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await openPanel()
    // 'yyz'/'RUSH'/'SomeOne' against 'YYZ'/'Rush'/'someone': one chart, whatever case either side
    // spelled it in, which is the shared key doing its job.
    expect(screen.getByRole('button', { name: 'Friday night' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: 'Encores' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
  })

  it('reads as on while the chart is in any setlist at all', () => {
    setlists.set([HOLDING])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    expect(screen.getByRole('button', { name: 'Add to setlist' }).classList.contains('on')).toBe(
      true
    )
  })

  it('adds a library chart by the three fields it names itself by', async () => {
    const setlistsSetEntry = vi.fn().mockResolvedValue([])
    vi.stubGlobal('encore', { setlistsSetEntry })
    setlists.set([SETLIST])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await openPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Friday night' }))
    expect(setlistsSetEntry).toHaveBeenCalledWith({
      id: 'a',
      name: 'YYZ',
      artist: 'Rush',
      charter: 'someone',
      member: true
    })
  })

  // The same press on a chart from Chorus, which is what a key on the chart rather than on a path
  // buys: the entry is already there when the download lands.
  it('adds a chart on Chorus the same way', async () => {
    const setlistsSetEntry = vi.fn().mockResolvedValue([])
    vi.stubGlobal('encore', { setlistsSetEntry })
    setlists.set([SETLIST])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'remote', chart: chart() } } })
    await openPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Friday night' }))
    expect(setlistsSetEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', name: 'YYZ', member: true })
    )
  })

  it('takes it back out of one it is already in', async () => {
    const setlistsSetEntry = vi.fn().mockResolvedValue([])
    vi.stubGlobal('encore', { setlistsSetEntry })
    setlists.set([HOLDING])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await openPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Friday night' }))
    expect(setlistsSetEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', member: false })
    )
  })

  it('makes a setlist and puts the chart in it in one go', async () => {
    const setlistsCreate = vi.fn().mockResolvedValue([SETLIST])
    const setlistsSetEntry = vi.fn().mockResolvedValue([SETLIST])
    vi.stubGlobal('encore', { setlistsCreate, setlistsSetEntry })
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await openPanel()
    const box = screen.getByLabelText('New setlist name')
    await fireEvent.input(box, { target: { value: 'Friday night' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(setlistsCreate).toHaveBeenCalledWith({ name: 'Friday night' })
    await waitFor(() =>
      expect(setlistsSetEntry).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a', name: 'YYZ', member: true })
      )
    )
  })

  it('offers to name one when there are none, rather than an empty list', async () => {
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await openPanel()
    expect(screen.getByText(/You have no setlists yet/)).toBeTruthy()
    expect(screen.getByLabelText('New setlist name')).toBeTruthy()
  })

  // The same refusal the heart makes, for the same reason: a chart drawn from its folder name has
  // no identity an entry could hold on to.
  it('refuses a chart that sets no name of its own, and says why where it was pressed', async () => {
    const setlistsSetEntry = vi.fn()
    vi.stubGlobal('encore', { setlistsSetEntry })
    const target = { kind: 'local' as const, record: record({ name: null }) }
    render(Rail, { props: { onOpenDetail: () => {}, target } })
    const button = screen.getByRole('button', { name: 'Add to setlist' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(setlistsSetEntry).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toContain('no name of its own')
  })

  it('says why a write was refused, where the user pressed it', async () => {
    vi.stubGlobal('encore', {
      setlistsSetEntry: vi.fn().mockRejectedValue(new Error('That setlist no longer exists.'))
    })
    setlists.set([SETLIST])
    render(Rail, { props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } } })
    await openPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Friday night' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'That setlist no longer exists.'
    )
  })

  // A panel left open over the next chart would be a list of ticks about the chart before it.
  it('shuts when the rail changes chart', async () => {
    setlists.set([SETLIST])
    const { rerender } = render(Rail, {
      props: { onOpenDetail: () => {}, target: { kind: 'local', record: record() } }
    })
    await openPanel()
    expect(screen.getByRole('button', { name: 'Friday night' })).toBeTruthy()
    await rerender({
      onOpenDetail: () => {},
      target: { kind: 'local', record: record({ path: '/library/other', name: 'Other' }) }
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add to setlist' }).getAttribute('aria-expanded')
      ).toBe('false')
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
