import type { CatalogDb } from '../catalog/db'
import type { ChartPlaySummary, PlayBreakdown, PlayStats, TopChart } from '../../shared/play'
import type { PlayRecord } from './scorestats'

/**
 * Reads and writes of the `plays` table. The table itself is created in catalog/db.ts, alongside
 * `charts`, because one SCHEMA_VERSION governs the whole file.
 *
 * Every query here scans a table with one row per play. That is small by construction: the file
 * this data comes from records one play at a time, and even a heavy user produces a few thousand
 * rows a year. No pagination, no caching, and the aggregates are computed rather than kept.
 */

/** Most-played charts returned by `playStats`. Enough for a leaderboard, short enough to send. */
const TOP_CHARTS_LIMIT = 10

/**
 * Record a play, unless it is one already recorded.
 *
 * Returns true only when a row was actually inserted, which is what tells the watcher whether
 * anything changed. This matters more than it looks: the watcher re-reads and re-parses the file
 * on every filesystem event it sees, and chokidar emits several for one save, so the overwhelming
 * majority of calls here are re-presentations of the play recorded a moment ago.
 *
 * The duplicate rule is the table's own UNIQUE(checksum, playedAt), applied with INSERT OR
 * IGNORE rather than a SELECT-then-INSERT. Two reasons: the check and the write are then one
 * statement, so nothing can interleave between them, and the rule lives in the schema where a
 * second writer would also be bound by it instead of in a caller that could forget.
 *
 * Note what this does NOT dedupe: the same chart played twice. Clone Hero's timestamp carries
 * seven fractional digits, so two genuine plays differ, and they must — a user grinding one song
 * is exactly the history this feature exists to show.
 */
export function recordPlay(db: CatalogDb, play: PlayRecord): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO plays (
				checksum, playedAt, songName, artistName, charterName, gameVersion, gameMode,
				playbackSpeed, bandScore, bandStars, playerCount, instrument, difficulty, profileName,
				score, notesHit, totalNotes, maxStreak, isFc, isPfc, stars, avgMultiplier
			) VALUES (
				@checksum, @playedAt, @songName, @artistName, @charterName, @gameVersion, @gameMode,
				@playbackSpeed, @bandScore, @bandStars, @playerCount, @instrument, @difficulty,
				@profileName, @score, @notesHit, @totalNotes, @maxStreak, @isFc, @isPfc, @stars,
				@avgMultiplier
			)`
    )
    // better-sqlite3 binds no JavaScript booleans, so the two flags become 0/1 here. Everything
    // else is already a string, a number or null out of the parser.
    .run({ ...play, isFc: play.isFc ? 1 : 0, isPfc: play.isPfc ? 1 : 0 })
  return result.changes > 0
}

/** How many plays have been recorded. The cheapest "is there anything to show" test there is. */
export function countPlays(db: CatalogDb): number {
  const row = db.prepare(`SELECT count(*) AS n FROM plays`).get() as { n: number }
  return row.n
}

/** SQLite gives integers for the two flags and may give null for an aggregate over no rows. */
interface SummaryRow {
  checksum: string
  timesPlayed: number
  bestScore: number | null
  bestStars: number | null
  everFc: number
  lastPlayedAt: string | null
  bestNotesHit: number | null
  bestTotalNotes: number | null
}

/**
 * Play summaries for the named charts, one entry per checksum that has at least one play.
 *
 * Checksums with no plays are OMITTED rather than returned as an empty summary. The caller has
 * the list it asked for and can tell the difference; sending back a row of zeroes for every
 * unplayed chart on a 500-chart page would be almost the entire payload, and would also read as
 * "played zero times" where the truth is "no record either way" (see shared/play.ts).
 *
 * `bestAccuracy` comes from the best-SCORING play, not from the most accurate one. Those differ,
 * and the score is the figure the rest of the summary is about; reporting the accuracy of a run
 * the user never saw next to the score of one they did would be a quiet lie. The window function
 * is what picks the right row's notes rather than the maximum of each column independently.
 */
export function chartPlaySummaries(db: CatalogDb, checksums: string[]): ChartPlaySummary[] {
  if (checksums.length === 0) return []
  // Placeholders are generated from the array's LENGTH; the values are always bound. The
  // checksums arrive zod-validated as 32 hex characters, and are still never interpolated.
  const placeholders = checksums.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT
				checksum,
				count(*) AS timesPlayed,
				max(score) AS bestScore,
				max(stars) AS bestStars,
				max(isFc) AS everFc,
				max(playedAt) AS lastPlayedAt,
				-- The notes of the highest-scoring play: ordering by score picks the row, and
				-- first_value takes that row's columns rather than each column's own maximum.
				first_value(notesHit) OVER w AS bestNotesHit,
				first_value(totalNotes) OVER w AS bestTotalNotes
			 FROM plays
			 WHERE checksum IN (${placeholders})
			 GROUP BY checksum
			 WINDOW w AS (PARTITION BY checksum ORDER BY score DESC)`
    )
    .all(...checksums) as SummaryRow[]

  return rows.map((row) => ({
    checksum: row.checksum,
    timesPlayed: row.timesPlayed,
    bestScore: row.bestScore,
    bestStars: row.bestStars,
    // Guarded against a zero total as well as a null one: a chart scanned as having no notes
    // would otherwise divide to Infinity and cross IPC as null anyway, having looked like a
    // number the whole way.
    bestAccuracy:
      row.bestNotesHit !== null && row.bestTotalNotes !== null && row.bestTotalNotes > 0
        ? row.bestNotesHit / row.bestTotalNotes
        : null,
    everFc: row.everFc === 1,
    lastPlayedAt: row.lastPlayedAt
  }))
}

/**
 * One "plays by column" breakdown, commonest first.
 *
 * `column` is never user input: both call sites below pass a literal, and widening this to take
 * one would make the interpolation a real injection. It stays private for that reason.
 */
function breakdown(db: CatalogDb, column: 'instrument' | 'difficulty'): PlayBreakdown[] {
  return db
    .prepare(
      `SELECT ${column} AS key, count(*) AS plays FROM plays
			 WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY plays DESC, key ASC`
    )
    .all() as PlayBreakdown[]
}

/** The aggregate row, before nulls from an empty table are interpreted. */
interface StatsRow {
  totalPlays: number
  chartsPlayed: number
  // sum() over no rows is null, not 0, so all four of these are nullable on an empty table.
  fcCount: number | null
  pfcCount: number | null
  notesHit: number | null
  totalNotes: number | null
  bestScore: number | null
  longestStreak: number | null
  firstPlayedAt: string | null
  lastPlayedAt: string | null
}

/**
 * Everything a stats view needs, in one pass plus three small ones.
 *
 * Safe on an empty table: `count` and `sum(... )` over no rows give 0 and null respectively, and
 * the nulls are mapped to 0 for the two totals (where "no notes recorded" and "zero notes" mean
 * the same thing) but kept for the bests and the bounds (where they do not: a null best score is
 * "nothing recorded", and 0 would be a claim about a real play).
 */
export function playStats(db: CatalogDb): PlayStats {
  const row = db
    .prepare(
      `SELECT
				count(*) AS totalPlays,
				count(DISTINCT checksum) AS chartsPlayed,
				-- The flags are 0/1, so summing them counts the plays that set them.
				sum(isFc) AS fcCount,
				sum(isPfc) AS pfcCount,
				sum(notesHit) AS notesHit,
				sum(totalNotes) AS totalNotes,
				max(score) AS bestScore,
				max(maxStreak) AS longestStreak,
				-- playedAt is ISO 8601 with a fixed-width date and a Z suffix, so it sorts
				-- lexicographically in chronological order and min/max need no date parsing.
				min(playedAt) AS firstPlayedAt,
				max(playedAt) AS lastPlayedAt
			 FROM plays`
    )
    .get() as StatsRow

  const topCharts = db
    .prepare(
      `SELECT
				checksum,
				-- The names Clone Hero recorded with the play, not the catalog's. A chart that was
				-- played and then deleted still has a name this way, and it is the name the user
				-- saw at the time.
				max(songName) AS songName,
				max(artistName) AS artistName,
				max(charterName) AS charterName,
				count(*) AS timesPlayed,
				max(score) AS bestScore
			 FROM plays
			 GROUP BY checksum
			 ORDER BY timesPlayed DESC, max(playedAt) DESC
			 LIMIT ?`
    )
    .all(TOP_CHARTS_LIMIT) as TopChart[]

  return {
    totalPlays: row.totalPlays,
    chartsPlayed: row.chartsPlayed,
    fcCount: row.fcCount ?? 0,
    pfcCount: row.pfcCount ?? 0,
    notesHit: row.notesHit ?? 0,
    totalNotes: row.totalNotes ?? 0,
    bestScore: row.bestScore,
    longestStreak: row.longestStreak,
    firstPlayedAt: row.firstPlayedAt,
    lastPlayedAt: row.lastPlayedAt,
    byInstrument: breakdown(db, 'instrument'),
    byDifficulty: breakdown(db, 'difficulty'),
    topCharts
  }
}
