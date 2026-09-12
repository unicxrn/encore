import { z } from 'zod'
import type { ScoreFolderSource } from './score-folder'

/**
 * Clone Hero's own play data, as it crosses the IPC boundary.
 *
 * The source is a single file the game rewrites after every play (`scorestats.json`), holding
 * only the most recent one. Encore accumulates history by watching it, so everything here is
 * bounded by what was recorded while Encore was running: a user who plays for a month and then
 * installs Encore starts from one play, not from a month of them. Nothing in this module should
 * present its numbers as the user's lifetime totals, because they are not.
 *
 * Plays are keyed by Clone Hero's `checksum`, an MD5 of the chart file alone (see
 * main/catalog/chart-checksum.ts). Stored and passed as lower hex throughout; the game writes
 * upper, and the parser is the single place that normalises.
 */

/** A 32-character lower-hex MD5. The form every checksum takes once it is past the parser. */
export const ChecksumSchema = z.string().regex(/^[0-9a-f]{32}$/)

/**
 * How many checksums one summary request may name.
 *
 * Matches `catalog:query`'s own page cap of 500, because the caller with the most to ask for is
 * a rendered page of charts asking for a badge each.
 */
export const PLAY_SUMMARY_MAX = 500

export const PlaySummaryRequestSchema = z.array(ChecksumSchema).max(PLAY_SUMMARY_MAX)

/**
 * Whether there is any play data to show, and why not when there is not.
 *
 * `unavailable` is the ordinary case, not an error. Most users have no Clone Hero install on the
 * machine running Encore, or have one that has never written a score, and a UI that renders this
 * as a failure would be wrong about all of them. The `reason` exists to pick wording, not to
 * apologise.
 *
 * - `ok`: the file was found and read at least once.
 * - `noFile`: the location is known for this platform and nothing is there.
 * - `unknownPlatform`: no location has been established for this platform (see main/play/
 *   location.ts, which refuses to guess one).
 * - `unreadable`: something is there but could not be read or parsed. Still not an error the
 *   user must act on: a half-written file mid-save looks exactly like this and fixes itself.
 */
export const PlayAvailabilitySchema = z.enum(['ok', 'noFile', 'unknownPlatform', 'unreadable'])
export type PlayAvailability = z.infer<typeof PlayAvailabilitySchema>

export interface PlayDataStatus {
  /** True only when plays have actually been recorded; the UI's single "show this at all" test. */
  available: boolean
  reason: PlayAvailability
  /**
   * The scorestats.json path being watched, or null on a platform with no established location.
   * Surfaced so a user who keeps Clone Hero somewhere unusual can be told where Encore looked.
   */
  path: string | null
  /** Plays recorded so far. Zero with reason `ok` means the file exists but held nothing new. */
  playCount: number
}

/**
 * What one chart's plays add up to. Everything a Library row or a detail panel needs, and
 * nothing that would require reading the play rows themselves.
 *
 * `bestScore` and friends are taken across every play of the chart regardless of instrument or
 * difficulty. That is the honest reading of what this data supports: Clone Hero records one
 * player's instrument and difficulty per play, and splitting the best score by them would give
 * a column that is null for every combination the user has not played, which is most of them.
 */
export interface ChartPlaySummary {
  checksum: string
  timesPlayed: number
  bestScore: number | null
  bestStars: number | null
  /** notes_hit / total_notes of the best-scoring play, 0-1, or null when notes were not recorded. */
  bestAccuracy: number | null
  /** True when ANY play of this chart was a full combo. */
  everFc: boolean
  /** ISO 8601, exactly as Clone Hero wrote it. Not re-parsed, so no timezone is invented. */
  lastPlayedAt: string | null
}

/** One row of a "plays by X" breakdown. */
export interface PlayBreakdown {
  key: string
  plays: number
}

/** One chart in a most-played list, carrying the names Clone Hero recorded alongside the play. */
export interface TopChart {
  checksum: string
  songName: string | null
  artistName: string | null
  charterName: string | null
  timesPlayed: number
  bestScore: number | null
}

/**
 * The aggregates a stats view needs, over every play recorded.
 *
 * Deliberately one call rather than several: these are all cheap scans of one small table, and a
 * view that assembled them from five round trips would still be drawing one screen.
 */
export interface PlayStats {
  totalPlays: number
  /** Distinct charts, by checksum. Lower than totalPlays whenever anything was replayed. */
  chartsPlayed: number
  /** Plays that were a full combo. */
  fcCount: number
  /** Plays that were a perfect full combo. A subset of fcCount. */
  pfcCount: number
  /** Notes hit across every play, and notes those plays contained. Accuracy is the ratio. */
  notesHit: number
  totalNotes: number
  /** Highest single-play score and longest streak recorded, across everything. */
  bestScore: number | null
  longestStreak: number | null
  /** ISO 8601 bounds of the recorded history, or null when nothing is recorded. */
  firstPlayedAt: string | null
  lastPlayedAt: string | null
  byInstrument: PlayBreakdown[]
  byDifficulty: PlayBreakdown[]
  /** Most-played charts, longest first. Capped by the query; see main/play/store.ts. */
  topCharts: TopChart[]
}

/**
 * One day of the play history, as a count.
 *
 * `day` is `YYYY-MM-DD` in the machine's own timezone, not UTC: a play finished at 00:30 local
 * belongs to the evening the user remembers, and a chart of "when do I play" bucketed by UTC
 * would move a whole timezone's late nights onto the next day. The conversion happens in SQL,
 * once, so the bucket and the boundary agree (see main/play/store.ts).
 *
 * Only days that HAVE a play appear. The days between are zero by definition and sending a row
 * for each would make the payload a function of the calendar rather than of the history.
 */
export interface PlayDay {
  day: string
  plays: number
}

/**
 * How much of the library has a play on record, and how much of it could ever have one.
 *
 * Three numbers rather than one ratio, because the shortfall has two unrelated causes and a
 * single "12% played" would hide both. `identified` is the charts Encore holds a Clone Hero
 * checksum for; a chart without one can never be matched to a play however much it was played,
 * and the fix is a rescan, not more playing. `withPlay` is how many of those Encore has actually
 * seen played, which is NOT how many the user has ever played: the history starts when Encore
 * did (see the module comment above).
 */
export interface PlayCoverage {
  /** Charts in the catalog, whatever their state. */
  inLibrary: number
  /** Charts carrying a Clone Hero checksum, so a play can be joined to them. */
  identified: number
  /** Identified charts with at least one recorded play. */
  withPlay: number
  /** Recorded plays matching no chart in the catalog: deleted, moved, or never scanned. */
  playsOffLibrary: number
}

/** One charter, with what the library holds of theirs beside what has been played. */
export interface CharterPlays {
  /** Clone Hero's markup already removed, because the merging below is done on this name. */
  charter: string
  /** Charts by this charter in the catalog. */
  owned: number
  /** How many of those have a recorded play. */
  played: number
  /** Recorded plays across all of them. */
  plays: number
}

/** One play, as the history recorded it. The only place a single play is visible. */
export interface RecentPlay {
  /** Clone Hero's chart identity plus the timestamp: together, the row's identity. */
  checksum: string
  playedAt: string
  songName: string | null
  artistName: string | null
  charterName: string | null
  instrument: string | null
  difficulty: string | null
  score: number | null
  /** notes_hit / total_notes for this play, 0-1, or null when notes were not recorded. */
  accuracy: number | null
  isFc: boolean
  isPfc: boolean
}

/**
 * The cuts of the play history a page has room for and a panel did not.
 *
 * Separate from `PlayStats` rather than folded into it: `playStats` is the cheap aggregate any
 * consumer can ask for, and three of the four reads below touch the `charts` table as well,
 * which nothing asking for a total should have to pay for.
 */
export interface PlayInsights {
  /** Every day with a play, oldest first. */
  days: PlayDay[]
  coverage: PlayCoverage
  /** Charters with at least one recorded play, most played first. Capped by the query. */
  topCharters: CharterPlays[]
  /** The last few plays, newest first. Capped by the query. */
  recent: RecentPlay[]
}

/**
 * What Clone Hero's OWN score files say, which is a different thing from everything above.
 *
 * Everything before this point comes from `scorestats.json`, which holds one play and is gone at
 * the next song, so Encore's history starts when Encore does. `scoredata.bin` and `scoresext.bin`
 * are the game's high score table: one record per chart, a lifetime play count, and the best
 * score, all of it surviving since long before Encore was installed. That is the point of reading
 * them, and it is also the whole of what they can say. Neither file carries a timestamp, so
 * nothing here can be placed on a calendar, and none of it is a play in the sense the `plays`
 * table means.
 *
 * The two overlap, and the overlap is the trap. `lifetimePlays` is the game's running total for a
 * chart and ALREADY INCLUDES every play Encore watched happen. Adding a lifetime count to an
 * observed count double counts. The shapes below carry both numbers side by side, separately
 * named, so a screen has to choose which it is showing rather than accidentally summing them.
 */

/**
 * What a caller may ask the lifetime channel for.
 *
 * The checksum cap is `PLAY_SUMMARY_MAX`, for the same reason it applies there: the caller with
 * the most to ask for is one rendered page of chart rows.
 */
export const LifetimeScoreRequestSchema = z.object({
  /**
   * Restrict `charts` to these checksums. Omitted means every chart the score files know of,
   * which is bounded by how many charts the user has ever played, not by the library's size.
   *
   * `totals` ignores this and is always computed over everything, because a summary of the
   * subset a page happens to be showing would be a number nobody asked for.
   */
  checksums: z.array(ChecksumSchema).max(PLAY_SUMMARY_MAX).optional()
})
export type LifetimeScoreRequest = z.infer<typeof LifetimeScoreRequestSchema>

/**
 * One chart's best score, as the score files hold it.
 *
 * Taken from the rows whose variant has been confirmed against a real play (see
 * main/play/scoredata.ts). A chart whose only rows are unconfirmed has no `best` at all rather
 * than a score on a scale nothing has checked.
 */
export interface LifetimeBest {
  /** The game's own key for this row. Not decoded; carried so a caller can report it verbatim. */
  variant: number
  /** 0 to 3 as the file stores it. Only 3, Expert, is confirmed. */
  difficulty: number
  /** The name for that code, or null when the code is outside the range we can name. */
  difficultyName: string | null
  /** Notes hit over total notes, floored to a whole percent, as the game stored it. */
  percent: number
  /** 0 to 6, where 6 is the gold star. */
  stars: number
  /** Inferred from a sample with one positive. Do not render this as "perfect". */
  isFullCombo: boolean
  /** Playback speed as a percent. 100 in every row seen. */
  playbackSpeed: number
  /** The score the game reports, from `scoresext.bin`. This is the number the user remembers. */
  score: number
  /** The same score less the clean play bonus, from `scoredata.bin`. Shown by nothing; kept
   * because the gap between the two is the only evidence of what the bonus was. */
  scoreWithoutCleanPlayBonus: number
}

/** Everything the score files say about one chart, with the observed count kept separate. */
export interface ChartLifetime {
  checksum: string
  /**
   * Plays over the chart's whole life, with no dates attached, as the game counts them.
   *
   * INCLUDES the `observedPlays` below. The two are never added.
   */
  lifetimePlays: number
  /** Plays of this chart Encore watched happen, out of the `plays` table. A subset of the above. */
  observedPlays: number
  /**
   * True when the game has a record of this chart at all.
   *
   * Trustworthy even when `best` is null: a record exists because the chart was played, whatever
   * its rows turn out to mean.
   */
  everPlayed: boolean
  /** The best confirmed score, or null when every row for this chart is unconfirmed. */
  best: LifetimeBest | null
  /**
   * Score rows on a variant that has never been tied to a play whose real numbers are known.
   *
   * Zero for almost every chart. Above zero means the game keeps a score for this chart that
   * Encore cannot explain and whose scale does not match a normal one, so a screen showing a
   * "best" here is showing the best of the rows it CAN explain and should say so. The play count
   * and `everPlayed` are unaffected: an unexplained row is still a record of a real play.
   */
  unconfirmedRows: number
}

/** The whole-library summary, always over everything the score files hold. */
export interface LifetimeTotals {
  /** Charts the score files have a record of. */
  charts: number
  /** Those charts' lifetime play counts, summed. Includes `observedPlays`; never add the two. */
  lifetimePlays: number
  /** Charts whose checksum matches a chart in the catalog. */
  chartsInLibrary: number
  /** The rest: played once and since deleted, moved, renamed, or never scanned. */
  chartsNotInLibrary: number
  /** Charts carrying at least one unconfirmed score row. See `ChartLifetime.unconfirmedRows`. */
  chartsWithUnconfirmedRows: number
  /** The highest confirmed score in the files, or null when there is no confirmed row at all. */
  bestScore: number | null
  /** Plays Encore itself watched happen. Already counted inside `lifetimePlays`. */
  observedPlays: number
  /** Distinct charts those observed plays cover. */
  observedCharts: number
}

/** Whether the score files were found and read, and where Encore looked. */
export interface LifetimeScoreStatus {
  /** True only when a record was actually imported; the UI's single "show this at all" test. */
  available: boolean
  /** The same four states as `PlayAvailability`, and none of them is an error. */
  reason: PlayAvailability
  /**
   * The two paths being watched, or null on a platform with no established location.
   *
   * Nothing but Linux has been verified (see main/play/location.ts), so a Windows or macOS user
   * finding nothing is being told where Encore looked, not where the files definitely are.
   */
  scoreDataPath: string | null
  scoresExtPath: string | null
  /** When the last import ran, by Encore's clock. Null until one has. Not a play date. */
  lastImportAt: string | null
  /**
   * Whether the last successful read came from one of Clone Hero's own backup files.
   *
   * A separate flag rather than a fifth `reason`, and deliberately: `reason` is
   * `PlayAvailability`, which the scorestats channel answers with too, and no read of that file
   * can ever fall back to a backup. Widening the enum would hand every consumer of `playStatus` a
   * state that channel cannot produce. It is also not an alternative to `ok`: the read succeeded,
   * and this says only that the numbers are as old as the game's last backup.
   *
   * False before any read has succeeded, and false again as soon as one succeeds from the
   * primaries, so it describes the last successful read rather than the session.
   */
  usedBackup: boolean
  /**
   * Where the folder came from: the user's setting, or Encore's own probe.
   *
   * The paths above say where Encore looked; this says who chose. A user whose override is in
   * effect and who still sees nothing is looking at their own answer, not at Encore's guess.
   */
  folderSource: ScoreFolderSource
}

/**
 * What a request to inspect a score folder carries. An empty string means "wherever you look now".
 *
 * The report it answers with, and the sentence that describes it, are in `score-folder.ts`: the
 * renderer draws both and must not pull zod in to do it.
 */
export const ScoreFolderRequestSchema = z.object({ folder: z.string() })
export type ScoreFolderRequest = z.infer<typeof ScoreFolderRequestSchema>

/** The one shape the lifetime channel answers with. */
export interface LifetimeScores {
  status: LifetimeScoreStatus
  totals: LifetimeTotals
  /** One entry per chart the score files know of, filtered to the request's checksums if given. */
  charts: ChartLifetime[]
}
