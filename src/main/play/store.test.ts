import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmpDir } from '../../../test/helpers/tmp'
import { openCatalog, type CatalogDb } from '../catalog/db'
import { upsertChart } from '../catalog/queries'
import { ChartRecordSchema } from '../../shared/schemas'
import type { PlayRecord } from './scorestats'
import { chartPlaySummaries, countPlays, playInsights, playStats, recordPlay } from './store'

const A = 'e54e9a0521444e81bd1fed4f3f3a3201'
const B = 'aac70b7c7bfc0092a8f7f05a59db5676'

/** A play with everything set, so a test only has to name what it cares about. */
function play(over: Partial<PlayRecord> = {}): PlayRecord {
  return {
    checksum: A,
    playedAt: '2026-09-10T22:23:37.1089500Z',
    songName: 'Skrting On The Surface',
    artistName: 'The Smile',
    charterName: 'Mech',
    gameVersion: 'v1.1.0.6142-final',
    gameMode: 'Quickplay',
    playbackSpeed: 100,
    bandScore: 40122,
    bandStars: 2,
    playerCount: 1,
    instrument: 'Guitar',
    difficulty: 'Expert',
    profileName: 'Aevyx',
    score: 40122,
    notesHit: 795,
    totalNotes: 1529,
    maxStreak: 12,
    isFc: false,
    isPfc: false,
    stars: 2,
    avgMultiplier: 0.524525821,
    ...over
  }
}

let db: CatalogDb
beforeEach(() => {
  db = openCatalog(join(tmpDir('play-store'), 'catalog.db'))
})

describe('recordPlay', () => {
  it('records a play and reports it as new', () => {
    expect(recordPlay(db, play())).toBe(true)
    expect(countPlays(db)).toBe(1)
  })

  it('ignores a play it has already recorded', () => {
    // The watcher re-reads and re-parses the file on every filesystem event it sees, and
    // chokidar emits several per save, so this is the overwhelmingly common call.
    expect(recordPlay(db, play())).toBe(true)
    expect(recordPlay(db, play())).toBe(false)
    expect(recordPlay(db, play())).toBe(false)
    expect(countPlays(db)).toBe(1)
  })

  it('treats checksum and timestamp together as the identity', () => {
    recordPlay(db, play())
    // Same chart, later play: a genuinely new row. This is the case a naive "one row per chart"
    // rule would lose, and grinding one song is the history the feature exists to show.
    expect(recordPlay(db, play({ playedAt: '2026-09-10T22:30:00.0000000Z' }))).toBe(true)
    // Different chart, same instant: also new.
    expect(recordPlay(db, play({ checksum: B }))).toBe(true)
    expect(countPlays(db)).toBe(3)
  })

  it('does not let a changed score resurrect an already-recorded play', () => {
    recordPlay(db, play({ score: 1 }))
    expect(recordPlay(db, play({ score: 999_999 }))).toBe(false)
    // INSERT OR IGNORE keeps the first write. The pair is the identity, so a second file with
    // the same pair and a different score is a re-read of one play, not two plays.
    const row = db.prepare('SELECT score FROM plays').get() as { score: number }
    expect(row.score).toBe(1)
  })

  it('stores the booleans as 0/1 and reads them back', () => {
    recordPlay(db, play({ isFc: true, isPfc: true }))
    expect(db.prepare('SELECT isFc, isPfc FROM plays').get()).toEqual({ isFc: 1, isPfc: 1 })
  })

  it('accepts a play whose optional fields are all null', () => {
    const bare: PlayRecord = {
      ...play(),
      songName: null,
      artistName: null,
      charterName: null,
      gameVersion: null,
      gameMode: null,
      playbackSpeed: null,
      bandScore: null,
      bandStars: null,
      playerCount: null,
      instrument: null,
      difficulty: null,
      profileName: null,
      score: null,
      notesHit: null,
      totalNotes: null,
      maxStreak: null,
      stars: null,
      avgMultiplier: null
    }
    expect(recordPlay(db, bare)).toBe(true)
  })
})

describe('chartPlaySummaries', () => {
  it('is empty when nothing is asked for or nothing is recorded', () => {
    expect(chartPlaySummaries(db, [])).toEqual([])
    expect(chartPlaySummaries(db, [A])).toEqual([])
  })

  it('omits checksums with no plays rather than returning zeroes', () => {
    // A page of 500 charts would otherwise be almost entirely rows meaning "no record", which
    // also reads as "played zero times" — a different claim.
    recordPlay(db, play())
    const summaries = chartPlaySummaries(db, [A, B])
    expect(summaries).toHaveLength(1)
    expect(summaries[0].checksum).toBe(A)
  })

  it('summarises repeated plays of one chart', () => {
    recordPlay(db, play({ playedAt: '2026-09-01T00:00:00.0000000Z', score: 100, stars: 1 }))
    recordPlay(
      db,
      play({
        playedAt: '2026-09-05T00:00:00.0000000Z',
        score: 500,
        stars: 4,
        isFc: true,
        notesHit: 90,
        totalNotes: 100
      })
    )
    recordPlay(db, play({ playedAt: '2026-09-03T00:00:00.0000000Z', score: 300, stars: 2 }))

    expect(chartPlaySummaries(db, [A])).toEqual([
      {
        checksum: A,
        timesPlayed: 3,
        bestScore: 500,
        bestStars: 4,
        bestAccuracy: 0.9,
        everFc: true,
        // Latest by timestamp, not by insertion order: the out-of-order write above is what
        // would break a "last row wins" implementation.
        lastPlayedAt: '2026-09-05T00:00:00.0000000Z'
      }
    ])
  })

  it('takes accuracy from the best-scoring play, not the most accurate one', () => {
    // A short, clean run can beat a long one on accuracy while scoring far less. Reporting that
    // run's accuracy beside the other run's score would describe a play that never happened.
    recordPlay(
      db,
      play({ playedAt: '2026-09-01T00:00:00Z', score: 100, notesHit: 10, totalNotes: 10 })
    )
    recordPlay(
      db,
      play({ playedAt: '2026-09-02T00:00:00Z', score: 900, notesHit: 50, totalNotes: 100 })
    )
    expect(chartPlaySummaries(db, [A])[0]).toMatchObject({ bestScore: 900, bestAccuracy: 0.5 })
  })

  it('reports no accuracy when the notes were not recorded', () => {
    recordPlay(db, play({ notesHit: null, totalNotes: null }))
    expect(chartPlaySummaries(db, [A])[0].bestAccuracy).toBeNull()
  })

  it('reports no accuracy rather than Infinity for a chart with no notes', () => {
    recordPlay(db, play({ notesHit: 0, totalNotes: 0 }))
    expect(chartPlaySummaries(db, [A])[0].bestAccuracy).toBeNull()
  })
})

describe('playStats', () => {
  it('is safe and empty on a catalog with no plays', () => {
    // sum() over no rows is null, not 0. The two totals are mapped to 0 because "no notes
    // recorded" and "zero notes" mean the same thing; the bests stay null because 0 would be a
    // claim about a play that does not exist.
    expect(playStats(db)).toEqual({
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
      topCharts: []
    })
  })

  it('aggregates across every recorded play', () => {
    recordPlay(
      db,
      play({
        playedAt: '2026-09-01T00:00:00.0000000Z',
        score: 100,
        notesHit: 10,
        totalNotes: 20,
        maxStreak: 5
      })
    )
    recordPlay(
      db,
      play({
        playedAt: '2026-09-05T00:00:00.0000000Z',
        score: 900,
        notesHit: 40,
        totalNotes: 50,
        maxStreak: 40,
        isFc: true,
        isPfc: true
      })
    )
    recordPlay(
      db,
      play({
        checksum: B,
        playedAt: '2026-09-03T00:00:00.0000000Z',
        instrument: 'Drums',
        difficulty: 'Hard',
        score: 300,
        notesHit: 5,
        totalNotes: 30,
        maxStreak: 3
      })
    )

    const stats = playStats(db)
    expect(stats).toMatchObject({
      totalPlays: 3,
      chartsPlayed: 2,
      fcCount: 1,
      pfcCount: 1,
      notesHit: 55,
      totalNotes: 100,
      bestScore: 900,
      longestStreak: 40,
      firstPlayedAt: '2026-09-01T00:00:00.0000000Z',
      lastPlayedAt: '2026-09-05T00:00:00.0000000Z'
    })
    expect(stats.byInstrument).toEqual([
      { key: 'Guitar', plays: 2 },
      { key: 'Drums', plays: 1 }
    ])
    expect(stats.byDifficulty).toEqual([
      { key: 'Expert', plays: 2 },
      { key: 'Hard', plays: 1 }
    ])
    expect(stats.topCharts[0]).toEqual({
      checksum: A,
      songName: 'Skrting On The Surface',
      artistName: 'The Smile',
      charterName: 'Mech',
      timesPlayed: 2,
      bestScore: 900
    })
  })

  it('leaves unrecorded instruments and difficulties out of the breakdowns', () => {
    recordPlay(db, play({ instrument: null, difficulty: null }))
    const stats = playStats(db)
    expect(stats.totalPlays).toBe(1)
    expect(stats.byInstrument).toEqual([])
    expect(stats.byDifficulty).toEqual([])
  })
})

/** A catalog row, named by path and carrying whichever fields a test is about. */
function chart(path: string, over: Record<string, unknown> = {}): void {
  upsertChart(
    db,
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      name: 'Chart',
      folderHash: path,
      modifiedTime: 1,
      ...over
    })
  )
}

/**
 * The local calendar day a timestamp falls on, as this machine reckons it.
 *
 * The expectations below are computed rather than written out, because the bucketing is by the
 * user's own day and the suite runs wherever it runs. `en-CA` is the locale that spells a date
 * the way the query does, `YYYY-MM-DD`. Run the suite under `TZ=Pacific/Kiritimati` (UTC+14) and
 * these move together, which is the property being pinned.
 */
const localDay = (iso: string): string => new Date(iso).toLocaleDateString('en-CA')

describe('playInsights: an empty history', () => {
  it('answers with empty lists and zeroes rather than nulls', () => {
    const insights = playInsights(db)
    expect(insights.days).toEqual([])
    expect(insights.topCharters).toEqual([])
    expect(insights.recent).toEqual([])
    // sum() over no rows is null in SQLite; count() is 0. Nothing here may reach the renderer
    // as a null that would draw as "—" where the honest answer is "none".
    expect(insights.coverage).toEqual({
      inLibrary: 0,
      identified: 0,
      withPlay: 0,
      playsOffLibrary: 0
    })
  })

  it('counts a library that has never been played without inventing a play', () => {
    chart('/lib/a', { cloneHeroChecksum: A })
    chart('/lib/b')
    expect(playInsights(db).coverage).toEqual({
      inLibrary: 2,
      identified: 1,
      withPlay: 0,
      playsOffLibrary: 0
    })
  })
})

describe('playInsights: the history by day', () => {
  it('buckets plays by the day they happened, oldest first', () => {
    recordPlay(db, play({ playedAt: '2026-09-01T10:00:00.0000000Z' }))
    recordPlay(db, play({ playedAt: '2026-09-01T11:30:00.0000000Z' }))
    recordPlay(db, play({ checksum: B, playedAt: '2026-09-03T09:00:00.0000000Z' }))

    expect(playInsights(db).days).toEqual([
      { day: localDay('2026-09-01T10:00:00.0000000Z'), plays: 2 },
      { day: localDay('2026-09-03T09:00:00.0000000Z'), plays: 1 }
    ])
  })

  it('sends no row for the days between, which are zero by definition', () => {
    recordPlay(db, play({ playedAt: '2026-01-01T12:00:00.0000000Z' }))
    recordPlay(db, play({ playedAt: '2026-12-31T12:00:00.0000000Z' }))
    expect(playInsights(db).days).toHaveLength(2)
  })

  it('drops a timestamp no date function can read rather than drawing a dateless day', () => {
    // Date.parse accepts this and SQLite's date() does not, so it reaches the table and then
    // groups as null. A null key would render as an empty bar with no date under it.
    recordPlay(db, play({ playedAt: 'Thu, 10 Sep 2026 22:23:37 GMT' }))
    recordPlay(db, play({ checksum: B, playedAt: '2026-09-10T22:23:37.0000000Z' }))

    const days = playInsights(db).days
    expect(days).toHaveLength(1)
    expect(days[0].plays).toBe(1)
  })
})

describe('playInsights: how much of the library has been played', () => {
  beforeEach(() => {
    chart('/lib/played', { cloneHeroChecksum: A })
    chart('/lib/unplayed', { cloneHeroChecksum: B })
    // No checksum: nothing can ever be joined to it, however much it was played.
    chart('/lib/unidentified')
    recordPlay(db, play({ checksum: A }))
  })

  it('keeps "no play on record" apart from "cannot be matched at all"', () => {
    expect(playInsights(db).coverage).toMatchObject({
      inLibrary: 3,
      identified: 2,
      withPlay: 1
    })
  })

  it('counts plays of charts the library does not hold, rather than dropping them', () => {
    // A chart played and then deleted. The play is still the user's history (see the top-ten
    // rule in playStats), so it has to be visible somewhere, and this is where.
    recordPlay(db, play({ checksum: 'f'.repeat(32), playedAt: '2026-09-11T00:00:00.0000000Z' }))
    expect(playInsights(db).coverage.playsOffLibrary).toBe(1)
    expect(playInsights(db).coverage.withPlay).toBe(1)
  })
})

describe('playInsights: charters played against charters owned', () => {
  it('counts what is owned beside what has a play, and leaves out the unplayed', () => {
    chart('/lib/a', { charter: 'Mech', cloneHeroChecksum: A })
    chart('/lib/b', { charter: 'Mech', cloneHeroChecksum: B })
    chart('/lib/c', { charter: 'Someone Else', cloneHeroChecksum: 'c'.repeat(32) })
    recordPlay(db, play({ checksum: A }))
    recordPlay(db, play({ checksum: A, playedAt: '2026-09-11T00:00:00.0000000Z' }))

    expect(playInsights(db).topCharters).toEqual([
      { charter: 'Mech', owned: 2, played: 1, plays: 2 }
    ])
  })

  /**
   * One charter in the owner's own history is eight colour tags, one per letter. SQL groups on
   * the stored string, so a charter who styled their name on some charts and not on others is
   * two rows that read identically on screen.
   */
  it('folds a name styled in Clone Hero markup into its plain spelling', () => {
    chart('/lib/a', { charter: '<color=#7B0000>Mech</color>', cloneHeroChecksum: A })
    chart('/lib/b', { charter: 'Mech', cloneHeroChecksum: B })
    recordPlay(db, play({ checksum: A }))
    recordPlay(db, play({ checksum: B, playedAt: '2026-09-11T00:00:00.0000000Z' }))

    expect(playInsights(db).topCharters).toEqual([
      { charter: 'Mech', owned: 2, played: 2, plays: 2 }
    ])
  })

  it('keeps a name that is nothing but markup apart from another one', () => {
    chart('/lib/a', { charter: '<b></b>', cloneHeroChecksum: A })
    chart('/lib/b', { charter: '<i></i>', cloneHeroChecksum: B })
    recordPlay(db, play({ checksum: A }))
    recordPlay(db, play({ checksum: B, playedAt: '2026-09-11T00:00:00.0000000Z' }))

    const charters = playInsights(db).topCharters
    expect(charters).toHaveLength(2)
    // Both strip to nothing, so neither has a name to draw; the renderer says so.
    expect(charters.every((row) => row.charter === '')).toBe(true)
  })
})

describe('playInsights: the last few plays', () => {
  it('returns them newest first, with the accuracy of each play', () => {
    recordPlay(db, play({ playedAt: '2026-09-01T00:00:00.0000000Z', score: 10 }))
    recordPlay(
      db,
      play({
        checksum: B,
        playedAt: '2026-09-05T00:00:00.0000000Z',
        score: 20,
        notesHit: 90,
        totalNotes: 100,
        isFc: true,
        isPfc: true
      })
    )

    const recent = playInsights(db).recent
    expect(recent.map((row) => row.score)).toEqual([20, 10])
    expect(recent[0]).toMatchObject({
      checksum: B,
      accuracy: 0.9,
      isFc: true,
      isPfc: true,
      instrument: 'Guitar',
      difficulty: 'Expert'
    })
    // The flags are 0/1 in SQLite and must not cross IPC as numbers.
    expect(typeof recent[1].isFc).toBe('boolean')
  })

  it('keeps a play with no notes recorded as a null accuracy, never as a zero', () => {
    recordPlay(db, play({ notesHit: null, totalNotes: null }))
    expect(playInsights(db).recent[0].accuracy).toBeNull()
  })

  it('caps the list rather than returning the whole history', () => {
    for (let i = 0; i < 12; i++) {
      recordPlay(db, play({ playedAt: `2026-09-01T00:00:0${i % 10}.000000${i}Z` }))
    }
    expect(countPlays(db)).toBe(12)
    expect(playInsights(db).recent).toHaveLength(8)
  })
})
