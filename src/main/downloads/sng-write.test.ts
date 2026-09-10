import { describe, expect, it } from 'vitest'
import { scanChartFolder } from 'scan-chart'
import { extractSngEntries } from './sng'
import { buildSng, buildSngHeader, type SngDescriptor } from './sng-write'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

const CHART = bytes(
  '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
)

interface RawSng {
  magic: string
  version: number
  xorMask: Uint8Array
  /** Byte length the archive claims for each section, and what parsing it actually consumed. */
  declaredMetadataLen: number
  metadataBytes: number
  declaredFileMetaLen: number
  fileMetaBytes: number
  fileMeta: { fileName: string; contentsLen: number; contentsIndex: number }[]
  fileDataLen: number
  /** Absolute offset of the first byte after the header. */
  dataStart: number
}

/**
 * Walks the header field by field, independently of parse-sng.
 *
 * Deliberately a second implementation: parse-sng is a streaming reader that ignores the very
 * fields most likely to be written wrong, so using it here would just re-test what the
 * round-trip tests already cover.
 */
function parseRawSng(sng: Buffer): RawSng {
  const magic = sng.toString('latin1', 0, 6)
  const version = sng.readUInt32LE(6)
  const xorMask = new Uint8Array(sng.subarray(10, 26))

  let at = 26
  const declaredMetadataLen = Number(sng.readBigUInt64LE(at))
  at += 8
  const metadataStart = at
  const metadataCount = Number(sng.readBigUInt64LE(at))
  at += 8
  for (let i = 0; i < metadataCount; i++) {
    const keyLen = sng.readInt32LE(at)
    at += 4 + keyLen
    const valueLen = sng.readInt32LE(at)
    at += 4 + valueLen
  }
  const metadataBytes = at - metadataStart

  const declaredFileMetaLen = Number(sng.readBigUInt64LE(at))
  at += 8
  const fileMetaStart = at
  const fileMetaCount = Number(sng.readBigUInt64LE(at))
  at += 8
  const fileMeta: RawSng['fileMeta'] = []
  for (let i = 0; i < fileMetaCount; i++) {
    const nameLen = sng.readUInt8(at)
    at += 1
    const fileName = sng.toString('utf8', at, at + nameLen)
    at += nameLen
    const contentsLen = Number(sng.readBigUInt64LE(at))
    at += 8
    const contentsIndex = Number(sng.readBigUInt64LE(at))
    at += 8
    fileMeta.push({ fileName, contentsLen, contentsIndex })
  }
  const fileMetaBytes = at - fileMetaStart

  const fileDataLen = Number(sng.readBigUInt64LE(at))
  at += 8

  return {
    magic,
    version,
    xorMask,
    declaredMetadataLen,
    metadataBytes,
    declaredFileMetaLen,
    fileMetaBytes,
    fileMeta,
    fileDataLen,
    dataStart: at
  }
}

/** Inverse of the writer's mask; the cycle restarts at 0 for each file. */
function unmask(masked: Uint8Array, xorMask: Uint8Array): Uint8Array {
  const out = new Uint8Array(masked.length)
  for (let i = 0; i < masked.length; i++) {
    const cyclicIndex = i % 256
    out[i] = masked[i] ^ (xorMask[cyclicIndex % 16] ^ cyclicIndex)
  }
  return out
}

describe('buildSng', () => {
  it('round-trips entries and header metadata through parse-sng', async () => {
    const sng = buildSng(
      [
        { fileName: 'notes.chart', data: CHART },
        { fileName: 'album.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }
      ],
      { name: 'Built Song', artist: 'Built Artist', diff_guitar: '4' }
    )
    const entries = await extractSngEntries(new Uint8Array(sng))

    expect(entries.map((e) => e.fileName).sort()).toEqual([
      'album.png',
      'notes.chart',
      // extractSngEntries asks parse-sng to materialize the header metadata as a song.ini;
      // the archive itself carries no such entry.
      'song.ini'
    ])
    expect(entries.find((e) => e.fileName === 'album.png')?.data).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    )
    expect(entries.find((e) => e.fileName === 'notes.chart')?.data).toEqual(CHART)

    const ini = decoder.decode(entries.find((e) => e.fileName === 'song.ini')?.data)
    expect(ini).toContain('name = Built Song')
    expect(ini).toContain('artist = Built Artist')
    expect(ini).toContain('diff_guitar = 4')
  })

  it('produces an archive scan-chart can read', async () => {
    // The point of the format is that Clone Hero and scan-chart accept it. A round-trip
    // through our own reader alone would pass even if we invented a private layout, so this
    // hands the extracted entries to scan-chart the same way the scanner does.
    const sng = buildSng([{ fileName: 'notes.chart', data: CHART }], {
      name: 'Scannable',
      artist: 'A',
      charter: 'Tester'
    })
    const entries = await extractSngEntries(new Uint8Array(sng))
    const scanned = scanChartFolder(entries, { includeMd5: false, includeBTrack: false })

    expect(scanned.name).toBe('Scannable')
    expect(scanned.artist).toBe('A')
    expect(scanned.charter).toBe('Tester')
    // Only "missingValue" issues for the fields this fixture omits, with nothing saying the
    // metadata was absent or unreadable, which is what a malformed header would produce.
    expect(scanned.metadataIssues.map((i) => i.metadataIssue)).not.toContain('noMetadata')
    expect(scanned.metadataIssues.map((i) => i.metadataIssue)).not.toContain('invalidMetadata')
    expect(scanned.notesData?.instruments).toContain('guitar')
  })

  it('rejects a file name longer than our reader can handle', () => {
    // The spec's filenameLen is an unsigned byte (max 255); parse-sng reads it with .int8, so
    // 127 is the ceiling that matters to us. Over it, the length comes back negative.
    expect(() => buildSng([{ fileName: 'x'.repeat(200), data: new Uint8Array() }], {})).toThrow(
      /127/
    )
    expect(() => buildSng([{ fileName: 'x'.repeat(128), data: new Uint8Array() }], {})).toThrow(
      /127/
    )
    expect(() =>
      buildSng([{ fileName: 'x'.repeat(127), data: new Uint8Array() }], {})
    ).not.toThrow()
  })

  it('counts the name limit in bytes, not characters', () => {
    // 64 three-byte characters is 192 bytes but only 64 code points.
    expect(() => buildSng([{ fileName: '☃'.repeat(64), data: new Uint8Array() }], {})).toThrow(
      /127/
    )
  })

  it("declares an offset and length for each entry that point at that entry's bytes", () => {
    // Read with parseRawSng, not parse-sng, on purpose. parse-sng streams the data section
    // straight through: it never seeks to contentsIndex, never reads fileDataLen's value and
    // never looks at version, so a round-trip through it (including the one writeSngAsset
    // uses to verify a repack before overwriting the chart) cannot see any of those three
    // fields go wrong. Clone Hero locates files by contentsIndex, so this checks them directly.
    const entries = [
      { fileName: 'empty.txt', data: new Uint8Array() },
      // 300 bytes exceeds the 256-step mask cycle, so a mask applied from the wrong start
      // offset shows up as a mismatch rather than an accidental match.
      { fileName: 'big.bin', data: new Uint8Array(300).map((_, i) => (i * 7) % 251) },
      { fileName: 'notes.chart', data: CHART }
    ]
    const sng = buildSng(entries, { name: 'Offsets' })
    const raw = parseRawSng(sng)

    expect(raw.magic).toBe('SNGPKG')
    expect(raw.version).toBe(1)
    expect(raw.fileMeta.map((f) => f.fileName)).toEqual(entries.map((e) => e.fileName))
    expect(raw.fileDataLen).toBe(entries.reduce((sum, e) => sum + e.data.length, 0))
    // The declared section lengths have to match what parsing them actually consumed, or a
    // reader that trusts them lands mid-record.
    expect(raw.declaredMetadataLen).toBe(raw.metadataBytes)
    expect(raw.declaredFileMetaLen).toBe(raw.fileMetaBytes)
    // First entry starts where the header ends: no gap, and nothing overlapping fileDataLen.
    expect(raw.fileMeta[0].contentsIndex).toBe(raw.dataStart)

    for (const [i, want] of entries.entries()) {
      const meta = raw.fileMeta[i]
      expect(meta.contentsLen).toBe(want.data.length)
      const slice = sng.subarray(meta.contentsIndex, meta.contentsIndex + meta.contentsLen)
      expect(unmask(new Uint8Array(slice), raw.xorMask)).toEqual(want.data)
    }

    const last = raw.fileMeta[raw.fileMeta.length - 1]
    expect(last.contentsIndex + last.contentsLen).toBe(sng.length)
  })

  it('writes duplicate file names as separate entries', () => {
    // Documented pass-through, pinned so it cannot change unnoticed: an archive in the wild may
    // pack a name twice and a repack has to put it back. extractSngEntries dedupes on read, so
    // only the raw header shows both, which is exactly why this is easy to break silently.
    const sng = buildSng([
      { fileName: 'dup.txt', data: bytes('first') },
      { fileName: 'dup.txt', data: bytes('second') }
    ])
    const raw = parseRawSng(sng)
    expect(raw.fileMeta.map((f) => f.fileName)).toEqual(['dup.txt', 'dup.txt'])
    expect(raw.fileMeta[0].contentsIndex).not.toBe(raw.fileMeta[1].contentsIndex)
  })

  it('writes an empty archive without entries or metadata', async () => {
    const sng = buildSng([], {})
    // Nothing to read back but parse-sng's placeholder song.ini. The point is that the
    // section lengths still describe a parseable archive rather than throwing on write.
    const entries = await extractSngEntries(new Uint8Array(sng))
    expect(entries.map((e) => e.fileName)).toEqual(['song.ini'])
    expect(decoder.decode(entries[0].data)).toBe('[song]\n')
  })
})

describe('buildSngHeader', () => {
  const HEADER_CASE = [
    { fileName: 'empty.txt', data: new Uint8Array() },
    { fileName: 'big.bin', data: new Uint8Array(300).map((_, i) => (i * 7) % 251) },
    { fileName: '☃-unicode-name.txt', data: bytes('snow') },
    { fileName: 'notes.chart', data: CHART }
  ]
  const HEADER_METADATA = { name: 'Header', artist: 'A', diff_guitar: '4' }
  const descriptorsOf = (entries: { fileName: string; data: Uint8Array }[]): SngDescriptor[] =>
    entries.map((e) => ({ fileName: e.fileName, byteLength: e.data.length }))

  it("produces bytes identical to buildSng's header region, from sizes alone", () => {
    // The equivalence the streaming repack rests on: if a header built from names and lengths
    // alone can differ from the one buildSng writes, the two paths produce different archives
    // from the same entries and only one of them is right.
    const sng = buildSng(HEADER_CASE, HEADER_METADATA)
    const raw = parseRawSng(sng)
    const header = buildSngHeader(descriptorsOf(HEADER_CASE), HEADER_METADATA)

    expect(header.bytes.length).toBe(raw.dataStart)
    expect(Buffer.compare(header.bytes, sng.subarray(0, raw.dataStart))).toBe(0)
    expect(header.contentsIndexes).toEqual(raw.fileMeta.map((f) => f.contentsIndex))
  })

  it('produces the whole archive when there are no entries', () => {
    // With no file data an archive IS its header, so byte equality here also pins that the
    // fileDataLen field is inside the header region rather than after it.
    const sng = buildSng([], {})
    const header = buildSngHeader([], {})
    expect(Buffer.compare(header.bytes, sng)).toBe(0)
    expect(header.contentsIndexes).toEqual([])
  })

  it('writes the xorMask it is given, and buildSng masks with that same mask', () => {
    // Task 2 repacks by copying an entry's masked bytes verbatim, which is only valid under the
    // mask they were written with, so both the header and the data must take the source's.
    const mask = new Uint8Array(16).map((_, i) => (i * 37 + 5) % 256)
    const data = new Uint8Array(300).map((_, i) => (i * 7) % 251)
    const entries = [{ fileName: 'big.bin', data }]
    const sng = buildSng(entries, HEADER_METADATA, mask)
    const raw = parseRawSng(sng)

    expect(raw.xorMask).toEqual(mask)
    const slice = sng.subarray(
      raw.fileMeta[0].contentsIndex,
      raw.fileMeta[0].contentsIndex + raw.fileMeta[0].contentsLen
    )
    expect(unmask(new Uint8Array(slice), mask)).toEqual(data)

    const header = buildSngHeader(descriptorsOf(entries), HEADER_METADATA, mask)
    expect(Buffer.compare(header.bytes, sng.subarray(0, raw.dataStart))).toBe(0)
  })

  it('defaults to the mask every archive we have written so far uses', () => {
    // Pinned by value: the mask became a parameter, and a changed default would rewrite every
    // byte of every entry we produce without any length or offset looking wrong.
    const raw = parseRawSng(buildSng([{ fileName: 'a.txt', data: bytes('a') }]))
    expect(raw.xorMask).toEqual(
      // prettier-ignore
      new Uint8Array([
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
        0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10
      ])
    )
    expect(new Uint8Array(buildSngHeader([], {}).bytes.subarray(10, 26))).toEqual(raw.xorMask)
  })

  it('rejects a file name longer than our reader can handle', () => {
    // Same ceiling as buildSng's, because it is the same uint8 length field being written.
    expect(() => buildSngHeader([{ fileName: 'x'.repeat(128), byteLength: 0 }], {})).toThrow(/127/)
  })
})
