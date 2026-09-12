import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openCatalog, type CatalogDb } from '../catalog/db'
import { upsertChart } from '../catalog/queries'
import { ChartRecordSchema } from '../../shared/schemas'
import { tmpDir } from '../../../test/helpers/tmp'
import { chartLifetimes, countScoreCharts, importScoreBests, lifetimeTotals } from './score-store'
import type { ChartBest, ChartBestRow } from './scoredata'

/**
 * The import and the reads over it, against a real SQLite catalog in a scratch directory.
 *
 * A real database rather than a stubbed one because most of what is being tested is SQL: the
 * diff's "did anything move", the join to `charts`, and the rule that a best score comes from a
 * confirmed row. Nothing here reads the owner's catalog or their score files; the merged records
 * below are built from the layout the parser defines.
 */

const SKRTING = 'e54e9a0521444e81bd1fed4f3f3a3201'
const TWO_ROW = '5c8056b089373b38fc272824180be26c'
const OFF_LIBRARY = 'aac70b7c7bfc0092a8f7f05a59db5676'

function row(over: Partial<ChartBestRow> = {}): ChartBestRow {
  return {
    variant: 0,
    difficulty: 3,
    percent: 51,
    isFullCombo: false,
    playbackSpeed: 100,
    stars: 2,
    score: 40122,
    scoreWithoutCleanPlayBonus: 40100,
    ...over
  }
}

function chart(checksum: string, over: Partial<ChartBest> = {}): ChartBest {
  const rows = over.rows ?? [row()]
  return {
    checksum,
    playCount: 2,
    rows,
    hasOnlyConfirmedVariants: rows.every((r) => r.variant === 0),
    ...over
  }
}

/** A chart in the catalog carrying the checksum a score record can join to. */
function library(db: CatalogDb, path: string, checksum: string | null): void {
  upsertChart(
    db,
    ChartRecordSchema.parse({
      path,
      chartType: 'folder',
      name: path,
      cloneHeroChecksum: checksum,
      folderHash: 'h1',
      modifiedTime: 1
    })
  )
}

describe('importScoreBests', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('score-store'), 'catalog.db'))
  })

  it('writes a first import', () => {
    const result = importScoreBests(db, [chart(SKRTING), chart(TWO_ROW)])
    expect(result).toMatchObject({ charts: 2, rows: 2, added: 2, updated: 0, removed: 0 })
    expect(result.wrote).toBe(true)
    expect(countScoreCharts(db)).toBe(2)
  })

  it('writes nothing on a re-import of the same records', () => {
    // The files are rewritten after every song, so this is what almost every read finds while
    // the app is open. A diff that failed to notice would rewrite both tables several times a
    // minute and fire a UI refresh for each.
    const charts = [chart(SKRTING), chart(TWO_ROW)]
    importScoreBests(db, charts)
    const again = importScoreBests(db, charts)
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0, wrote: false })
  })

  it('updates the one chart a new play moved, and leaves the rest alone', () => {
    importScoreBests(db, [chart(SKRTING), chart(TWO_ROW)])
    const played = chart(SKRTING, {
      playCount: 3,
      rows: [row({ score: 41000, scoreWithoutCleanPlayBonus: 40950, percent: 55 })]
    })
    const result = importScoreBests(db, [played, chart(TWO_ROW)])
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0, wrote: true })
    const [best] = chartLifetimes(db, [SKRTING])
    expect(best.lifetimePlays).toBe(3)
    expect(best.best?.score).toBe(41000)
  })

  it('notices a changed score even when the play count did not move', () => {
    // The count is the obvious field and the cheap thing to compare. A diff that stopped there
    // would keep a stale best forever for any chart whose count is already correct.
    importScoreBests(db, [chart(SKRTING)])
    const result = importScoreBests(db, [chart(SKRTING, { rows: [row({ score: 99999 })] })])
    expect(result).toMatchObject({ updated: 1, wrote: true })
    expect(chartLifetimes(db, [SKRTING])[0].best?.score).toBe(99999)
  })

  it('drops a chart the files no longer mention, rows and all', () => {
    importScoreBests(db, [chart(SKRTING), chart(TWO_ROW)])
    const result = importScoreBests(db, [chart(SKRTING)])
    expect(result).toMatchObject({ removed: 1, wrote: true })
    expect(chartLifetimes(db)).toHaveLength(1)
    const rows = db.prepare(`SELECT count(*) AS n FROM score_bests`).get() as { n: number }
    expect(rows.n).toBe(1)
  })

  it('drops a variant that has disappeared from a chart', () => {
    // An upsert of the remaining rows would leave the old variant in place, and the chart would
    // carry a score row the game no longer holds.
    importScoreBests(db, [chart(TWO_ROW, { rows: [row(), row({ variant: 8, score: 300000 })] })])
    importScoreBests(db, [chart(TWO_ROW, { rows: [row()] })])
    const stored = db
      .prepare(`SELECT variant FROM score_bests WHERE checksum = ?`)
      .all(TWO_ROW) as { variant: number }[]
    expect(stored.map((r) => r.variant)).toEqual([0])
    expect(chartLifetimes(db, [TWO_ROW])[0].unconfirmedRows).toBe(0)
  })

  it('never writes into the plays table', () => {
    // The rule this whole table exists to keep. A best written as a play would invent a date and
    // double count the play it came from.
    importScoreBests(db, [chart(SKRTING, { playCount: 99 })])
    const plays = db.prepare(`SELECT count(*) AS n FROM plays`).get() as { n: number }
    expect(plays.n).toBe(0)
  })
})

describe('chartLifetimes', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('lifetimes'), 'catalog.db'))
    library(db, '/lib/skrting', SKRTING)
    library(db, '/lib/tworow', TWO_ROW)
    db.prepare(`INSERT INTO plays (checksum, playedAt) VALUES (?, ?)`).run(
      SKRTING,
      '2026-09-10T22:23:37.1089500Z'
    )
  })

  it('keeps the lifetime count and the observed count apart', () => {
    // The lifetime count already includes the observed one. Two named fields is the only shape
    // that stops a caller adding them.
    importScoreBests(db, [chart(SKRTING, { playCount: 12 })])
    expect(chartLifetimes(db, [SKRTING])[0]).toMatchObject({
      lifetimePlays: 12,
      observedPlays: 1,
      everPlayed: true
    })
  })

  it('gives a chart whose rows are all confirmed a best score worth showing', () => {
    importScoreBests(db, [chart(SKRTING)])
    const [entry] = chartLifetimes(db, [SKRTING])
    expect(entry.unconfirmedRows).toBe(0)
    expect(entry.best).toMatchObject({
      score: 40122,
      scoreWithoutCleanPlayBonus: 40100,
      difficulty: 3,
      difficultyName: 'Expert',
      stars: 2,
      percent: 51
    })
  })

  it('withholds the score of a chart whose only row is an unconfirmed variant', () => {
    // Variant 8 rows score several times what the game's scoring can reach, so the number is not
    // comparable to anything. The play count and "ever played" are still trustworthy, and this is
    // the shape that lets a screen show those two and not the score.
    importScoreBests(db, [
      chart(TWO_ROW, {
        playCount: 4,
        rows: [row({ variant: 8, score: 300000 })],
        hasOnlyConfirmedVariants: false
      })
    ])
    const [entry] = chartLifetimes(db, [TWO_ROW])
    expect(entry.best).toBeNull()
    expect(entry.unconfirmedRows).toBe(1)
    expect(entry.lifetimePlays).toBe(4)
    expect(entry.everPlayed).toBe(true)
  })

  it('shows the confirmed best of a mixed chart and still reports the unconfirmed row', () => {
    // The unconfirmed row outscores the confirmed one by design here: a plain max() over every
    // row would pick it and put two scoring scales in one column.
    importScoreBests(db, [
      chart(TWO_ROW, {
        rows: [row({ score: 40122 }), row({ variant: 8, score: 300000 })],
        hasOnlyConfirmedVariants: false
      })
    ])
    const [entry] = chartLifetimes(db, [TWO_ROW])
    expect(entry.best?.score).toBe(40122)
    expect(entry.best?.variant).toBe(0)
    expect(entry.unconfirmedRows).toBe(1)
  })

  it('carries a chart the library does not have', () => {
    // Played once and since deleted, moved, or never scanned. It has no catalog row to join to
    // and is still a real record; dropping it would understate the lifetime totals.
    importScoreBests(db, [chart(OFF_LIBRARY, { playCount: 7 })])
    expect(chartLifetimes(db, [OFF_LIBRARY])[0]).toMatchObject({
      lifetimePlays: 7,
      observedPlays: 0
    })
  })

  it('omits a checksum the score files know nothing about', () => {
    // Not a row of zeroes: "played zero times" and "no record either way" are different facts,
    // and a caller has the list it asked for and can tell which it got back.
    importScoreBests(db, [chart(SKRTING)])
    expect(chartLifetimes(db, [TWO_ROW])).toEqual([])
    expect(chartLifetimes(db, [])).toEqual([])
  })

  it('returns every chart when no checksums are named', () => {
    importScoreBests(db, [chart(SKRTING, { playCount: 2 }), chart(TWO_ROW, { playCount: 9 })])
    expect(chartLifetimes(db).map((c) => c.checksum)).toEqual([TWO_ROW, SKRTING])
  })
})

describe('lifetimeTotals', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('lifetime-totals'), 'catalog.db'))
  })

  it('is safe on an empty catalog', () => {
    expect(lifetimeTotals(db)).toEqual({
      charts: 0,
      lifetimePlays: 0,
      chartsInLibrary: 0,
      chartsNotInLibrary: 0,
      chartsWithUnconfirmedRows: 0,
      // Null rather than 0: nothing recorded is not a score of zero.
      bestScore: null,
      observedPlays: 0,
      observedCharts: 0
    })
  })

  it('splits the score files by whether the library still holds the chart', () => {
    library(db, '/lib/skrting', SKRTING)
    importScoreBests(db, [chart(SKRTING, { playCount: 12 }), chart(OFF_LIBRARY, { playCount: 3 })])
    expect(lifetimeTotals(db)).toMatchObject({
      charts: 2,
      lifetimePlays: 15,
      chartsInLibrary: 1,
      chartsNotInLibrary: 1
    })
  })

  it('reports observed plays separately from the lifetime total', () => {
    db.prepare(`INSERT INTO plays (checksum, playedAt) VALUES (?, ?)`).run(SKRTING, '2026-09-10T1')
    db.prepare(`INSERT INTO plays (checksum, playedAt) VALUES (?, ?)`).run(SKRTING, '2026-09-10T2')
    importScoreBests(db, [chart(SKRTING, { playCount: 12 })])
    const totals = lifetimeTotals(db)
    expect(totals.lifetimePlays).toBe(12)
    expect(totals.observedPlays).toBe(2)
    expect(totals.observedCharts).toBe(1)
  })

  it('takes the best score from confirmed rows only, and counts the charts it could not', () => {
    importScoreBests(db, [
      chart(SKRTING, { rows: [row({ score: 40122 })] }),
      chart(TWO_ROW, {
        rows: [row({ variant: 8, score: 300000 })],
        hasOnlyConfirmedVariants: false
      })
    ])
    expect(lifetimeTotals(db)).toMatchObject({
      bestScore: 40122,
      chartsWithUnconfirmedRows: 1
    })
  })
})
