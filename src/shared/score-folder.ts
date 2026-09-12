/**
 * Where Clone Hero's score files are, as a question the user can answer.
 *
 * Deliberately free of any zod import, for the reason `settings-defaults.ts` records: the
 * renderer needs `describeScoreFolder` to draw the Settings row, and importing it from
 * `play.ts` would put the whole zod runtime and every schema in the app into the renderer's
 * startup bundle. Measured at 154 kB of JS parsed on every launch, for one sentence.
 *
 * `ScoreFolderRequestSchema`, which does need zod, stays in `play.ts` and takes its type from
 * here, so there is still one definition of the shape.
 */

/** Whether the score folder was chosen by the user or probed. See `SettingsSchema.scoreFolder`. */
export type ScoreFolderSource = 'override' | 'probe'

/**
 * What one directory holds of Clone Hero's score files.
 *
 * The point of the shape is that a folder with nothing in it can be told apart from a folder
 * that does not exist, and both from a folder holding only the files Clone Hero has quarantined.
 * A setting that stored any of the three without saying which would be the failure this exists to
 * prevent: the user would have pointed Encore somewhere useless and been told nothing.
 *
 * `lookedFor` travels with the report rather than being a constant the renderer also knows,
 * because the message names it: it has to be what main actually looked for, not a second list
 * that can drift from it.
 */
export interface ScoreFolderReport {
  /** The directory inspected, or null when this platform has no known location and none was given. */
  folder: string | null
  /** False when there is no directory there at all, or it could not be listed. */
  exists: boolean
  /** The names Encore reads, exactly as Clone Hero writes them. */
  lookedFor: string[]
  /** Which of those are in the folder, by the name on disk. */
  found: string[]
  /**
   * Files matching Clone Hero's quarantine name, `scoredata_corrupted_<n>.bin` and its
   * `scoresext` twin. Reported so the message can explain them; never read. See
   * main/play/location.ts for why they are never a source.
   */
  quarantined: string[]
  /** True when at least one file Encore can read is there. The single "is this folder any use" test. */
  usable: boolean
}

/** Joins names for a sentence: "a", "a and b", "a, b and c". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * One sentence saying what Encore looked for in a folder and what it found.
 *
 * Lives here rather than in the component because it is the answer to a main-side read and both
 * sides need to agree on it: the renderer shows it, and the tests that pin the wording run
 * against this rather than against rendered markup.
 */
export function describeScoreFolder(report: ScoreFolderReport): string {
  if (report.folder === null) {
    return 'Encore has no known location for Clone Hero score files on this platform. Choose the folder yourself.'
  }
  if (!report.exists) return `There is no folder at ${report.folder}.`
  if (report.usable) return `Found ${nameList(report.found)} in ${report.folder}.`
  const looked = `Encore looked for ${nameList(report.lookedFor)}`
  if (report.quarantined.length > 0) {
    return `No score files in ${report.folder}. ${looked}, and found only ${nameList(report.quarantined)}, which is what Clone Hero renames a score file to when it cannot read it. Encore does not read those.`
  }
  return `No score files in ${report.folder}. ${looked}, and found none of them.`
}
