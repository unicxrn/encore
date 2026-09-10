import { copyFileSync, mkdirSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ENCORE_TMP_DIR } from '../../shared/constants'
import { volumeFreeBytes } from '../assets/free-space'
import { assertUnderLibrary } from '../assets/library-guard'
import { putPlanEntrySource, type RepackPlan } from '../downloads/sng-repack'
import { rewriteSngPlan } from '../assets/sng-asset'
import { removeChartFiles, withChartLock, writeChartAssetFromFile } from '../assets/write'
import { chartTypeAt, scanChartIssues, type ChartIssueRow } from '../catalog/issues'
import {
  backupBlobPath,
  deleteBackup,
  hashFile,
  readBackup,
  stampChart,
  type BackupGuard,
  type FixBackup
} from './backup-store'
import { hasIniExtension, iniFileScanChartReads, readChartIniFiles } from './chart-ini'

/**
 * Putting back what a repair replaced.
 *
 * ## A restore is a chart write, and is held to every rule one is
 *
 * There is deliberately no second write path here. The bytes go back through `writeChartFile`'s own
 * machinery: `withChartLock`, `writeChartAssetFromFile` for a folder chart, and `rewriteSngPlan`
 * (and so `repackSng` + `verifyRepack` + the atomic rename) for a `.sng`. The result is re-scanned
 * and refused unless the chart's `chartHash` is one of exactly two values. Not one: `applyFix` may
 * only leave the hash alone, but an undo of a repair that DID move it has to be allowed to move it
 * back, and that is the case the undo matters most for. `assertRestoreHash` spells out both. An
 * undo that could break multiplayer would be a worse bug than the irreversibility it exists to
 * remove.
 *
 * ## Refusing is the safe answer
 *
 * The interesting case is not "the backup is missing". It is "the chart changed since the repair":
 * the user converted a video, then downloaded a better one, then pressed Undo. Writing the
 * original back over that is a second irreversible loss caused by the feature meant to prevent the
 * first. So the manifest records what the repair LEFT BEHIND (`BackupGuard`) and this refuses
 * unless it is still there, unchanged. Three separate things are checked before a byte is written:
 *
 * 1. The chart is still the shape it was, and still inside a library folder.
 * 2. Every file the repair wrote is still exactly as the repair left it, and every file it removed
 *    is still absent, so nothing is silently overwritten and nothing is silently deleted. For a
 *    `.sng` that is the whole archive when nothing has touched it, and the specific entries and
 *    header keys this undo would write when something has; `BackupGuard` says why both are needed
 *    and what the second does not prove.
 * 3. Restoring will not change which `.ini` file scan-chart reads the chart's metadata from.
 *    Putting a stray `desktop.ini` back into a chart whose `song.ini` has since been deleted would
 *    hand the chart a different `hopo_frequency` and a different multiplayer identity. The
 *    post-write hash assertion catches that too, but only after the file is on disk; this is what
 *    keeps it from getting there.
 *
 * ## What "byte-identical" means here, precisely
 *
 * The FILE that comes back is byte-identical to the one the repair replaced, and that is proven at
 * runtime rather than assumed: the backup records the original's sha256, and the restore hashes
 * what it is about to install and refuses on a mismatch. For a `.sng` the ARCHIVE is not
 * byte-identical to the one before the repair: the restored entry is appended rather than put
 * back at its old offset, and the header lengths move with it. Nothing reads a `.sng` by absolute
 * layout (see `assertEntriesFillArchive`), the entry's own bytes are identical, and the hash Clone
 * Hero matches by is asserted afterwards, so the chart is the same chart. It is not the same file,
 * and this comment exists so nobody later reads the tests' byte-for-byte assertions as promising
 * that it is.
 */

/** Where a restore reports it has got to, on the same shape as a fix's progress. */
export interface RestoreProgress {
  phase: string
  percent: number | null
}

export interface RestoreContext {
  /** The backup store root; see `beginBackup`. */
  storeDir: string
  /** The write guard's allow-list, as everywhere else that writes to a chart. */
  libraryFolders: { path: string }[]
  onProgress?: (progress: RestoreProgress) => void
}

export interface RestoreResult {
  backup: FixBackup
  /** The chart's fresh issue rows, so the Issues tab can update without a full re-scan. */
  rows: ChartIssueRow[]
}

/** Distinguishes concurrent restores staging into one chart folder; see `stagingDirFor`. */
let stagingCounter = 0

/**
 * Where a restored file is staged before it is moved into a folder chart.
 *
 * Inside the chart's own `.encore-tmp`, for the reason `writeChartAssetFromFile` states: the move
 * that installs the file is a rename, so the source has to be on the library volume. A blob lives
 * in `userData`, which is routinely a different filesystem, so copying straight from there would
 * fail with EXDEV on exactly the machines this feature is for.
 *
 * `ENCORE_TMP_DIR` is skipped by the scanner and, being a directory, is invisible to both chart
 * readers. Removed on every exit path.
 */
function stagingDirFor(chartPath: string): string {
  return join(chartPath, ENCORE_TMP_DIR, `restore-${process.pid}-${stagingCounter++}`)
}

/**
 * Refuse a name that is anything but a single file name.
 *
 * The writers this delegates to check the same thing, but they check it after this module has
 * already used the name to build a staging path. A manifest is a file in `userData` that this
 * process wrote; it is also a file a user can edit, and a `../` in it must not become a path
 * before anything looks at it.
 */
function assertBareFileName(fileName: string): void {
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName !== basename(fileName)
  ) {
    throw new Error(`This undo names a file Encore will not touch: ${JSON.stringify(fileName)}`)
  }
}

/**
 * Prove the chart is still exactly as the repair left it.
 *
 * Named rather than folded into the restore because the message is the feature: a user who is told
 * "the chart changed since this repair" can go and look, while a user whose chart is quietly
 * overwritten cannot.
 */
export async function assertChartUnchanged(chartPath: string, guard: BackupGuard): Promise<void> {
  const now = await stampChart(
    chartPath,
    guard.chartType,
    guard.chartType === 'folder'
      ? guard.files.map((file) => file.fileName)
      : guard.entries.map((entry) => entry.fileName),
    guard.chartType === 'sng' ? guard.metadata.map((entry) => entry.key) : []
  )
  if (now.chartType !== guard.chartType) {
    // Unreachable: `stampChart` was asked for the guard's own type. Stated so a future change to
    // that function cannot silently turn a mismatch into a comparison of two different shapes.
    throw new Error(`${chartPath} could not be checked against this fix.`)
  }

  if (guard.chartType === 'sng' && now.chartType === 'sng') {
    // The strong check, and the usual one: every writer in this app replaces a `.sng` wholesale,
    // so an archive that has not moved proves nothing inside it has either.
    if (now.archive.size === guard.archive.size && now.archive.mtimeMs === guard.archive.mtimeMs) {
      return
    }
    // It has moved. That is ORDINARY, since a second repair on the same chart repacks it, so the
    // question becomes narrower: are the parts this undo is about to touch still as the repair
    // left them? See `BackupGuard` for what this check does and does not prove.
    const lengths = new Map(now.entries.map((entry) => [entry.fileName, entry.byteLength]))
    for (const { fileName, byteLength } of guard.entries) {
      const found = lengths.get(fileName) ?? null
      if (found === byteLength) continue
      throw new Error(
        byteLength === null
          ? `${chartPath} has gained a ${fileName} since this fix, so Encore will not undo it. ` +
              `Restoring the original would overwrite the one that is there now.`
          : `${fileName} in ${chartPath} has been rewritten since this fix, so Encore will not ` +
              `undo it. Putting the original back would discard whatever changed it.`
      )
    }
    const values = new Map(now.metadata.map((entry) => [entry.key, entry.value]))
    for (const { key, value } of guard.metadata) {
      if ((values.get(key) ?? null) === value) continue
      throw new Error(
        `The "${key}" value in ${chartPath} has been changed since this fix, so Encore will ` +
          `not undo it. Putting the original back would discard whatever changed it.`
      )
    }
    return
  }

  const current = new Map(
    (now.chartType === 'folder' ? now.files : []).map((file) => [file.fileName, file.stamp])
  )
  for (const { fileName, stamp } of guard.chartType === 'folder' ? guard.files : []) {
    const found = current.get(fileName) ?? null
    if (stamp === null && found !== null) {
      throw new Error(
        `${chartPath} has gained a ${fileName} since this fix, so Encore will not undo it. ` +
          `Restoring the original would overwrite the one that is there now.`
      )
    }
    if (stamp !== null && found === null) {
      throw new Error(
        `${chartPath} no longer has the ${fileName} this fix produced, so Encore will not ` +
          `undo it. The chart has changed since.`
      )
    }
    if (stamp !== null && found !== null) {
      if (found.size !== stamp.size || found.mtimeMs !== stamp.mtimeMs) {
        throw new Error(
          `${fileName} in ${chartPath} has been rewritten since this fix, so Encore will not ` +
            `undo it. Putting the original back would discard whatever changed it.`
        )
      }
    }
  }
}

/**
 * Refuse a restore that would change which `.ini` scan-chart reads this chart's metadata from.
 *
 * That file supplies the seven keys `getChartHash` mixes into a chart's identity, so a restore
 * that moved it would move the chart's multiplayer identity. The only repair that can set this up
 * is the stray-`.ini` one, and only on a chart whose surviving `song.ini` has since been deleted
 * by something else, at which point putting `desktop.ini` back makes it the file scan-chart
 * reads.
 *
 * Restored names are appended to the end of the reader's own order, which is the worst case for
 * `iniFileScanChartReads`' "the last one wins" rule and therefore the conservative direction: a
 * restore this clears cannot change the answer whatever order the filesystem actually hands back.
 */
async function assertIniReaderUnchanged(
  chartPath: string,
  chartType: 'folder' | 'sng',
  backup: FixBackup
): Promise<void> {
  const touched = [...backup.files.map((file) => file.fileName), ...backup.remove]
  if (!touched.some(hasIniExtension)) return

  const { names, reads } = await readChartIniFiles(chartPath, chartType)
  const after = names.filter((name) => !backup.remove.includes(name))
  for (const file of backup.files) {
    if (hasIniExtension(file.fileName) && !after.includes(file.fileName)) after.push(file.fileName)
  }
  const next = iniFileScanChartReads(after)
  if (next !== reads) {
    throw new Error(
      `Undoing this would make Clone Hero read ${chartPath}'s metadata from ` +
        `${next ?? 'no file at all'} instead of ${reads ?? 'no file at all'}, which would change ` +
        `what this chart matches by in multiplayer. The chart has not been changed.`
    )
  }
}

/**
 * Refuse a restore the chart's own volume cannot hold.
 *
 * Folder charts only: a `.sng` restore goes through `rewriteSngPlan`, which runs
 * `assertRepackSpace` over the archive plus the incoming entry. That is the tighter of the two
 * checks, since a rebuild needs the whole archive again. Here the cost is one staged copy of each
 * restored file, which is what this counts.
 *
 * Advisory, exactly as `assertRepackSpace` is: the figure is stale the moment it is read, and a
 * filesystem that will not answer is not evidence of a full disk. Running out anyway is survivable
 * and leaves nothing half-done: every copy happens before any file is installed (see
 * `restoreIntoFolder`), so a full disk throws with the chart untouched and the backup unspent, and
 * the undo can simply be run again once there is room.
 */
function assertStagingSpace(chartPath: string, incomingBytes: number): void {
  const free = volumeFreeBytes(chartPath)
  if (free === undefined || free >= incomingBytes) return
  throw new Error(
    `Not enough free space to restore into ${chartPath}: it needs about ${incomingBytes} bytes ` +
      `and ${free} bytes are free.`
  )
}

/**
 * Put one backup's content back, and prove the chart still matches what it matched before.
 *
 * The order is the design, and mirrors `applyFix`'s:
 *
 * 1. Validate the manifest and the paths it names, before anything is opened.
 * 2. Take the chart's write lock, so a batch asset write cannot land between the checks and the
 *    write, or between the write and the hash comparison.
 * 3. Check the guard, the ini reader and the chart hash's starting value INSIDE the lock, for the
 *    same reason `applyFix` reads its hash there: a check against a chart another writer has
 *    already changed blames this restore for their edit.
 * 4. Write, through the ordinary chart writers.
 * 5. Re-scan and refuse unless the chart's identity is one of the two `assertRestoreHash`
 *    accepts: unchanged, or back to what it was before the repair.
 *
 * On success the backup is deleted: the chart is back to where it started, so the bytes have done
 * their job, and the guard they carry no longer describes the chart anyway.
 */
export async function restoreBackup(ctx: RestoreContext, id: string): Promise<RestoreResult> {
  const backup = readBackup(ctx.storeDir, id)
  if (backup === null) {
    throw new Error(`Encore has no undo with the id ${JSON.stringify(id)}.`)
  }
  for (const file of backup.files) assertBareFileName(file.fileName)
  for (const name of backup.remove) assertBareFileName(name)

  const chartPath = backup.chartPath
  // Before the chart is opened: a chart outside the configured library folders is one Encore must
  // not write to whatever its manifest says. The writers below check this again.
  assertUnderLibrary(chartPath, ctx.libraryFolders)

  // Throws when the path is gone, which is what a caller about to write to it needs to hear.
  const chartType = chartTypeAt(chartPath)
  if (chartType !== backup.chartType) {
    throw new Error(
      `${chartPath} is now a ${chartType === 'sng' ? '.sng archive' : 'folder'} but this fix ` +
        `was made to a ${backup.chartType === 'sng' ? '.sng archive' : 'folder'}. Encore will not ` +
        `undo it. This is not the same chart.`
    )
  }
  if (chartType === 'folder' && backup.metadata.length > 0) {
    // Header metadata is a `.sng` concept; a folder chart's values live in `song.ini`, which is
    // restored as a file. A manifest claiming otherwise did not come from these actions.
    throw new Error(`This undo carries .sng header metadata for a folder chart at ${chartPath}.`)
  }

  const blobs = backup.files.map((file) => {
    const path = backupBlobPath(ctx.storeDir, backup.id, file.blob)
    if (path === null) throw new Error(`This undo names a blob Encore did not write: ${file.blob}`)
    const size = statSync(path, { throwIfNoEntry: false })?.size
    if (size !== file.byteLength) {
      throw new Error(
        `Encore's copy of ${file.fileName} is ${size ?? 'missing'} bytes, not the ` +
          `${file.byteLength} it recorded. The chart has not been changed.`
      )
    }
    return { file, path }
  })

  const rows = await withChartLock(chartPath, async () => {
    ctx.onProgress?.({ phase: 'checking the chart', percent: null })
    await assertChartUnchanged(chartPath, backup.guard)
    await assertIniReaderUnchanged(chartPath, chartType, backup)

    const before = await scanChartIssues(chartPath, chartType)
    ctx.onProgress?.({ phase: 'restoring', percent: null })
    if (chartType === 'sng') await restoreIntoSng(chartPath, backup, blobs, ctx)
    else await restoreIntoFolder(chartPath, backup, blobs, ctx)

    const after = await scanChartIssues(chartPath, chartType)
    assertRestoreHash(chartPath, before.chartHash, after.chartHash, backup.chartHash)
    return after.rows
  })

  try {
    deleteBackup(ctx.storeDir, backup.id)
  } catch (err) {
    // Reclaiming the disk is not what the caller asked for, and reporting a failed undo over one
    // that has already succeeded would be the worse of the two lies, because the user would try
    // again on a chart that is already back. The entry that survives is inert: its guard describes
    // the repaired chart, which no longer exists, so a second attempt refuses rather than writing.
    console.warn(`Could not delete the spent backup ${backup.id}:`, err)
  }
  return { backup, rows }
}

/**
 * Rebuild a `.sng` around the restored entries, in one pass.
 *
 * One `rewriteSngPlan` rather than one per file: the archive is only ever swapped for a complete
 * one, so there is no moment where the chart has lost the repair's output and not yet regained the
 * original. `verifyRepack` then compares the rebuilt archive against this plan entry by entry,
 * reading each blob back and checking it against what landed in the archive, before the rename
 * makes it the chart.
 *
 * The blobs are hashed first. `verifyRepack` proves the archive holds what the PLAN named; only
 * the hash proves the plan names the original bytes rather than a blob that rotted in `userData`.
 */
async function restoreIntoSng(
  chartPath: string,
  backup: FixBackup,
  blobs: { file: FixBackup['files'][number]; path: string }[],
  ctx: RestoreContext
): Promise<void> {
  for (const { file, path } of blobs) await assertBlobIntact(file, path)

  const incomingBytes = blobs.reduce((total, blob) => total + blob.file.byteLength, 0)
  await rewriteSngPlan(
    chartPath,
    (plan) => {
      for (const name of backup.remove) {
        if (!plan.entries.some((entry) => entry.fileName === name)) {
          throw new Error(
            `${chartPath} no longer contains ${name}, so it is not the archive this fix ` +
              `produced. The chart has not been changed.`
          )
        }
      }
      // A fresh object, never a mutation: the plan handed in describes the archive still on disk
      // and is what a failed rebuild leaves behind.
      let next: RepackPlan = {
        ...plan,
        entries: plan.entries.filter((entry) => !backup.remove.includes(entry.fileName)),
        metadata: restoredMetadata(plan.metadata, backup.metadata)
      }
      for (const { file, path } of blobs) {
        // A path rather than bytes: a restored `video.mp4` runs to 159 MB in this library, and
        // both the rebuild and its verification stream it a chunk at a time.
        next = putPlanEntrySource(next, file.fileName, {
          kind: 'file',
          path,
          byteLength: file.byteLength
        })
      }
      return next
    },
    ctx.libraryFolders,
    { incomingBytes }
  )
}

/** Header metadata with the backup's keys put back, or deleted again where the value is null. */
function restoredMetadata(
  current: Record<string, string>,
  changes: FixBackup['metadata']
): Record<string, string> {
  const metadata = { ...current }
  for (const { key, value } of changes) {
    if (value === null) delete metadata[key]
    else metadata[key] = value
  }
  return metadata
}

/**
 * Put the files back into a folder chart, then remove what the repair created.
 *
 * Every file is staged and verified BEFORE any of them is installed, and that ordering is the
 * point. A folder chart has no equivalent of the `.sng` path's build-then-rename, so the closest it
 * can get to all-or-nothing is to do everything fallible first: the copies, and the hash that
 * proves each copy is the original. By the time the second loop runs, all that is left is renames
 * within one directory of files that are already there. That is where a `multipleIniFiles` undo
 * restoring two files stops being able to install one, fail on the other, and leave the chart
 * halfway between two states its guard no longer describes.
 *
 * Staging lives inside the chart's own `.encore-tmp` so the install is a rename rather than a copy,
 * which makes it atomic per file and keeps a 159 MB video out of memory. Hashing the STAGED copy
 * rather than the blob is one pass that proves two things: that the stored blob is intact, and that
 * the copy of it is faithful. Together they are the byte-identical claim this feature makes.
 *
 * Writes come before removals, on the same rule `writeChartAsset` follows for stale siblings: the
 * original being back on disk is what makes the repair's output redundant. A failure between the
 * two leaves the chart holding both, which is untidy and reversible; the other order would leave
 * it holding neither.
 */
async function restoreIntoFolder(
  chartPath: string,
  backup: FixBackup,
  blobs: { file: FixBackup['files'][number]; path: string }[],
  ctx: RestoreContext
): Promise<void> {
  const incomingBytes = blobs.reduce((total, blob) => total + blob.file.byteLength, 0)
  assertStagingSpace(chartPath, incomingBytes)

  const staging = stagingDirFor(chartPath)
  mkdirSync(staging, { recursive: true })
  try {
    const staged: { fileName: string; path: string }[] = []
    for (const { file, path } of blobs) {
      const stagedPath = join(staging, file.fileName)
      copyFileSync(path, stagedPath)
      await assertBlobIntact(file, stagedPath)
      staged.push({ fileName: file.fileName, path: stagedPath })
    }
    for (const file of staged) {
      writeChartAssetFromFile(chartPath, file.fileName, file.path, ctx.libraryFolders)
    }
    if (backup.remove.length > 0) removeChartFiles(chartPath, backup.remove, ctx.libraryFolders)
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
      // And the `.encore-tmp` we may have created, but only when nothing else is using it: rmdir
      // is not recursive, so a directory still holding the download queue's `.part` files fails
      // with ENOTEMPTY and is left exactly as it was.
      rmdirSync(dirname(staging))
    } catch (err) {
      // Not ours to clean, already gone, or a directory Encore may not remove. None of those is
      // worth failing a restore that has succeeded: rethrowing from here would tell the user the
      // undo failed on a chart that is already back, and would leave a backup they can no longer
      // spend. `rmSync` is inside the guard for that reason and not only `rmdirSync`: a staging
      // copy that survives is disk to reclaim rather than damage.
      console.warn(`Could not clean up after restoring ${chartPath}:`, err)
    }
  }
}

/**
 * The multiplayer-hash invariant, in the form a restore has to satisfy.
 *
 * A restore is a chart write, so it is subject to the same rule every other chart write in this app
 * is: it must not change what Clone Hero matches the chart by (`assertChartHashUnchanged`, and the
 * long note at the top of issues/fix.ts). Almost always that means "the hash did not move", because
 * none of the four repairs touches hashed content and neither does putting their originals back.
 *
 * The exception is the reason this exists rather than a direct call to `assertChartHashUnchanged`.
 * A repair that DID move the hash is caught by `applyFix` and reported, and the backup is
 * committed before that check precisely so the user can undo it. For that chart, "the hash did not
 * move" is the wrong test: the restore's whole job is to move it back. So two outcomes are
 * correct, and they are the only two:
 *
 * - the hash is what it was a moment ago (the restore changed nothing Clone Hero reads), or
 * - the hash is what it was before the repair (the restore undid a repair that had changed it).
 *
 * Anything else is a bug in this module, and fails loudly naming all three values. The chart is
 * left as the restore made it rather than rolled back, on `applyFix`'s reasoning: a second
 * automatic recovery attempt only ever runs in a situation we have already established we do not
 * understand.
 */
export function assertRestoreHash(
  chartPath: string,
  before: string | null,
  after: string | null,
  backedUp: string | null
): void {
  if (after === before || after === backedUp) return
  throw new Error(
    `Undo aborted: restoring changed the chart hash of ${chartPath} to something it has never ` +
      `had (it was ${before ?? 'none'} a moment ago and ${backedUp ?? 'none'} before the fix, ` +
      `and is now ${after ?? 'none'}). The chart has NOT been put back. This is a bug in Encore, ` +
      `not something you did.`
  )
}

/** Refuse content whose bytes are not the ones the backup recorded, naming the file. */
async function assertBlobIntact(file: FixBackup['files'][number], path: string): Promise<void> {
  const sha256 = await hashFile(path)
  if (sha256 === file.sha256) return
  throw new Error(
    `Encore's copy of ${file.fileName} is not the file it backed up (expected sha256 ` +
      `${file.sha256}, got ${sha256}). The chart has not been changed.`
  )
}
