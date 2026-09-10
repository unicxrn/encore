import { chmodSync, renameSync, rmSync, statSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  planEntryFromFile,
  putPlanEntrySource,
  readRepackPlan,
  repackSng,
  sourceByteLength,
  type RepackEntry,
  type RepackPlan
} from '../downloads/sng-repack'
import { maskChunk } from '../downloads/sng-write'
import { volumeFreeBytes } from './free-space'
import { assertUnderLibrary } from './library-guard'
import { isStaleSibling, type StaleSiblingOptions } from './stale-siblings'

/**
 * Ceiling on the asset being written in, in bytes. It does NOT count the archive.
 *
 * What it replaced, and why the replacement bounds something different. `MAX_REPACK_BYTES` was 640
 * MiB against the archive PLUS the asset, sized against peak memory back when a repack decoded
 * every entry, rebuilt the archive as one Buffer and read the whole thing back to check it. That
 * put about 6.3x the content resident at once, measured at 3,271 MiB and 4.98 s for the largest
 * chart in the reference library (544,453,793 bytes, 519.2 MiB). Summing the two was right then,
 * because both were resident.
 *
 * Both halves now stream: `repackSng` copies each entry through one reused buffer and
 * `verifyRepack` compares the result the same way, so the archive is never resident at all. That
 * measured 128 MiB peak RSS and 0.71-0.88 s for that same chart, of which ~126 MiB was already
 * resident before the repack began. An archive-sized term in a memory bound now describes nothing,
 * and the old sum refused `Of Mice & Men - Bloom` any video at all: at 519.2 MiB it had 120.8 MiB
 * of headroom, less than a 1080p music video.
 *
 * The asset is a different matter, and is why this is a ceiling rather than nothing. Callers hand
 * `writeSngAsset` a `Uint8Array`, and the video path materialises one with `readFileSync`
 * (sidecars/ytdlp.ts), so the asset is still held whole in memory: one allocation, once, and the
 * only term left that scales with anything. Peak RSS for a write is therefore the asset plus a
 * constant, and the constant is small: adding a 512 MiB entry to that 519.2 MiB chart (a 1,031 MiB
 * destination, every one of the source's five entries copied) peaked at 594 MiB in a Node harness
 * whose idle RSS was 70 MiB, i.e. 6 MiB above the moment the asset buffer was allocated. That
 * 6 MiB held at 1 MiB, 130 MiB and 512 MiB of asset, which is the shape the bound assumes.
 *
 * The value is Node's own limit rather than a number picked for comfort. `readFileSync` refuses
 * anything at or above 2 GiB (`kIoMaxLength`) with `ERR_FS_FILE_TOO_LARGE`, so 2,147,483,647 bytes
 * is the largest asset the video path can physically produce; a higher ceiling here would let
 * yt-dlp transfer a file for minutes and then fail on the read with a message about internals.
 * Putting the ceiling exactly there turns that into a `--max-filesize` yt-dlp honours before it
 * transfers anything, and, for the art and background paths, a refusal naming the file.
 *
 * It refuses nothing real. Videos are the only asset near this size, and the largest in the
 * reference library is 1,239,823,296 bytes (1.15 GiB). That is also why the obvious tidier value of
 * 1 GiB was rejected: it would have refused a video the user already has.
 *
 * NOT a disk-space bound. That is `assertRepackSpace`, which is the constraint that actually
 * survived this milestone.
 *
 * **It does not apply to a file-backed asset, and must not.** M14 added `{ kind: 'file' }` entry
 * sources: `writeSngAssetContent` hands the repacker a path and both the rebuild and the verify
 * stream it a chunk at a time, so nothing about such an asset is ever resident and the
 * `readFileSync` limit this number encodes describes nothing it does. `writeSngAssetContent`
 * therefore checks it for `data` assets only. The disk-space check applies to both.
 */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024 - 1

export interface RepackOptions extends StaleSiblingOptions {
  /** Override for the asset ceiling. A test seam: no test can produce a 2 GiB file. */
  maxAssetBytes?: number
  /**
   * Override for the measured free space on the chart's volume, in bytes. A test seam: filling a
   * real disk is not something a test can do, and the alternative, mocking `node:fs`, would
   * stop testing the module that ships.
   */
  freeBytes?: number
}

/** Distinguishes concurrent repacks of one archive; see the tmp path comment below. */
let repackCounter = 0

/**
 * Refuse an asset too large to hold in memory, before anything is read or written.
 *
 * Exported because more than one entry point needs to refuse before it commits to the expensive
 * part. writeSngAsset calls it on the bytes it was handed; the video path (sidecars/ytdlp.ts)
 * calls it once the download has landed, against the size of the file that actually arrived
 * rather than the one a format advertised, so that an oversized video is refused before
 * `readFileSync` pulls it into memory.
 *
 * NOT called by injectLyrics, which reads a `.sng` whole to get at its chart text and is
 * therefore unbounded in the archive's size; see the note on that function.
 */
export function assertAssetSize(
  fileName: string,
  incomingBytes: number,
  maxBytes: number = MAX_ASSET_BYTES
): void {
  if (incomingBytes > maxBytes) {
    throw new Error(
      `${fileName} is too large to write into a chart (${incomingBytes} bytes exceeds ${maxBytes})`
    )
  }
}

/**
 * Refuse a repack the volume cannot hold, before it spends minutes proving the same thing.
 *
 * This is what the old ceiling was accidentally doing that still needed doing. A streaming repack
 * writes a whole second archive beside the first and only removes the first by renaming over it,
 * so source and destination coexist for the length of the operation: the volume needs the
 * archive's size again, plus the asset. Streaming did not change that. It is the one cost this
 * milestone did not remove.
 *
 * Running out mid-write is survivable rather than catastrophic: `repackSng` deletes its partial
 * destination and `writeSngAsset` deletes it again, the chart is untouched because the rename
 * never happens, and the destination name is free for a retry (pinned by a test in
 * downloads/sng-repack.test.ts). What it is not is quick or clear: 519 MiB of copying, then an
 * ENOSPC. Checking first turns that into an immediate message naming both numbers.
 *
 * Advisory, in two directions, and deliberately so:
 *
 * - `archiveBytes + incomingBytes` OVERSTATES the destination when the write replaces an existing
 *   entry or `removeMatching` drops one, since those bytes are not copied forward. Overstating is
 *   the safe direction for a check that exists to stop a write.
 * - The figure is stale the moment it is read. Another process can take the space between here and
 *   the last byte, and on a copy-on-write or compressing filesystem `bavail` does not predict what
 *   the write will actually consume. It cannot replace the mid-write handling above; it only makes
 *   the common case fail fast and legibly.
 *
 * A `statfs` that fails is not a refusal. It means the platform or filesystem would not answer,
 * which is not evidence of a full disk, and turning an unanswered question into a blocked write
 * would make Encore refuse to work somewhere it otherwise would.
 */
export function assertRepackSpace(
  sngPath: string,
  incomingBytes: number,
  freeBytes: number | undefined = volumeFreeBytes(dirname(sngPath))
): void {
  if (freeBytes === undefined) return
  const needed = statSync(sngPath).size + incomingBytes
  if (freeBytes < needed) {
    throw new Error(
      `Not enough free space to repack this chart: it needs about ${needed} bytes beside the original, and ${freeBytes} bytes are free`
    )
  }
}

/**
 * Add or replace one file inside a .sng chart.
 *
 * This is the only code in the app that rewrites a chart archive wholesale. injectLyrics already
 * rewrites a folder chart's notes.chart in place, and with no verification at all, but that risks
 * one file rather than every file the chart has. Rebuilding an archive puts all of
 * them through the writer at once, so this path is deliberately paranoid: the rebuilt archive
 * goes to a sibling temp, is checked against the chart it was built from, and only then is
 * allowed to replace it. A bug in the writer costs a temp file rather than the chart.
 *
 * What that buys, precisely: the bytes now on disk parse, hold every entry the original had plus
 * the new one at the length and offset the header declares, carry exactly the original's header
 * metadata, and hold, entry by entry and chunk by chunk, the same bytes as the archive they came
 * from.
 * What it does not buy: proof that Clone Hero accepts the file. buildSng was hand-derived from
 * parse-sng's reader, so the two share a lineage: a field the game validates and parse-sng
 * ignores is invisible to both, and a rebuild that lost it verifies clean. Only playing a real
 * repacked chart settles that.
 *
 * It also does not revalidate the chart it was handed. The rebuild copies each unchanged entry's
 * masked bytes without decoding them (see downloads/sng-repack.ts), so a chart whose data section
 * was already damaged comes back damaged in exactly the same way. That is the honest trade for a
 * repack whose cost is three fixed buffers rather than the whole archive: this promises to change
 * one entry and nothing else, not to certify the rest.
 *
 * `options.removeMatching` exists because replacing an asset that has several accepted names is
 * not the same operation as adding one: `album.png` does not replace `album.jpg` by name, so the
 * archive keeps both and scan-chart reports `multipleAlbumArt`. See `isStaleSibling`.
 */
export async function writeSngAsset(
  sngPath: string,
  fileName: string,
  data: Uint8Array,
  libraryFolders: { path: string }[],
  options: RepackOptions = {}
): Promise<string> {
  return writeSngAssetContent(sngPath, fileName, { kind: 'data', data }, libraryFolders, options)
}

/**
 * What a caller is putting into the archive: bytes it holds, or a file it has already written.
 *
 * The second exists for video conversion (M14). The background videos in the reference library run
 * to 151.6 MiB and ffmpeg has just written the converted one to a temp file; reading it back into
 * a `Uint8Array` only to hand it to a repacker that writes it out again in 1 MiB chunks would put
 * the whole file in the main process's heap to move bytes from one path to another.
 *
 * Measured on that chart (`BABYMETAL - Rondo Of Nightmare`, a 155.7 MiB archive holding a 151.6 MiB
 * video), writing the video back in as a file source peaked at **4.8 MiB over a 80.2 MiB
 * baseline**, the whole repack and its verification included. `new Uint8Array(readFileSync(path))`
 * on the same file, before any archive work at all, cost **305.2 MiB** (the read's Buffer plus the
 * copy) and left the process at 385.4 MiB.
 */
export type AssetContent =
  | { kind: 'data'; data: Uint8Array }
  /** Path to a file the caller owns; it must still be there when the repack and verify read it. */
  | { kind: 'file'; path: string }

/**
 * `writeSngAsset` over either kind of content. See `AssetContent` for why the second exists.
 *
 * Does NOT take the per-chart lock: `writeChartFile` is the locking entry point, and the M14 fix
 * framework holds the lock across a whole action (`issues/fix.ts`), which a second acquisition
 * here would deadlock against, and `withChartLock` is documented as not re-entrant.
 */
export async function writeSngAssetContent(
  sngPath: string,
  fileName: string,
  content: AssetContent,
  libraryFolders: { path: string }[],
  options: RepackOptions = {}
): Promise<string> {
  // Canonicalizes before comparing, so a .sng that is a symlink out of the library is judged
  // by the file it would actually rewrite, not by where the link sits.
  assertUnderLibrary(sngPath, libraryFolders)
  if (!fileName || fileName !== basename(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`Asset file name must be a bare name: ${JSON.stringify(fileName)}`)
  }

  const source =
    content.kind === 'data'
      ? { kind: 'data' as const, data: content.data }
      : await planEntryFromFile(content.path)
  const incomingBytes = sourceByteLength(source)

  // Before the archive is opened, so an oversized asset costs a stat rather than a read of the
  // chart. The size ceiling is a memory bound and so applies only to the resident kind (see
  // MAX_ASSET_BYTES). The disk-space check belongs to `rewriteSngPlan`, which does it for every
  // rebuild rather than only this one.
  if (content.kind === 'data') {
    assertAssetSize(fileName, incomingBytes, options.maxAssetBytes ?? MAX_ASSET_BYTES)
  }

  const { removeMatching } = options
  return rewriteSngPlan(
    sngPath,
    // Dropping the superseded entries here, in the rebuild that adds the new one, rather than in
    // a repack of their own: the archive is only ever swapped for a complete one, so there is no
    // moment where the chart has lost its old cover and not yet gained the new one.
    (plan) =>
      putPlanEntrySource(plan, fileName, source, {
        removeMatching: removeMatching
          ? (name) => isStaleSibling(name, fileName, removeMatching)
          : undefined
      }),
    libraryFolders,
    { freeBytes: options.freeBytes, incomingBytes }
  )
}

export interface RewriteSngOptions {
  /** As in `RepackOptions`: a test seam for the measured free space on the chart's volume. */
  freeBytes?: number
  /**
   * How many bytes the rebuild adds that the source does not already hold, for the space check.
   * Zero for a rewrite that only removes entries or edits header metadata, which is the safe
   * direction, because the destination is then no larger than the source.
   */
  incomingBytes?: number
}

/**
 * Rebuild a `.sng` from a transformed plan, verify the result, and swap it in.
 *
 * The whole of `writeSngAssetContent`'s machinery minus the opinion about what changed: the
 * space check, the sibling temp, the permission carry-over, `verifyRepack`, the atomic rename and
 * the cleanup are identical whether the rebuild adds a cover, drops a stray `desktop.ini` or
 * edits a header key. M14's issue fixes need the second and third of those (issues/actions), and
 * a second copy of this sequence would be a second place for the ordering to drift. That ordering
 * is the only thing keeping a failed rebuild from reaching the user's chart.
 *
 * `build` is given the plan read from `sngPath` and returns the plan to write. It must not mutate
 * what it was given: that plan describes the archive still on disk and is what `verifyRepack`
 * compares copied entries against.
 *
 * **`verifyRepack` checks the destination against the returned plan, not against the source**, so
 * a deliberate change (a removed entry, an edited metadata key) verifies as correct rather than
 * as corruption. What it still proves is that the archive on disk is exactly the archive that was
 * asked for: every entry present at the declared length and offset, every copied byte identical
 * to the range it came from, the same mask, and the same metadata keys with no key invented.
 *
 * Does NOT take the per-chart lock, for the same reason `writeSngAssetContent` does not: the M14
 * fix framework holds it across a whole action, and `withChartLock` is not re-entrant.
 */
export async function rewriteSngPlan(
  sngPath: string,
  build: (plan: RepackPlan) => RepackPlan,
  libraryFolders: { path: string }[],
  options: RewriteSngOptions = {}
): Promise<string> {
  assertUnderLibrary(sngPath, libraryFolders)
  // Before the archive is opened, so a full volume costs a stat rather than minutes of copying.
  assertRepackSpace(sngPath, options.incomingBytes ?? 0, options.freeBytes)

  const original = statSync(sngPath)
  // The header only: every entry's name, length and offset, and nothing of the bodies. The plan
  // that comes back describes the archive still on disk, which is what makes it usable as the
  // expectation the rebuild is checked against.
  const plan = await readRepackPlan(sngPath)
  const next = build(plan)

  // Same directory as the chart, so the rename is atomic; unique per call, because the tmp name
  // is keyed on the archive rather than the asset and two writers on one chart (a per-chart art
  // action during a batch, say) would otherwise share one path. Writer A verifies its own bytes,
  // B then overwrites the temp with a different complete archive, and A renames B's unverified
  // bytes over the chart while reporting success. Uniqueness rules that out, and repackSng
  // opens its destination `wx`, so a collision fails loudly rather than adopting the other
  // writer's file. It does not make concurrent repacks safe: both read the same original, and
  // the later rename silently drops the earlier one's asset. The .tmp suffix keeps a scan that
  // lands mid-write from indexing it: the scanner only collects files ending in .sng
  // (catalog/scanner.ts).
  const tmpPath = join(
    dirname(sngPath),
    `.${basename(sngPath)}.${process.pid}.${repackCounter++}.tmp`
  )
  try {
    // sngPath is only read here, and is still the chart until the rename below.
    await repackSng(sngPath, tmpPath, next)
    // The temp is a fresh file, so it carries default permissions rather than the chart's. A
    // chart the user had locked down to 0600 would come back 0644 after the rename. Only the
    // mode is carried over: owner, ACLs and xattrs are not, and mtime deliberately changes,
    // because the scanner uses a .sng's mtime as its content stamp and a repack must look new.
    chmodSync(tmpPath, original.mode & 0o7777)
    await verifyRepack(sngPath, tmpPath, next)
    renameSync(tmpPath, sngPath)
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // Cleanup must not replace the reason the repack failed. `force` already swallows a
      // missing temp; what is left is the likes of EISDIR or a read-only directory, where
      // rethrowing would discard the original cause and leave the caller debugging the wrong
      // failure. The chart is untouched either way; the cost is a stray temp file.
    }
    throw err
  }
  return sngPath
}

/**
 * How much of an entry is compared at a time.
 *
 * Verification holds two of these, one chunk of the rebuild and one of what it should be, and
 * nothing else that scales with the archive, so its peak is flat in archive size for the same
 * reason the rebuild's is. That symmetry is the point: a buffered verify of a streamed build
 * would put the whole peak straight back, and the milestone would be for nothing.
 */
const VERIFY_CHUNK_BYTES = 1024 * 1024

export interface VerifyRepackOptions {
  /** Test seam, as in `repackSng`: how many bytes are compared per round trip. */
  chunkBytes?: number
}

/**
 * Prove the rebuilt archive at `destPath` is the archive `plan` describes, reading both files a
 * chunk at a time.
 *
 * `sourcePath` is the chart the plan was read from, and is needed rather than optional: an entry
 * the rebuild copied was never decoded by this process, so the only thing its bytes can be
 * checked against is the range they came from.
 *
 * The comparison is done on MASKED bytes, on both sides, which is only sound because the mask is
 * checked first. A copied entry's masked bytes are position-independent, since parse-sng starts a
 * fresh unmasker at index 0 for each file, so equal masked bytes under one shared mask means
 * equal decoded bytes. Skip the mask check and this whole loop proves nothing about what a reader
 * would actually get back.
 *
 * Exported so its own checks can be driven with deliberately-wrong archives; writeSngAsset is
 * the only production caller, and calls it on the temp, before the rename. Nothing about that
 * ordering is negotiable.
 */
export async function verifyRepack(
  sourcePath: string,
  destPath: string,
  plan: RepackPlan,
  options: VerifyRepackOptions = {}
): Promise<void> {
  const chunkBytes = options.chunkBytes ?? VERIFY_CHUNK_BYTES
  let back: RepackPlan
  try {
    back = await readRepackPlan(destPath)
  } catch (err) {
    throw new Error(`Rebuilt chart failed verification: it could not be read back (${String(err)})`)
  }

  if (back.entries.length !== plan.entries.length) {
    throw new Error(
      `Rebuilt chart failed verification: expected ${plan.entries.length} files, found ${back.entries.length}`
    )
  }
  // The one failure with no symptom. Copied entries were never unmasked, so an archive that
  // declares any other mask still reports every correct name, length and offset while every byte
  // a reader unmasks comes back as noise. The byte comparison below cannot see it either, because
  // the bytes really are identical to the source's.
  if (Buffer.compare(back.xorMask, plan.xorMask) !== 0) {
    throw new Error(
      'Rebuilt chart failed verification: it declares a different xorMask, so its copied entries would not decode'
    )
  }
  for (const [key, value] of Object.entries(plan.metadata)) {
    if (back.metadata[key] !== value) {
      throw new Error(`Rebuilt chart failed verification: metadata ${key} did not round-trip`)
    }
  }
  // The loop above only walks expected -> actual, so a rebuild that INVENTED a header field
  // would pass it. Header metadata is what Clone Hero shows as the song's title, artist and
  // difficulty ratings, so a key we made up is a visible change to the user's chart. Together
  // the two checks prove the key sets are equal, not merely that ours survived.
  const added = Object.keys(back.metadata).filter((key) => !Object.hasOwn(plan.metadata, key))
  if (added.length > 0) {
    throw new Error(`Rebuilt chart failed verification: metadata gained ${added.sort().join(', ')}`)
  }

  // Matched one-to-one out of a shrinking pool rather than looked up by name: an archive that
  // packs the same name twice would otherwise pair both copies with the first match and be
  // rejected even when the rebuild is byte-perfect. Combined with the count check above, every
  // entry read back is accounted for by exactly one expected entry.
  const unmatched = [...back.entries]
  const pairs = plan.entries.map((want) => {
    const at = unmatched.findIndex((entry) => entry.fileName === want.fileName)
    if (at === -1) throw new Error(`Rebuilt chart failed verification: ${want.fileName} is missing`)
    return { want, got: copyRange(unmatched.splice(at, 1)[0]) }
  })

  const source = await open(sourcePath, 'r')
  try {
    const dest = await open(destPath, 'r')
    try {
      await assertEntriesFillArchive(dest, back.entries)

      const actual = Buffer.allocUnsafe(chunkBytes)
      const wanted = Buffer.allocUnsafe(chunkBytes)
      /** Read the rebuild's chunk and prove it is the `wanted` bytes already staged. */
      const assertChunkMatches = async (
        fileName: string,
        gotOffset: number,
        at: number,
        length: number
      ): Promise<void> => {
        await readExact(dest, actual, length, gotOffset + at, `${fileName} in the rebuild`)
        if (Buffer.compare(actual.subarray(0, length), wanted.subarray(0, length)) !== 0) {
          throw new Error(`Rebuilt chart failed verification: ${fileName} does not match`)
        }
      }

      for (const { want, got } of pairs) {
        // Bound to a const so each branch below keeps its narrowing; `want.source` is a property
        // and would widen again inside the callback.
        const src = want.source
        const byteLength = sourceByteLength(src)
        if (got.byteLength !== byteLength) {
          throw new Error(
            `Rebuilt chart failed verification: ${want.fileName} is ${got.byteLength} bytes, expected ${byteLength}`
          )
        }

        if (src.kind === 'file') {
          // Re-read from the same path the repack read, a chunk at a time, for the same reason
          // that kind exists: a 159 MB video must not become a Buffer on either side of the
          // check. What this proves is what it proves for `data`: the rebuild holds the bytes
          // the PLAN named. If the file changed under both, both change together.
          const added = await open(src.path, 'r')
          try {
            for (let at = 0; at < byteLength; at += chunkBytes) {
              const length = Math.min(chunkBytes, byteLength - at)
              await readExact(added, wanted, length, at, `${want.fileName} on disk`)
              maskChunk(wanted, wanted.subarray(0, length), at, plan.xorMask)
              await assertChunkMatches(want.fileName, got.offset, at, length)
            }
          } finally {
            await added.close()
          }
          continue
        }

        for (let at = 0; at < byteLength; at += chunkBytes) {
          const length = Math.min(chunkBytes, byteLength - at)
          if (src.kind === 'copy') {
            await readExact(
              source,
              wanted,
              length,
              src.offset + at,
              `${want.fileName} in the original`
            )
          } else {
            // Masked into the comparison buffer rather than the asset being unmasked out of the
            // rebuild, so the incoming bytes are never copied whole.
            maskChunk(wanted, src.data.subarray(at, at + length), at, plan.xorMask)
          }
          await assertChunkMatches(want.fileName, got.offset, at, length)
        }
      }
    } finally {
      await dest.close()
    }
  } finally {
    await source.close()
  }
}

/**
 * `readRepackPlan` builds every entry as a `copy`, so this narrows rather than checks.
 *
 * The throw is unreachable from the one call site above and exists because the alternative is a
 * cast, which would go on being true after someone changes what a plan can hold.
 */
function copyRange(entry: RepackEntry): { offset: number; byteLength: number } {
  if (entry.source.kind !== 'copy') {
    throw new Error(`Rebuilt chart failed verification: ${entry.fileName} declares no byte range`)
  }
  return entry.source
}

/**
 * Check the rebuild's entries run back to back from the end of its header to the end of the file.
 *
 * Every comparison above reads an entry at the offset its header declares, which is where Clone
 * Hero seeks. parse-sng, and so the scanner, the extractor and every other reader in this app,
 * ignores `contentsIndex` entirely and walks the data section start to finish instead. Those are
 * two different readings of one file, and the old verification, which only ever read
 * sequentially, could not produce the first. This is what keeps them the same bytes: with no
 * gap, no overlap and nothing trailing, seeking to each declared offset and reading straight
 * through return the same entries in the same order.
 *
 * The data section's start is derived here the way a reader derives it (parse-sng's `_start`
 * adds up the two declared section lengths from a fixed 6+4+16 byte preamble) rather than from
 * `buildSngHeader`, so it is the offset a reader will compute and not the one the writer meant.
 */
async function assertEntriesFillArchive(dest: FileHandle, entries: RepackEntry[]): Promise<void> {
  if (entries.length === 0) return
  const field = Buffer.allocUnsafe(8)
  await readExact(dest, field, 8, 6 + 4 + 16, 'the rebuilt header')
  const fileMetaLenAt = 6 + 4 + 16 + 8 + Number(field.readBigUInt64LE(0))
  await readExact(dest, field, 8, fileMetaLenAt, 'the rebuilt header')
  let expected = fileMetaLenAt + 8 + Number(field.readBigUInt64LE(0)) + 8

  for (const entry of entries) {
    const { offset, byteLength } = copyRange(entry)
    if (offset !== expected) {
      throw new Error(
        `Rebuilt chart failed verification: ${entry.fileName} sits at ${offset}, not ${expected}`
      )
    }
    expected += byteLength
  }
  // The open handle rather than the path: the file being measured has to be the one just read.
  const { size } = await dest.stat()
  if (size !== expected) {
    throw new Error(
      `Rebuilt chart failed verification: the archive is ${size} bytes but its entries end at ${expected}`
    )
  }
}

/**
 * Read exactly `length` bytes into the front of `buffer`, or fail naming what was being read.
 *
 * A positional read is allowed to return fewer bytes than asked for. A short read treated as
 * complete leaves the tail of the buffer holding the previous chunk, so the comparison below
 * runs on bytes nobody read: usually that is a spurious mismatch, which fails a good repack, but
 * if both sides come up short in the same place it is a pass. Neither belongs in the check that
 * stands between a rebuild and the user's chart.
 */
async function readExact(
  handle: FileHandle,
  buffer: Uint8Array,
  length: number,
  position: number,
  what: string
): Promise<void> {
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read)
    if (bytesRead <= 0) {
      throw new Error(
        `Rebuilt chart failed verification: ${what} ended early (wanted ${length} bytes at ${position}, got ${read})`
      )
    }
    read += bytesRead
  }
}
