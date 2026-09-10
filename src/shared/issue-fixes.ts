/**
 * Which issue rows Encore can repair, and the sentence it shows before repairing one.
 *
 * This lives in `shared` because two processes need the same answer and must never disagree
 * about it. Main asks "is there an action for this row?" when the Fix button is pressed
 * (`resolveFixAction`, issues/fix.ts); the renderer asks the same question 24,151 times to decide
 * which rows get a button at all. If the renderer answered by testing the code against the list
 * `issues:fixable` returns, it would be wrong twice over:
 *
 * - `strayIniAction.code` is `'invalidIni'`, but the action also repairs `multipleIniFiles`. A
 *   membership test would leave those rows without a button even though the fix works on them.
 * - `extraValue` and `invalidIni` are only fixable when the row's description is one scan-chart
 *   actually wrote. The fix DELETES what it parses out of that text, so a row it cannot parse
 *   gets no action. A code-level test would offer a button that fails on click.
 *
 * So the row-level predicate and the confirmation text are defined once, here, and the four
 * action modules in `main/issues/actions` delegate to them. Everything in this file is pure and
 * reads nothing but the row, which is also why it is safe in the renderer: the parts that touch
 * the filesystem stay in main.
 *
 * `availability` (whether the tool an action needs is installed) is deliberately NOT here. That
 * is a question about the machine, not about the row, and only main can answer it
 * (`issues:fixable`).
 */

/**
 * A row, structurally. Not `ChartIssueRow`: that type lives in `main/catalog/issues`, and shared
 * code importing from main would invert the dependency. `ChartIssueRow` satisfies this.
 */
export interface IssueRowLike {
  kind: string
  code: string
  description: string
  /**
   * Never read: every function here answers from the three fields above. Declared anyway so a
   * caller can hand over a whole scan row written inline without TypeScript's excess-property
   * check rejecting it, and optional so nothing has to invent one.
   */
  chartPath?: string
}

/**
 * The code each action reports its availability under in `issues:fixable`.
 *
 * Note `invalidIni` covers `multipleIniFiles` rows too: one action, two codes. This is the
 * action's name, not the row's.
 */
export type FixActionCode = 'badVideo' | 'extraValue' | 'albumArtSize' | 'invalidIni'

export interface RowFix {
  actionCode: FixActionCode
  /**
   * What the fix does, verb-first, short enough for a summary line. Says what Encore will do
   * rather than what is wrong; the issue's own label already says that.
   */
  title: string
  /**
   * The exact user-facing sentence, naming the file that will be written or removed.
   *
   * Destructive actions name the file. "Clean up duplicates" is not an acceptable confirmation
   * for something that deletes from a user's library.
   */
  describe: string
}

/**
 * How long one video conversion takes, measured on the reference library: 34 s for a 200 s
 * 1280x720 source, 63.6 s for the smallest of the six real charts. Six charts is therefore
 * minutes, not seconds, and the user should be told that before pressing Fix rather than after.
 */
export const VIDEO_CONVERSION_SECONDS = { min: 35, max: 70 }

// ── badVideo ────────────────────────────────────────────────────────────────

/**
 * The same rule as scan-chart's `hasBadVideoName` (node_modules/scan-chart/dist/index.js:128),
 * for the three containers it actually complains about. `.ogv` and `.vp8` are recognised video names that
 * scan-chart does NOT flag, so they are not converted.
 *
 * **This is also what keeps `video.mp4.disabled` alone**, and that matters more than it looks.
 * Three of those exist in the reference library totalling 2,357.5 MiB, and the user turned them
 * off on purpose. Their extension is `disabled`, so this never matches. But the day someone
 * "tidies" this into `/^video\.(mp4|avi|mpeg)/` without the anchor, or lower-cases it, is the day
 * Encore spends an hour converting 2.3 GiB of video a user deliberately switched off. There is a
 * test that fails if that happens.
 *
 * Case-SENSITIVE, because scan-chart is: `getBasename(fileName) === "video"` and an extension
 * list membership test, neither of which lower-cases. A `Video.MP4` is not a background to
 * scan-chart, so it is not one here.
 */
export function isBadVideoName(fileName: string): boolean {
  const parts = fileName.split('.')
  if (parts.length < 2) return false
  const extension = parts[parts.length - 1]
  const base = parts.slice(0, -1).join('.')
  return base === 'video' && ['mp4', 'avi', 'mpeg'].includes(extension)
}

/**
 * The video named in the row's own description, or null.
 *
 * scan-chart writes `"video.mp4" will not work on Linux and should be converted to .webm.`, so
 * the row already carries the exact file it is about, which matters for a chart with more than
 * one bad video, where the two rows differ ONLY in that name. The extracted name is put back
 * through `isBadVideoName` rather than trusted: a description is a string that reaches us from a
 * dependency, and the only names this may act on are the ones scan-chart's own rule admits. When
 * the format changes this returns null, and the action falls back to reading the chart.
 */
export function videoNameFromRow(row: IssueRowLike): string | null {
  const quoted = /"([^"]+)"/.exec(row.description)
  if (!quoted) return null
  return isBadVideoName(quoted[1]) ? quoted[1] : null
}

// ── extraValue ──────────────────────────────────────────────────────────────

/**
 * scan-chart's two templates for this code, matched exactly rather than by hunting for a quoted
 * word.
 *
 *   index.js:2739  `Metadata contains "${diffKey}", but ${instrument} is not charted.`
 *   index.js:2756  `Metadata contains "diff_vocals", but vocals are not charted.`
 *
 * (The second is a separate literal in scan-chart's source only because "vocals are" needs the
 * plural verb.) A looser pattern (the first quoted token, say) would happily pull a key out of
 * any future `extraValue` text, and this fix DELETES what it is given. Anchoring both ends means
 * a changed message produces no fix rather than the wrong one.
 */
const EXTRA_VALUE_RE =
  /^Metadata contains "([A-Za-z0-9_]+)", but [A-Za-z0-9_]+ (?:is|are) not charted\.$/

/**
 * Every key `checkExtraDifficulty` can name, transcribed from index.js:2745-2760.
 *
 * The template match above already constrains the shape; this constrains the value. Together they
 * mean the key that reaches the filesystem is one of eleven literals from scan-chart's own source
 * rather than anything a description happened to contain.
 */
const EXTRA_VALUE_KEYS: readonly string[] = [
  'diff_guitar',
  'diff_guitar_coop',
  'diff_rhythm',
  'diff_bass',
  'diff_drums',
  'diff_keys',
  'diff_guitarghl',
  'diff_guitar_coop_ghl',
  'diff_rhythm_ghl',
  'diff_bassghl',
  'diff_vocals'
]

/** The key this row is about, or null when the description is not one scan-chart wrote. */
export function extraValueKey(row: IssueRowLike): string | null {
  const match = EXTRA_VALUE_RE.exec(row.description)
  if (!match) return null
  return EXTRA_VALUE_KEYS.includes(match[1]) ? match[1] : null
}

// ── invalidIni / multipleIniFiles ───────────────────────────────────────────

/** scan-chart's `invalidIni` template, anchored at both ends. This action DELETES what it parses. */
const INVALID_INI_RE = /^"(.+)" is not named "song\.ini"\.$/

/** The file an `invalidIni` row is about, or null when the description is not one scan-chart wrote. */
export function invalidIniName(row: IssueRowLike): string | null {
  const match = INVALID_INI_RE.exec(row.description)
  return match ? match[1] : null
}

// ── the mapping ─────────────────────────────────────────────────────────────

/**
 * The fix for this row, or null when Encore has none.
 *
 * Null is the answer for the overwhelming majority of a real library's rows. Of 24,151, the four
 * actions here cover a few hundred, and the rest are meant to render with no button and no hint
 * that one could exist. The Issues tab's worth is its honesty about what is wrong; it has to be
 * equally honest about what it can do.
 *
 * `kind` is checked as well as `code` throughout: scan-chart's three issue arrays are flattened
 * into one row type, and each of these codes can only come from one of them. A row claiming
 * otherwise did not come from a scan.
 */
export function fixForRow(row: IssueRowLike): RowFix | null {
  if (row.code === 'badVideo' && row.kind === 'folder') {
    const source = videoNameFromRow(row) ?? 'the background video'
    return {
      actionCode: 'badVideo',
      title: 'Convert the video to WebM',
      describe:
        `Convert ${source} to video.webm (VP8 video, Vorbis audio) and remove ${source}. ` +
        `The chart file and song.ini are not touched, so this cannot affect multiplayer.`
    }
  }

  if (row.code === 'extraValue' && row.kind === 'metadata') {
    const key = extraValueKey(row)
    // No key, no fix: this action deletes a line from the user's song.ini, and it will not guess
    // which one from wording it does not recognise.
    if (key === null) return null
    return {
      actionCode: 'extraValue',
      title: 'Remove ratings for instruments the chart does not have',
      describe:
        `Remove the "${key}" difficulty rating from this chart's song.ini. ` +
        `The chart file is not touched and this value is not one Clone Hero matches charts by, ` +
        `so it cannot affect multiplayer.`
    }
  }

  if (row.code === 'albumArtSize' && row.kind === 'folder') {
    return {
      actionCode: 'albumArtSize',
      title: 'Resize the album art to 512x512',
      describe:
        "Re-encode this chart's album art to 512x512, cropping to a square from the center if it " +
        'is not one already. The file keeps its name and format. The chart file and song.ini are ' +
        'not touched, so this cannot affect multiplayer.'
    }
  }

  if (row.kind === 'folder' && (row.code === 'invalidIni' || row.code === 'multipleIniFiles')) {
    // `multipleIniFiles` names no file, so it removes every `.ini` that is not the one scan-chart
    // reads; `invalidIni` names one and removes only that. An `invalidIni` whose wording is not
    // scan-chart's gets no fix, for the same reason `extraValue` does not.
    const named = row.code === 'invalidIni' ? invalidIniName(row) : null
    if (row.code === 'invalidIni' && named === null) return null
    return {
      actionCode: 'invalidIni',
      title: 'Remove the .ini files Clone Hero ignores',
      describe:
        `${named ? `Delete ${named}` : 'Delete every .ini file except the one Clone Hero reads'} ` +
        `from this chart. Clone Hero only reads song.ini, so this file does nothing. ` +
        `The file the chart's metadata comes from is kept.`
    }
  }

  return null
}

/**
 * The confirmation sentence for a row a given action handles.
 *
 * Exists so the four action modules in main can delegate their `describe` here without each
 * having to decide what to say about a row they were never given. It throws rather than
 * returning a placeholder because the only way to reach that state is a caller that skipped
 * `appliesTo`, and a fix framework that showed generic wording for an unrecognised row would be
 * confirming a deletion it could not describe.
 */
export function fixSentence(row: IssueRowLike, actionCode: FixActionCode): string {
  const fix = fixForRow(row)
  if (fix === null || fix.actionCode !== actionCode) {
    throw new Error(
      `The ${actionCode} fix was asked to describe a row it does not handle ` +
        `(${row.kind}/${row.code}): ${JSON.stringify(row.description)}`
    )
  }
  return fix.describe
}
