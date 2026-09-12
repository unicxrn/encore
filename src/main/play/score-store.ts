import type { CatalogDb } from '../catalog/db'
import type { ChartLifetime, LifetimeTotals } from '../../shared/play'
import { CONFIRMED_VARIANT, scoreDataDifficultyName, type ChartBest } from './scoredata'

/**
 * Reads and writes of `score_charts` and `score_bests`, the import of Clone Hero's own score
 * files. The tables are created in catalog/db.ts, alongside `charts`, because one SCHEMA_VERSION
 * governs the whole file.
 *
 * NOTHING HERE MAY TOUCH `plays`, in either direction, and the rule is not a style preference.
 * `plays` is a log of plays Encore watched, one row each, every one carrying the timestamp the
 * game wrote. What the score files hold is a table of bests with no dates, and a lifetime play
 * count that already includes every play `plays` holds. A best written as a play would invent a
 * date, double count the play it came from, and move the accuracy ratio, the activity chart and
 * every total on the Stats page. The only contact between the two is a read: `chartLifetimes`
 * counts observed plays per chart so a caller can show the pair side by side.
 *
 * The import is a diff, not a rewrite. The files are written after every song, so while Encore is
 * open the watcher re-reads them several times a minute and almost every read finds a table it
 * has already stored; comparing first means those cost a read and no write at all. The write that
 * does happen is scoped to the charts that actually moved.
 *
 * What it costs, measured against generated files at three scales (the first is the owner's, whose
 * real files are 3.8 kB and 2.9 kB for 101 charts and 111 rows):
 *
 *     101 charts    parse and merge 1 ms, first import 1 ms, re-import 1 ms, one chart moved 1 ms
 *     2,000 charts  parse and merge 8 ms, first import 14 ms, re-import 5 ms, one chart moved 7 ms
 *     10,000 charts parse and merge 32 ms, first import 86 ms, re-import 23 ms, one moved 29 ms
 *
 * The re-import figure is the one that repeats: it is what a play costs while the app is open, and
 * it is dominated by reading the stored tables back to compare them, not by writing. 10,000 charts
 * is far past anything plausible (it is one score record per chart in a large library, all of them
 * played), and is here to show where the shape stops being free rather than as a target.
 */

/** A stored chart record, as the diff compares it. */
interface StoredChart {
  playCount: number
  rowCount: number
  hasOnlyConfirmedVariants: number
}

/** A stored score row, as the diff compares it. Column order matches the insert below. */
interface StoredRow {
  checksum: string
  variant: number
  difficulty: number
  percent: number
  isFullCombo: number
  playbackSpeed: number
  stars: number
  score: number
  scoreWithoutCleanPlayBonus: number
}

/** What one import did, for a log line and for the watcher's "did anything change" answer. */
export interface ScoreImportResult {
  /** Charts the files describe. */
  charts: number
  /** Score rows the files describe, across every chart. */
  rows: number
  /** Charts that had no stored record before this import. */
  added: number
  /** Charts whose stored record differed from the files and was rewritten. */
  updated: number
  /** Charts that were stored and the files no longer mention. */
  removed: number
  /** True when anything at all was written. False is the ordinary answer while the app is open. */
  wrote: boolean
}

/** Rows of one chart, keyed by variant, so the diff can compare without caring about order. */
function rowsByVariant(rows: StoredRow[]): Map<number, StoredRow> {
  const map = new Map<number, StoredRow>()
  for (const row of rows) map.set(row.variant, row)
  return map
}

/** Whether a chart's stored rows say exactly what the files now say. */
function rowsMatch(stored: Map<number, StoredRow> | undefined, wanted: StoredRow[]): boolean {
  if (stored === undefined) return wanted.length === 0
  if (stored.size !== wanted.length) return false
  return wanted.every((row) => {
    const was = stored.get(row.variant)
    return (
      was !== undefined &&
      was.difficulty === row.difficulty &&
      was.percent === row.percent &&
      was.isFullCombo === row.isFullCombo &&
      was.playbackSpeed === row.playbackSpeed &&
      was.stars === row.stars &&
      was.score === row.score &&
      was.scoreWithoutCleanPlayBonus === row.scoreWithoutCleanPlayBonus
    )
  })
}

/** The score rows one merged chart contributes, flattened for storage. */
function storedRowsOf(chart: ChartBest): StoredRow[] {
  return chart.rows.map((row) => ({
    checksum: chart.checksum,
    variant: row.variant,
    difficulty: row.difficulty,
    percent: row.percent,
    // better-sqlite3 binds no JavaScript booleans, so the flag becomes 0/1 here.
    isFullCombo: row.isFullCombo ? 1 : 0,
    playbackSpeed: row.playbackSpeed,
    stars: row.stars,
    score: row.score,
    scoreWithoutCleanPlayBonus: row.scoreWithoutCleanPlayBonus
  }))
}

/**
 * Replace the stored score tables with what the files now say, writing only what moved.
 *
 * `charts` is the whole of what the two files hold, already merged and validated by
 * `mergeScoreFiles`. A partial list must never be passed: anything stored and not listed is
 * deleted, because the files are the complete record and a chart missing from them has had its
 * record cleared in the game, not hidden.
 *
 * One transaction, so a crash mid-import cannot leave a chart's summary row describing a set of
 * score rows that was never written. The two tables are only consistent together.
 */
export function importScoreBests(db: CatalogDb, charts: ChartBest[]): ScoreImportResult {
  const storedCharts = new Map<string, StoredChart>()
  for (const row of db
    .prepare(`SELECT checksum, playCount, rowCount, hasOnlyConfirmedVariants FROM score_charts`)
    .iterate() as Iterable<StoredChart & { checksum: string }>) {
    storedCharts.set(row.checksum, row)
  }
  const storedRows = new Map<string, Map<number, StoredRow>>()
  for (const row of db.prepare(`SELECT * FROM score_bests`).iterate() as Iterable<StoredRow>) {
    const forChart = storedRows.get(row.checksum)
    if (forChart === undefined) storedRows.set(row.checksum, rowsByVariant([row]))
    else forChart.set(row.variant, row)
  }

  const seen = new Set<string>()
  const dirty: { chart: ChartBest; rows: StoredRow[]; isNew: boolean }[] = []
  let rows = 0
  for (const chart of charts) {
    seen.add(chart.checksum)
    const wanted = storedRowsOf(chart)
    rows += wanted.length
    const was = storedCharts.get(chart.checksum)
    const same =
      was !== undefined &&
      was.playCount === chart.playCount &&
      was.rowCount === chart.rows.length &&
      was.hasOnlyConfirmedVariants === (chart.hasOnlyConfirmedVariants ? 1 : 0) &&
      rowsMatch(storedRows.get(chart.checksum), wanted)
    if (!same) dirty.push({ chart, rows: wanted, isNew: was === undefined })
  }
  const gone = [...storedCharts.keys()].filter((checksum) => !seen.has(checksum))

  const result: ScoreImportResult = {
    charts: charts.length,
    rows,
    added: dirty.filter((d) => d.isNew).length,
    updated: dirty.filter((d) => !d.isNew).length,
    removed: gone.length,
    wrote: dirty.length > 0 || gone.length > 0
  }
  if (!result.wrote) return result

  const putChart = db.prepare(
    `INSERT INTO score_charts (checksum, playCount, rowCount, hasOnlyConfirmedVariants)
		 VALUES (@checksum, @playCount, @rowCount, @hasOnlyConfirmedVariants)
		 ON CONFLICT(checksum) DO UPDATE SET
			playCount = excluded.playCount,
			rowCount = excluded.rowCount,
			hasOnlyConfirmedVariants = excluded.hasOnlyConfirmedVariants`
  )
  const dropRows = db.prepare(`DELETE FROM score_bests WHERE checksum = ?`)
  const dropChart = db.prepare(`DELETE FROM score_charts WHERE checksum = ?`)
  const putRow = db.prepare(
    `INSERT INTO score_bests (
			checksum, variant, difficulty, percent, isFullCombo, playbackSpeed, stars, score,
			scoreWithoutCleanPlayBonus
		 ) VALUES (
			@checksum, @variant, @difficulty, @percent, @isFullCombo, @playbackSpeed, @stars, @score,
			@scoreWithoutCleanPlayBonus
		 )`
  )

  db.transaction(() => {
    for (const { chart, rows: wanted } of dirty) {
      // Delete then insert rather than upsert the rows: a variant that has disappeared from a
      // chart has to go, and an upsert alone would leave it there for good.
      dropRows.run(chart.checksum)
      for (const row of wanted) putRow.run(row)
      putChart.run({
        checksum: chart.checksum,
        playCount: chart.playCount,
        rowCount: chart.rows.length,
        hasOnlyConfirmedVariants: chart.hasOnlyConfirmedVariants ? 1 : 0
      })
    }
    for (const checksum of gone) {
      dropRows.run(checksum)
      dropChart.run(checksum)
    }
  })()
  return result
}

/** How many charts the score files have a record of. The "is there anything to show" test. */
export function countScoreCharts(db: CatalogDb): number {
  const row = db.prepare(`SELECT count(*) AS n FROM score_charts`).get() as { n: number }
  return row.n
}

/** The totals row, before the nulls an empty table produces are interpreted. */
interface TotalsRow {
  charts: number
  lifetimePlays: number
  chartsInLibrary: number
  chartsWithUnconfirmedRows: number
  bestScore: number | null
  observedPlays: number
  observedCharts: number
}

/**
 * The whole-library summary, over everything imported.
 *
 * Six counts in one statement, every one of them aggregated by SQLite. `chartsInLibrary` is the
 * only one that touches `charts`, through an EXISTS probe of the charts_checksum index, and it is
 * the number that says how much of this data a library view can attach to anything: on the
 * owner's install 97 of 101 charts match, and the other four were played and then deleted,
 * moved, or never scanned.
 *
 * `bestScore` covers confirmed rows only. A maximum taken over every row would be a race between
 * two scoring scales and the unexplained one wins it every time (see play/scoredata.ts).
 */
export function lifetimeTotals(db: CatalogDb): LifetimeTotals {
  const row = db
    .prepare(
      `SELECT
				(SELECT count(*) FROM score_charts) AS charts,
				-- sum() over no rows is null, and a total of "no charts" is 0, not "unknown".
				(SELECT coalesce(sum(playCount), 0) FROM score_charts) AS lifetimePlays,
				(SELECT count(*) FROM score_charts s WHERE EXISTS (
					SELECT 1 FROM charts c WHERE c.cloneHeroChecksum = s.checksum
				)) AS chartsInLibrary,
				(SELECT count(*) FROM score_charts WHERE hasOnlyConfirmedVariants = 0)
					AS chartsWithUnconfirmedRows,
				-- Kept null on an empty table: "nothing recorded" is not a score of 0.
				(SELECT max(score) FROM score_bests WHERE variant = @confirmed) AS bestScore,
				(SELECT count(*) FROM plays) AS observedPlays,
				(SELECT count(DISTINCT checksum) FROM plays) AS observedCharts`
    )
    .get({ confirmed: CONFIRMED_VARIANT }) as TotalsRow

  return {
    charts: row.charts,
    lifetimePlays: row.lifetimePlays,
    chartsInLibrary: row.chartsInLibrary,
    chartsNotInLibrary: row.charts - row.chartsInLibrary,
    chartsWithUnconfirmedRows: row.chartsWithUnconfirmedRows,
    bestScore: row.bestScore,
    observedPlays: row.observedPlays,
    observedCharts: row.observedCharts
  }
}

/** One chart's joined row, with the best confirmed score's columns left null when there is none. */
interface LifetimeRow {
  checksum: string
  lifetimePlays: number
  rowCount: number
  observedPlays: number
  unconfirmedRows: number
  variant: number | null
  difficulty: number | null
  percent: number | null
  isFullCombo: number | null
  playbackSpeed: number | null
  stars: number | null
  score: number | null
  scoreWithoutCleanPlayBonus: number | null
}

/**
 * Per-chart lifetime facts, for every imported chart or for the named ones.
 *
 * An unknown checksum is simply absent from the result, exactly as `chartPlaySummaries` omits a
 * chart with no play: a row of zeroes would read as "played zero times" where the truth is that
 * Clone Hero has no record either way, and those are different facts (see shared/play.ts).
 *
 * The subquery picks the best CONFIRMED row per chart rather than the best row. Written as a
 * window function over the confirmed rows instead of `WHERE variant = @confirmed` alone, because
 * the rule is "the best of the rows we can vouch for" and only happens to select at most one row
 * today; a second confirmed variant would make the max meaningful and this query already right.
 */
export function chartLifetimes(db: CatalogDb, checksums?: string[]): ChartLifetime[] {
  if (checksums !== undefined && checksums.length === 0) return []
  // Placeholders are generated from the array's LENGTH; the values are always bound, and the
  // checksums arrive zod-validated as 32 hex characters. CONFIRMED_VARIANT is interpolated below
  // rather than bound because better-sqlite3 refuses to mix named and anonymous parameters in one
  // statement, and it is a number this module imports, never anything a caller supplies.
  const filter =
    checksums === undefined ? '' : ` WHERE s.checksum IN (${checksums.map(() => '?').join(', ')})`

  const rows = db
    .prepare(
      `SELECT
				s.checksum AS checksum,
				s.playCount AS lifetimePlays,
				s.rowCount AS rowCount,
				(SELECT count(*) FROM plays p WHERE p.checksum = s.checksum) AS observedPlays,
				(SELECT count(*) FROM score_bests b WHERE b.checksum = s.checksum
					AND b.variant <> ${CONFIRMED_VARIANT}) AS unconfirmedRows,
				best.variant, best.difficulty, best.percent, best.isFullCombo, best.playbackSpeed,
				best.stars, best.score, best.scoreWithoutCleanPlayBonus
			 FROM score_charts s
			 LEFT JOIN (
				SELECT *, row_number() OVER (PARTITION BY checksum ORDER BY score DESC, variant ASC)
					AS rn
				FROM score_bests WHERE variant = ${CONFIRMED_VARIANT}
			 ) best ON best.checksum = s.checksum AND best.rn = 1${filter}
			 ORDER BY s.playCount DESC, s.checksum ASC`
    )
    .all(...(checksums ?? [])) as LifetimeRow[]

  return rows.map((row) => ({
    checksum: row.checksum,
    lifetimePlays: row.lifetimePlays,
    observedPlays: row.observedPlays,
    // A record exists at all because the game wrote one, which it does when the chart is played.
    // Kept as an explicit test rather than a constant true so a record that somehow carries
    // neither a count nor a row does not claim more than it can.
    everPlayed: row.lifetimePlays > 0 || row.rowCount > 0,
    best: bestOf(row),
    unconfirmedRows: row.unconfirmedRows
  }))
}

/**
 * The joined best row, or null when the chart has no confirmed row for the join to find.
 *
 * `variant` decides, not `score`: a real row can hold a score of 0, and testing the score would
 * read that chart as having no best. Every other column is NOT NULL in the table, so they are
 * null here only when the whole join missed, which `variant` has already settled.
 */
function bestOf(row: LifetimeRow): ChartLifetime['best'] {
  if (row.variant === null) return null
  return {
    variant: row.variant,
    difficulty: row.difficulty as number,
    difficultyName: scoreDataDifficultyName(row.difficulty as number),
    percent: row.percent as number,
    stars: row.stars as number,
    isFullCombo: row.isFullCombo === 1,
    playbackSpeed: row.playbackSpeed as number,
    score: row.score as number,
    scoreWithoutCleanPlayBonus: row.scoreWithoutCleanPlayBonus as number
  }
}
