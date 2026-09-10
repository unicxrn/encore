import { existsSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSngForRepack, type SngEntry } from './sng'
import { buildSng } from './sng-write'
import {
  planEntryFromFile,
  putPlanEntry,
  putPlanEntrySource,
  readRepackPlan,
  repackSng
} from './sng-repack'
import { tmpDir } from '../../../test/helpers/tmp'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

/**
 * Deliberately not sng-write's default mask. Every assertion about copied bytes below is only
 * meaningful if the source archive was written under a mask the repacker could get wrong.
 */
const SOURCE_MASK = new Uint8Array(16).map((_, i) => (i * 53 + 11) % 256)

const NOTES = bytes('[Song]\n{\n  Resolution = 192\n}\n')
const ART = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])
/** Long enough, and deliberately not a multiple of 256, to run past any chunk boundary. */
const BIG = new Uint8Array(9973).map((_, i) => (i * 31 + 7) % 256)

const METADATA = { name: 'Bloom', artist: 'Of Mice & Men', charter: 'SirMonkfish' }

const SOURCE_ENTRIES: SngEntry[] = [
  { fileName: 'notes.chart', data: NOTES },
  { fileName: 'album.jpg', data: ART },
  { fileName: 'big.bin', data: BIG }
]

function scratch(): string {
  return tmpDir('repack')
}

function writeSource(dir: string, entries = SOURCE_ENTRIES, metadata = METADATA): string {
  const path = join(dir, 'chart.sng')
  writeFileSync(path, buildSng(entries, metadata, SOURCE_MASK))
  return path
}

interface RawHeader {
  xorMask: Uint8Array
  fileMeta: { fileName: string; contentsLen: number; contentsIndex: number }[]
}

/**
 * Walks the header by hand rather than through parse-sng or through the module under test.
 *
 * The bytes that matter most here (the mask and each entry's absolute `contentsIndex`) are
 * exactly the ones parse-sng's forward-only reader never has to get right, so verifying with it
 * alone would leave the sharpest failure invisible.
 */
function readRawHeader(sng: Buffer): RawHeader {
  const xorMask = new Uint8Array(sng.subarray(10, 26))
  let at = 26
  at += 8 // metadataLen
  const metadataCount = Number(sng.readBigUInt64LE(at))
  at += 8
  for (let i = 0; i < metadataCount; i++) {
    at += 4 + sng.readInt32LE(at)
    at += 4 + sng.readInt32LE(at)
  }
  at += 8 // fileMetaLen
  const fileMetaCount = Number(sng.readBigUInt64LE(at))
  at += 8
  const fileMeta: RawHeader['fileMeta'] = []
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
  return { xorMask, fileMeta }
}

/** The reader's masking, written out independently of sng-write's. */
function unmask(masked: Uint8Array, xorMask: Uint8Array): Uint8Array {
  const out = new Uint8Array(masked.length)
  for (let i = 0; i < masked.length; i++) {
    const cyclicIndex = i % 256
    out[i] = masked[i] ^ (xorMask[cyclicIndex % 16] ^ cyclicIndex)
  }
  return out
}

/** Decodes one entry straight out of the archive bytes, using the mask the archive declares. */
function decodeEntry(sng: Buffer, header: RawHeader, fileName: string): Uint8Array {
  const meta = header.fileMeta.find((f) => f.fileName === fileName)
  if (!meta) throw new Error(`no entry named ${fileName}`)
  return unmask(
    new Uint8Array(sng.subarray(meta.contentsIndex, meta.contentsIndex + meta.contentsLen)),
    header.xorMask
  )
}

describe('readRepackPlan', () => {
  it('maps every entry to its own byte range in the source file', async () => {
    const dir = scratch()
    const path = writeSource(dir)
    const raw = readRawHeader(readFileSync(path))

    const plan = await readRepackPlan(path)

    expect(plan.metadata).toEqual(METADATA)
    expect(plan.xorMask).toEqual(SOURCE_MASK)
    expect(plan.entries).toEqual(
      raw.fileMeta.map((f) => ({
        fileName: f.fileName,
        source: { kind: 'copy', offset: f.contentsIndex, byteLength: f.contentsLen }
      }))
    )
  })

  it('needs only the header, not the file bodies', async () => {
    // The whole design rests on this. Truncating everything after the header leaves an archive
    // no reader could stream to the end. If the plan still comes back complete, the cost of
    // reading it is the header's size and not the archive's.
    const dir = scratch()
    const path = writeSource(dir)
    const firstEntryOffset = readRawHeader(readFileSync(path)).fileMeta[0].contentsIndex
    truncateSync(path, firstEntryOffset)

    const plan = await readRepackPlan(path)

    expect(plan.entries.map((e) => e.fileName)).toEqual(['notes.chart', 'album.jpg', 'big.bin'])
    expect(plan.xorMask).toEqual(SOURCE_MASK)
  })

  it('reads an archive with no entries at all', async () => {
    const dir = scratch()
    const path = join(dir, 'empty.sng')
    writeFileSync(path, buildSng([], METADATA, SOURCE_MASK))

    const plan = await readRepackPlan(path)

    expect(plan.entries).toEqual([])
    expect(plan.metadata).toEqual(METADATA)
  })
})

describe('putPlanEntry', () => {
  it('appends a new entry and leaves the existing ones as copies', async () => {
    const dir = scratch()
    const plan = await readRepackPlan(writeSource(dir))

    const next = putPlanEntry(plan, 'album.png', ART)

    expect(next.entries.map((e) => e.fileName)).toEqual([
      'notes.chart',
      'album.jpg',
      'big.bin',
      'album.png'
    ])
    expect(next.entries.slice(0, 3).every((e) => e.source.kind === 'copy')).toBe(true)
    expect(next.entries[3].source).toEqual({ kind: 'data', data: ART })
    // The plan it was given is the caller's; a repack that mutated it would leave the caller
    // holding a plan describing an archive that no longer matches the file it names.
    expect(plan.entries).toHaveLength(3)
  })

  it('replaces an entry of the same name rather than packing it twice', async () => {
    const dir = scratch()
    const plan = await readRepackPlan(writeSource(dir))

    const next = putPlanEntry(plan, 'album.jpg', BIG)

    expect(next.entries.map((e) => e.fileName)).toEqual(['notes.chart', 'big.bin', 'album.jpg'])
    expect(next.entries.at(-1)?.source).toEqual({ kind: 'data', data: BIG })
  })

  it('drops the entries a caller asks it to remove', async () => {
    const dir = scratch()
    const plan = await readRepackPlan(writeSource(dir))

    const next = putPlanEntry(plan, 'album.png', ART, {
      removeMatching: (fileName) => fileName === 'album.jpg'
    })

    expect(next.entries.map((e) => e.fileName)).toEqual(['notes.chart', 'big.bin', 'album.png'])
  })
})

describe('file entry sources', () => {
  it('packs a file from disk byte for byte, across chunk boundaries', async () => {
    const dir = scratch()
    const source = writeSource(dir)
    const dest = join(dir, 'out.sng')
    const videoPath = join(dir, 'video.webm')
    writeFileSync(videoPath, BIG)

    const plan = putPlanEntrySource(
      await readRepackPlan(source),
      'video.webm',
      await planEntryFromFile(videoPath)
    )
    // Coprime with 256, for the reason RepackSngOptions gives: a chunk size that is a power of
    // two would hide an implementation that restarted the mask index on every chunk, and a file
    // source is masked chunk by chunk out of a buffer it shares with the reader.
    await repackSng(source, dest, plan, { chunkBytes: 997 })

    const sng = readFileSync(dest)
    expect(decodeEntry(sng, readRawHeader(sng), 'video.webm')).toEqual(BIG)
    // And the entries it did not touch are still themselves.
    expect(decodeEntry(sng, readRawHeader(sng), 'notes.chart')).toEqual(NOTES)
  })

  it('takes the entry length from the file when the plan is built', async () => {
    const dir = scratch()
    const videoPath = join(dir, 'video.webm')
    writeFileSync(videoPath, BIG)

    expect(await planEntryFromFile(videoPath)).toEqual({
      kind: 'file',
      path: videoPath,
      byteLength: BIG.length
    })
  })

  it('fails naming the entry when the file is shorter than the plan promised', async () => {
    const dir = scratch()
    const source = writeSource(dir)
    const videoPath = join(dir, 'video.webm')
    writeFileSync(videoPath, BIG)
    const plan = putPlanEntrySource(
      await readRepackPlan(source),
      'video.webm',
      await planEntryFromFile(videoPath)
    )
    // Truncated after the plan was built: the header already declares the old length, so a
    // short read is the only thing standing between this and an archive padded with noise.
    truncateSync(videoPath, 10)

    await expect(repackSng(source, join(dir, 'out.sng'), plan)).rejects.toThrow(/video\.webm/)
    expect(existsSync(join(dir, 'out.sng'))).toBe(false)
  })
})

describe('repackSng', () => {
  it('produces an archive parse-sng reads back entry for entry', async () => {
    const dir = scratch()
    const source = writeSource(dir)
    const dest = join(dir, 'out.sng')

    await repackSng(source, dest, putPlanEntry(await readRepackPlan(source), 'album.png', ART))

    const back = await readSngForRepack(new Uint8Array(readFileSync(dest)))
    expect(back.metadata).toEqual(METADATA)
    expect(back.entries.map((e) => e.fileName)).toEqual([
      'notes.chart',
      'album.jpg',
      'big.bin',
      'album.png'
    ])
    expect(back.entries[0].data).toEqual(NOTES)
    expect(back.entries[1].data).toEqual(ART)
    expect(back.entries[2].data).toEqual(BIG)
    expect(back.entries[3].data).toEqual(ART)
  })

  it('keeps the source mask, so copied entries still decode', async () => {
    // The one failure this milestone cannot afford. A copied entry is never unmasked, so it
    // only decodes under the mask it was written with; writing any other mask into the header
    // corrupts every copied byte while the magic, both section lengths, every contentsLen and
    // every contentsIndex still read as perfectly correct.
    const dir = scratch()
    const source = writeSource(dir)
    const dest = join(dir, 'out.sng')

    await repackSng(source, dest, putPlanEntry(await readRepackPlan(source), 'album.png', ART))

    const sng = readFileSync(dest)
    const header = readRawHeader(sng)
    expect(header.xorMask).toEqual(SOURCE_MASK)
    expect(decodeEntry(sng, header, 'notes.chart')).toEqual(NOTES)
    expect(decodeEntry(sng, header, 'album.jpg')).toEqual(ART)
    expect(decodeEntry(sng, header, 'big.bin')).toEqual(BIG)
    // The added entry is masked by us rather than copied, so it pins the other half: the mask
    // we write into the header has to be the mask we masked new data with.
    expect(decodeEntry(sng, header, 'album.png')).toEqual(ART)
  })

  it('lands every entry exactly at the contentsIndex its own header declares', async () => {
    const dir = scratch()
    const source = writeSource(dir)
    const dest = join(dir, 'out.sng')

    await repackSng(source, dest, putPlanEntry(await readRepackPlan(source), 'album.png', ART))

    const sng = readFileSync(dest)
    const header = readRawHeader(sng)
    let expected = header.fileMeta[0].contentsIndex
    for (const meta of header.fileMeta) {
      expect(meta.contentsIndex).toBe(expected)
      expected += meta.contentsLen
    }
    expect(statSync(dest).size).toBe(expected)
  })

  it('copies and masks correctly across chunk boundaries', async () => {
    // Real chunk sizes are powers of two, and the mask repeats every 256 bytes, so on a real
    // chunk an implementation that restarted the mask index per chunk would produce identical
    // bytes. A chunk size coprime with 256 is the only way to make that bug visible.
    const dir = scratch()
    const source = writeSource(dir)
    const dest = join(dir, 'out.sng')

    await repackSng(source, dest, putPlanEntry(await readRepackPlan(source), 'new.bin', BIG), {
      chunkBytes: 101
    })

    const back = await readSngForRepack(new Uint8Array(readFileSync(dest)))
    expect(back.entries.map((e) => e.data)).toEqual([NOTES, ART, BIG, BIG])
  })

  it('refuses to write over a destination that already exists', async () => {
    const dir = scratch()
    const source = writeSource(dir)
    const dest = join(dir, 'out.sng')
    writeFileSync(dest, 'occupied')

    await expect(repackSng(source, dest, await readRepackPlan(source))).rejects.toThrow(/EEXIST/)
    expect(readFileSync(dest, 'utf8')).toBe('occupied')
  })

  it('fails, and leaves nothing behind, when the source is truncated mid-copy', async () => {
    const dir = scratch()
    const source = writeSource(dir)
    const dest = join(dir, 'out.sng')
    const plan = await readRepackPlan(source)
    // Read the plan first, then cut the file short: the header still promises three entries,
    // so the copy runs off the end of the file the way a concurrently-shrinking source would.
    truncateSync(source, statSync(source).size - 100)

    await expect(repackSng(source, dest, plan)).rejects.toThrow(/big\.bin/)
    expect(existsSync(dest)).toBe(false)
  })

  it('leaves the destination name free, so a retry after a failure is not an EEXIST', async () => {
    // The claim `wx` rests on. A repack that dies part-way (a disk that filled up under it is
    // the realistic one) has already written some of the destination, and if that partial file
    // survived, every later attempt would fail with EEXIST instead of the reason it really
    // failed, and the chart would be unfixable without the user deleting a hidden temp by hand.
    const dir = scratch()
    const source = writeSource(dir)
    const dest = join(dir, 'out.sng')
    const plan = await readRepackPlan(source)
    const whole = readFileSync(source)
    truncateSync(source, whole.byteLength - 100)

    await expect(repackSng(source, dest, plan)).rejects.toThrow(/big\.bin/)

    writeFileSync(source, whole)
    await repackSng(source, dest, plan)
    const back = await readSngForRepack(new Uint8Array(readFileSync(dest)))
    expect(back.entries.map((e) => e.data)).toEqual([NOTES, ART, BIG])
  })

  it('writes an archive whose only entry is empty', async () => {
    const dir = scratch()
    const source = writeSource(dir, [{ fileName: 'empty.bin', data: new Uint8Array(0) }])
    const dest = join(dir, 'out.sng')

    await repackSng(source, dest, await readRepackPlan(source))

    const sng = readFileSync(dest)
    expect(readRawHeader(sng).fileMeta).toEqual([
      { fileName: 'empty.bin', contentsLen: 0, contentsIndex: sng.length }
    ])
  })

  it('rejects a mask that is not the 16 bytes the format defines', async () => {
    // A short mask indexes past its own end, which reads as undefined and masks with NaN: a
    // silently zero-filled region rather than an error. parse-sng always hands over 16 bytes,
    // so this only bites a synthesised plan, which is exactly why it is worth catching.
    const dir = scratch()
    const source = writeSource(dir)
    const plan = await readRepackPlan(source)

    await expect(
      repackSng(source, join(dir, 'out.sng'), { ...plan, xorMask: new Uint8Array(8) })
    ).rejects.toThrow(/16/)
  })
})
