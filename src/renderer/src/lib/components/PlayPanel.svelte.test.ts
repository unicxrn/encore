import { render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayDataStatus, PlayStats } from '../../../../shared/play'
import PlayPanel from './PlayPanel.svelte'

/**
 * What these can and cannot check.
 *
 * jsdom applies no stylesheet and computes no layout, so nothing here sees the tile grid wrap,
 * the top-ten columns line up, or the caveat sit above the numbers in the rendered page. What
 * IS checked is the thing the panel is actually risky about: which sentence it says in which
 * state, and that no figure is drawn without the window it covers being stated first. The
 * caveat's POSITION in the DOM is asserted below; how it looks on screen is not.
 */

const status = (over: Partial<PlayDataStatus> = {}): PlayDataStatus => ({
  available: false,
  reason: 'ok',
  path: '/home/player/.clonehero/scorestats.json',
  playCount: 0,
  ...over
})

const stats = (over: Partial<PlayStats> = {}): PlayStats => ({
  totalPlays: 0,
  chartsPlayed: 0,
  fcCount: 0,
  pfcCount: 0,
  notesHit: 0,
  totalNotes: 0,
  bestScore: null,
  longestStreak: null,
  firstPlayedAt: null,
  lastPlayedAt: null,
  byInstrument: [],
  byDifficulty: [],
  topCharts: [],
  ...over
})

/**
 * `encore()` reads `window.encore`, and under jsdom `globalThis` *is* `window`. `playStats` is
 * given to every stub whether or not the test expects it to be called, so that "was it called"
 * is a question these tests can ask rather than a crash.
 */
function renderPanel(
  playStatus: PlayDataStatus,
  playStats: PlayStats = stats()
): { playStats: ReturnType<typeof vi.fn>; playStatus: ReturnType<typeof vi.fn> } {
  const statusFn = vi.fn(() => Promise.resolve(playStatus))
  const statsFn = vi.fn(() => Promise.resolve(playStats))
  vi.stubGlobal('encore', {
    playStatus: statusFn,
    playStats: statsFn,
    // Returns the unsubscribe the component hands back from onMount.
    onPlayRecorded: () => () => {}
  })
  render(PlayPanel)
  return { playStats: statsFn, playStatus: statusFn }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The panel's text, whitespace-collapsed, once the first fetch has settled. */
async function panelText(): Promise<string> {
  const section = await waitFor(() => {
    const found = document.querySelector('section')
    if (!found) throw new Error('no panel rendered')
    if (/LOADING/.test(found.textContent ?? '')) throw new Error('still loading')
    return found
  })
  return (section.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The state every user is in on the day they install Encore, and the one the owner is most
 * likely to be looking at. A grid of zeroes here would be a claim about their playing.
 */
describe('PlayPanel: nothing recorded yet', () => {
  it('says the file is being watched and draws no figures', async () => {
    renderPanel(status({ available: false, reason: 'ok', playCount: 0 }))

    const text = await panelText()
    expect(text).toContain('has recorded no play yet')
    expect(text).toContain('/home/player/.clonehero/scorestats.json')
    // No tiles, which is the part that matters: a zero is a number, and a number here is a lie.
    expect(document.querySelector('.tiles')).toBeNull()
    expect(text).not.toMatch(/\bACCURACY\b/)
  })

  it('never asks for the aggregate when the gate says there is nothing', async () => {
    // playStats on an empty table answers with a zeroed object, which is correct and
    // indistinguishable from "played nothing". The gate is what keeps the two apart.
    const { playStats } = renderPanel(status({ available: false, reason: 'ok' }))
    await panelText()
    expect(playStats).not.toHaveBeenCalled()
  })
})

describe('PlayPanel: no score file to read', () => {
  it('reports a missing file as ordinary, with the path it looked at', async () => {
    renderPanel(status({ reason: 'noFile', available: false }))

    const text = await panelText()
    expect(text).toContain('Nothing to show yet')
    expect(text).toContain('/home/player/.clonehero/scorestats.json')
    // Not an error the user has to act on, so it is not worded as one.
    expect(text).not.toMatch(/failed|error|could not/i)
  })

  it('says Encore has no location on a platform it refuses to guess for', async () => {
    renderPanel(status({ reason: 'unknownPlatform', path: null, available: false }))
    expect(await panelText()).toContain('no established location')
  })

  it('says an unreadable file fixes itself, because a mid-save one does', async () => {
    renderPanel(status({ reason: 'unreadable', available: false }))

    const text = await panelText()
    expect(text).toContain('could not read it')
    expect(text).toContain('fixes itself')
  })
})

describe('PlayPanel: a populated panel', () => {
  const populated = stats({
    totalPlays: 42,
    chartsPlayed: 17,
    fcCount: 5,
    pfcCount: 1,
    // 1000 of 1100. Chosen so the two readings differ: as a ratio of sums this is 90.9%, while
    // the average of the two plays it could be made of (100/100 and 900/1000) is 95.0%. The
    // panel must show the first, which is the only one this data supports.
    notesHit: 1000,
    totalNotes: 1100,
    bestScore: 1_234_567,
    longestStreak: 888,
    firstPlayedAt: '2026-03-03T18:04:11.1234567Z',
    lastPlayedAt: '2026-09-01T20:00:00.0000000Z',
    topCharts: [
      {
        checksum: 'a'.repeat(32),
        songName: 'YYZ',
        artistName: 'Rush',
        charterName: 'someone',
        timesPlayed: 12,
        bestScore: 500_000
      },
      {
        checksum: 'b'.repeat(32),
        songName: 'Limelight',
        artistName: 'Rush',
        charterName: null,
        timesPlayed: 1,
        bestScore: null
      }
    ]
  })

  const ok = status({ available: true, reason: 'ok', playCount: 42 })

  it('anchors every figure to the date the record starts, above the figures', async () => {
    renderPanel(ok, populated)
    await panelText()

    const caveat = document.querySelector('.caveat')
    expect(caveat).not.toBeNull()
    const text = (caveat?.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('not your lifetime totals')
    expect(text).toContain(new Date('2026-03-03T18:04:11.1234567Z').toLocaleDateString())

    // Above, not merely present. compareDocumentPosition's FOLLOWING bit is set when the tiles
    // come after the caveat in document order, which is what "cannot be missed" means here.
    const tiles = document.querySelector('.tiles')
    if (!caveat || !tiles) throw new Error('caveat and tiles must both render')
    expect(caveat.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows accuracy as the ratio of the two totals, and says which totals', async () => {
    renderPanel(ok, populated)
    const text = await panelText()

    expect(text).toContain('90.9%')
    // Not 95.0%, which is what averaging the per-play accuracies would give.
    expect(text).not.toContain('95.0%')
    expect(text).toContain('1,000 of 1,100 notes')
  })

  it('renders a dash rather than dividing by zero when no notes were recorded', async () => {
    renderPanel(
      ok,
      stats({ totalPlays: 3, notesHit: 0, totalNotes: 0, firstPlayedAt: '2026-03-03T00:00:00Z' })
    )
    const text = await panelText()

    expect(text).toContain('no notes recorded')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('Infinity')
  })

  it('draws the totals, the combos and the bests', async () => {
    renderPanel(ok, populated)
    const text = await panelText()

    expect(text).toContain('42')
    expect(text).toContain('across 17 charts')
    expect(text).toContain('1 of them perfect')
    expect(text).toContain('1,234,567')
    expect(text).toContain('888')
  })

  it('keeps a null best as the empty-cell dash, never as a zero', async () => {
    renderPanel(
      ok,
      stats({
        totalPlays: 1,
        bestScore: null,
        longestStreak: null,
        firstPlayedAt: '2026-03-03T00:00:00Z'
      })
    )
    const tiles = await waitFor(() => {
      const found = [...document.querySelectorAll('.tile')]
      if (found.length === 0) throw new Error('no tiles yet')
      return found
    })
    const best = tiles.find((tile) => tile.textContent?.includes('BEST SCORE'))
    expect(best?.querySelector('.t-value')?.textContent?.trim()).toBe('—')
  })

  /**
   * The names in this list are the ones Clone Hero wrote with the play, not the catalog's, so a
   * chart deleted since is still here. That is deliberate (see main/play/store.ts) and the panel
   * says so rather than quietly joining the rows away.
   */
  it('lists the most played with what Clone Hero recorded, and says so', async () => {
    renderPanel(ok, populated)
    const text = await panelText()

    expect(text).toContain('YYZ')
    expect(text).toContain('12 plays')
    expect(text).toContain('Limelight')
    // Singular for one, because "1 plays" is the kind of thing people stop trusting a panel over.
    expect(text).toContain('1 play')
    expect(text).toContain('since deleted')
  })

  it('refetches when a play is recorded while the panel is open', async () => {
    const statusFn = vi.fn(() => Promise.resolve(ok))
    const statsFn = vi.fn(() => Promise.resolve(populated))
    let fire: (() => void) | null = null
    vi.stubGlobal('encore', {
      playStatus: statusFn,
      playStats: statsFn,
      onPlayRecorded: (handler: () => void) => {
        fire = handler
        return () => {}
      }
    })
    render(PlayPanel)
    await waitFor(() => expect(statsFn).toHaveBeenCalledTimes(1))

    fire?.()
    await waitFor(() => expect(statsFn).toHaveBeenCalledTimes(2))
  })
})

describe('PlayPanel: a bridge that cannot answer', () => {
  it('reports the failure instead of drawing an empty state that blames the user', async () => {
    vi.stubGlobal('encore', {
      playStatus: () => Promise.reject(new Error('no handler')),
      playStats: () => Promise.resolve(stats())
    })
    render(PlayPanel)

    expect(await panelText()).toContain('could not read your play history: no handler')
  })

  it('still draws the panel when the bridge has no play-recorded event', async () => {
    // An older preload, or a test stub: the numbers are worth having without live updates, so
    // the missing subscription must not take the panel down with it.
    vi.stubGlobal('encore', {
      playStatus: () => Promise.resolve(status({ available: false, reason: 'noFile' }))
    })
    render(PlayPanel)

    expect(await panelText()).toContain('Nothing to show yet')
  })
})
