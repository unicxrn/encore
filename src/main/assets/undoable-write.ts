import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { scanChartIssues } from '../catalog/issues'
import { readRepackPlan } from '../downloads/sng-repack'
import {
  beginBackup,
  type AssetBackupKind,
  type BackupContent,
  type BackupPlan
} from '../issues/backup-store'
import { isStaleSibling } from './stale-siblings'
import { withChartLock } from './write'

/**
 * A chart write that keeps what it replaces, so it can be undone from the Issues tab.
 *
 * M15 gave the four Issues repairs an undo and left three writes without one: the art download
 * deleted the cover it superseded, and the background write and the lyrics injection overwrote
 * in place. Each of those has the same shape as a repair: one chart, one thing replaced, one
 * write under the chart's lock. So this is `applyFix`'s sequence (issues/fix.ts) with the
 * repair-specific parts taken out, and the store it writes to is the same one:
 *
 * 1. Take the chart's write lock, so nothing lands between what is read here and what is written.
 * 2. Inside it, ask the caller what it is about to replace. That is read now rather than passed
 *    in, because a name listed before the lock describes a chart another writer may since have
 *    changed.
 * 3. Record the chart's hash and copy the originals aside. A backup that cannot be written fails
 *    the write HERE, with the chart untouched. That is the one ordering that makes "undoable" a
 *    promise rather than a hope.
 * 4. Write, through the caller's own writer, which must not take the lock itself.
 * 5. Commit the manifest, which stamps the chart as the write left it.
 *
 * No hash assertion after the write, and that is a difference from `applyFix` worth being plain
 * about. A repair promises to leave the multiplayer hash alone and is checked on it. Two of these
 * writers never touch hashed content, and the third, lyrics, rewrites the chart file on purpose, so
 * the hash moving is the feature rather than a failure. What is asserted instead is the restore's
 * rule (`assertRestoreHash`): an undo lands on the hash the chart had a moment ago or on the one
 * recorded here, and for lyrics only the second is possible.
 */

/** The noun the undo list shows for each writer. The copy pass owns words; these are the nouns. */
export const ASSET_BACKUP_LABELS: Record<AssetBackupKind, string> = {
  art: 'Album art',
  background: 'Background',
  lyrics: 'Lyrics'
}

export interface UndoableChart {
  /** The catalog path: a folder for a folder chart, the archive for a `.sng`. */
  chartPath: string
  chartType: 'folder' | 'sng'
  /**
   * Where the originals go, or `null` for no undo.
   *
   * Required rather than optional, on `FixContext.backupDir`'s reasoning: a parameter that could
   * be left out would make "irreversible" the accident of a forgotten call site. Main passes
   * `<userData>/fix-backups`, the same store the repairs use.
   */
  backupDir: string | null
}

/** What a write is about to do to the chart, and the write itself. See `writeWithUndo`. */
export interface UndoableWrite<T> {
  /** The files (or archive entries) the write replaces or removes, and where their bytes are. */
  files: BackupPlan['files']
  /** Names the write creates that did not exist before, which an undo deletes again. */
  remove?: string[]
  /** The write. Runs inside the chart's lock, so it must not call `withChartLock` itself. */
  write: () => Promise<T>
}

/**
 * Run one asset write under the chart's lock, with what it replaces copied aside first.
 *
 * `prepare` is called inside the lock and returns both halves, what is about to change and the
 * write that changes it, so a caller that has to read the chart to decide (lyrics reads the
 * chart text) reads it once, at the moment it is about to be rewritten.
 */
export async function writeWithUndo<T>(
  chart: UndoableChart,
  kind: AssetBackupKind,
  prepare: () => Promise<UndoableWrite<T>>
): Promise<T> {
  return withChartLock(chart.chartPath, async () => {
    const { files, remove, write } = await prepare()

    const pending =
      chart.backupDir === null
        ? null
        : await beginBackup(
            chart.backupDir,
            {
              chartPath: chart.chartPath,
              chartType: chart.chartType,
              chartHash: await chartHashBeforeWrite(chart)
            },
            {
              code: kind,
              actionCode: kind,
              describe: ASSET_BACKUP_LABELS[kind],
              files,
              remove
            }
          )

    let result: T
    try {
      result = await write()
    } catch (err) {
      // Nothing was replaced, so there is nothing to undo, and a backup nobody can act on is
      // still the user's disk. Best-effort inside the rethrow, so a failure to clean up cannot
      // replace the reason the write failed.
      try {
        pending?.discard()
      } catch (cleanup) {
        console.warn(`Could not discard the unused backup for ${chart.chartPath}:`, cleanup)
      }
      throw err
    }

    try {
      await pending?.commit()
    } catch (err) {
      // The write really happened and cannot now be undone. Both halves have to reach the
      // caller: reporting only the store's error would have a user retry a write that has
      // already landed, and reporting success would offer an undo that does not exist.
      throw new Error(
        `${chart.chartPath} was written, but Encore could not save what the write replaced, ` +
          `so this cannot be undone: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return result
  })
}

/**
 * The chart's multiplayer hash as it stands, or null when scan-chart cannot produce one.
 *
 * A scan that throws is recorded as "no hash" rather than failing the write. A chart whose
 * chart file scan-chart cannot read has no gameplay identity to preserve, and it could take a
 * cover or a background before this existed, so a backup must not be the thing that stops it.
 * The restore's rule then reduces to "the hash did not move", which is still the right rule for
 * a write that touched nothing hashed. Lyrics parses the chart text itself and fails on its own
 * terms.
 */
async function chartHashBeforeWrite(chart: UndoableChart): Promise<string | null> {
  try {
    return (await scanChartIssues(chart.chartPath, chart.chartType)).chartHash
  } catch (err) {
    console.warn(`Could not hash ${chart.chartPath} before writing to it:`, err)
    return null
  }
}

/**
 * The names a chart holds right now: its files for a folder, its entries for a `.sng`.
 *
 * Directories are left out of the folder listing. The writers never replace one, since a
 * directory named `album.png` is not a cover, and `writeChartAsset`'s stale-sibling sweep skips
 * them too, so listing one here would back up something the write is not going to touch.
 */
export async function chartFileNames(chart: UndoableChart): Promise<string[]> {
  if (chart.chartType === 'folder') {
    return readdirSync(chart.chartPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  }
  // The header only: one 64 KiB read even on the 519 MB chart.
  return (await readRepackPlan(chart.chartPath)).entries.map((entry) => entry.fileName)
}

/** Where the bytes of one of the chart's files come from, for the backup to copy. */
export function chartFileContent(chart: UndoableChart, fileName: string): BackupContent {
  return chart.chartType === 'folder'
    ? { kind: 'copyFile', path: join(chart.chartPath, fileName) }
    : { kind: 'sngEntry', sngPath: chart.chartPath }
}

/**
 * What writing `fileName` into the chart is about to replace, as the two halves of an
 * `UndoableWrite`: the names to copy aside, and whether the name is new to the chart (so an
 * undo deletes it) or already there (so an undo puts the original back over it).
 *
 * `supersedes` is the writer's `removeMatching` pattern: the other names the write sweeps once
 * it has landed (`isStaleSibling`). Those are backed up under their own names, because that is
 * the name the sweep deletes and the name the undo has to bring back.
 *
 * A case-variant of the incoming name, `Album.PNG` while writing `album.png`, is where the two
 * chart shapes part ways, and the reason a folder chart asks the filesystem rather than the
 * listing. The sweep deliberately spares such a name (see `isStaleSibling` for why), so the
 * listing alone says "untouched". On Windows and a default macOS volume that is false: the
 * variant IS the file the write is about to rename over, and an undo that had not kept it would
 * first put nothing back and then delete it. So for a folder chart the variant is backed up, and
 * "already there" is `existsSync` on the exact name, which answers per the filesystem's own
 * case rule: true on Windows, where the undo then restores the variant in place; false on
 * Linux, where the variant is a separate file the undo rewrites with its own bytes and the new
 * name is deleted. The cost on Linux is one extra copy of a cover the write never touched.
 * `.sng` entry names have no filesystem behind them and are matched exactly, as the repacker
 * matches them, so a variant there is neither replaced nor kept.
 */
export async function replacementOf(
  chart: UndoableChart,
  fileName: string,
  supersedes?: RegExp
): Promise<{ files: BackupPlan['files']; remove: string[] }> {
  const names = await chartFileNames(chart)
  const sameName =
    chart.chartType === 'folder'
      ? (name: string) => name.toLowerCase() === fileName.toLowerCase()
      : (name: string) => name === fileName
  const replaced = names.filter(
    (name) =>
      sameName(name) || (supersedes !== undefined && isStaleSibling(name, fileName, supersedes))
  )
  const existed =
    chart.chartType === 'folder'
      ? existsSync(join(chart.chartPath, fileName))
      : names.includes(fileName)
  return {
    files: replaced.map((name) => ({ fileName: name, content: chartFileContent(chart, name) })),
    remove: existed ? [] : [fileName]
  }
}
