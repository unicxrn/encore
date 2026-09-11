import { normalizeChecksum } from '../catalog/chart-checksum'

/**
 * Parser for Clone Hero's `scorestats.json`.
 *
 * The file holds exactly one play: the most recent. Clone Hero rewrites it in place after every
 * song, so this parser runs on every change the watcher sees, and the same unchanged content is
 * re-parsed often. It must therefore be cheap, total, and silent about bad input.
 *
 * "Total and silent" is the whole design. Four states are indistinguishable from the outside and
 * all four are ordinary: the file is absent (no Clone Hero, or no play yet), it is being written
 * as we read it (truncated JSON), it is from a Clone Hero version whose shape we do not know, or
 * it is genuinely corrupt. None of them is something the user did wrong, none is actionable, and
 * a watcher that logged an error for the half-written case would log one after every single
 * song. So there is one failure value, `null`, and no throw.
 *
 * The shape was confirmed against Clone Hero v1.1.0.6142-final on 2026-09-11. Top level:
 * `game_version, checksum, song_name, artist_name, charter_name, playback_speed, game_mode,
 * score_timestamp, band_score, band_stars, player_count, players[]`. Each `players[]` entry
 * carries some forty fields, of which this reads the dozen the app has a use for.
 *
 * Only `players[0]` is read. `player_count` is kept as recorded so a multiplayer play is not
 * silently reported as a solo one, but the per-player stats stored are the first player's. Every
 * other player in a local band session is a different human on a different controller, and
 * attributing their score to this user's history would be wrong. If per-player history is ever
 * wanted, this is the function to widen and the `plays` table's UNIQUE key to revisit.
 */

/**
 * One play, flattened to the columns the `plays` table has.
 *
 * Fields are nullable wherever Clone Hero might not record them, which in practice is most of
 * them: the two that are not are the two that form the row's identity.
 */
export interface PlayRecord {
  /** Clone Hero's chart identity, lower hex. Required: a play that cannot name a chart is useless. */
  checksum: string
  /** `score_timestamp`, kept as the ISO 8601 string Clone Hero wrote. Required: half the key. */
  playedAt: string
  songName: string | null
  artistName: string | null
  charterName: string | null
  gameVersion: string | null
  gameMode: string | null
  playbackSpeed: number | null
  bandScore: number | null
  bandStars: number | null
  playerCount: number | null
  instrument: string | null
  difficulty: string | null
  profileName: string | null
  score: number | null
  notesHit: number | null
  totalNotes: number | null
  maxStreak: number | null
  isFc: boolean
  isPfc: boolean
  stars: number | null
  avgMultiplier: number | null
}

/** A JSON object, once we know it is one. */
type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string field, or null for anything else. Empty strings become null: they say nothing. */
function str(source: Json, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * A finite number field, or null.
 *
 * The finiteness check is not ceremony. JSON has no NaN or Infinity literal, but these values
 * come out of a float in the game and `avg_multiplier` is a float column; a value that arrived
 * as a string, or as a number SQLite would refuse, has to become null before it reaches a bind
 * parameter rather than after.
 */
function num(source: Json, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A boolean field. Absent or wrong-typed means false: these are "did something special happen". */
function bool(source: Json, key: string): boolean {
  return source[key] === true
}

/**
 * An ISO 8601 timestamp, or null.
 *
 * Validated by `Date.parse` but stored as the ORIGINAL string, never as a re-serialised date.
 * Clone Hero writes .NET's round-trip format with seven fractional digits
 * (`2026-09-10T22:23:37.1089500Z`), and JavaScript's Date truncates to three. Round-tripping
 * would throw away the four digits that make two rapid plays distinguishable, and the whole
 * point of this field is that it is half of the row's identity.
 */
function timestamp(source: Json, key: string): string | null {
  const value = str(source, key)
  if (value === null) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/**
 * Parse the contents of scorestats.json into one play, or null when it does not yield one.
 *
 * Takes text rather than a path so the read and the parse fail separately: the caller has to
 * handle a missing file anyway, and a parser that did its own I/O could not be tested against a
 * truncated string without writing one to disk.
 *
 * Returns null, never throws, for: text that is not JSON (including a truncated write caught
 * mid-save), JSON that is not an object, an object with no usable checksum, one with no valid
 * timestamp, and one whose `players` is missing or empty. Those five are the only ways this can
 * fail, and the caller treats them identically.
 */
export function parseScoreStats(text: string): PlayRecord | null {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    // Truncated or malformed. The common cause is reading while Clone Hero is still writing,
    // which the next watcher event fixes on its own.
    return null
  }
  if (!isObject(root)) return null

  // Both of these are required, and both are rejections rather than defaults. A play with no
  // chart identity can never be joined to anything, and one with no timestamp has no identity of
  // its own, so it would either duplicate on every re-read or collide with a real play.
  const checksum = normalizeChecksum(root['checksum'])
  if (checksum === null) return null
  const playedAt = timestamp(root, 'score_timestamp')
  if (playedAt === null) return null

  const players = root['players']
  if (!Array.isArray(players) || players.length === 0) return null
  const player = players[0]
  if (!isObject(player)) return null

  return {
    checksum,
    playedAt,
    songName: str(root, 'song_name'),
    artistName: str(root, 'artist_name'),
    charterName: str(root, 'charter_name'),
    gameVersion: str(root, 'game_version'),
    gameMode: str(root, 'game_mode'),
    playbackSpeed: num(root, 'playback_speed'),
    bandScore: num(root, 'band_score'),
    bandStars: num(root, 'band_stars'),
    playerCount: num(root, 'player_count'),
    instrument: str(player, 'instrument'),
    difficulty: str(player, 'difficulty'),
    profileName: str(player, 'profile_name'),
    score: num(player, 'score'),
    notesHit: num(player, 'notes_hit'),
    totalNotes: num(player, 'total_notes'),
    maxStreak: num(player, 'max_streak'),
    isFc: bool(player, 'is_fc'),
    isPfc: bool(player, 'is_pfc'),
    stars: num(player, 'stars'),
    avgMultiplier: num(player, 'avg_multiplier')
  }
}
