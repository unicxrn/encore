import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

/**
 * Minimal zip reader: pull one named entry out of an archive and write it to disk.
 *
 * It exists because ffmpeg ships as a zip on every platform and Node has no bundled unzip. But
 * zip entries are raw Deflate, which `node:zlib` already inflates, so this is a header parser
 * rather than a codec. That is the whole reason ffmpeg could finally be installed without a new
 * dependency.
 *
 * Deliberately not a general-purpose zip library. It reads exactly one entry, by exact name, and
 * refuses everything it does not fully understand (zip64, encryption, and compression methods
 * other than stored and deflate) rather than guessing at bytes it cannot interpret. Callers
 * verify the archive's SHA-256 before calling, so the failure it has to survive is our own
 * mis-parsing, not a hostile input.
 *
 * It streams rather than buffering: the Windows ffmpeg entry expands to 134 MB, and inflating
 * that synchronously in the main process would freeze every window while it ran.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/** An end-of-central-directory record with an empty comment, which is its minimum size. */
const EOCD_SIZE = 22
/** The comment length is a uint16, so the record can start at most this far from the end. */
const MAX_COMMENT = 0xffff
/** Fixed part of a central directory file header, before the name/extra/comment fields. */
const CENTRAL_HEADER_SIZE = 46
/** Fixed part of a local file header, before the name/extra fields. */
const LOCAL_HEADER_SIZE = 30

const METHOD_STORED = 0
const METHOD_DEFLATED = 8

/** General purpose bit 0: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x1

/** A uint32 field set to all ones means "the real value is in a zip64 extra field". */
const ZIP64_MARKER = 0xffffffff

interface CentralEntry {
  name: string
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/**
 * Extracts the entry named `entryName` from the zip at `zipPath`, writing it to `destPath`.
 *
 * Throws when the archive is truncated or malformed, when the entry is absent, or when the entry
 * uses a feature this reader refuses. `destPath` may be left partially written on failure, and
 * the caller stages extraction outside the final path for exactly that reason.
 */
export async function extractZipEntry(
  zipPath: string,
  entryName: string,
  destPath: string
): Promise<void> {
  const handle = await open(zipPath, 'r')
  let entry: CentralEntry
  let dataStart: number
  try {
    const { size } = await handle.stat()
    const eocd = await readEocd(handle, size)
    entry = await findEntry(handle, eocd, entryName)
    dataStart = await readDataStart(handle, entry)
    if (dataStart + entry.compressedSize > size) {
      throw new Error(`Zip is truncated: entry "${entryName}" runs past the end of the file`)
    }
  } finally {
    await handle.close()
  }

  // A zero-length entry has no byte range to stream: createReadStream would be handed an `end`
  // before its `start`. Write the empty file directly instead.
  if (entry.compressedSize === 0) {
    await writeFile(destPath, '')
  } else {
    const source = createReadStream(zipPath, {
      start: dataStart,
      end: dataStart + entry.compressedSize - 1
    })
    const sink = createWriteStream(destPath)
    if (entry.method === METHOD_DEFLATED) await pipeline(source, createInflateRaw(), sink)
    else await pipeline(source, sink)
  }

  // The only cross-check the central directory gives us for free. Inflate rejects garbage on its
  // own, so this mostly catches a plausible-but-wrong offset, where we decompressed real data
  // belonging to some other entry.
  const written = (await stat(destPath)).size
  if (written !== entry.uncompressedSize) {
    throw new Error(
      `Zip entry "${entryName}" extracted to ${written} bytes, expected ${entry.uncompressedSize}`
    )
  }
}

interface Eocd {
  entryCount: number
  centralDirOffset: number
  centralDirSize: number
}

async function readEocd(
  handle: import('node:fs/promises').FileHandle,
  size: number
): Promise<Eocd> {
  if (size < EOCD_SIZE) throw new Error('Zip is truncated: file is smaller than its trailer')
  const tailSize = Math.min(size, EOCD_SIZE + MAX_COMMENT)
  const tail = Buffer.alloc(tailSize)
  await handle.read(tail, 0, tailSize, size - tailSize)

  // Scan backwards: the record is at the very end unless there is a trailing comment, and the
  // last match is the right one if an inner entry's data happens to contain the signature.
  let at = -1
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue
    // Signature bytes alone are not proof: a 30 MB compressed payload will contain any given
    // four bytes. A real record's declared comment length accounts for the rest of the file.
    if (tail.readUInt16LE(i + 20) !== tail.length - i - EOCD_SIZE) continue
    at = i
    break
  }
  if (at === -1) {
    throw new Error('Not a zip file, or truncated: no end-of-central-directory record')
  }

  const entryCount = tail.readUInt16LE(at + 10)
  const centralDirSize = tail.readUInt32LE(at + 12)
  const centralDirOffset = tail.readUInt32LE(at + 16)
  if (
    entryCount === 0xffff ||
    centralDirSize === ZIP64_MARKER ||
    centralDirOffset === ZIP64_MARKER
  ) {
    throw new Error('Zip64 archives are not supported')
  }
  if (centralDirOffset + centralDirSize > size) {
    throw new Error('Zip is truncated: central directory runs past the end of the file')
  }
  return { entryCount, centralDirOffset, centralDirSize }
}

async function findEntry(
  handle: import('node:fs/promises').FileHandle,
  eocd: Eocd,
  entryName: string
): Promise<CentralEntry> {
  const dir = Buffer.alloc(eocd.centralDirSize)
  await handle.read(dir, 0, eocd.centralDirSize, eocd.centralDirOffset)

  let at = 0
  for (let i = 0; i < eocd.entryCount; i++) {
    if (at + CENTRAL_HEADER_SIZE > dir.length) {
      throw new Error('Zip is malformed: central directory ends mid-header')
    }
    if (dir.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error('Zip is malformed: bad central directory header signature')
    }
    const nameLength = dir.readUInt16LE(at + 28)
    const extraLength = dir.readUInt16LE(at + 30)
    const commentLength = dir.readUInt16LE(at + 32)
    const nameEnd = at + CENTRAL_HEADER_SIZE + nameLength
    if (nameEnd > dir.length) {
      throw new Error('Zip is malformed: central directory ends mid-name')
    }
    const name = dir.subarray(at + CENTRAL_HEADER_SIZE, nameEnd).toString('utf8')
    if (name === entryName) {
      const entry: CentralEntry = {
        name,
        flags: dir.readUInt16LE(at + 8),
        method: dir.readUInt16LE(at + 10),
        compressedSize: dir.readUInt32LE(at + 20),
        uncompressedSize: dir.readUInt32LE(at + 24),
        localHeaderOffset: dir.readUInt32LE(at + 42)
      }
      assertReadable(entry)
      return entry
    }
    at = nameEnd + extraLength + commentLength
  }
  throw new Error(`Zip has no entry named "${entryName}"`)
}

function assertReadable(entry: CentralEntry): void {
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new Error(`Zip entry "${entry.name}" is encrypted`)
  }
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATED) {
    throw new Error(`Zip entry "${entry.name}" uses unsupported compression method ${entry.method}`)
  }
  if (
    entry.compressedSize === ZIP64_MARKER ||
    entry.uncompressedSize === ZIP64_MARKER ||
    entry.localHeaderOffset === ZIP64_MARKER
  ) {
    throw new Error(`Zip entry "${entry.name}" needs zip64, which is not supported`)
  }
}

/** Byte offset of the entry's payload, which sits after a local header of its own. */
async function readDataStart(
  handle: import('node:fs/promises').FileHandle,
  entry: CentralEntry
): Promise<number> {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE)
  const { bytesRead } = await handle.read(header, 0, LOCAL_HEADER_SIZE, entry.localHeaderOffset)
  if (bytesRead < LOCAL_HEADER_SIZE || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`Zip is malformed: no local header for entry "${entry.name}"`)
  }
  // The local extra field is allowed to differ in length from the central directory's copy, so
  // the payload offset has to come from this header rather than from the entry we already read.
  return (
    entry.localHeaderOffset + LOCAL_HEADER_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28)
  )
}
