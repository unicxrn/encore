import { open, rm, stat, type FileHandle } from 'node:fs/promises'
import { SngStream } from 'parse-sng'
import { readSngFile } from './sng'
import { buildSngHeader, maskChunk } from './sng-write'

/**
 * Rewrites a .sng archive by copying byte ranges, in bounded memory.
 *
 * The old path read every entry into memory, rebuilt the archive as one Buffer, wrote it, and read
 * it back to check it, which put around 6.3x the archive resident at once, measured at ~3.2 GB for
 * the 519 MiB chart in the reference library. Nothing about that is required by the format.
 *
 * Two facts make the streaming version possible:
 *
 * 1. `readRepackPlan` gets the whole header (mask, metadata, and every entry's name, length and
 *    absolute offset) from parse-sng's `header` event, which fires as soon as the header's
 *    bytes have arrived. parse-sng's `_start` returns at that point and only reads further when
 *    an emitted file stream is pulled, so a plan for the 519 MiB chart costs one 64 KiB read.
 *
 * 2. The XOR mask keys off each byte's index WITHIN ITS OWN FILE, as `data[i] ^ (mask[i % 16] ^
 * (i % 256))`, rather than off its offset in the archive, and parse-sng builds a fresh unmasker per
 * file starting at index 0. An entry's masked bytes are therefore identical wherever the entry
 * sits, so an unchanged entry can be copied verbatim: no unmask, no remask, no decode.
 *
 * Fact 2 carries the sharpest edge in this module. Copied bytes only decode under the mask they
 * were written with, so the destination MUST declare the source's `xorMask`. Get it wrong and
 * every section length, every contentsLen and every contentsIndex still reads as correct while
 * every copied byte decodes to noise. There is no parse error and no failed check, just charts
 * that stop loading. `readRepackPlan` carries the mask through for that reason alone.
 *
 * This module writes an archive; it does not verify one, and it does not touch the chart it read
 * from. Verification and the rename belong to the caller.
 */

/** Where one output entry's bytes come from. */
export type RepackEntrySource =
  /** Bytes already masked under `plan.xorMask`, at `offset` in the source archive. */
  | { kind: 'copy'; offset: number; byteLength: number }
  /** Unmasked bytes the caller is adding; this module masks them on the way out. */
  | { kind: 'data'; data: Uint8Array }
  /**
   * An unmasked file the caller is adding, read a chunk at a time rather than held whole.
   *
   * `data` is the right shape for an album cover and the wrong one for a video: M14 converts
   * background videos of 18-159 MB, and the converted output would sit in a Buffer across the
   * whole repack, plus a second copy inside `verifyRepack`, for no reason, since both walk the
   * entry in order and neither needs the byte before the one it is writing. `byteLength` is
   * settled when the entry is added (`planEntryFromFile`) so the header can be laid out before
   * anything is read, exactly as it is for the other two kinds.
   */
  | { kind: 'file'; path: string; byteLength: number }

export interface RepackEntry {
  fileName: string
  source: RepackEntrySource
}

export interface RepackPlan {
  entries: RepackEntry[]
  /** Header metadata, verbatim from the source archive; no key is guaranteed present. */
  metadata: Record<string, string>
  /** The source archive's own mask. Copied entries only decode under this one. */
  xorMask: Uint8Array
}

/**
 * How long the entry a source describes will be on disk.
 *
 * Exported because the verifier asks the same question of the same plan, and the answer is a
 * property of the type rather than of either caller.
 */
export function sourceByteLength(source: RepackEntrySource): number {
  return source.kind === 'data' ? source.data.length : source.byteLength
}

/**
 * Read a source archive's header and describe it as a repack of itself: every entry copied from
 * where it already is.
 *
 * Deliberately not `readSngForRepack`, which decodes every entry into memory. The entire point
 * here is to learn the layout without reading the bodies. `readSngFile` closes the descriptor
 * before this settles, which is safe precisely because the plan is resolved from the header
 * alone; see `readRepackPlanFromStream`.
 */
export async function readRepackPlan(sngPath: string): Promise<RepackPlan> {
  return readSngFile(sngPath, readRepackPlanFromStream)
}

/**
 * The header half of `readRepackPlan`, over a stream the caller owns.
 *
 * Split out for the scan reader, which supplies the archive's leading bytes from a descriptor it
 * keeps open afterwards to fetch selected entries. Nothing about learning a layout depends on
 * where the bytes come from, and a second copy of the subtleties below would be a second place
 * to get them wrong.
 *
 * Resolving inside the `header` handler is what keeps the data section unread: parse-sng emits
 * `header` and then waits to be pulled, so returning at that moment means nothing past the
 * header has been asked for.
 *
 * `generateSongIni: false` matters as much as it does in `readSngForRepack`: with generation on,
 * parse-sng unshifts a synthetic song.ini into `fileMeta` with a `contentsIndex` of -1. Here that
 * would not merely add a spurious entry, it would describe a copy from a negative offset.
 */
export function readRepackPlanFromStream(stream: ReadableStream<Uint8Array>): Promise<RepackPlan> {
  return new Promise<RepackPlan>((resolve, reject) => {
    const sng = new SngStream(stream, { generateSongIni: false })
    sng.on('header', (header) => {
      resolve({
        entries: header.fileMeta.map((file) => ({
          fileName: file.filename,
          source: {
            kind: 'copy',
            offset: Number(file.contentsIndex),
            byteLength: Number(file.contentsLen)
          }
        })),
        metadata: header.metadata,
        // Copied, not aliased: the plan outlives the parser, and callers compare masks.
        xorMask: new Uint8Array(header.xorMask)
      })
    })
    sng.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    sng.start()
  })
}

export interface PutPlanEntryOptions {
  /**
   * Also drop existing entries this returns true for. Replacing an asset that has several
   * accepted names is not the same operation as adding one: `album.png` does not replace
   * `album.jpg` by name, so without this the archive keeps both. See `isStaleSibling`.
   */
  removeMatching?: (fileName: string) => boolean
}

/**
 * Add or replace one entry, as a new plan.
 *
 * Returns a new plan rather than mutating: the caller's plan describes the archive still on
 * disk, and it is the thing they would fall back to if the repack fails.
 *
 * Appends rather than replacing in place, matching what the in-memory repack did before it, so
 * a rebuilt archive's entry order is unchanged from what the app has always produced. Nothing in
 * the format or in Clone Hero depends on the order; leaving it alone keeps this task's diff to
 * the bytes it means to change.
 */
export function putPlanEntry(
  plan: RepackPlan,
  fileName: string,
  data: Uint8Array,
  options: PutPlanEntryOptions = {}
): RepackPlan {
  return putPlanEntrySource(plan, fileName, { kind: 'data', data }, options)
}

/**
 * `putPlanEntry` over any source, for a caller adding a file rather than bytes.
 *
 * Same rules, and deliberately the same function underneath: which kind of source an entry has
 * must not change whether it replaces an entry of the same name or what `removeMatching` drops.
 */
export function putPlanEntrySource(
  plan: RepackPlan,
  fileName: string,
  source: RepackEntrySource,
  options: PutPlanEntryOptions = {}
): RepackPlan {
  const { removeMatching } = options
  const entries = plan.entries.filter(
    (entry) => entry.fileName !== fileName && !removeMatching?.(entry.fileName)
  )
  entries.push({ fileName, source })
  return { ...plan, entries }
}

/**
 * Describe a file on disk as an entry source, taking its length now.
 *
 * The length is read once, here, rather than at write time: `buildSngHeader` needs every entry's
 * length before a single byte is written, so a file that changed size between the plan and the
 * repack could not be accommodated anyway. Taking it up front means such a file fails as a short
 * read naming the entry (`readExact`) instead of silently producing an archive whose header
 * disagrees with its contents. Callers pass their own freshly-written temp file, which nothing
 * else is writing to.
 */
export async function planEntryFromFile(path: string): Promise<RepackEntrySource> {
  const { size } = await stat(path)
  return { kind: 'file', path, byteLength: size }
}

/**
 * How much of an entry is held in memory at once, and the only allocation that scales with
 * anything. One buffer is reused for every chunk of every entry, so peak usage is this plus the
 * header regardless of whether the archive is 3 MiB or 519 MiB.
 *
 * 1 MiB is a compromise, not a measurement: large enough that a 519 MiB entry is ~520 round
 * trips rather than ~8300, small enough to be irrelevant to a main process that used to peak at
 * 3.2 GB doing this.
 */
const DEFAULT_CHUNK_BYTES = 1024 * 1024

export interface RepackSngOptions {
  /**
   * Test seam. Real chunk sizes are powers of two and the mask repeats every 256 bytes, so an
   * implementation that restarted the mask index on each chunk would produce byte-identical
   * output at any realistic size. A chunk size coprime with 256 is the only way to see it.
   */
  chunkBytes?: number
}

/**
 * Write `plan` to `destPath`, copying `kind: 'copy'` ranges out of `sourcePath` untouched.
 *
 * `destPath` must not exist; it is opened `wx`. The caller owns the destination name, and a repack
 * that silently adopted a file already there would be writing over whatever a previous failed
 * attempt, or a concurrent one, had left mid-write. On failure the partial destination is
 * removed, so `wx` stays true on the next attempt.
 *
 * `sourcePath` is only ever read. It is legal for it to be the archive the caller intends to
 * replace afterwards, which is the whole point: the source is intact until the caller renames
 * over it.
 */
export async function repackSng(
  sourcePath: string,
  destPath: string,
  plan: RepackPlan,
  options: RepackSngOptions = {}
): Promise<void> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error(`Repack chunk size must be a positive integer, got ${chunkBytes}`)
  }
  // Built before anything is opened, so a rejected plan (an over-long name, a malformed mask)
  // costs nothing and leaves no file behind. `contentsIndexes` is then the authority on where
  // each entry goes: writing at the offset the header declares means the two cannot disagree.
  const header = buildSngHeader(
    plan.entries.map((entry) => ({
      fileName: entry.fileName,
      byteLength: sourceByteLength(entry.source)
    })),
    plan.metadata,
    plan.xorMask
  )

  const chunk = Buffer.allocUnsafe(chunkBytes)
  const source = await open(sourcePath, 'r')
  try {
    const dest = await open(destPath, 'wx')
    try {
      await writeAll(dest, header.bytes, header.bytes.length, 0)
      for (let i = 0; i < plan.entries.length; i++) {
        await writeEntry({
          dest,
          source,
          entry: plan.entries[i],
          destOffset: header.contentsIndexes[i],
          chunk,
          chunkBytes,
          xorMask: plan.xorMask
        })
      }
      await dest.close()
    } catch (err) {
      await dest.close().catch(() => {
        // Swallowed so the reason the repack failed survives; a leaked descriptor is the
        // lesser problem, and the process is about to surface an error either way.
      })
      await rm(destPath, { force: true }).catch(() => {
        // Likewise. `force` already covers a missing file; what is left is the likes of a
        // read-only directory, where the cost is a stray temp rather than a lost error.
      })
      throw err
    }
  } finally {
    await source.close()
  }
}

/**
 * Write one entry's bytes into the destination at the offset its header declares.
 *
 * Split out of `repackSng` because the `file` kind has to hold a descriptor for the length of one
 * entry and nothing longer, and a handle opened around the whole entry loop would either stay
 * open across every other entry or be re-opened for every chunk. Branching on the kind out here
 * also means each branch reads its own source with the union already narrowed.
 */
async function writeEntry(job: {
  dest: FileHandle
  source: FileHandle
  entry: RepackEntry
  destOffset: number
  chunk: Buffer
  chunkBytes: number
  xorMask: Uint8Array
}): Promise<void> {
  const { dest, source, entry, destOffset, chunk, chunkBytes, xorMask } = job
  const entrySource = entry.source
  const byteLength = sourceByteLength(entrySource)

  if (entrySource.kind === 'file') {
    const added = await open(entrySource.path, 'r')
    try {
      for (let at = 0; at < byteLength; at += chunkBytes) {
        const length = Math.min(chunkBytes, byteLength - at)
        await readExact(added, chunk, length, at, entry.fileName)
        // Masked in place: the XOR reads and writes one index at a time, so the chunk can be its
        // own source. Nothing here holds more of the file than this one chunk.
        maskChunk(chunk, chunk.subarray(0, length), at, xorMask)
        await writeAll(dest, chunk, length, destOffset + at)
      }
    } finally {
      await added.close()
    }
    return
  }

  for (let at = 0; at < byteLength; at += chunkBytes) {
    const length = Math.min(chunkBytes, byteLength - at)
    if (entrySource.kind === 'copy') {
      // Verbatim: these bytes are already masked, and under this plan's mask.
      await readExact(source, chunk, length, entrySource.offset + at, entry.fileName)
    } else {
      // `subarray` is a view, so this masks in place into the shared chunk rather than
      // allocating a second copy of an asset the caller already holds whole.
      maskChunk(chunk, entrySource.data.subarray(at, at + length), at, xorMask)
    }
    await writeAll(dest, chunk, length, destOffset + at)
  }
}

/**
 * Write `length` bytes from the front of `buffer` at `position`, however many calls that takes.
 *
 * A positional write is allowed to write fewer bytes than asked. Short writes are rare on a
 * regular file but not forbidden, and a partial write treated as complete would leave a hole in
 * the middle of an entry that every length and offset in the header still describes as intact.
 */
async function writeAll(
  handle: FileHandle,
  buffer: Uint8Array,
  length: number,
  position: number
): Promise<void> {
  let written = 0
  while (written < length) {
    const { bytesWritten } = await handle.write(
      buffer,
      written,
      length - written,
      position + written
    )
    // A full disk raises ENOSPC from write() rather than returning zero, so a zero here is a
    // condition we have no way to make progress against; looping on it would just spin.
    if (bytesWritten <= 0) {
      throw new Error(`Repack write made no progress at offset ${position + written}`)
    }
    written += bytesWritten
  }
}

/**
 * Read exactly `length` bytes into the front of `buffer`, or fail naming the entry.
 *
 * A short read here means the source no longer holds what its header promised: it was truncated
 * under us, or the header lied. Either way the destination cannot be completed, and the
 * alternative to failing is an archive padded with whatever the reused chunk last held.
 */
async function readExact(
  handle: FileHandle,
  buffer: Uint8Array,
  length: number,
  position: number,
  fileName: string
): Promise<void> {
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read)
    if (bytesRead <= 0) {
      throw new Error(
        `Source .sng ended before ${fileName} was fully copied (wanted ${length} bytes at ${position}, got ${read})`
      )
    }
    read += bytesRead
  }
}
