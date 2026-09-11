import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { volumeFreeBytes } from '../assets/free-space'
import { extractSngEntryToFile } from '../downloads/sng-read-selective'
import { readRepackPlan, sourceByteLength } from '../downloads/sng-repack'

/**
 * What a repair replaced, kept on disk so the repair can be undone.
 *
 * ## Why the content and not the archive
 *
 * Every one of M14's four repairs rewrites a chart in the user's library and none of them can be
 * taken back. The obvious answer, copying the chart aside first, does not survive contact with the
 * numbers: the reference library is 6.6 GB across 219 charts and its largest single chart is
 * 519 MB, so an archive-level backup of six video conversions is several gigabytes to undo a few
 * hundred megabytes of change.
 *
 * A repair only ever replaces one thing, and that thing is what is kept here:
 *
 * | repair         | what is kept                              | measured        |
 * | -------------- | ----------------------------------------- | --------------- |
 * | `badVideo`     | the original `video.mp4`                  | 18-159 MB       |
 * | `albumArtSize` | the original cover                        | ~1 MB           |
 * | `extraValue`   | the original `song.ini`, or the header key| bytes           |
 * | stray `.ini`   | the deleted `.ini` files                   | bytes           |
 *
 * Repairing every fixable row in the reference library costs about half a gigabyte against 300 GB
 * free, so backups are kept until the user clears them. There is no expiry, no rotation and no
 * "last N" limit: those are policies with failure modes and nothing here needs one. Settings shows
 * the total and offers to clear it, because the disk is the user's.
 *
 * The three asset writers outside the Issues tab go through the same store: the art download, the
 * background write and the lyrics injection (`assets/undoable-write.ts`). They keep the same things
 * a repair does: the cover a download superseded, the `background.png` a write overwrote, the
 * `notes.chart` (or archive entry) an injection rewrote, and the names each of them created.
 * Nothing about the shape below is theirs; see `FixBackup.code` for the one field whose meaning
 * they widened.
 *
 * ## Shape on disk
 *
 * One directory per backup under the store root, named by the backup's id:
 *
 *     <userData>/fix-backups/<id>/backup.json   the manifest below
 *     <userData>/fix-backups/<id>/0.bin         the bytes of files[0]
 *     <userData>/fix-backups/<id>/1.bin         ...
 *
 * A directory rather than one index file, because the alternative is a manifest rewritten on every
 * repair. Corrupt or truncate that one file with a crash mid-write and the user loses every undo
 * they have rather than one. `backup.json` is written LAST and atomically (temp + rename), so a
 * directory without it is an interrupted backup and is ignored by `listBackups` and swept by
 * `clearBackups`.
 *
 * Blobs are numbered rather than named after the file they hold. The names come from a chart in
 * the user's library and reach this module unfiltered; numbering means no name from outside ever
 * becomes a path, and the manifest carries the real name for the restore to write back under.
 *
 * ## What this module does NOT do
 *
 * It does not write to charts. Restoring is `issues/restore.ts`, which goes through the same write
 * machinery (`withChartLock`, `writeChartAssetFromFile`, `rewriteSngPlan`) every other chart write
 * in the app uses, and asserts a multiplayer-hash rule afterwards, a deliberately weaker one than
 * a repair's, because an undo of a repair that DID move the hash has to be allowed to move it back
 * (`assertRestoreHash`). Keeping the store ignorant of charts is also what lets `issues/fix.ts`
 * depend on it without a cycle.
 */

/**
 * Enough of a file's identity to notice that something else has rewritten it.
 *
 * Size and mtime, not a hash. The honest description of what that buys: every writer that has
 * touched the file changes its mtime, so this catches the cases the undo exists to refuse: the
 * user converted a video, then downloaded a better one, then pressed Undo. What it cannot catch is
 * a rewrite that produces the same size within the same millisecond, which needs either a
 * filesystem with coarse mtime granularity or deliberate effort.
 *
 * The alternative was hashing, and it was rejected for the file that matters: the thing a
 * `badVideo` repair leaves behind is a WebM of up to 159 MB, and re-hashing it on every listing of
 * the undo panel would make the panel cost a full read of every video the user has converted. The
 * blobs themselves ARE hashed, because those are read once, at restore time, where the cost is
 * paid against a write that is about to happen anyway.
 */
export interface FileStamp {
  size: number
  mtimeMs: number
}

/**
 * How the chart must still look for its restore to be safe.
 *
 * A folder chart is stamped per file the repair touched, and `null` means the file must still be
 * ABSENT. That is how a `badVideo` restore knows nothing has put a `video.mp4` back in the
 * meantime, and how a stray-`.ini` restore knows it is not about to overwrite a file someone
 * recreated by hand.
 *
 * A `.sng` carries BOTH the archive's own stamp and the state of the parts the undo touches, and
 * needs both. The archive stamp is the strong check and the common one: every writer in this app
 * replaces a `.sng` wholesale, so an untouched archive proves nothing inside it moved either. It
 * cannot be the only check, because the case it fails is an ordinary one: a chart carrying two
 * repairable codes. Repair the cover, then repair a difficulty rating, and the
 * second repack moves the archive's stamp; if that were the whole guard, the first repair would
 * become permanently un-undoable the moment the second one ran. So when the stamp has moved the
 * restore falls back to asking whether the entries and header keys IT is about to touch are still
 * as the repair left them.
 *
 * The fallback is deliberately weaker than the folder charts' and it is worth being plain about
 * why. It compares an entry's declared length, not its bytes: the length comes out of the header
 * that `readRepackPlan` already reads, so the check costs one 64 KiB read, while hashing would
 * mean decrypting up to 159 MB of video every time an undo is offered. A writer that replaced an
 * entry with different content of exactly the same length would slip past it. Nothing in Encore
 * does that, since every write here goes through `rewriteSngPlan`, and the strong check covers
 * every case where nothing has touched the archive at all.
 */
export type BackupGuard =
  | {
      chartType: 'sng'
      archive: FileStamp
      /** Declared length of each touched entry as the repair left it; `null` means absent. */
      entries: { fileName: string; byteLength: number | null }[]
      /** Each touched header key as the repair left it; `null` means the repair removed it. */
      metadata: { key: string; value: string | null }[]
    }
  | { chartType: 'folder'; files: { fileName: string; stamp: FileStamp | null }[] }

/** One file (for a folder chart) or archive entry (for a `.sng`) the restore puts back. */
export interface BackupFile {
  /** The name it is written back under, inside the chart. */
  fileName: string
  /** The blob holding its bytes, relative to the backup's own directory. */
  blob: string
  byteLength: number
  /** Of the ORIGINAL bytes. Checked before a restore writes anything. */
  sha256: string
}

/** A `.sng` header metadata key to put back; `value: null` means the restore deletes it. */
export interface BackupMetadata {
  key: string
  value: string | null
}

/**
 * The three writes outside the Issues tab that keep what they replace.
 *
 * A backup taken by one of these carries the kind in BOTH `code` and `actionCode`, and its
 * `describe` is the kind's noun and nothing more. That is the whole of the generalisation, and
 * it is deliberately not a fourth field: a `kind` would have been something every M15 manifest
 * already on disk lacks, so either the validator would have to default it or every existing undo
 * would be stranded. Nothing reads a manifest that needs to tell a repair from a write: the undo
 * list shows `describe`, Settings counts, and the restore works from `files`, `remove`
 * and the guard alone.
 */
export type AssetBackupKind = 'art' | 'background' | 'lyrics'

export interface FixBackup {
  id: string
  /** Epoch ms, for ordering the undo list newest-first. */
  createdAt: number
  chartPath: string
  chartType: 'folder' | 'sng'
  /**
   * For a repair: the issue code that was repaired, and the action that repaired it. For one of
   * the asset writers: the `AssetBackupKind`, in both. All for the UI's label.
   */
  code: string
  actionCode: string
  /**
   * What the repair said it would do, so the undo list can name what it is taking back. An asset
   * writer puts its kind's noun here ("Album art", "Background", "Lyrics") and no sentence.
   */
  describe: string
  /**
   * The chart's `getChartHash` BEFORE the repair: what Clone Hero matched it by.
   *
   * A repair is supposed to leave this alone and `applyFix` refuses to report success if it did
   * not. Recording it anyway is what makes the undo usable in the one case where it matters most:
   * if a repair ever does move the hash, the restore is the thing that has to move it back, and a
   * restore that only knew "do not change the hash" would refuse to run. See `assertRestoreHash`.
   *
   * For the lyrics writer that case is not an accident but the design: `getChartHash` hashes the
   * chart file's bytes and an injection rewrites them, so the value here is the one the restore
   * has to land back on, and the only proof that it did.
   */
  chartHash: string | null
  /**
   * The checksum Clone Hero itself records for the chart, BEFORE the repair.
   *
   * Kept for the same reason `chartHash` is, and used by the same rule: a restore may land on
   * the value the chart has now or on this one, and nothing else (`assertRestoreChecksum`).
   *
   * Optional, and it has to be: every manifest written before M17 lacks the field, and a
   * validator that demanded it would strand every undo already sitting in the user's store. The
   * three states are distinguished deliberately at the call site — a string is a recorded value,
   * `null` is "this chart had no chart file", and `undefined` is "written before Encore recorded
   * this", which the restore treats as no second target rather than as a null one.
   */
  cloneHeroChecksum?: string | null
  files: BackupFile[]
  /** Names the repair CREATED, which the restore removes. Empty for an in-place replacement. */
  remove: string[]
  metadata: BackupMetadata[]
  guard: BackupGuard
  /** Sum of `files[].byteLength`; what Settings totals without opening a single blob. */
  sizeBytes: number
}

/** Where the bytes of one backed-up file come from, at the moment the backup is taken. */
export type BackupContent =
  /** Bytes the action already holds: a cover, a `song.ini`. */
  | { kind: 'data'; data: Uint8Array }
  /** A file in a folder chart, copied. `copyFileSync` reflinks on filesystems that can. */
  | { kind: 'copyFile'; path: string }
  /** An entry inside a `.sng`, decrypted out of the archive a chunk at a time. */
  | { kind: 'sngEntry'; sngPath: string }

/** What an action says it is about to replace. See `FixAction.backup` in issues/fix.ts. */
export interface BackupPlan {
  code: string
  actionCode: string
  describe: string
  files: { fileName: string; content: BackupContent }[]
  /** Names the repair will create that a restore has to remove again. */
  remove?: string[]
  metadata?: BackupMetadata[]
}

/**
 * A backup whose blobs are written but whose manifest is not.
 *
 * The two halves are separate because the guard can only be taken AFTER the repair has run: it
 * records what the repair left behind, which is the state a later restore has to find unchanged.
 * So `issues/fix.ts` opens one of these before the action, and commits or discards it after.
 */
export interface PendingBackup {
  id: string
  /**
   * Stamp the chart as the repair left it and write the manifest. Only after this does the backup
   * exist as far as `listBackups` is concerned.
   */
  commit: () => Promise<FixBackup>
  /** Throw the whole thing away. The repair never happened, so there is nothing to undo. */
  discard: () => void
}

/** The manifest file inside a backup's directory. Written last, so its presence means "complete". */
const MANIFEST = 'backup.json'

/**
 * A backup id, and the only shape this module will treat as one.
 *
 * The timestamp prefix is for a human reading the directory listing while debugging; ordering is
 * done from `createdAt` in the manifest, which is not derived from the name. The random half is
 * what makes it unique, because two repairs in one millisecond are ordinary during a batch.
 *
 * Validated on the way in as well as on the way out, because an id reaches `readBackup` from the
 * renderer over IPC and would otherwise be a path segment supplied by an untrusted process.
 */
const ID_RE = /^[0-9a-z]+-[0-9a-f]{16}$/

function newBackupId(): string {
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
}

/** Whether `id` is one this module could have produced. Anything else resolves to no path at all. */
export function isBackupId(id: string): boolean {
  return ID_RE.test(id)
}

/**
 * The directory holding one backup, or null when the id is not one.
 *
 * Shaped like `artFilePath` (catalog/art-cache.ts) and for the same reason: the input crosses IPC,
 * so the shape is validated rather than the path escaped. A traversal attempt has nowhere to
 * resolve to instead of a path that merely happens to stay inside the store today.
 */
export function backupDirPath(storeDir: string, id: string): string | null {
  return isBackupId(id) ? join(storeDir, id) : null
}

/** Blob names are the ones this module writes and nothing else. */
const BLOB_RE = /^\d+\.bin$/

/** The path of one of a backup's blobs, or null when either name is not one of ours. */
export function backupBlobPath(storeDir: string, id: string, blob: string): string | null {
  const dir = backupDirPath(storeDir, id)
  return dir !== null && BLOB_RE.test(blob) ? join(dir, blob) : null
}

/**
 * Refuse a backup the userData volume cannot hold, before it spends a minute proving the same
 * thing by copying a 159 MB video.
 *
 * Advisory in both directions, exactly as `assertRepackSpace` is: the figure is stale the moment
 * it is read, and a filesystem that will not answer is not evidence of a full disk. What it buys
 * is that the common case fails immediately, with both numbers, rather than as an ENOSPC partway
 * through a copy.
 *
 * Failing here is what makes a failed backup safe. `issues/fix.ts` takes the backup BEFORE the
 * repair, so a store that cannot hold the original leaves the chart untouched rather than
 * irreversibly repaired.
 */
export function assertBackupSpace(
  storeDir: string,
  incomingBytes: number,
  freeBytes: number | undefined = volumeFreeBytes(storeDir)
): void {
  if (freeBytes === undefined) return
  if (freeBytes < incomingBytes) {
    throw new Error(
      `Not enough free space to back up what this fix would replace: it needs about ` +
        `${incomingBytes} bytes and ${freeBytes} bytes are free. Free some space, or clear ` +
        `Encore's undo history in Settings, then try again.`
    )
  }
}

/**
 * How many bytes one backed-up file will occupy, known before any of it is copied.
 *
 * The `.sng` branch reads the archive's header alone (every entry's name, length and offset),
 * which is one 64 KiB read even on the 519 MB chart. See `readRepackPlan`.
 */
async function contentByteLength(fileName: string, content: BackupContent): Promise<number> {
  if (content.kind === 'data') return content.data.length
  if (content.kind === 'copyFile') return statSync(content.path).size
  const plan = await readRepackPlan(content.sngPath)
  const entry = plan.entries.find((candidate) => candidate.fileName === fileName)
  if (entry === undefined) {
    throw new Error(`${content.sngPath} has no entry named ${fileName} to back up`)
  }
  return sourceByteLength(entry.source)
}

/**
 * Copy one entry out of a `.sng`, by name, into the store.
 *
 * Reads the header again rather than sharing `contentByteLength`'s plan: the two are asked at
 * different moments and a plan cached across them would describe an archive that had since been
 * repacked. Both reads are the header only, so the second costs 64 KiB.
 */
async function writeSngEntryBlob(
  sngPath: string,
  fileName: string,
  destPath: string
): Promise<void> {
  const plan = await readRepackPlan(sngPath)
  await extractSngEntryToFile(sngPath, plan, fileName, destPath)
}

/** sha256 of a file already on disk, read a chunk at a time so a 159 MB video is not resident. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array)
  return hash.digest('hex')
}

/**
 * Write the bytes a repair is about to replace into the store, ready to be committed.
 *
 * Order inside: space check, then blobs, and the manifest only in `commit`. Nothing here touches
 * the chart, so a failure at any point leaves the library exactly as it was, which is the whole
 * reason the backup runs first.
 */
export async function beginBackup(
  storeDir: string,
  chart: {
    chartPath: string
    chartType: 'folder' | 'sng'
    chartHash: string | null
    cloneHeroChecksum: string | null
  },
  plan: BackupPlan
): Promise<PendingBackup> {
  const sizes = await Promise.all(
    plan.files.map((file) => contentByteLength(file.fileName, file.content))
  )
  const sizeBytes = sizes.reduce((total, size) => total + size, 0)

  mkdirSync(storeDir, { recursive: true })
  assertBackupSpace(storeDir, sizeBytes)

  const id = newBackupId()
  const dir = join(storeDir, id)
  // `mkdirSync` without `recursive` so a collision with an existing backup fails loudly instead of
  // adopting its directory. `newBackupId` makes that unreachable; a loud failure is what keeps it
  // unreachable if it ever stops being.
  mkdirSync(dir)

  const files: BackupFile[] = []
  try {
    for (const [index, file] of plan.files.entries()) {
      const blob = `${index}.bin`
      const blobPath = join(dir, blob)
      let sha256: string
      if (file.content.kind === 'data') {
        // Hashed from the buffer already in hand rather than by reading the file back: these are
        // covers and `song.ini`s, and the bytes written are the bytes hashed by construction.
        writeFileSync(blobPath, file.content.data, { flag: 'wx' })
        sha256 = createHash('sha256').update(file.content.data).digest('hex')
      } else {
        if (file.content.kind === 'copyFile') copyFileSync(file.content.path, blobPath)
        else await writeSngEntryBlob(file.content.sngPath, file.fileName, blobPath)
        sha256 = await hashFile(blobPath)
      }
      files.push({ fileName: file.fileName, blob, byteLength: statSync(blobPath).size, sha256 })
    }
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (cleanup) {
      // Cleanup must not replace the reason the backup failed. `force` already covers a missing
      // directory; what is left is the likes of a read-only store, where rethrowing would discard
      // the cause and leave the caller debugging the wrong failure. The chart is untouched either
      // way, since nothing here has been near it, so the cost is a directory `clearBackups`
      // reclaims.
      console.warn(`Could not remove the abandoned backup at ${dir}:`, cleanup)
    }
    throw err
  }

  const remove = plan.remove ?? []
  const metadata = plan.metadata ?? []

  return {
    id,
    commit: async () => {
      const backup: FixBackup = {
        id,
        createdAt: Date.now(),
        chartPath: chart.chartPath,
        chartType: chart.chartType,
        code: plan.code,
        actionCode: plan.actionCode,
        describe: plan.describe,
        chartHash: chart.chartHash,
        cloneHeroChecksum: chart.cloneHeroChecksum,
        files,
        remove,
        metadata,
        guard: await stampChart(
          chart.chartPath,
          chart.chartType,
          // Every name the repair could have left in a different state: the ones it removed or
          // replaced (which the restore writes back) and the ones it created (which the restore
          // deletes).
          [...files.map((file) => file.fileName), ...remove],
          metadata.map((entry) => entry.key)
        ),
        sizeBytes: files.reduce((total, file) => total + file.byteLength, 0)
      }
      writeManifest(dir, backup)
      return backup
    },
    discard: () => rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Record the chart as it stands right now.
 *
 * Called after the repair, so what it records is the state a restore has to find unchanged, and
 * called again by the restore to compare. Absent things are recorded as `null` rather than
 * skipped: "this file is not here" is exactly the fact a `badVideo` restore depends on before it
 * writes a `video.mp4`, and "this header key is not here" is the same fact for an `extraValue`
 * undo.
 *
 * `fileNames` are the entries or files the undo will write back or delete, and `metadataKeys` the
 * `.sng` header keys it will put back. A folder chart has no header, so the second is ignored
 * there; `restoreBackup` refuses a manifest that claims otherwise.
 */
export async function stampChart(
  chartPath: string,
  chartType: 'folder' | 'sng',
  fileNames: string[],
  metadataKeys: string[]
): Promise<BackupGuard> {
  // Deduped: `files` and `remove` can name the same file when a repair replaced it in place, and
  // two stamps of one name would be two chances to disagree.
  const names = [...new Set(fileNames)]

  if (chartType === 'sng') {
    const archive = stampOf(chartPath)
    // Unreachable from `beginBackup`, whose caller has just written this archive under a lock.
    // Stated rather than asserted away, because a guard built from a missing file would be a
    // guard that can never match and an undo that can never run.
    if (archive === null) {
      throw new Error(`${chartPath} is gone, so there is nothing to record an undo against`)
    }
    // The header alone: one 64 KiB read even on the 519 MB chart.
    const plan = await readRepackPlan(chartPath)
    const lengths = new Map(
      plan.entries.map((entry) => [entry.fileName, sourceByteLength(entry.source)])
    )
    return {
      chartType: 'sng',
      archive,
      entries: names.map((fileName) => ({
        fileName,
        byteLength: lengths.get(fileName) ?? null
      })),
      metadata: [...new Set(metadataKeys)].map((key) => ({
        key,
        value: Object.hasOwn(plan.metadata, key) ? plan.metadata[key] : null
      }))
    }
  }

  return {
    chartType: 'folder',
    files: names.map((fileName) => ({ fileName, stamp: stampOf(join(chartPath, fileName)) }))
  }
}

/** The stamp of a path, or null when nothing is there. Anything else (EACCES, ELOOP) throws. */
function stampOf(path: string): FileStamp | null {
  const stat = statSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return null
  return { size: stat.size, mtimeMs: stat.mtimeMs }
}

/** Write the manifest atomically, so a crash mid-write cannot leave a half-parsed backup. */
function writeManifest(dir: string, backup: FixBackup): void {
  const tmp = join(dir, `${MANIFEST}.tmp`)
  writeFileSync(tmp, JSON.stringify(backup, null, 2))
  renameSync(tmp, join(dir, MANIFEST))
}

/**
 * Every complete backup in the store, newest first.
 *
 * A directory whose manifest is missing or unreadable is SKIPPED rather than raised. Those are
 * interrupted backups, where the process died between the blobs and the manifest, and the undo
 * panel refusing to open because one of them exists would take away every other undo the user has.
 * `clearBackups` removes them along with everything else.
 */
export function listBackups(storeDir: string): FixBackup[] {
  if (!existsSync(storeDir)) return []
  const backups: FixBackup[] = []
  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isBackupId(entry.name)) continue
    const backup = tryReadManifest(join(storeDir, entry.name))
    if (backup !== null) backups.push(backup)
  }
  return backups.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * How much disk the store is actually using, measured rather than summed from the manifests.
 *
 * The manifests would be cheaper and would be wrong in the direction that matters. A backup
 * interrupted between its blobs and its manifest is invisible to `listBackups`, and the blobs
 * most likely to be interrupted are the big ones, because a backup is cut short while copying a
 * 159 MB video, not while writing a `song.ini`. Summing manifests would report 0 bytes over a
 * store holding a gigabyte, under a button whose whole job is to reclaim it.
 *
 * The Settings panel therefore offers Clear whenever this is non-zero, not only when something is
 * listed as undoable; see Settings.svelte.
 *
 * Never throws: a store that cannot be walked is reported as costing nothing, which is the same
 * answer a missing one gives and keeps a disk-space readout from taking down the Settings tab.
 */
export function backupStoreBytes(storeDir: string): number {
  if (!existsSync(storeDir)) return 0
  let total = 0
  try {
    for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isBackupId(entry.name)) continue
      for (const blob of readdirSync(join(storeDir, entry.name), { withFileTypes: true })) {
        if (!blob.isFile() || !BLOB_RE.test(blob.name)) continue
        total +=
          statSync(join(storeDir, entry.name, blob.name), { throwIfNoEntry: false })?.size ?? 0
      }
    }
  } catch (err) {
    console.warn(`Could not measure the undo store at ${storeDir}:`, err)
  }
  return total
}

/**
 * The manifest in `dir`, or null when there is not a complete and self-consistent one.
 *
 * The id is checked against the directory it was found in. Everything downstream resolves blobs
 * and deletes by `backup.id` rather than by the path it came from, so a manifest naming another
 * backup would read that one's bytes and delete that one's directory. The manifest is a file in
 * `userData` that a user can edit, so one comparison closes it.
 */
function tryReadManifest(dir: string): FixBackup | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
    if (!isFixBackup(parsed) || parsed.id !== basename(dir)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Whether a parsed manifest is one this module wrote.
 *
 * Structural rather than a schema library, and deliberately shallow: the file is written by this
 * process into its own userData, so the realistic failure is a truncated or half-migrated file
 * rather than a hostile one. What it has to catch is a manifest missing a field the restore would
 * then read as `undefined`, and the restore is a write to the user's library.
 */
function isFixBackup(value: unknown): value is FixBackup {
  if (typeof value !== 'object' || value === null) return false
  const backup = value as Partial<FixBackup>
  return (
    typeof backup.id === 'string' &&
    isBackupId(backup.id) &&
    typeof backup.createdAt === 'number' &&
    typeof backup.chartPath === 'string' &&
    (backup.chartType === 'folder' || backup.chartType === 'sng') &&
    typeof backup.code === 'string' &&
    typeof backup.actionCode === 'string' &&
    typeof backup.describe === 'string' &&
    (typeof backup.chartHash === 'string' || backup.chartHash === null) &&
    // Tolerated when absent, unlike every other field here: see `FixBackup.cloneHeroChecksum`.
    (backup.cloneHeroChecksum === undefined ||
      typeof backup.cloneHeroChecksum === 'string' ||
      backup.cloneHeroChecksum === null) &&
    Array.isArray(backup.files) &&
    backup.files.every(
      (file) =>
        typeof file?.fileName === 'string' &&
        typeof file?.blob === 'string' &&
        BLOB_RE.test(file.blob) &&
        typeof file?.byteLength === 'number' &&
        typeof file?.sha256 === 'string'
    ) &&
    Array.isArray(backup.remove) &&
    backup.remove.every((name) => typeof name === 'string') &&
    Array.isArray(backup.metadata) &&
    backup.metadata.every(
      (entry) =>
        typeof entry?.key === 'string' && (typeof entry.value === 'string' || entry.value === null)
    ) &&
    typeof backup.sizeBytes === 'number' &&
    isBackupGuard(backup.guard)
  )
}

function isBackupGuard(value: unknown): value is BackupGuard {
  if (typeof value !== 'object' || value === null) return false
  const guard = value as Partial<BackupGuard> & Record<string, unknown>
  if (guard.chartType === 'sng') {
    return (
      isFileStamp(guard.archive) &&
      Array.isArray(guard.entries) &&
      guard.entries.every(
        (entry: unknown) =>
          typeof (entry as { fileName?: unknown })?.fileName === 'string' &&
          ((entry as { byteLength?: unknown }).byteLength === null ||
            typeof (entry as { byteLength?: unknown }).byteLength === 'number')
      ) &&
      Array.isArray(guard.metadata) &&
      guard.metadata.every(
        (entry: unknown) =>
          typeof (entry as { key?: unknown })?.key === 'string' &&
          ((entry as { value?: unknown }).value === null ||
            typeof (entry as { value?: unknown }).value === 'string')
      )
    )
  }
  if (guard.chartType !== 'folder') return false
  return (
    Array.isArray(guard.files) &&
    guard.files.every(
      (file: unknown) =>
        typeof (file as { fileName?: unknown })?.fileName === 'string' &&
        ((file as { stamp?: unknown }).stamp === null ||
          isFileStamp((file as { stamp?: unknown }).stamp))
    )
  )
}

function isFileStamp(value: unknown): value is FileStamp {
  const stamp = value as Partial<FileStamp> | null | undefined
  return typeof stamp?.size === 'number' && typeof stamp?.mtimeMs === 'number'
}

/** One backup by id, or null when the id is not one of ours or names nothing complete. */
export function readBackup(storeDir: string, id: string): FixBackup | null {
  const dir = backupDirPath(storeDir, id)
  return dir === null ? null : tryReadManifest(dir)
}

/**
 * Remove one backup and its blobs.
 *
 * Called after a successful restore, where the chart is back to where it started, so the bytes
 * have done their job and the guard would no longer match anyway. The undo panel's per-entry
 * delete calls it too. A no-op for an id that is not ours.
 */
export function deleteBackup(storeDir: string, id: string): void {
  const dir = backupDirPath(storeDir, id)
  if (dir !== null) rmSync(dir, { recursive: true, force: true })
}

/**
 * Remove every backup, complete or not.
 *
 * The whole store rather than its entries one at a time, so an interrupted backup (a directory
 * with blobs and no manifest, which `listBackups` cannot see) is reclaimed too. Those are the
 * entries most likely to be large: a backup is interrupted while copying a video, not while
 * writing a `song.ini`.
 */
export function clearBackups(storeDir: string): void {
  rmSync(storeDir, { recursive: true, force: true })
}
