import type { CatalogDb } from '../catalog/db'
import type {
  CharterPlays,
  ChartPlaySummary,
  PlayBreakdown,
  PlayDay,
  PlayInsights,
  PlayStats,
  TopChart
} from '../../shared/play'
import { stripRichText } from '../../shared/format'
import type { PlayRecord } from './scorestats'

/**
 * Reads and writes of the `plays` table. The table itself is created in catalog/db.ts, alongside
 * `charts`, because one SCHEMA_VERSION governs the whole file.
 *
 * Most queries here scan a table with one row per play. That is small by construction: the file
 * this data comes from records one play at a time, and even a heavy user produces a few thousand
 * rows a year. No pagination, no caching, and the aggregates are computed rather than kept.
 *
 * `playInsights` is the exception: two of its four reads also count or join the `charts` table,
 * which is as big as the user's library. Every one of them aggregates in SQL; nothing here reads
 * rows in order to count them. Measured on a seeded catalog of 40,000 charts and 60,000 plays,
 * one call is about 160 ms: 99 ms of it the day grouping, 24 ms the charters, 17 ms the coverage
 * counts and 5 ms the last few plays. At a more ordinary 8,000 charts and 5,000 plays the whole
 * call is about 20 ms. It runs once when the tab opens and again when a play is recorded while
 * it is open.
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

/** How many charters the "played against owned" list carries. A page's worth, not a report. */
const TOP_CHARTERS_LIMIT = 12

/** How many individual plays the recent list carries. */
const RECENT_PLAYS_LIMIT = 8

/** The coverage row, before the counts are named. */
interface CoverageRow {
  inLibrary: number
  identified: number
  withPlay: number
  playsOffLibrary: number
}

/** A charter's row as SQL groups it: still carrying whatever markup the charter wrote. */
interface CharterRow {
  charter: string
  owned: number
  played: number
  plays: number
}

/** A play row as the recent query returns it, with the two flags still 0/1. */
interface RecentRow {
  checksum: string
  playedAt: string
  songName: string | null
  artistName: string | null
  charterName: string | null
  instrument: string | null
  difficulty: string | null
  score: number | null
  notesHit: number | null
  totalNotes: number | null
  isFc: number
  isPfc: number
}

/**
 * The cuts of the history the stats page draws that `playStats` does not carry.
 *
 * Four statements, each aggregated by SQLite rather than in JavaScript: a real library is tens
 * of thousands of charts and the play table grows without bound, so "read the rows and count
 * them here" would be a payload and a loop that both scale with the user's history.
 */
export function playInsights(db: CatalogDb): PlayInsights {
  // date(..., 'localtime') rather than substr: the stored string is UTC, and a user's "what did
  // I play yesterday" is a question about their own calendar. Clone Hero's seven fractional
  // digits and the Z suffix both parse. A timestamp SQLite cannot read groups as null, and is
  // dropped here rather than drawn as a day with no date.
  const days = db
    .prepare(
      `SELECT date(playedAt, 'localtime') AS day, count(*) AS plays
			 FROM plays
			 GROUP BY day
			 HAVING day IS NOT NULL
			 ORDER BY day ASC`
    )
    .all() as PlayDay[]

  // Four counts in one statement. The two totals are covering-index scans of charts_checksum
  // rather than reads of the rows themselves, and both EXISTS probes are index lookups, one
  // through plays_checksum and one through charts_checksum.
  const coverage = db
    .prepare(
      `SELECT
				(SELECT count(*) FROM charts) AS inLibrary,
				(SELECT count(*) FROM charts WHERE cloneHeroChecksum IS NOT NULL) AS identified,
				(SELECT count(*) FROM charts c
				 WHERE c.cloneHeroChecksum IS NOT NULL
				   AND EXISTS (SELECT 1 FROM plays p WHERE p.checksum = c.cloneHeroChecksum)) AS withPlay,
				(SELECT count(*) FROM plays p
				 WHERE NOT EXISTS (
				   SELECT 1 FROM charts c WHERE c.cloneHeroChecksum = p.checksum
				 )) AS playsOffLibrary`
    )
    .get() as CoverageRow

  // Only charters with a play. That bound is what makes the merge below safe to do in
  // JavaScript: it is at most one row per charter the user has actually played, where an
  // unfiltered list would be one row per charter in the library.
  const charterRows = db
    .prepare(
      `SELECT
				c.charter AS charter,
				count(*) AS owned,
				count(p.checksum) AS played,
				coalesce(sum(p.plays), 0) AS plays
			 FROM charts c
			 LEFT JOIN (SELECT checksum, count(*) AS plays FROM plays GROUP BY checksum) p
			   ON p.checksum = c.cloneHeroChecksum
			 WHERE c.charter IS NOT NULL AND trim(c.charter) <> ''
			 GROUP BY c.charter
			 HAVING plays > 0
			 ORDER BY plays DESC`
    )
    .all() as CharterRow[]

  const recent = db
    .prepare(
      `SELECT
				checksum, playedAt, songName, artistName, charterName, instrument, difficulty,
				score, notesHit, totalNotes, isFc, isPfc
			 FROM plays
			 ORDER BY playedAt DESC
			 LIMIT ?`
    )
    .all(RECENT_PLAYS_LIMIT) as RecentRow[]

  return {
    days,
    coverage,
    topCharters: mergeCharters(charterRows),
    recent: recent.map((row) => ({
      checksum: row.checksum,
      playedAt: row.playedAt,
      songName: row.songName,
      artistName: row.artistName,
      charterName: row.charterName,
      instrument: row.instrument,
      difficulty: row.difficulty,
      score: row.score,
      // Same guard as chartPlaySummaries: a chart recorded with no notes would divide to
      // Infinity and cross IPC as null, having looked like a number the whole way.
      accuracy:
        row.notesHit !== null && row.totalNotes !== null && row.totalNotes > 0
          ? row.notesHit / row.totalNotes
          : null,
      isFc: row.isFc === 1,
      isPfc: row.isPfc === 1
    }))
  }
}

/**
 * Charter rows folded together by the name as it READS, then cut to the list's length.
 *
 * SQL groups on the stored string, and charters style their own names: `Mech` and
 * `<color=#7B0000>Mech</color>` are one person with two spellings, and grouping on the raw
 * value gives them a row each that look identical on screen and disagree about the count.
 * Done here rather than in SQL because SQLite has no way to strip the markup, and safe to do
 * here because the rows are already filtered to charters with a play.
 *
 * A name that is nothing but markup strips to empty. Those keep their raw string as the key, so
 * two different all-markup names stay apart, and the renderer names them.
 */
function mergeCharters(rows: CharterRow[]): CharterPlays[] {
  const merged = new Map<string, CharterPlays>()
  for (const row of rows) {
    const name = stripRichText(row.charter)
    const key = (name === '' ? row.charter : name).toLowerCase()
    const existing = merged.get(key)
    if (existing === undefined) {
      merged.set(key, { charter: name, owned: row.owned, played: row.played, plays: row.plays })
      continue
    }
    existing.owned += row.owned
    existing.played += row.played
    existing.plays += row.plays
    // The first spelling to arrive wins the name, unless it had none to give.
    if (existing.charter === '') existing.charter = name
  }
  return [...merged.values()]
    .sort((a, b) => b.plays - a.plays || b.owned - a.owned || a.charter.localeCompare(b.charter))
    .slice(0, TOP_CHARTERS_LIMIT)
}
