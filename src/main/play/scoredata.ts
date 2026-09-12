/**
 * Parsers for Clone Hero's `scoredata.bin` and `scoresext.bin`.
 *
 * These two files are the game's own high score table, and they are the only record of anything
 * the user played before Encore was watching. `scorestats.json` holds one play, the most recent,
 * and is gone the moment the next song ends; these hold one row per chart and survive.
 *
 * WHAT THEY ARE NOT is the more important half. Neither file carries a timestamp, a per-play
 * history, or anything else that would let a play be placed in time. `scoredata.bin` records a
 * play COUNT per chart and a best score per chart, and that is all. A best is not a play: it has
 * no date, and the count cannot be spread over dates without inventing them. Anything derived
 * from these files can say "you have played this, and this was your best", and cannot say when,
 * or how often in a given week. The `plays` table is a log of observed plays and these rows are
 * not plays, so they must never be written into it.
 *
 * Both files are another program's private format with no specification, so everything here is
 * untrusted input. The parsers are total: no throw, one failure value (`null`), and no partial
 * result. They refuse the whole file rather than return a best guess, because a wrong number
 * shown confidently is worse than nothing, and the caller has no way to tell a decoded score
 * from a misdecoded one. Refusal happens on an unrecognised version tag, a record count that
 * does not walk to exactly the end of the file, and any record whose declared size runs past it.
 *
 * Layout, decoded against the owner's install of Clone Hero v1.1.0.6142-final on 2026-09-12,
 * with 101 charts and 111 score rows. All integers are little endian.
 *
 * `scoredata.bin`, 8 byte header then `count` variable length records:
 *
 *     u32   version tag, 20211009
 *     u32   count, the number of chart records
 *     per chart:
 *       16B   MD5, Clone Hero's chart checksum, the same identity `chart-checksum.ts` computes
 *       u8    the number of score rows that follow
 *       u24   play count for this chart, all plays on it across every row
 *       per score row, 16 bytes:
 *         u16   variant, see below
 *         u8    difficulty
 *         u8    percent, floor of notes hit over total notes
 *         u8    full combo flag
 *         u16   playback speed, percent
 *         u8    stars
 *         u32   variant flag, see below
 *         u32   score, which is the score the game reports MINUS the clean play bonus
 *
 * `scoresext.bin`, the same 8 byte header and the same charts in the same order:
 *
 *     u32   version tag, 20251011
 *     u32   count, the number of chart records
 *     per chart:
 *       16B   MD5, the same checksum
 *       u8    the number of score rows that follow, always equal to scoredata's
 *       per score row, 11 bytes:
 *         u16   variant, matching the scoredata row it belongs to
 *         u8    full combo flag, agreeing with scoredata's
 *         u32   score, the score the game reports
 *         u32   zero in every row observed
 *
 * How the fields were pinned. Encore's own `plays` table held 15 plays observed through
 * `scorestats.json`, each with a checksum, instrument, difficulty, score, stars and note counts
 * straight from the game. All 15 charts appear in `scoredata.bin`, and in all 15 the difficulty
 * byte is 3 for Expert, the percent byte is `floor(notes_hit / total_notes * 100)` to the unit,
 * the stars byte is the star count, the speed field is 100 against a recorded playback speed of
 * 100, and `scoresext`'s score is the reported score EXACTLY. `scoredata`'s score sits a little
 * below it, and the gap is the clean play bonus: the game reported 40122 with a bonus of 22 and
 * `scoredata` holds 40100, and it reported 80597 with a bonus of 40 and `scoredata` holds 80557.
 * That is why a caller that wants the number the user remembers wants `scoresext`.
 *
 * Difficulty 3 is Expert on that evidence. That 2, 1 and 0 are Hard, Medium and Easy is inferred
 * from the ordering and from the one public parser found, and is not confirmed; see
 * `scoreDataDifficultyName`.
 *
 * The full combo flag is inferred. It is 0 in all 15 confirmed plays, none of which was a full
 * combo, and 1 in exactly one row out of 111: the only row at 100 percent, which also holds the
 * maximum 6 stars. `scoresext`'s flag is 1 on that same row and 0 everywhere else. One of the
 * two may be full combo and the other perfect full combo; a sample with one positive cannot
 * tell them apart, so both are read under the same name and neither should be shown as "perfect".
 *
 * The variant, and the `variantFlag` that moves with it, are NOT decoded, and a caller must not
 * treat them as decoded. What is established:
 *
 * - The variant is the key that separates the several score rows one chart can hold, and the key
 *   that pairs a `scoredata` row with its `scoresext` row. It was 0 or 8, never anything else.
 * - It is NOT the instrument. A chart whose only track is `ExpertSingle`, verified by reading the
 *   `.sng`, carries a single row whose variant is 8. There is exactly one instrument it could
 *   have been played on.
 * - `variantFlag` was 1 in every row with variant 0 and 0 in every row with variant 8, across all
 *   111 rows. Two fields that never disagree are one fact written twice, or two halves of one.
 * - All 15 externally confirmed plays have variant 0. Not one variant 8 row can be tied to a play
 *   whose real numbers are known.
 * - Variant 8 rows are on a different scale. Scored against the note counts Encore's catalog
 *   holds for the same chart and difficulty, variant 0 rows run at a median of 123 points per
 *   note hit and variant 8 rows at 389, which is above what the game's own scoring can reach.
 *
 * So a variant 8 row is a real row about a real chart, and its score is not comparable to a
 * variant 0 score. A caller that shows a "best score" without splitting on the variant will put
 * two different scales in one column. `hasOnlyConfirmedVariants` exists to make that decision
 * explicit rather than accidental.
 */

/** Bytes of header before the first record: the version tag and the record count. */
const HEADER_BYTES = 8

/** `scoredata.bin`'s version tag. */
export const SCORE_DATA_VERSION = 20211009

/** `scoresext.bin`'s version tag. */
export const SCORES_EXT_VERSION = 20251011

/** Bytes in a chart record before its score rows: the checksum, the row count and the play count. */
const SCORE_DATA_CHART_BYTES = 16 + 1 + 3

/** Bytes in one `scoredata.bin` score row. */
const SCORE_DATA_ROW_BYTES = 16

/** Bytes in a `scoresext.bin` chart record before its score rows. */
const SCORES_EXT_CHART_BYTES = 16 + 1

/** Bytes in one `scoresext.bin` score row. */
const SCORES_EXT_ROW_BYTES = 11

/**
 * The only variant confirmed against a play whose real numbers are known.
 *
 * Named rather than written as a bare 0 at each use because the number means "the class of row we
 * can vouch for", and a reader who meets it as a literal has no way to know that.
 */
const CONFIRMED_VARIANT = 0

/** One chart's best score on one variant, from `scoredata.bin`. */
export interface ScoreDataRow {
  /** Not decoded. See the module comment before using this for anything. */
  variant: number
  /** 0 to 3. 3 is Expert; see `scoreDataDifficultyName` for the rest. */
  difficulty: number
  /** Notes hit over total notes, floored to a whole percent, as the game stored it. */
  percent: number
  /** Inferred, see the module comment. Do not render this as "perfect". */
  isFullCombo: boolean
  /** Playback speed as a percent. 100 in every row observed. */
  playbackSpeed: number
  /** 0 to 6, where 6 is the gold star. */
  stars: number
  /** Not decoded, and never seen to disagree with `variant`. */
  variantFlag: number
  /** The score the game reports MINUS the clean play bonus. `scoresext` holds the reported one. */
  score: number
}

/** One chart's row in `scoredata.bin`. */
export interface ScoreDataChart {
  /** Clone Hero's chart checksum, lower hex, joinable to `charts.cloneHeroChecksum`. */
  checksum: string
  /**
   * Times this chart has been played, over its whole life, with no dates attached.
   *
   * This is a running total the game increments, not a set of events. It cannot be turned into a
   * timeline, and adding it to a count of observed plays would double count the ones Encore saw.
   */
  playCount: number
  rows: ScoreDataRow[]
}

/** A parsed `scoredata.bin`. */
export interface ScoreDataFile {
  version: number
  charts: ScoreDataChart[]
}

/** One chart's best score on one variant, from `scoresext.bin`. */
export interface ScoresExtRow {
  /** Pairs this row with the `scoredata.bin` row carrying the same value. */
  variant: number
  /** Inferred, and agreeing with `scoredata`'s flag in every row observed. */
  isFullCombo: boolean
  /** The score the game reports, matching `scorestats.json`'s `score` exactly. */
  score: number
  /** Zero in every row observed. Carried rather than dropped so a future value is not lost. */
  trailing: number
}

/** One chart's row in `scoresext.bin`. */
export interface ScoresExtChart {
  checksum: string
  rows: ScoresExtRow[]
}

/** A parsed `scoresext.bin`. */
export interface ScoresExtFile {
  version: number
  charts: ScoresExtChart[]
}

/** One chart's best score on one variant, with both files' numbers side by side. */
export interface ChartBestRow {
  /** Not decoded. See the module comment. */
  variant: number
  difficulty: number
  percent: number
  isFullCombo: boolean
  playbackSpeed: number
  stars: number
  /** The score the game reports, from `scoresext.bin`. Show this one. */
  score: number
  /** The same score less the clean play bonus, from `scoredata.bin`. */
  scoreWithoutCleanPlayBonus: number
}

/** Everything the two files say about one chart. */
export interface ChartBest {
  checksum: string
  /** A running total with no dates. Not a log, and not addable to observed plays. */
  playCount: number
  rows: ChartBestRow[]
  /**
   * Whether every row here is of the class that has been confirmed against a real play.
   *
   * False means at least one row's score is on a scale nothing has verified, and the chart's
   * "best" is a mix of two kinds of number. A caller that cannot explain what it would mean to
   * show such a row should not show it.
   */
  hasOnlyConfirmedVariants: boolean
}

/**
 * The name of a difficulty code, or null.
 *
 * Only 3 is confirmed: every one of the 15 plays cross checked against `scorestats.json` was
 * Expert and stored 3. The other three names come from the ordering and from the one public
 * parser found, and no play in the sample was recorded at any of them, so they are a reasonable
 * reading rather than a verified one. Returning null for anything outside 0 to 3 keeps a future
 * code from being rendered as a difficulty the game never meant.
 */
export function scoreDataDifficultyName(difficulty: number): string | null {
  switch (difficulty) {
    case 0:
      return 'Easy'
    case 1:
      return 'Medium'
    case 2:
      return 'Hard'
    case 3:
      return 'Expert'
    default:
      return null
  }
}

/** Lower hex for `length` bytes at `at`. Hand rolled to keep this working on a bare Uint8Array. */
function hex(bytes: Uint8Array, at: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += bytes[at + i].toString(16).padStart(2, '0')
  return out
}

/**
 * The version tag and record count, or null when the file cannot hold them or is another version.
 *
 * The count is NOT bounded here. It looked like it should be, since it is a u32 a corrupt file
 * could set to four billion, but the walk that follows refuses the moment a record runs past the
 * end, and that happens on the first record of a file too small to hold them. A bound here would
 * be a second check for the same thing, unreachable in any test, and the codebase's rule is that
 * an assertion that cannot fire proves nothing.
 */
function readHeader(
  bytes: Uint8Array,
  expectedVersion: number
): { version: number; count: number } | null {
  if (bytes.byteLength < HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(0, true)
  if (version !== expectedVersion) return null
  return { version, count: view.getUint32(4, true) }
}

/**
 * Parse `scoredata.bin`, or null.
 *
 * Takes bytes rather than a path for the same reason `parseScoreStats` takes text: a caller has
 * to handle a missing file anyway, and a parser that read its own file could not be tested
 * against a truncated one without writing one to disk.
 */
export function parseScoreData(bytes: Uint8Array): ScoreDataFile | null {
  const header = readHeader(bytes, SCORE_DATA_VERSION)
  if (header === null) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const charts: ScoreDataChart[] = []
  let at = HEADER_BYTES
  for (let i = 0; i < header.count; i += 1) {
    if (at + SCORE_DATA_CHART_BYTES > bytes.byteLength) return null
    const checksum = hex(bytes, at, 16)
    const rowCount = bytes[at + 16]
    // A 24 bit count, which is how it is written: the byte after it belongs to the first score
    // row, so reading a u32 here would fold that row's first field into the play count.
    const playCount = bytes[at + 17] | (bytes[at + 18] << 8) | (bytes[at + 19] << 16)
    at += SCORE_DATA_CHART_BYTES
    if (at + rowCount * SCORE_DATA_ROW_BYTES > bytes.byteLength) return null

    const rows: ScoreDataRow[] = []
    for (let row = 0; row < rowCount; row += 1) {
      rows.push({
        variant: view.getUint16(at, true),
        difficulty: bytes[at + 2],
        percent: bytes[at + 3],
        isFullCombo: bytes[at + 4] !== 0,
        playbackSpeed: view.getUint16(at + 5, true),
        stars: bytes[at + 7],
        variantFlag: view.getUint32(at + 8, true),
        score: view.getUint32(at + 12, true)
      })
      at += SCORE_DATA_ROW_BYTES
    }
    charts.push({ checksum, playCount, rows })
  }

  // Every byte has to be accounted for. Bytes left over mean the records were not the size this
  // reads them at, which means the fields inside them are not where this read them either, and a
  // file that decoded into plausible looking numbers by accident is the failure to avoid.
  if (at !== bytes.byteLength) return null
  return { version: header.version, charts }
}

/** Parse `scoresext.bin`, or null. Refuses on the same three grounds as `parseScoreData`. */
export function parseScoresExt(bytes: Uint8Array): ScoresExtFile | null {
  const header = readHeader(bytes, SCORES_EXT_VERSION)
  if (header === null) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const charts: ScoresExtChart[] = []
  let at = HEADER_BYTES
  for (let i = 0; i < header.count; i += 1) {
    if (at + SCORES_EXT_CHART_BYTES > bytes.byteLength) return null
    const checksum = hex(bytes, at, 16)
    const rowCount = bytes[at + 16]
    at += SCORES_EXT_CHART_BYTES
    if (at + rowCount * SCORES_EXT_ROW_BYTES > bytes.byteLength) return null

    const rows: ScoresExtRow[] = []
    for (let row = 0; row < rowCount; row += 1) {
      rows.push({
        variant: view.getUint16(at, true),
        isFullCombo: bytes[at + 2] !== 0,
        score: view.getUint32(at + 3, true),
        trailing: view.getUint32(at + 7, true)
      })
      at += SCORES_EXT_ROW_BYTES
    }
    charts.push({ checksum, rows })
  }

  if (at !== bytes.byteLength) return null
  return { version: header.version, charts }
}

/**
 * Join the two files into one row per chart, or null when they do not describe the same library.
 *
 * Joined by checksum and then by variant, not by position. The two files were written in the same
 * order in the sample, but nothing guarantees that, and a positional join that silently slipped
 * by one would attach every chart's reported score to its neighbour. A join that has to match on
 * two keys either lines up or refuses.
 *
 * Refuses when: either file repeats a checksum or a variant, the two files disagree about which
 * charts exist, or a chart's rows do not pair one to one. All of those mean the pair of files is
 * not the pair this understands, and half a join is not worth having.
 */
export function mergeScoreFiles(data: ScoreDataFile, ext: ScoresExtFile): ChartBest[] | null {
  const extByChecksum = new Map<string, ScoresExtChart>()
  for (const chart of ext.charts) {
    if (extByChecksum.has(chart.checksum)) return null
    extByChecksum.set(chart.checksum, chart)
  }
  if (extByChecksum.size !== data.charts.length) return null

  const seen = new Set<string>()
  const merged: ChartBest[] = []
  for (const chart of data.charts) {
    if (seen.has(chart.checksum)) return null
    seen.add(chart.checksum)
    const extChart = extByChecksum.get(chart.checksum)
    if (extChart === undefined) return null
    if (extChart.rows.length !== chart.rows.length) return null

    const extByVariant = new Map<number, ScoresExtRow>()
    for (const row of extChart.rows) {
      if (extByVariant.has(row.variant)) return null
      extByVariant.set(row.variant, row)
    }

    const rows: ChartBestRow[] = []
    for (const row of chart.rows) {
      const extRow = extByVariant.get(row.variant)
      if (extRow === undefined) return null
      rows.push({
        variant: row.variant,
        difficulty: row.difficulty,
        percent: row.percent,
        isFullCombo: row.isFullCombo,
        playbackSpeed: row.playbackSpeed,
        stars: row.stars,
        score: extRow.score,
        scoreWithoutCleanPlayBonus: row.score
      })
    }
    merged.push({
      checksum: chart.checksum,
      playCount: chart.playCount,
      rows,
      hasOnlyConfirmedVariants: rows.every((row) => row.variant === CONFIRMED_VARIANT)
    })
  }
  return merged
}
