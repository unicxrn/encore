import { render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayDataStatus, PlayInsights, PlayStats } from '../../../../shared/play'
import { localDay } from '../play-activity'
import Stats from './Stats.svelte'

/**
 * What these can and cannot check.
 *
 * jsdom applies no stylesheet and computes no layout, so nothing here sees the tile grid wrap,
 * the two lists sit side by side, the activity bars have any height, or the caveat sit above
 * the numbers in the rendered page. Those rest on scripts/measure-play-stats.mjs, which drives
 * the built renderer in a real engine. What IS checked is the thing this page is actually risky
 * about: which sentence it says in which state, that no figure is drawn without the window it
 * covers being stated first, and that a name written in Clone Hero's markup reads as text.
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

const insights = (over: Partial<PlayInsights> = {}): PlayInsights => ({
  days: [],
  coverage: { inLibrary: 0, identified: 0, withPlay: 0, playsOffLibrary: 0 },
  topCharters: [],
  recent: [],
  ...over
})

/**
 * `encore()` reads `window.encore`, and under jsdom `globalThis` *is* `window`. Both aggregate
 * calls are given to every stub whether or not the test expects them to be made, so that "was
 * it called" is a question these tests can ask rather than a crash.
 */
function renderStats(
  playStatus: PlayDataStatus,
  playStats: PlayStats = stats(),
  playInsights: PlayInsights = insights()
): {
  playStats: ReturnType<typeof vi.fn>
  playInsights: ReturnType<typeof vi.fn>
  playStatus: ReturnType<typeof vi.fn>
} {
  const statusFn = vi.fn(() => Promise.resolve(playStatus))
  const statsFn = vi.fn(() => Promise.resolve(playStats))
  const insightsFn = vi.fn(() => Promise.resolve(playInsights))
  vi.stubGlobal('encore', {
    playStatus: statusFn,
    playStats: statsFn,
    playInsights: insightsFn,
    // Returns the unsubscribe the component hands back from onMount.
    onPlayRecorded: () => () => {}
  })
  render(Stats)
  return { playStats: statsFn, playInsights: insightsFn, playStatus: statusFn }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The page's text, whitespace-collapsed, once the first fetch has settled. */
async function pageText(): Promise<string> {
  const page = await waitFor(() => {
    const found = document.querySelector('.stats')
    if (!found) throw new Error('no page rendered')
    if (/LOADING/.test(found.textContent ?? '')) throw new Error('still loading')
    return found
  })
  return (page.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The state every user is in on the day they install Encore, and the one the owner is most
 * likely to be looking at. A page of zeroes here would be a claim about their playing.
 */
describe('Stats: nothing recorded yet', () => {
  it('says the file is being watched and draws no figures', async () => {
    renderStats(status({ available: false, reason: 'ok', playCount: 0 }))

    const text = await pageText()
    expect(text).toContain('has recorded no play yet')
    expect(text).toContain('/home/player/.clonehero/scorestats.json')
    // No tiles and no chart, which is the part that matters: a zero is a number, and a number
    // here is a lie.
    expect(document.querySelector('.tiles')).toBeNull()
    expect(document.querySelector('.chart')).toBeNull()
    expect(text).not.toMatch(/\bACCURACY\b/)
  })

  it('never asks for either aggregate when the gate says there is nothing', async () => {
    // Both answer an empty table with zeroes and empty lists, which is correct and
    // indistinguishable from "played nothing". The gate is what keeps the two apart.
    const { playStats, playInsights } = renderStats(status({ available: false, reason: 'ok' }))
    await pageText()
    expect(playStats).not.toHaveBeenCalled()
    expect(playInsights).not.toHaveBeenCalled()
  })
})

describe('Stats: no score file to read', () => {
  it('reports a missing file as ordinary, with the path it looked at', async () => {
    renderStats(status({ reason: 'noFile', available: false }))

    const text = await pageText()
    expect(text).toContain('Nothing to show yet')
    expect(text).toContain('/home/player/.clonehero/scorestats.json')
    // Not an error the user has to act on, so it is not worded as one.
    expect(text).not.toMatch(/failed|error|could not/i)
  })

  it('says Encore has no location on a platform it refuses to guess for', async () => {
    renderStats(status({ reason: 'unknownPlatform', path: null, available: false }))
    expect(await pageText()).toContain('no established location')
  })

  it('says an unreadable file fixes itself, because a mid-save one does', async () => {
    renderStats(status({ reason: 'unreadable', available: false }))

    const text = await pageText()
    expect(text).toContain('could not read it')
    expect(text).toContain('fixes itself')
  })
})

const ok = status({ available: true, reason: 'ok', playCount: 42 })

const populated = stats({
  totalPlays: 42,
  chartsPlayed: 17,
  fcCount: 5,
  pfcCount: 1,
  // 1000 of 1100. Chosen so the two readings differ: as a ratio of sums this is 90.9%, while
  // the average of the two plays it could be made of (100/100 and 900/1000) is 95.0%. The
  // page must show the first, which is the only one this data supports.
  notesHit: 1000,
  totalNotes: 1100,
  bestScore: 1_234_567,
  longestStreak: 888,
  firstPlayedAt: '2026-03-03T18:04:11.1234567Z',
  lastPlayedAt: '2026-09-01T20:00:00.0000000Z',
  byInstrument: [
    { key: 'Guitar', plays: 30 },
    { key: 'Drums', plays: 12 }
  ],
  byDifficulty: [{ key: 'Expert', plays: 42 }],
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

/** Two days of history ending today, so the chart has a window whatever day the suite runs. */
const today = localDay(new Date())
const yesterday = localDay(new Date(Date.now() - 86_400_000))

const populatedInsights = insights({
  days: [
    { day: yesterday, plays: 3 },
    { day: today, plays: 5 }
  ],
  coverage: { inLibrary: 4210, identified: 4000, withPlay: 177, playsOffLibrary: 6 },
  topCharters: [{ charter: 'Mech', owned: 40, played: 9, plays: 31 }],
  recent: [
    {
      checksum: 'a'.repeat(32),
      playedAt: '2026-09-01T20:00:00.0000000Z',
      songName: 'YYZ',
      artistName: 'Rush',
      charterName: 'someone',
      instrument: 'Guitar',
      difficulty: 'Expert',
      score: 500_000,
      accuracy: 0.9812,
      isFc: true,
      isPfc: false
    }
  ]
})

describe('Stats: a populated page', () => {
  it('anchors every figure to the date the record starts, above the figures', async () => {
    renderStats(ok, populated, populatedInsights)
    await pageText()

    const caveat = document.querySelector('.caveat')
    expect(caveat).not.toBeNull()
    const text = (caveat?.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('not your lifetime totals')
    expect(text).toContain(new Date('2026-03-03T18:04:11.1234567Z').toLocaleDateString())

    // Above, not merely present. compareDocumentPosition's FOLLOWING bit is set when the figures
    // come after the caveat in document order, which is what "cannot be missed" means here.
    for (const selector of ['.tiles', '.chart', '.top', '.charters']) {
      const figures = document.querySelector(selector)
      if (!caveat || !figures) throw new Error(`caveat and ${selector} must both render`)
      expect(
        caveat.compareDocumentPosition(figures) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${selector} is not below the caveat`
      ).toBeTruthy()
    }
  })

  it('states the window once rather than on every block', async () => {
    renderStats(ok, populated, populatedInsights)
    await pageText()
    expect(document.querySelectorAll('.caveat')).toHaveLength(1)
  })

  it('shows accuracy as the ratio of the two totals, and says which totals', async () => {
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(text).toContain('90.9%')
    // Not 95.0%, which is what averaging the per-play accuracies would give.
    expect(text).not.toContain('95.0%')
    expect(text).toContain('1,000 of 1,100 notes')
  })

  it('renders a dash rather than dividing by zero when no notes were recorded', async () => {
    renderStats(
      ok,
      stats({ totalPlays: 3, notesHit: 0, totalNotes: 0, firstPlayedAt: '2026-03-03T00:00:00Z' })
    )
    const text = await pageText()

    expect(text).toContain('no notes recorded')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('Infinity')
  })

  it('draws the totals, the combos and the bests', async () => {
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(text).toContain('42')
    expect(text).toContain('across 17 charts')
    expect(text).toContain('1 of them perfect')
    expect(text).toContain('1,234,567')
    expect(text).toContain('888')
  })

  it('keeps a null best as the empty-cell dash, never as a zero', async () => {
    renderStats(
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
   * chart deleted since is still here. That is deliberate (see main/play/store.ts) and the page
   * says so rather than quietly joining the rows away.
   */
  it('lists the most played with what Clone Hero recorded, and says so', async () => {
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(text).toContain('YYZ')
    expect(text).toContain('12 plays')
    expect(text).toContain('Limelight')
    // Singular for one, because "1 plays" is the kind of thing people stop trusting a page over.
    expect(text).toContain('1 play')
    expect(text).toContain('since deleted')
  })

  it('refetches both aggregates when a play is recorded while the page is open', async () => {
    const statusFn = vi.fn(() => Promise.resolve(ok))
    const statsFn = vi.fn(() => Promise.resolve(populated))
    const insightsFn = vi.fn(() => Promise.resolve(populatedInsights))
    let fire: (() => void) | null = null
    vi.stubGlobal('encore', {
      playStatus: statusFn,
      playStats: statsFn,
      playInsights: insightsFn,
      onPlayRecorded: (handler: () => void) => {
        fire = handler
        return () => {}
      }
    })
    render(Stats)
    await waitFor(() => expect(statsFn).toHaveBeenCalledTimes(1))

    fire?.()
    await waitFor(() => expect(statsFn).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(insightsFn).toHaveBeenCalledTimes(2))
  })
})

describe('Stats: the history over time', () => {
  it('draws one bar per day of the window, starting at the first recorded play', async () => {
    renderStats(ok, populated, populatedInsights)
    await pageText()

    // Two days of history, two bars, and the left-hand label is the first recorded day rather
    // than a week or a month that would reach back before Encore was watching.
    expect(document.querySelectorAll('.chart .col')).toHaveLength(2)
    const axis = document.querySelector('.axis')?.textContent?.replace(/\s+/g, ' ').trim()
    expect(axis).toContain(new Date(`${yesterday}T12:00:00`).toLocaleDateString())
    expect(axis).toContain(new Date(`${today}T12:00:00`).toLocaleDateString())
  })

  it('names the busiest day and how much of the window has a play', async () => {
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(text).toContain('Busiest day on record: 5 plays')
    expect(text).toContain('You played on 2 of the 2 days since the record started')
  })

  it('draws no chart at all when no day has a play', async () => {
    renderStats(ok, stats({ totalPlays: 1, firstPlayedAt: '2026-03-03T00:00:00Z' }), insights())
    await pageText()
    expect(document.querySelector('.chart')).toBeNull()
  })
})

describe('Stats: what the library has been played of', () => {
  it('keeps "no play on record" apart from "never played"', async () => {
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(text).toContain('Encore has seen you play 177 of the 4,000 charts')
    expect(text).toContain('3,823 have no play on record')
    expect(text).toContain('not the same as never played')
  })

  it('says which charts can never be matched, and that a rescan fixes it', async () => {
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(text).toContain('210 of your 4,210 charts carry no Clone Hero checksum')
    expect(text).toContain('A rescan gives them one')
  })

  it('counts plays of charts the library no longer holds rather than hiding them', async () => {
    renderStats(ok, populated, populatedInsights)
    expect(await pageText()).toContain('6 plays on record are of charts your library does not hold')
  })

  it('states no ratio at all when nothing in the library can be matched yet', async () => {
    // A library that has not been scanned since Encore started recording Clone Hero's identity
    // for a chart. "0 of 0" would read as a claim about the user's playing.
    renderStats(
      ok,
      populated,
      insights({
        ...populatedInsights,
        coverage: { inLibrary: 0, identified: 0, withPlay: 0, playsOffLibrary: 2 }
      })
    )
    const text = await pageText()
    expect(text).toContain('Nothing in your library can be matched to a play yet')
    expect(text).not.toContain('Encore has seen you play 0')
  })

  it('says nothing about unmatched charts when every chart is matched', async () => {
    renderStats(
      ok,
      populated,
      insights({
        ...populatedInsights,
        coverage: { inLibrary: 100, identified: 100, withPlay: 100, playsOffLibrary: 0 }
      })
    )
    const text = await pageText()
    expect(text).not.toContain('no Clone Hero checksum')
    expect(text).not.toContain('does not hold')
    // Nothing left unplayed either, so the "not the same as never played" clause is not drawn.
    expect(text).not.toContain('have no play on record')
  })

  it('counts a charter off the library, and says that is what it did', async () => {
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(text).toContain('Mech')
    expect(text).toContain('9 of 40 played')
    expect(text).toContain('no longer own is not listed')
  })
})

/**
 * Charters style their own names in the game, and song.ini carries the markup verbatim. One
 * charter in a real history is eight colour tags, one per letter; drawn raw, a top-ten row
 * reads as `<color=#7B0000>W</color><color=#8B0000>i</color>…`.
 */
describe('Stats: names written in Clone Hero markup', () => {
  it('reads a styled name as text everywhere it is drawn', async () => {
    renderStats(
      ok,
      stats({
        ...populated,
        topCharts: [
          {
            checksum: 'a'.repeat(32),
            songName: '<color=#ff0000>YYZ</color>',
            artistName: '<b>Rush</b>',
            charterName: '<color=#7B0000>W</color><color=#8B0000>i</color>',
            timesPlayed: 12,
            bestScore: 500_000
          }
        ]
      }),
      insights({
        ...populatedInsights,
        topCharters: [{ charter: '<i>Mech</i>', owned: 4, played: 2, plays: 9 }],
        recent: [
          {
            ...populatedInsights.recent[0],
            songName: '<size=20>Limelight</size>',
            artistName: '<color=#00ff00>Rush</color>',
            charterName: null
          }
        ]
      })
    )
    const text = await pageText()

    expect(text).not.toContain('<color=')
    expect(text).not.toContain('</color>')
    expect(text).not.toContain('<size=')
    expect(text).toContain('YYZ')
    expect(text).toContain('Wi')
    expect(text).toContain('Mech')
    expect(text).toContain('Limelight')
  })

  it('names a chart whose title is nothing but markup rather than drawing a blank row', async () => {
    renderStats(
      ok,
      stats({ ...populated, topCharts: [{ ...populated.topCharts[0], songName: '<b></b>' }] }),
      populatedInsights
    )
    expect(await pageText()).toContain('Unnamed chart')
  })

  it('names a charter whose name is nothing but markup', async () => {
    renderStats(
      ok,
      populated,
      insights({
        ...populatedInsights,
        topCharters: [{ charter: '', owned: 2, played: 1, plays: 4 }]
      })
    )
    expect(await pageText()).toContain('Unnamed charter')
  })
})

describe('Stats: the last few plays', () => {
  it('draws one row per play with what it scored and how accurate it was', async () => {
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(document.querySelectorAll('.recent-row')).toHaveLength(1)
    expect(text).toContain('98.1%')
    expect(text).toContain('Guitar · Expert')
    expect(text).toContain(new Date('2026-09-01T20:00:00.0000000Z').toLocaleDateString())
  })

  it('marks a full combo, and a perfect one differently', async () => {
    renderStats(ok, populated, populatedInsights)
    await pageText()
    expect(document.querySelector('.tag')?.textContent?.trim()).toBe('FC')

    vi.unstubAllGlobals()
    document.body.innerHTML = ''
    renderStats(
      ok,
      populated,
      insights({
        ...populatedInsights,
        recent: [{ ...populatedInsights.recent[0], isFc: true, isPfc: true }]
      })
    )
    await waitFor(() => expect(document.querySelector('.tag')?.textContent?.trim()).toBe('PFC'))
  })

  it('leaves the accuracy as a dash when the play recorded no notes', async () => {
    renderStats(
      ok,
      populated,
      insights({
        ...populatedInsights,
        recent: [{ ...populatedInsights.recent[0], accuracy: null }]
      })
    )
    await pageText()
    expect(document.querySelector('.recent-row .acc')?.textContent?.trim()).toContain('—')
  })
})

describe('Stats: a bridge that cannot answer', () => {
  it('reports the failure instead of drawing an empty state that blames the user', async () => {
    vi.stubGlobal('encore', {
      playStatus: () => Promise.reject(new Error('no handler')),
      playStats: () => Promise.resolve(stats()),
      playInsights: () => Promise.resolve(insights())
    })
    render(Stats)

    expect(await pageText()).toContain('could not read your play history: no handler')
  })

  it('still draws the page when the bridge has no play-recorded event', async () => {
    // An older preload, or a test stub: the numbers are worth having without live updates, so
    // the missing subscription must not take the page down with it.
    vi.stubGlobal('encore', {
      playStatus: () => Promise.resolve(status({ available: false, reason: 'noFile' }))
    })
    render(Stats)

    expect(await pageText()).toContain('Nothing to show yet')
  })
})
