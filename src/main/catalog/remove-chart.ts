import { existsSync } from 'node:fs'
import type { ChartRemoval } from '../../shared/chart-removal'
import { isUnderLibrary } from '../assets/library-guard'
import type { CatalogDb } from './db'
import { deleteChartByPath } from './queries'

export interface RemoveChartDeps {
  /**
   * Hand the chart to the operating system's Trash. Wired to `shell.trashItem` in index.ts, and
   * a parameter rather than an import so a test can exercise this without putting a fixture in
   * the real Trash.
   *
   * The ONLY disposal this module knows about. There is no unlink fallback for the filesystems
   * that have no trash (a FAT drive, some network mounts, a container with no XDG trash spec):
   * on those the removal fails and says so. A fallback would quietly turn the one operation
   * Encore promises is recoverable into the one operation nobody can undo, and it would do it
   * exactly where the user is least likely to notice.
   */
  trash: (path: string) => Promise<void>
  /** Seam for the "already gone" case. Defaults to the real filesystem. */
  exists?: (path: string) => boolean
}

/**
 * Remove one chart: to the Trash first, out of the catalog second.
 *
 * That order is the whole of the safety argument and is not an implementation detail.
 *
 *   - Row last means a trash that fails leaves a library exactly as it was, with the chart on
 *     disk and findable in Installed. Row first would leave a chart the catalog has forgotten
 *     and the user cannot see, until some later full scan happened to re-add it.
 *   - Row last is also what keeps this out of a fight with the library watcher. The watcher
 *     notices the folder disappear and, two seconds later, runs a scan whose first pass deletes
 *     every row whose path is no longer on disk (see scanLibrary in scanner.ts). By then the row
 *     is already gone, so that pass is a no-op; and because the chart really has left the disk,
 *     no pass can re-add it. The reverse order would open a window where the row is gone, the
 *     chart is still there, and a scan starting inside that window puts the row straight back.
 *
 * Containment is checked first, on the same `isUnderLibrary` the writers and `chart:reveal` use.
 * The path arrives from the renderer; nothing outside the configured library folders is Encore's
 * to move, whatever it is sent.
 */
export async function removeChart(
  db: CatalogDb,
  path: string,
  libraryFolders: { path: string }[],
  deps: RemoveChartDeps
): Promise<ChartRemoval> {
  if (!isUnderLibrary(path, libraryFolders)) {
    throw new Error(`Refusing to remove a path outside the library folders: ${path}`)
  }
  const exists = deps.exists ?? existsSync
  // A chart that is not there is not a failure the user can act on: there is nothing left to
  // trash and the row is the only thing still claiming the chart exists. Removing it is the
  // whole of what "remove this chart" can still mean.
  if (!exists(path)) {
    deleteChartByPath(db, path)
    return { path, outcome: 'already-gone' }
  }
  await deps.trash(path)
  deleteChartByPath(db, path)
  return { path, outcome: 'trashed' }
}
