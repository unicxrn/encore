import type { SngEntry } from './sng'

/**
 * Builds .sng (SNGPKG v1) archives.
 *
 * parse-sng is reader-only, so writing one is ours to do. The layout below was hand-derived
 * from its reader (node_modules/parse-sng/index.ts) and is exercised end to end by the
 * round-trip tests: anything this writes, parse-sng and scan-chart must be able to read.
 *
 *   "SNGPKG" (6 bytes) | version uint32le | xorMask (16 bytes)
 *   metadataLen uint64le: byte length of everything from metadataCount through the last entry
 *   metadataCount uint64le, then per entry: keyLen int32le, key, valueLen int32le, value
 *   fileMetaLen uint64le: byte length of everything from fileMetaCount through the last entry
 *   fileMetaCount uint64le, then per entry: nameLen uint8, name, contentsLen uint64le,
 *     contentsIndex uint64le (absolute byte offset of the file's masked data)
 *   fileDataLen uint64le, then each file's data, XOR-masked
 *
 * The mask cycles per file: data[i] ^ (xorMask[i % 16] ^ (i % 256)). Even an all-zero
 * xorMask still XORs with the cyclic index, so masking must always be applied.
 *
 * Metadata keys and values are written verbatim. The format spec forbids newlines and
 * semicolons in either, and `=` in keys, because a reader turns the header back into INI text,
 * parse-sng's generated song.ini included. buildSng does not reject them: the metadata it is
 * given comes from readSngForRepack or readRepackPlan, i.e. an archive already on the user's
 * disk, and refusing to write back what we just read would turn "add album art" into a hard
 * failure for a chart that is merely odd. A caller introducing NEW metadata from user input has
 * to sanitise it.
 *
 * Duplicate file names are likewise written as given, both copies. Same reason: an archive in
 * the wild may pack one, and a repack has to be able to put it back.
 */

const MAGIC = 'SNGPKG'
const VERSION = 1

/**
 * The mask we write when no other is given. Any 16 bytes are legal (the archive carries its own),
 * so this is a default, not a constant of the format. A repack must pass the SOURCE archive's
 * mask instead: an entry copied across without being unmasked and remasked only decodes under
 * the mask it was written with, and getting that wrong corrupts the data while every length and
 * offset in the header still reads as correct.
 */
const XOR_MASK = new Uint8Array([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10
])

/**
 * Our cap, not the format's. The spec types fileMeta's `filenameLen` as `byte` (unsigned, so
 * names may run to 255), and writeUInt8 below writes exactly that. parse-sng reads the field
 * with `.int8`, so anything over 127 comes back negative and desyncs its whole fileMeta array.
 * An archive our only reader cannot open is one we cannot verify before swapping it over the
 * user's chart, so the cap follows the reader rather than the spec.
 */
const MAX_FILE_NAME_BYTES = 127

/** The format's mask is a fixed 16 bytes, and the header has room for exactly that many. */
const XOR_MASK_BYTES = 16

/**
 * Masks `source` into the front of `target`, treating `source[0]` as byte `entryIndex` of its
 * own file.
 *
 * `entryIndex` is what makes this usable a chunk at a time: the mask cycles on each byte's
 * position within its entry, not within the archive, so a caller streaming an entry through a
 * fixed buffer must carry the running position across calls. The repack path does exactly that,
 * and the arithmetic lives here rather than there because a second copy of it that drifted would
 * produce an archive whose every length and offset is right and whose every byte is wrong.
 */
export function maskChunk(
  target: Uint8Array,
  source: Uint8Array,
  entryIndex: number,
  xorMask: Uint8Array
): void {
  for (let i = 0; i < source.length; i++) {
    const cyclicIndex = (entryIndex + i) % 256
    target[i] = source[i] ^ (xorMask[cyclicIndex % 16] ^ cyclicIndex)
  }
}

function maskData(data: Uint8Array, xorMask: Uint8Array): Uint8Array {
  const masked = new Uint8Array(data.length)
  maskChunk(masked, data, 0, xorMask)
  return masked
}

/** An entry reduced to what the header needs to know about it: its name and how long it is. */
export interface SngDescriptor {
  fileName: string
  byteLength: number
}

export interface SngHeader {
  /** Everything before the first entry's data, i.e. up to and including the fileDataLen field. */
  bytes: Buffer
  /** Absolute offset of each descriptor's masked data in the finished archive, in order. */
  contentsIndexes: number[]
}

/**
 * Builds an archive's header from names, lengths and metadata. No file data required.
 *
 * The repack path streams entries from the source file straight into the destination, so it
 * cannot hand `buildSng` the bytes and has to lay out the header before it has read any. Every
 * field here derives from sizes: `contentsIndex` is the running total of preceding entries added
 * to where the data section starts, and where the data section starts is the size of this
 * header, which depends on how many entries there are and how long their names are. So the two
 * section sizes must be settled before a single `contentsIndex` can be written, which is why the
 * loop below runs after both sections are allocated rather than while they are being filled.
 *
 * `buildSng` is implemented on this. Two copies of the arithmetic would drift, and a drift here
 * writes offsets that point into the middle of a neighbouring entry while every declared length
 * still adds up. parse-sng streams the data section start-to-finish and never seeks to
 * `contentsIndex`, so our own round-trip tests would not notice. Clone Hero does seek.
 */
export function buildSngHeader(
  descriptors: SngDescriptor[],
  metadata: Record<string, string> = {},
  xorMask: Uint8Array = XOR_MASK
): SngHeader {
  // Checked rather than assumed because a SHORT mask fails silently and expensively: indexing
  // past its end yields undefined, XORing that yields NaN, and the mask region is written as
  // zeroes. The result is an archive that parses, reports every correct length and offset, and
  // decodes to nothing. parse-sng always hands over 16 bytes, so only a synthesised mask can
  // get here.
  if (xorMask.length !== XOR_MASK_BYTES) {
    throw new Error(`.sng xorMask must be exactly ${XOR_MASK_BYTES} bytes, got ${xorMask.length}`)
  }
  const encoder = new TextEncoder()
  const encoded = descriptors.map((descriptor) => {
    const nameBytes = encoder.encode(descriptor.fileName)
    if (nameBytes.length > MAX_FILE_NAME_BYTES) {
      throw new Error(`.sng file name exceeds ${MAX_FILE_NAME_BYTES} bytes: ${descriptor.fileName}`)
    }
    return { nameBytes, byteLength: descriptor.byteLength }
  })

  const header = Buffer.alloc(6 + 4 + 16)
  header.write(MAGIC, 0, 'latin1')
  header.writeUInt32LE(VERSION, 6)
  header.set(xorMask, 10)

  // Header metadata is where real .sng files keep song.ini's contents. The format has no
  // song.ini entry in fileMeta at all. An empty record still writes a valid (empty) section.
  const metaPairs = Object.entries(metadata).map(([key, value]) => ({
    keyBytes: encoder.encode(key),
    valueBytes: encoder.encode(value)
  }))
  const metaEntriesBytes = metaPairs.reduce(
    (sum, p) => sum + 4 + p.keyBytes.length + 4 + p.valueBytes.length,
    0
  )
  const metadataSection = Buffer.alloc(8 + 8 + metaEntriesBytes)
  metadataSection.writeBigUInt64LE(BigInt(8 + metaEntriesBytes), 0) // metadataLen
  metadataSection.writeBigUInt64LE(BigInt(metaPairs.length), 8) // metadataCount
  let metaWriteOffset = 16
  for (const pair of metaPairs) {
    metadataSection.writeInt32LE(pair.keyBytes.length, metaWriteOffset)
    metaWriteOffset += 4
    metadataSection.set(pair.keyBytes, metaWriteOffset)
    metaWriteOffset += pair.keyBytes.length
    metadataSection.writeInt32LE(pair.valueBytes.length, metaWriteOffset)
    metaWriteOffset += 4
    metadataSection.set(pair.valueBytes, metaWriteOffset)
    metaWriteOffset += pair.valueBytes.length
  }

  const fileMetaEntriesBytes = encoded.reduce((sum, f) => sum + 1 + f.nameBytes.length + 8 + 8, 0)
  const fileMetaSection = Buffer.alloc(8 + 8 + fileMetaEntriesBytes)
  fileMetaSection.writeBigUInt64LE(BigInt(8 + fileMetaEntriesBytes), 0) // fileMetaLen
  fileMetaSection.writeBigUInt64LE(BigInt(encoded.length), 8) // fileMetaCount

  const fileDataLen = encoded.reduce((sum, f) => sum + f.byteLength, 0)
  const fileDataOffset = header.length + metadataSection.length + fileMetaSection.length + 8 // + fileDataLen field

  const contentsIndexes: number[] = []
  let metaOffset = 16
  let contentsIndex = fileDataOffset
  for (const file of encoded) {
    fileMetaSection.writeUInt8(file.nameBytes.length, metaOffset)
    metaOffset += 1
    fileMetaSection.set(file.nameBytes, metaOffset)
    metaOffset += file.nameBytes.length
    fileMetaSection.writeBigUInt64LE(BigInt(file.byteLength), metaOffset)
    metaOffset += 8
    fileMetaSection.writeBigUInt64LE(BigInt(contentsIndex), metaOffset)
    metaOffset += 8
    contentsIndexes.push(contentsIndex)
    contentsIndex += file.byteLength
  }

  const fileDataLenField = Buffer.alloc(8)
  fileDataLenField.writeBigUInt64LE(BigInt(fileDataLen), 0)

  return {
    bytes: Buffer.concat([header, metadataSection, fileMetaSection, fileDataLenField]),
    contentsIndexes
  }
}

export function buildSng(
  entries: SngEntry[],
  metadata: Record<string, string> = {},
  xorMask: Uint8Array = XOR_MASK
): Buffer {
  const header = buildSngHeader(
    entries.map((entry) => ({ fileName: entry.fileName, byteLength: entry.data.length })),
    metadata,
    xorMask
  )
  return Buffer.concat([
    header.bytes,
    ...entries.map((entry) => Buffer.from(maskData(entry.data, xorMask)))
  ])
}
