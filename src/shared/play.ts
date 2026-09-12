import { z } from 'zod'

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
