/**
 * Human-readable names for the issue codes scan-chart reports.
 *
 * The raw codes (`noAudio`, `isDefaultBPM`, `missingValue`, …) are precise but meaningless
 * to anyone who hasn't read scan-chart's source, so the Issues view leads with these labels
 * and keeps the code as secondary, greppable detail.
 *
 * `label` names the problem; `meaning` says why the user should care, in terms of what
 * Clone Hero will do. Both are deliberately plainer than scan-chart's own `description`,
 * which stays visible because it carries the specifics (file names, instrument, difficulty).
 *
 * Coverage is pinned by the Record's key type: it is scan-chart's own FolderIssueType |
 * MetadataIssueType | ChartIssueType unions plus our synthetic 'scanFailed', so a library
 * upgrade that adds a code fails typecheck rather than silently showing a bare camelCase
 * string. humanizeCode() is the runtime backstop for anything that still slips through.
 */

import type { ChartIssueType, FolderIssueType, MetadataIssueType } from 'scan-chart'

export type IssueGroupId = 'missing' | 'chart' | 'damaged' | 'metadata' | 'other'

/**
 * `blocking`: Clone Hero cannot play this chart, or will show it wrong. Worth acting on.
 * `quality`: the chart plays fine; this is a note about how it was charted.
 *
 * The split exists because scan-chart is a charting linter, and on a real library its
 * craft-level checks outnumber the actionable ones by around a hundred to one. Showing both
 * in one undifferentiated list buries the handful of charts that are genuinely broken.
 */
export type IssueSeverity = 'blocking' | 'quality'

export interface IssueExplanation {
  label: string
  meaning: string
  group: IssueGroupId
  severity: IssueSeverity
}

/** Display order runs from "this chart will not play" down to cosmetic. */
export const ISSUE_GROUPS: { id: IssueGroupId; label: string; blurb: string }[] = [
  {
    id: 'missing',
    label: 'Missing files',
    blurb: 'Files Clone Hero needs that are not in the chart.'
  },
  {
    id: 'chart',
    label: 'Chart problems',
    blurb: 'Problems in the note chart itself that change how it plays.'
  },
  {
    id: 'damaged',
    label: 'Damaged or duplicate files',
    blurb: 'Files that are present but unreadable, the wrong size, or duplicated.'
  },
  {
    id: 'metadata',
    label: 'Metadata problems',
    blurb: 'Song details Clone Hero will reject or display incorrectly.'
  },
  { id: 'other', label: 'Other problems', blurb: 'Anything that does not fit the groups above.' }
]

type IssueCode = FolderIssueType | MetadataIssueType | ChartIssueType | 'scanFailed'

/**
 * The codes that are charting craft rather than breakage. Everything absent from this map is
 * treated as blocking, so a code added by a scan-chart upgrade shows up rather than hiding.
 * Partial<Record<IssueCode, …>> keeps the keys typo-checked without demanding exhaustiveness.
 */
const QUALITY_CODES: Partial<Record<IssueCode, true>> = {
  albumArtSize: true,
  // Both emission sites are "song.ini rates an instrument this chart doesn't have", a
  // Rock Band conversion artifact. Nothing is rejected and nothing displays wrong.
  extraValue: true,
  noExpert: true,
  difficultyNotReduced: true,
  isDefaultBPM: true,
  noSections: true,
  badEndEvent: true,
  smallLeadingSilence: true,
  noStarPower: true,
  emptyStarPower: true,
  emptySoloSection: true,
  noDrumActivationLanes: true,
  emptyFlexLane: true,
  difficultyForbiddenNote: true,
  invalidChord: true,
  brokenNote: true,
  badSustainGap: true,
  babySustain: true
}

/**
 * scan-chart reports one `missingValue` code for two unrelated things, and only the text
 * separates them. Both flavours are hardcoded templates, so this match is exact rather than
 * heuristic:
 *
 *   ini-scanner.ts:214  `Metadata is missing the "<prop>" property.`  where <prop> is name,
 *                        artist, album, genre, year or charter. Clone Hero really does display
 *                        these wrong.
 *   index.ts:49,63      `Metadata is missing a "diff_<instrument>" value.`  An unset difficulty
 *                        rating. Cosmetic; the chart plays and reads correctly.
 *
 * None of the six required properties begins with `diff_`, so the two cannot collide. When no
 * description is available the code stays blocking, the safer default of the two.
 */
const MISSING_DIFFICULTY_RATING = /missing a "diff_/

/**
 * What the `diff_` flavour means, replacing the generic wording for the one code whose two
 * flavours need two different sentences.
 *
 * It also says, in the row itself, why this is the only large group with no Fix button. That is
 * not a guess: the M14 fix work looked the value up on Chorus by exact chart hash for all 78 of
 * the reference library's `missingValue` rows, and every matched entry carried `-1`. That is the
 * same sentinel that raises the issue. An exact hash match means Chorus ingested this same upload, so
 * its entry was built from this chart's own song.ini and knows nothing it does not. The rating is
 * the charter's to set, and the row should say so rather than leave the user wondering.
 */
const MISSING_DIFFICULTY_MEANING =
  'No difficulty rating is set for this instrument, so Clone Hero shows it unrated. Only the ' +
  'person who charted it can say how hard it is, so Encore cannot fill it in.'

const EXPLANATIONS: Record<IssueCode, Omit<IssueExplanation, 'severity'>> = {
  // ── scan-chart FolderIssueType ────────────────────────────────────────────
  noMetadata: {
    label: 'No song.ini',
    meaning:
      'Without song.ini the chart has no title, artist or difficulty ratings, so Clone Hero lists it unnamed.',
    group: 'missing'
  },
  noAudio: {
    label: 'No audio',
    meaning: 'There is no audio file, so the chart plays in silence.',
    group: 'missing'
  },
  noChart: {
    label: 'No chart file',
    meaning: 'There is no notes.chart or notes.mid, so there is nothing to play.',
    group: 'missing'
  },
  noAlbumArt: {
    label: 'No album art',
    meaning: 'Clone Hero shows a blank cover for this chart.',
    group: 'missing'
  },
  invalidIni: {
    label: 'Misnamed .ini file',
    meaning: 'Clone Hero only reads a file called song.ini, so this one is ignored.',
    group: 'metadata'
  },
  invalidMetadata: {
    label: 'song.ini has no [Song] section',
    meaning: 'The file exists but is not laid out as Clone Hero expects, so none of it is read.',
    group: 'metadata'
  },
  badIniLine: {
    label: 'Unreadable line in song.ini',
    meaning: 'Clone Hero cannot read one line and skips it, so whatever that line set is missing.',
    group: 'metadata'
  },
  multipleIniFiles: {
    label: 'More than one .ini file',
    meaning: 'Several .ini files are present and Clone Hero may not use the one you expect.',
    group: 'metadata'
  },
  albumArtSize: {
    label: 'Album art is the wrong size',
    meaning: 'Clone Hero expects 512x512. Other sizes can look stretched or blurry.',
    group: 'damaged'
  },
  badAlbumArt: {
    label: 'Unreadable album art',
    meaning: 'The image is corrupt or in an unsupported format, so no cover is shown.',
    group: 'damaged'
  },
  multipleAlbumArt: {
    label: 'More than one album art file',
    meaning: 'Several cover images are present and the wrong one may be used.',
    group: 'damaged'
  },
  invalidAudio: {
    label: 'Unrecognized audio file name',
    meaning:
      'Clone Hero only loads known stem names such as song, guitar or drums, so this file never plays.',
    group: 'damaged'
  },
  badAudio: {
    label: 'Unreadable audio',
    meaning: 'The audio file is corrupt or in an unsupported format and will not play.',
    group: 'damaged'
  },
  multipleAudio: {
    label: 'Duplicate audio stems',
    meaning: 'The same stem appears more than once, so playback may use the wrong file.',
    group: 'damaged'
  },
  badVideo: {
    // scan-chart emits this for video.mp4/.avi/.mpeg: the file is fine, but the
    // container doesn't play on Linux and should be converted to .webm.
    label: "Video won't play on Linux",
    meaning:
      'The video is fine, but Clone Hero on Linux cannot play this format. Convert it to .webm.',
    group: 'other'
  },
  multipleVideo: {
    label: 'More than one video background',
    meaning: 'Several background videos are present and the wrong one may be used.',
    group: 'damaged'
  },
  invalidChart: {
    label: 'Misnamed chart file',
    meaning: 'Clone Hero only reads notes.chart or notes.mid, so this file is ignored.',
    group: 'chart'
  },
  badChart: {
    label: 'Unreadable chart file',
    meaning: 'The chart file is corrupt, so Clone Hero cannot load it.',
    group: 'chart'
  },
  multipleChart: {
    label: 'More than one chart file',
    meaning: 'Several .chart or .mid files are present and the wrong one may be loaded.',
    group: 'chart'
  },

  // ── scan-chart MetadataIssueType ──────────────────────────────────────────
  // Graded per-row by description. See MISSING_DIFFICULTY_RATING above.
  missingValue: {
    label: 'Missing value in song.ini',
    meaning:
      'A value Clone Hero expects, such as a difficulty rating, is not set, so it shows as blank or unknown.',
    group: 'metadata'
  },
  invalidValue: {
    label: 'Unreadable value in song.ini',
    meaning: 'A value is written in a form Clone Hero cannot read, so it falls back to a default.',
    group: 'metadata'
  },
  extraValue: {
    label: 'Rating for an instrument the chart does not have',
    meaning:
      'song.ini rates an instrument this chart has no track for. Usually left over from a Rock Band conversion; Clone Hero ignores it.',
    group: 'metadata'
  },

  // ── scan-chart ChartIssueType ─────────────────────────────────────────────
  noNotes: {
    label: 'No notes',
    meaning: 'The chart file loads but contains nothing to play.',
    group: 'chart'
  },
  misalignedTimeSignature: {
    label: 'Time signature off the measure line',
    meaning:
      'A time signature marker does not land at the start of a measure, so Clone Hero cannot read it correctly.',
    group: 'chart'
  },
  noExpert: {
    label: 'No Expert difficulty',
    meaning: 'Lower difficulties are charted for this instrument but Expert is missing.',
    group: 'chart'
  },
  difficultyNotReduced: {
    label: 'Difficulty is a copy of Expert',
    meaning: 'This lower difficulty has the same notes as Expert, so it is no easier.',
    group: 'chart'
  },
  isDefaultBPM: {
    label: 'Not tempo-mapped',
    meaning:
      'The chart stays at the default 120 BPM and 4/4 throughout, which usually means the tempo was never mapped. Harmless if the song really is a steady 120.',
    group: 'chart'
  },
  noSections: {
    label: 'No sections',
    meaning: 'The chart has no section markers, so practice mode has nothing to jump between.',
    group: 'chart'
  },
  badEndEvent: {
    label: 'Misplaced end event',
    meaning: 'The end marker sits somewhere most games will ignore.',
    group: 'chart'
  },
  smallLeadingSilence: {
    label: 'Notes start too early',
    meaning: 'A note lands less than two seconds in, leaving no time to get ready.',
    group: 'chart'
  },
  noStarPower: {
    label: 'No star power',
    meaning: 'This track has no star power phrases to activate.',
    group: 'chart'
  },
  emptyStarPower: {
    label: 'Empty star power phrase',
    meaning: 'A star power phrase covers no notes, so it can never be earned.',
    group: 'chart'
  },
  badStarPower: {
    label: 'Star power ignored',
    meaning: 'The multiplier_note setting in song.ini causes this star power to be skipped.',
    group: 'chart'
  },
  emptySoloSection: {
    label: 'Empty solo section',
    meaning: 'A solo is marked over a stretch that has no notes.',
    group: 'chart'
  },
  noDrumActivationLanes: {
    label: 'No drum activation lanes',
    meaning: 'This drums track has no activation lanes for star power.',
    group: 'chart'
  },
  emptyFlexLane: {
    label: 'Empty flex lane',
    meaning: 'A flex lane covers no notes.',
    group: 'chart'
  },
  difficultyForbiddenNote: {
    label: 'Note not allowed on this difficulty',
    meaning: 'A note type appears on a difficulty that is not supposed to have it.',
    group: 'chart'
  },
  invalidChord: {
    label: 'Discouraged chord shape',
    meaning: 'This chord shape is discouraged because it feels wrong to play.',
    group: 'chart'
  },
  brokenNote: {
    label: 'Notes almost on top of each other',
    meaning: 'Two notes sit close enough together that it was probably a charting mistake.',
    group: 'chart'
  },
  badSustainGap: {
    label: 'Note too close to the previous sustain',
    meaning: 'There is not enough gap after the previous sustain ends.',
    group: 'chart'
  },
  babySustain: {
    label: 'Sustain too short',
    meaning: 'The sustain is so short it will barely register.',
    group: 'chart'
  },

  // ── Encore's own synthetic code (issues.ts) ───────────────────────────────
  scanFailed: {
    label: 'Could not read this chart',
    meaning:
      'Encore could not open or read the chart. The file may be corrupt, locked, or not a chart at all.',
    group: 'other'
  }
}

/** `noAlbumArt` → `No album art`. Last resort so an unmapped code is never shown bare. */
export function humanizeCode(code: string): string {
  const spaced = code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Never returns null: an unknown code falls back to a humanized label under "Other problems".
 *
 * `description` is scan-chart's own text for this specific row. It is optional because most
 * callers only have a code, and it only affects `missingValue`, the one code whose severity
 * cannot be decided from the code alone.
 */
export function explainIssue(code: string, description?: string): IssueExplanation {
  const explanation = EXPLANATIONS[code] ?? {
    label: humanizeCode(code),
    meaning:
      "Encore has no description for this check yet. The details below are scan-chart's own.",
    group: 'other' as const
  }
  const cosmeticRating =
    code === 'missingValue' &&
    description !== undefined &&
    MISSING_DIFFICULTY_RATING.test(description)
  return {
    ...explanation,
    meaning: cosmeticRating ? MISSING_DIFFICULTY_MEANING : explanation.meaning,
    severity: QUALITY_CODES[code] || cosmeticRating ? 'quality' : 'blocking'
  }
}
