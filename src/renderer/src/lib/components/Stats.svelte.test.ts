import { render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  LifetimeScores,
  PlayDataStatus,
  PlayInsights,
  PlayStats
} from '../../../../shared/play'
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
 * Clone Hero's own record, which is the other of the two the page draws from.
 *
 * Defaults to the unavailable state, because that is the answer most users get: only the Linux
 * location has been verified and the other two are Unity convention (see main/play/location.ts).
 */
const lifetime = (over: Partial<LifetimeScores> = {}): LifetimeScores => ({
  status: {
    available: false,
    reason: 'noFile',
    scoreDataPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoredata.bin',
    scoresExtPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoresext.bin',
    lastImportAt: null,
    usedBackup: false,
    pairRefused: false,
    folderSource: 'probe' as const
  },
  totals: {
    charts: 0,
    lifetimePlays: 0,
    chartsInLibrary: 0,
    chartsNotInLibrary: 0,
    chartsWithUnconfirmedRows: 0,
    bestScore: null,
    observedPlays: 0,
    observedCharts: 0
  },
  charts: [],
  ...over
})

/**
 * `encore()` reads `window.encore`, and under jsdom `globalThis` *is* `window`. Both aggregate
 * calls are given to every stub whether or not the test expects them to be made, so that "was
 * it called" is a question these tests can ask rather than a crash.
 *
 * `playLifetime` is the exception: passing nothing leaves the channel OFF the stub entirely, so
 * the call throws and the page falls back to Encore's log alone. That is the bridge a build
 * before the score files were read had, and every test written before this one exercises it.
 */
function renderStats(
  playStatus: PlayDataStatus,
  playStats: PlayStats = stats(),
  playInsights: PlayInsights = insights(),
  playLifetime: LifetimeScores | null = null
): {
  playStats: ReturnType<typeof vi.fn>
  playInsights: ReturnType<typeof vi.fn>
  playStatus: ReturnType<typeof vi.fn>
  playLifetime: ReturnType<typeof vi.fn>
} {
  const statusFn = vi.fn(() => Promise.resolve(playStatus))
  const statsFn = vi.fn(() => Promise.resolve(playStats))
  const insightsFn = vi.fn(() => Promise.resolve(playInsights))
  const lifetimeFn = vi.fn(() => Promise.resolve(playLifetime))
  vi.stubGlobal('encore', {
    playStatus: statusFn,
    playStats: statsFn,
    playInsights: insightsFn,
    ...(playLifetime === null ? {} : { playLifetime: lifetimeFn }),
    // Returns the unsubscribe the component hands back from onMount.
    onPlayRecorded: () => () => {}
  })
  render(Stats)
  return {
    playStats: statsFn,
    playInsights: insightsFn,
    playStatus: statusFn,
    playLifetime: lifetimeFn
  }
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

  it('says a refused pair is not a damaged install, because it need not be', async () => {
    // Both score files read and decoded and Encore could not match them to each other. Encore
    // matches their rows on a field nobody decoded, so this can be a healthy pair shaped unlike
    // the one install the format was read from, and it takes the whole library with it. The
    // sentence for a file that could not be read would send that user after damage they do not
    // have.
    renderStats(
      status({ reason: 'noFile', available: false }),
      stats(),
      insights(),
      lifetime({
        status: {
          ...lifetime().status,
          reason: 'unreadable',
          pairRefused: true
        }
      })
    )

    const text = await pageText()
    expect(text).toContain('could not match them to each other')
    expect(text).toContain('not a damaged install')
    // The other sentence, which is about a file rather than about the pair.
    expect(text).not.toContain('could not be read')
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

/**
 * Clone Hero's own record, beside Encore's.
 *
 * The page's whole problem is that its figures no longer share a span: lifetime plays, charts
 * ever played and best scores reach back before Encore, and the activity chart, accuracy and the
 * recent list never will. These pin the mechanism that keeps them apart, which is a source tag
 * on every section heading plus the sentence that defines the two.
 *
 * Not pinnable here: whether the tag is legible beside the heading at a real width, or wraps
 * intact when the pane is narrow. That is scripts/measure-play-stats.mjs.
 */
const owner = lifetime({
  // The owner's real lifetime numbers, read off their own score files: 101 charts, 144 lifetime
  // plays, 21 charts carrying a row nobody has decoded, best 665,629. Paired here with the
  // `populated` log above rather than with the owner's own 15, so that the two records on the
  // page disagree loudly enough for a test to catch one being drawn in the other's place.
  status: {
    available: true,
    reason: 'ok',
    scoreDataPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoredata.bin',
    scoresExtPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoresext.bin',
    lastImportAt: '2026-09-12T10:00:00.000Z',
    usedBackup: false,
    pairRefused: false,
    folderSource: 'probe' as const
  },
  totals: {
    charts: 101,
    lifetimePlays: 144,
    chartsInLibrary: 84,
    chartsNotInLibrary: 17,
    chartsWithUnconfirmedRows: 21,
    bestScore: 665_629,
    observedPlays: 15,
    observedCharts: 9
  }
})

describe('Stats: lifetime beside observed', () => {
  it('draws both records, each under a heading tagged with the span it covers', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    const text = await pageText()

    expect(text).toContain('144')
    expect(text).toContain('across 101 charts')
    expect(text).toContain('665,629')

    const tags = [...document.querySelectorAll('.src')].map((t) => t.textContent?.trim())
    expect(tags).toContain('ALL TIME')
    // The date the observed record actually starts, in the tag itself, so the span is readable
    // without hovering anything.
    expect(tags).toContain(`SINCE ${new Date('2026-03-03T18:04:11.1234567Z').toLocaleDateString()}`)
  })

  it('tags every section, so no figure on the page is left unattributed', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    await pageText()

    // Every section that carries a figure carries a tag. A single untagged block is the hole
    // this scheme has to not have: the reader would have no way to place its numbers.
    const sections = [...document.querySelectorAll('.stats section')]
    expect(sections.length).toBeGreaterThan(4)
    for (const section of sections) {
      expect(
        section.querySelector('.src'),
        `${section.querySelector('h2')?.textContent ?? '?'} carries no source tag`
      ).not.toBeNull()
    }
  })

  it('tags MOST PLAYED as observed, because it is the heading that reads as lifetime', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    await pageText()

    const heading = [...document.querySelectorAll('h2')].find((h) =>
      h.textContent?.includes('MOST PLAYED')
    )
    expect(heading?.querySelector('.src')?.textContent?.trim()).toMatch(/^SINCE /)
  })

  it('replaces the blanket caveat with the legend for the two tags', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    await pageText()

    const caveat = (document.querySelector('.caveat')?.textContent ?? '').replace(/\s+/g, ' ')
    expect(caveat).toContain('Two records feed this page')
    expect(caveat).toContain('labelled with the record it was drawn from')
    // The old sentence was true of every number and is now true of only some of them. Leaving
    // it over a page where the lifetime block is genuinely lifetime is the defect this whole
    // change exists to avoid.
    expect(caveat).not.toContain('not your lifetime totals')
  })

  it('says the observed plays are inside the lifetime count, not beside it', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    const text = await pageText()

    expect(text).toContain('already inside the lifetime count above')
    expect(text).toContain('Adding the two would count them twice')
    // 144 + 42 is not a number that means anything, and nothing on the page may print it.
    expect(text).not.toContain('186')
  })

  it('gives the two best scores different labels, since they come from different records', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    const text = await pageText()

    expect(text).toContain('BEST SCORE SEEN')
    expect(text).toContain('665,629')
    expect(text).toContain('1,234,567')
  })

  it('draws no tags at all when Clone Hero has nothing, and keeps the blanket caveat', async () => {
    renderStats(ok, populated, populatedInsights, lifetime())
    const text = await pageText()

    expect(document.querySelectorAll('.src')).toHaveLength(0)
    expect(text).toContain('not your lifetime totals')
  })

  it('falls back to the Encore log alone when the bridge has no lifetime channel', async () => {
    // A renderer running against an older main process. The page must draw, not error.
    renderStats(ok, populated, populatedInsights)
    const text = await pageText()

    expect(text).toContain('not your lifetime totals')
    expect(text).not.toMatch(/could not read your play history/)
  })
})

describe('Stats: a score Encore cannot read', () => {
  it('keeps the play count and withholds only the score, without calling it a fault', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    const text = await pageText()

    expect(text).toContain('21 of those charts also carry a score of a kind Encore cannot read')
    expect(text).toContain('The play counts above are unaffected and correct')
    expect(text).toContain('nothing is wrong with your files')
    // The best score tile says which rows it is the best of, rather than claiming the table.
    expect(text).toContain('of the scores Encore can read')
    // Not an error, and not worded as one.
    expect(text).not.toMatch(/\b(corrupt|invalid|failed|broken)\b/i)
  })

  it('says nothing about unreadable scores when every row is one Encore knows', async () => {
    renderStats(
      ok,
      populated,
      populatedInsights,
      lifetime({
        status: { ...owner.status },
        totals: { ...owner.totals, chartsWithUnconfirmedRows: 0 }
      })
    )
    const text = await pageText()

    expect(text).not.toContain('cannot read')
    // No hedge on the best score either: with nothing to qualify, qualifying it invents a doubt.
    expect(text).not.toContain('of the scores Encore can read')
    expect(text).toContain('highest in the table')
  })
})

describe('Stats: charts Clone Hero knows and the library does not', () => {
  it('counts them, and says how many of the record is still installed', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    const text = await pageText()

    expect(text).toContain('84 still in your library')
  })

  it('says all of them when nothing has been deleted', async () => {
    renderStats(
      ok,
      populated,
      populatedInsights,
      lifetime({
        status: { ...owner.status },
        totals: { ...owner.totals, chartsInLibrary: 101, chartsNotInLibrary: 0 }
      })
    )
    expect(await pageText()).toContain('all of them still in your library')
  })

  it('leads the coverage block with Clone Hero and keeps the Encore count beside it', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    const text = await pageText()

    // Both counted out of the same denominator, neither stated as a share of the other.
    expect(text).toContain(
      'Of the 4,000 charts in your library Encore can match a play to, Clone Hero has a record of playing 84 and Encore has watched 177 played'
    )
    expect(text).toContain("3,916 have nothing in Clone Hero's table")
    expect(text).toContain('still not the same as never played')
  })
})

describe('Stats: Clone Hero has a record and Encore has watched nothing', () => {
  it('draws the lifetime block and says why the other half is empty', async () => {
    // The state of every user who installs Encore today having played for years: a full score
    // table, an empty log. A page of zeroes here, or no page at all, would be the worse answer.
    renderStats(
      status({ available: false, reason: 'ok', playCount: 0 }),
      stats(),
      insights(),
      owner
    )
    const text = await pageText()

    expect(text).toContain('144')
    expect(text).toContain('665,629')
    expect(text).toContain('has recorded no play yet')
    // No tags: with one record on the page there is nothing to tell apart.
    expect(document.querySelectorAll('.src')).toHaveLength(0)
    expect(text).toContain("These are Clone Hero's own counts")
    // Nothing dated, because nothing in that record has a date.
    expect(document.querySelector('.chart')).toBeNull()
  })

  it('still asks for neither aggregate, since the log gate has not opened', async () => {
    const { playStats, playInsights } = renderStats(
      status({ available: false, reason: 'ok' }),
      stats(),
      insights(),
      owner
    )
    await pageText()
    expect(playStats).not.toHaveBeenCalled()
    expect(playInsights).not.toHaveBeenCalled()
  })
})

describe('Stats: neither record has anything', () => {
  it('says where it looked for each, and draws no figure from either', async () => {
    renderStats(
      status({ available: false, reason: 'noFile' }),
      stats(),
      insights(),
      lifetime({ status: { ...lifetime().status, reason: 'noFile' } })
    )
    const text = await pageText()

    expect(text).toContain('/home/player/.clonehero/scorestats.json')
    expect(text).toContain('scoredata.bin')
    expect(text).toContain("Clone Hero's own score table holds what you played before Encore")
    expect(document.querySelector('.tile')).toBeNull()
    expect(text).not.toMatch(/failed|error/i)
  })

  it('names the reason the score files gave, not a generic one', async () => {
    renderStats(
      status({ available: false, reason: 'ok' }),
      stats(),
      insights(),
      lifetime({ status: { ...lifetime().status, reason: 'unknownPlatform' } })
    )
    expect(await pageText()).toContain('no location for it has been established on this system')
  })

  it('says nothing about score files when the bridge never asked about them', async () => {
    // `lifetime` stays null with no channel on the bridge, and reporting on a search that never
    // happened would be inventing a result.
    renderStats(status({ available: false, reason: 'noFile' }))
    const text = await pageText()

    expect(text).toContain('Nothing to show yet')
    expect(text).not.toContain('scoredata.bin')
  })
})

/** The lifetime read is the page's own, and one that fails must not take the page with it. */
describe('Stats: the lifetime read', () => {
  it('asks for totals only, never for a row per chart', async () => {
    const { playLifetime } = renderStats(ok, populated, populatedInsights, owner)
    await pageText()
    expect(playLifetime).toHaveBeenCalledWith([])
  })

  it('draws the Encore-only page when the lifetime call rejects', async () => {
    vi.stubGlobal('encore', {
      playStatus: () => Promise.resolve(ok),
      playStats: () => Promise.resolve(populated),
      playInsights: () => Promise.resolve(populatedInsights),
      playLifetime: () => Promise.reject(new Error('no handler')),
      onPlayRecorded: () => () => {}
    })
    render(Stats)
    const text = await pageText()

    expect(text).toContain('not your lifetime totals')
    expect(document.querySelectorAll('.src')).toHaveLength(0)
  })
})

/**
 * The block the page opens with, and the rule that keeps it from being a second copy of the
 * page.
 *
 * Its figures are PROMOTED out of the blocks below rather than duplicated into it, which is the
 * one thing that can quietly go wrong here: a lead that copied would put the same number under
 * two headings carrying two different source tags, which is exactly the confusion the tags were
 * added to prevent.
 *
 * Not pinnable here, because jsdom applies no CSS and computes no layout: whether the lead is
 * painted above the rest, whether its source tag survives the narrowest content column the shell
 * has (509px, at the 1121px window where the rail appears), or whether the reach bars draw the
 * share the numbers state. That is scripts/measure-stats-page.mjs.
 */
describe('Stats: what the page opens with', () => {
  /** Every figure's label, with the source tag that follows it inside the label stripped off. */
  function figureLabels(): string[] {
    return [...document.querySelectorAll('.tile .t-label')].map((el) =>
      (el.textContent ?? '')
        .replace(/\s+/g, ' ')
        .replace(/(ALL TIME|SINCE .*|BOTH RECORDS)$/, '')
        .trim()
    )
  }

  it("leads with Clone Hero's count, not Encore's, when both records answer", async () => {
    renderStats(ok, populated, populatedInsights, owner)
    await pageText()

    const lead = document.querySelector('.standing')
    expect(lead).not.toBeNull()
    const leadLabels = [...(lead?.querySelectorAll('.tile .t-label') ?? [])].map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ')
    )
    // The older and larger of the two records is what "how much have I played" means.
    expect(leadLabels[0]).toContain('LIFETIME PLAYS')
    expect(leadLabels.join(' ')).toContain('ACCURACY')
  })

  it('draws every figure once, because the lead takes rather than copies', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    await pageText()

    const labels = figureLabels()
    expect(new Set(labels).size, `${labels.join(', ')} repeats a figure`).toBe(labels.length)
    // And the two it took are gone from the blocks they came from, not merely unique by accident.
    const lifetimeBlock = [...document.querySelectorAll('h2')]
      .find((h) => h.textContent?.includes('WHAT CLONE HERO KEPT'))
      ?.closest('section')
    expect(lifetimeBlock?.textContent).not.toContain('LIFETIME PLAYS')
    const observedBlock = [...document.querySelectorAll('h2')]
      .find((h) => h.textContent?.includes('WHAT ENCORE HAS WATCHED'))
      ?.closest('section')
    expect(observedBlock?.textContent).not.toContain('ACCURACY')
  })

  it('names the record beside each lead figure, since they come from different ones', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    await pageText()

    // The heading above the lead cannot say which record its figures came from, because they
    // came from both. So each figure says it for itself, in the same tag the headings use.
    const tags = [...document.querySelectorAll('.standing .tile .src')].map((el) =>
      el.textContent?.trim()
    )
    expect(tags).toContain('ALL TIME')
    expect(tags).toContain(`SINCE ${new Date('2026-03-03T18:04:11.1234567Z').toLocaleDateString()}`)
  })

  it('leads with what Encore watched when Clone Hero has no table to read', async () => {
    renderStats(ok, populated, populatedInsights)
    await pageText()

    const lead = document.querySelector('.standing')
    expect(lead?.textContent).toContain('PLAYS RECORDED')
    expect(lead?.textContent).toContain('42')
    // One record on the page, so nothing is tagged and nothing needs to be.
    expect(document.querySelectorAll('.src')).toHaveLength(0)
  })

  it('leads with a best score when there is no log to compute an accuracy from', async () => {
    // A full score table and an empty log: the state of everyone who installs Encore today
    // having played for years. Accuracy cannot be drawn at all, because the score files carry
    // no note counts, so the quality slot takes the only quality figure that record holds.
    renderStats(status({ available: false, reason: 'ok' }), stats(), insights(), owner)
    await pageText()

    const lead = document.querySelector('.standing')
    expect(lead?.textContent).toContain('LIFETIME PLAYS')
    expect(lead?.textContent).toContain('BEST SCORE')
    expect(lead?.textContent).toContain('665,629')
  })

  it('never opens on a dash, and leaves the empty accuracy where it was', async () => {
    // Accuracy is null whenever no play recorded its notes, which is a real state of this page.
    // Opening on an empty cell would say nothing in the place the page has decided says the most.
    renderStats(
      ok,
      stats({ totalPlays: 3, notesHit: 0, totalNotes: 0, firstPlayedAt: '2026-03-03T00:00:00Z' })
    )
    await pageText()

    const lead = document.querySelector('.standing')
    expect(lead?.textContent).not.toContain('ACCURACY')
    expect(lead?.querySelector('.t-value')?.textContent?.trim()).not.toBe('—')
    // Still on the page, under its own heading, saying why it is empty.
    expect(document.body.textContent).toContain('no notes recorded')
  })
})

/**
 * The reach block: how much of the library has been played at all, promoted from a paragraph at
 * the foot of the page to the third figure on it.
 *
 * The numbers are the same ones the paragraph states, and that paragraph stays: it is the honest
 * sentence and a bar cannot carry it.
 */
describe('Stats: how much of the library has been played', () => {
  it('draws a bar per record against one denominator, and names which is which', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    await pageText()

    const reach = document.querySelector('.tile.reach')
    const text = (reach?.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('LIBRARY PLAYED')
    expect(text).toContain('Clone Hero')
    expect(text).toContain('84')
    expect(text).toContain('Encore')
    expect(text).toContain('177')
    expect(text).toContain('of 4,000 charts Encore can match a play to')
    // Two bars side by side and never one inside the other: the counts come from tables nothing
    // joins, and a nested bar would assert the subset claim the paragraph below refuses to make.
    expect(reach?.querySelectorAll('.r-row')).toHaveLength(2)
  })

  it('drops the row labels when only one record is on the page', async () => {
    renderStats(ok, populated, populatedInsights)
    await pageText()

    const reach = document.querySelector('.tile.reach')
    expect(reach?.querySelectorAll('.r-row')).toHaveLength(1)
    expect(reach?.querySelectorAll('.r-key')).toHaveLength(0)
    expect(reach?.textContent).toContain('177')
  })

  it('draws no bar at all when nothing in the library can be matched to a play', async () => {
    // There is no ratio to draw against a zero, and a full-width empty track would read as "you
    // have played none of your library", which is a claim about the user rather than the scan.
    renderStats(
      ok,
      populated,
      insights({ coverage: { inLibrary: 900, identified: 0, withPlay: 0, playsOffLibrary: 0 } })
    )
    await pageText()

    expect(document.querySelector('.tile.reach')).toBeNull()
    expect(await pageText()).toContain('Nothing in your library can be matched to a play yet')
  })

  it('gives a bar its true share, with no minimum stub', async () => {
    renderStats(ok, populated, populatedInsights, owner)
    await pageText()

    // 84 of 4,000 is 2.1%, and the page's other bars floor themselves at 2%. Against a
    // denominator in the thousands that floor would be most of the bar, so this one has none.
    const fills = [...document.querySelectorAll('.tile.reach .r-fill')] as HTMLElement[]
    expect(fills[0].style.width).toBe(`${(84 / 4000) * 100}%`)
    expect(fills[1].style.width).toBe(`${(177 / 4000) * 100}%`)
  })

  it('keeps the count whole when it runs past its own denominator', async () => {
    // The two counts come from tables nothing joins, so nothing guarantees the smaller one is
    // smaller. The bar is what gives: its track hides the overflow, measured in
    // scripts/measure-stats-page.mjs. The number never gives, which is the whole rule.
    renderStats(
      ok,
      populated,
      populatedInsights,
      lifetime({ status: { ...owner.status }, totals: { ...owner.totals, chartsInLibrary: 5200 } })
    )
    await pageText()

    const reach = document.querySelector('.tile.reach')
    expect(reach?.textContent).toContain('5,200')
    const fill = document.querySelector('.tile.reach .r-fill') as HTMLElement
    expect(Number.parseFloat(fill.style.width)).toBeGreaterThan(100)
  })
})

/**
 * Colour on this page names an instrument and nothing else, which is the rule tokens.css states
 * and DiffPips.svelte already follows. Two surfaces disagreeing about what a guitar looks like
 * is worse than neither being coloured.
 */
describe('Stats: the instruments you play', () => {
  it("draws a bar in its instrument's own colour, the one the difficulty pips use", async () => {
    renderStats(ok, populated, populatedInsights)
    await pageText()

    const rows = [...document.querySelectorAll('.breakdown')]
      .find((b) => b.querySelector('h3')?.textContent === 'Instrument')
      ?.querySelectorAll('.bd-row')
    expect([...(rows ?? [])].map((r) => r.getAttribute('style'))).toEqual([
      '--pip: var(--inst-guitar);',
      '--pip: var(--inst-drums);'
    ])
  })

  it('leaves difficulty uncoloured, because a difficulty is not a part', async () => {
    renderStats(ok, populated, populatedInsights)
    await pageText()

    const rows = [...document.querySelectorAll('.breakdown')]
      .find((b) => b.querySelector('h3')?.textContent === 'Difficulty')
      ?.querySelectorAll('.bd-row')
    expect([...(rows ?? [])].map((r) => r.getAttribute('style'))).toEqual([null])
  })

  it('draws an instrument it has never heard of uncoloured, not as another one', async () => {
    renderStats(
      ok,
      stats({
        totalPlays: 5,
        firstPlayedAt: '2026-03-03T00:00:00Z',
        byInstrument: [
          { key: 'Guitar', plays: 4 },
          { key: 'Pro Drums (Real)', plays: 1 }
        ]
      }),
      populatedInsights
    )
    await pageText()

    const rows = [...document.querySelectorAll('.breakdown')]
      .find((b) => b.querySelector('h3')?.textContent === 'Instrument')
      ?.querySelectorAll('.bd-row')
    expect([...(rows ?? [])].map((r) => r.getAttribute('style'))).toEqual([
      '--pip: var(--inst-guitar);',
      null
    ])
    // The name is 90px of track wide at most, so the whole of it is on the hover.
    const keys = [...document.querySelectorAll('.bd-key')].map((el) => el.getAttribute('title'))
    expect(keys).toContain('Pro Drums (Real)')
  })
})
