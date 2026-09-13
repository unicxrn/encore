/**
 * Removing a chart, which is the only thing Encore does that takes something away.
 *
 * The recovery path is the operating system's Trash and nothing else: Encore keeps no copy of
 * its own, there is no undo here of the kind the issue fixes have, and there is deliberately no
 * permanent delete anywhere behind this. A chart that cannot be trashed is left alone and the
 * failure is reported, because the alternative that would "work" is the one nobody can undo.
 *
 * The wording lives here rather than in the two views that offer the action, so the Installed
 * list and the duplicate report cannot end up promising different things about the same call.
 */

/**
 * What happened to the chart.
 *
 * `already-gone` is a success, not a failure. The chart was not on disk when the removal ran
 * (moved by hand, on a drive that is no longer mounted the same way, removed by a file manager
 * since the last scan), so there was nothing to trash and the catalog row was the only thing
 * left to remove. Reporting it as an error would ask the user to act on something they cannot
 * act on, and leaving the row would keep a chart in Clone Hero's list that is not there.
 */
export type ChartRemovalOutcome = 'trashed' | 'already-gone'

export interface ChartRemoval {
  path: string
  outcome: ChartRemovalOutcome
}

/**
 * The sentence every confirmation makes about where the chart goes.
 *
 * Said in full in both places, rather than abbreviated in the list and spelled out in the
 * report: a user who has only ever seen one of the two screens has still been told the whole of
 * what happens.
 */
export const TRASH_PROMISE =
  'It goes to your system Trash, so you can put it back from there. Encore never deletes a ' +
  'chart permanently.'

/**
 * Said alongside it, because "remove this chart" reads like it takes the scores with it.
 *
 * Plays are keyed on the chart's Clone Hero checksum, not on its path (see the `plays` table in
 * catalog/db.ts), and the Stats page goes on naming charts the library no longer holds. Nothing
 * in a removal touches that record.
 */
export const PLAY_HISTORY_PROMISE =
  'Your play history is kept. Plays are recorded against the chart itself, not its folder.'

/** What to say once it is done, in the words each outcome earns. */
export function removalMessage(outcome: ChartRemovalOutcome, label: string): string {
  return outcome === 'trashed'
    ? `Moved ${label} to the Trash.`
    : `${label} was no longer on disk, so only its catalog entry was removed.`
}
