import { statfsSync } from 'node:fs'

/**
 * Free bytes on the filesystem holding `dir`, or undefined if it would not say.
 *
 * `bavail` rather than `bfree`: the second counts the root-only reserve as well, and clearing a
 * write on space Encore may not use would produce an ENOSPC after minutes of copying.
 *
 * A `statfs` that throws returns undefined rather than zero. It means the platform or filesystem
 * would not answer the question, which is not evidence of a full disk. Turning an unanswered
 * question into a blocked write would make Encore refuse to work somewhere it otherwise would.
 * Every caller therefore has to decide what "no answer" means, and all of them so far decide it
 * means "go ahead".
 *
 * Its own module because two unrelated things ask: `assertRepackSpace` (assets/sng-asset.ts),
 * which guards a `.sng` rebuild on the library volume, and `assertBackupSpace`
 * (issues/backup-store.ts), which guards the undo store on the userData volume. Those are
 * routinely different filesystems, and a shared helper is what stops a second, subtly different
 * transcription of the `bavail * bsize` rule appearing next to the second caller.
 */
export function volumeFreeBytes(dir: string): number | undefined {
  try {
    const { bavail, bsize } = statfsSync(dir)
    return bavail * bsize
  } catch {
    return undefined
  }
}
