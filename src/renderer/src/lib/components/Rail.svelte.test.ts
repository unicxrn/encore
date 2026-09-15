import { render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Rail from './Rail.svelte'
import type { ChartRecord } from '../../../../shared/schemas'
import type { ChartData } from '../api/enchor'

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
    render(Rail, { props: { target: null } })
    expect(screen.getByText('Open a chart and it stays here.')).toBeTruthy()
    // No viewport, so the controller has nothing to register and no preview can be opened
    // from a rail that has no chart.
    expect(document.querySelector('.viewport')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Play preview' })).toBeNull()
  })
})

describe('Rail: a chart from the library', () => {
  it('names the song, the artist and the charter', () => {
    render(Rail, { props: { target: { kind: 'local', record: record() } } })
    expect(screen.getByText('YYZ')).toBeTruthy()
    expect(screen.getByText('Rush')).toBeTruthy()
    expect(screen.getByText('Charted by someone')).toBeTruthy()
  })

  // Deliberately not a heading: the content pane already headlines the same song, and two
  // <h2>s reading "YYZ" is one song with two headings as far as a screen reader is concerned.
  it('does not add a second heading for the song the content pane is already showing', () => {
    render(Rail, { props: { target: { kind: 'local', record: record() } } })
    expect(screen.queryByRole('heading', { name: 'YYZ' })).toBeNull()
  })

  it('reports each asset the scan read, as read', () => {
    const target = { kind: 'local' as const, record: record({ hasAlbumArt: true }) }
    render(Rail, { props: { target } })
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
    render(Rail, { props: { target } })
    const options = [...document.querySelectorAll('.picks select')][0].querySelectorAll('option')
    expect([...options].map((o) => o.textContent?.trim())).toEqual(['Guitar', 'Drums'])
  })

  // A chart scanned before the catalog stored note counts has an empty matrix. An empty select
  // would be worse than the guess: the chart may well hold a guitar track nothing recorded.
  it('falls back to guitar rather than to an empty instrument list', () => {
    render(Rail, { props: { target: { kind: 'local', record: record({ noteCounts: [] }) } } })
    const options = [...document.querySelectorAll('.picks select')][0].querySelectorAll('option')
    expect([...options].map((o) => o.textContent?.trim())).toEqual(['Guitar'])
  })
})

describe('Rail: a chart from Chorus', () => {
  // The rail is entitled to say "missing" about a chart somebody has read, and only then. The
  // API reports the cover and the video and says nothing at all about the other two.
  it('says unknown for the two assets the API does not report', () => {
    render(Rail, {
      props: { target: { kind: 'remote', chart: chart({ hasVideoBackground: true }) } }
    })
    expect(healthState('Video')).toBe('OK')
    expect(healthState('Album art')).toBe('MISSING')
    expect(healthState('Background')).toBe('UNKNOWN')
    expect(healthState('Lyrics')).toBe('UNKNOWN')
  })
})
