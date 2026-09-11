import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmpDir } from '../../../test/helpers/tmp'
import { openCatalog, type CatalogDb } from '../catalog/db'
import type { PlayRecord } from './scorestats'
import { chartPlaySummaries, countPlays, playStats, recordPlay } from './store'

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
