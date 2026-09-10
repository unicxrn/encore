/**
 * Decide whether a file a chart already holds is made redundant by one about to be written.
 *
 * Some assets exist under several names that mean the same thing: `album.png`, `album.jpg` and
 * `album.jpeg` are all "the cover". Writing one of them replaces the file with that exact name
 * and nothing else, so a chart that had `album.jpg` and gains `album.png` ends up with both, and
 * scan-chart reports `multipleAlbumArt`. `pattern` says which names are interchangeable; every
 * matching name other than the one being written is stale.
 *
 * Shared by the folder writer and the .sng repacker so a chart's shape cannot change which files
 * survive a replacement.
 *
 * **Why the exclusion is case-insensitive.** On Windows, and on a default macOS volume,
 * `Album.PNG` and `album.png` are one file. If `album.png` had just been written and this
 * returned true for `Album.PNG`, the caller would unlink the cover it created moments earlier and
 * leave the chart with none, a worse outcome than the duplicate being fixed. Comparing
 * case-insensitively costs a case-variant of the incoming name surviving on Linux, where the two
 * really are separate files; that leaves one duplicate this cannot clear, but never leaves the
 * user without a cover.
 * A variant of a DIFFERENT name (`Album.jpg` while writing `album.png`) is still stale and still
 * removed: on Windows it would have to be, because unlinking the exact name `album.jpg` resolves
 * to that file, and matching case-insensitively is what makes Linux agree.
 *
 * `.sng` entry names are literal strings with no filesystem case-folding behind them, so the
 * repacker could safely be stricter and drop every variant. It uses this rule anyway: a second
 * rule would mean the set of files that survive depends on whether a chart is a folder or an
 * archive, and the archive case is not visible enough to the user to earn that.
 *
 * `pattern` must not carry the `g` flag: `RegExp.test` advances `lastIndex` on a global regex, so
 * a shared one would match only every other name it is asked about.
 */
export function isStaleSibling(name: string, written: string, pattern: RegExp): boolean {
  if (name.toLowerCase() === written.toLowerCase()) return false
  return pattern.test(name)
}

/** The half of an asset write's options that says what the incoming file supersedes. */
export interface StaleSiblingOptions {
  /**
   * Which names the incoming asset replaces, per `isStaleSibling`. Callers writing an asset with
   * exactly one possible name (`background.png`, `notes.chart`) leave it unset, and nothing is
   * removed.
   */
  removeMatching?: RegExp
}
