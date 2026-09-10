import { lstatSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assertUnderLibrary, canonicalize } from './library-guard'
import { writeSngAsset } from './sng-asset'
import { isStaleSibling, type StaleSiblingOptions } from './stale-siblings'

/**
 * Atomically write an asset file into a chart folder. `fileName` must be a
 * bare name (no separators, no `..`) so callers cannot smuggle path segments
 * past the chartDir guard.
 */
export function writeChartAsset(
  chartDir: string,
  fileName: string,
  data: Uint8Array,
  libraryFolders: { path: string }[],
  options: StaleSiblingOptions = {}
): string {
  assertUnderLibrary(chartDir, libraryFolders)
  assertBareFileName(fileName)
  const finalPath = join(chartDir, fileName)
  // tmp lives inside chartDir: same directory, so the rename is atomic.
  const tmpPath = join(chartDir, `.${fileName}.tmp`)
  try {
    writeFileSync(tmpPath, data)
    renameSync(tmpPath, finalPath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
  // After the rename, never before it. The new file being on disk is what makes the old one
  // redundant; removing first would mean a failed download costs the user the cover they had.
  if (options.removeMatching) removeStaleSiblings(chartDir, fileName, options.removeMatching)
  return finalPath
}

/**
 * Move a file the caller has already written into a chart folder, under `fileName`.
 *
 * The path-taking half of `writeChartAsset`, and it exists for the same reason
 * `writeSngAssetContent` does: M14 converts background videos of 18-159 MB, and the converted
 * file is already on disk when this is called. Reading it into a `Uint8Array` to hand to
 * `writeChartAsset`, which would write it straight back out, would put the whole video in the
 * main process's heap to accomplish a rename.
 *
 * `sourcePath` MUST be on the same filesystem as `chartDir`. This renames rather than copies, so
 * a source staged in `os.tmpdir()` fails with EXDEV. Callers stage inside the chart's own folder
 * (see `ENCORE_TMP_DIR`), which is on the right volume by construction. The rename is atomic
 * there, so a reader sees either the old file or the whole new one, never a partial write.
 *
 * The stale-sibling sweep runs after the rename, on the same terms as `writeChartAsset`: the new
 * file being in place is what makes the old one redundant.
 */
export function writeChartAssetFromFile(
  chartDir: string,
  fileName: string,
  sourcePath: string,
  libraryFolders: { path: string }[],
  options: StaleSiblingOptions = {}
): string {
  assertUnderLibrary(chartDir, libraryFolders)
  assertBareFileName(fileName)
  const finalPath = join(chartDir, fileName)
  renameSync(sourcePath, finalPath)
  if (options.removeMatching) removeStaleSiblings(chartDir, fileName, options.removeMatching)
  return finalPath
}

/**
 * Delete named files from a chart folder.
 *
 * The counterpart to the two writers above, and it exists for the same reason they do: a caller
 * that reached for `rmSync` directly would be one `assertUnderLibrary` away from unlinking a file
 * outside the user's library, and one `assertBareFileName` away from a caller-supplied `..`
 * walking out of the chart. M14's stray-`.ini` fix is the first caller (issues/actions).
 *
 * Unlike `removeStaleSiblings`, failures are NOT swallowed. That function is cleanup after a write
 * that already succeeded, where the caller has what they asked for and a leftover duplicate is not
 * a new harm. Here the removal IS what the caller asked for, and reporting a deletion that did not
 * happen would leave the user believing a file is gone.
 *
 * Directories are refused rather than skipped: `rmSync` without `recursive` cannot remove one
 * anyway, and a directory sharing a file's name is not the thing the caller meant to delete.
 * A symlink is unlinked, which removes the link and not its target, so a `.ini` symlinked out of
 * the library cannot make this delete a file elsewhere.
 */
export function removeChartFiles(
  chartDir: string,
  fileNames: string[],
  libraryFolders: { path: string }[]
): void {
  assertUnderLibrary(chartDir, libraryFolders)
  // Every name is checked before any file is removed, so a bad name at the end of the list cannot
  // leave the caller with half the deletion done and an error saying it failed.
  for (const fileName of fileNames) assertBareFileName(fileName)
  for (const fileName of fileNames) {
    const path = join(chartDir, fileName)
    if (lstatSync(path).isDirectory()) {
      throw new Error(`${path} is a directory, not a file Encore will remove`)
    }
    rmSync(path)
  }
}

/**
 * Refuse a name that is anything but a single file name.
 *
 * Shared by both folder writers so a caller cannot smuggle path segments past the chartDir guard
 * through whichever of the two it happens to call.
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
    throw new Error(`Asset file name must be a bare name: ${JSON.stringify(fileName)}`)
  }
}

/**
 * Delete the files in `chartDir` that `fileName` has just superseded.
 *
 * Failures are logged and swallowed rather than thrown. The caller asked for an asset and the
 * asset is on disk; rejecting now would report a failed art download over a chart that gained
 * the art, and the batch runner would count it as one. A cleanup that could not run leaves the
 * chart holding both covers, which is the state this exists to improve, not a new harm.
 *
 * Directories are skipped: `rmSync` without `recursive` cannot remove one, and a directory named
 * `album.jpg` is not a cover whatever it is. Symlinks are removed, which unlinks the link and
 * not its target, so a cover symlinked out of the library cannot make this delete a file
 * elsewhere.
 */
function removeStaleSiblings(chartDir: string, fileName: string, pattern: RegExp): void {
  try {
    for (const entry of readdirSync(chartDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue
      if (!isStaleSibling(entry.name, fileName, pattern)) continue
      rmSync(join(chartDir, entry.name), { force: true })
    }
  } catch (err) {
    console.warn(`Could not remove the superseded ${fileName} siblings in ${chartDir}:`, err)
  }
}

/**
 * One entry per chart with a write in flight; the value is that chart's write chain.
 *
 * Keyed on the canonicalized path so two spellings of one chart cannot take two locks.
 * Entries are removed once a chart's chain settles (see below), so the map holds at most one
 * key per chart being written right now, not one per chart ever written.
 */
const chartWriteChains = new Map<string, Promise<void>>()

/**
 * Run `write` with exclusive access to one chart, queued behind any write already in flight
 * on it.
 *
 * A `.sng` write is read-modify-rename over the whole archive: the writer reads every entry,
 * rebuilds the archive from that snapshot, and renames the result over the original. Two of
 * them on one chart both start from the SAME original, so the later rename silently discards
 * whatever the earlier one added, and both report success. Unique temp names (sng-asset.ts)
 * stop one writer renaming another's unverified bytes over the chart; they do nothing about
 * this. Only serialising the writes does, because then the second writer reads an original
 * that already contains the first one's asset.
 *
 * Folder charts are serialised too, though their writes target separate files and do not
 * collide. One rule for both shapes is worth more than the microseconds it costs: a reader of
 * a call site should not have to work out which chart shape they are looking at to know
 * whether their write is safe.
 *
 * Where this has to live: in main, not the renderer. The batch runner works through a list of
 * charts the renderer never sees, so no amount of renderer-side button-disabling can stop a
 * per-chart action from landing on the chart the batch is currently rebuilding. This lock is
 * the only place that knows about both.
 *
 * Errors are not swallowed. The promise returned here settles exactly as `write` did, so a
 * caller still sees its own failure; the promise STORED for the next writer has its rejection
 * absorbed, so one failed write does not reject the queue behind it.
 *
 * Not re-entrant, and must not become so: a `write` that itself called `withChartLock` on the
 * same chart would wait forever on a chain it is itself blocking. Verified at every call site:
 * `writeSngAsset` and `writeChartAsset` touch the filesystem and nothing else, the one caller
 * of `writeChartFile` (sidecars/ytdlp.ts) reaches it exactly one level deep, and the three
 * writers that hold the lock across a backup and a write (`writeWithUndo` in undoable-write.ts:
 * art.ts, background.ts, lyrics.ts, and the batch runner through the first and last) call the
 * two lock-free writers directly inside it.
 *
 * Exported for its own tests: the interesting properties (a rejection not poisoning the chain,
 * two charts still running concurrently, the map not growing) are about the lock rather than
 * about writing a file, and driving them through a real repack would test them by proxy.
 */
export function withChartLock<T>(chartPath: string, write: () => Promise<T>): Promise<T> {
  const key = canonicalize(chartPath)
  const previous = chartWriteChains.get(key) ?? Promise.resolve()
  // No onRejected handler needed: what is stored below never rejects.
  const result = previous.then(write)
  const settled = result.then(
    () => {},
    () => {}
  )
  chartWriteChains.set(key, settled)
  void settled.then(() => {
    // Only the LAST writer clears the slot. A writer that queued behind this one has already
    // replaced the entry with its own chain, and deleting that would hand the next arrival a
    // fresh lock while a write is still running.
    if (chartWriteChains.get(key) === settled) chartWriteChains.delete(key)
  })
  return result
}

/** Test seam: how many charts currently hold a write lock. Production code never asks. */
export function pendingChartLockCount(): number {
  return chartWriteChains.size
}

/**
 * Write one asset into a chart, whichever shape the chart is.
 *
 * A folder chart takes a sibling file; a `.sng` chart has to be repacked around the new entry,
 * which is orders of magnitude more work: every byte of the archive is copied into a sibling
 * temp, and the temp is verified against the chart it was built from before it replaces it.
 *
 * `chartType` is passed in rather than inferred from the path. The scanner decides a chart's
 * shape and records it on the catalog row; sniffing for a `.sng` suffix here would be a second
 * opinion that can disagree with the first. Callers carry the value down from that row. For
 * the renderer-driven writers it rides along in the IPC payload (see `ipc.ts`), the same way
 * `chart:read-files` already receives it, which keeps the read and write paths symmetric.
 *
 * A renderer that lies about the type cannot escape the library guard: both branches call
 * `assertUnderLibrary` on the path first, and a mismatched type only produces a failed write
 * (a folder write into a `.sng` path is ENOTDIR; a repack of a directory fails to parse).
 *
 * Async for both types so callers have one shape to await; the folder branch's synchronous
 * throws surface as rejections.
 *
 * Serialised per chart by `withChartLock`. See there for why a concurrent `.sng` write would
 * otherwise lose an asset while reporting success.
 */
export async function writeChartFile(
  chartPath: string,
  chartType: 'folder' | 'sng',
  fileName: string,
  data: Uint8Array,
  libraryFolders: { path: string }[],
  options: StaleSiblingOptions = {}
): Promise<string> {
  // Inside the lock, not before it: argument validation reads the same chart state the write
  // does (writeSngAsset stats the archive for its size ceiling), so checking it against an
  // archive another writer is about to replace would be checking the wrong file.
  return withChartLock(chartPath, async () =>
    chartType === 'sng'
      ? writeSngAsset(chartPath, fileName, data, libraryFolders, options)
      : writeChartAsset(chartPath, fileName, data, libraryFolders, options)
  )
}
