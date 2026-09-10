import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { beforeEach, describe, expect, it } from 'vitest'
import { extractZipEntry } from './unzip'
import { tmpDir } from '../../../test/helpers/tmp'

/**
 * Fixtures are built here rather than checked in: a zip in the repo would be an opaque blob
 * nobody could review, and Node's own deflate is the same codec the real archives use.
 */
interface FixtureEntry {
  name: string
  content: Buffer
  /** 0 stored, 8 deflated. Defaults to 8. */
  method?: number
  /** Overrides the general purpose bit flag, for exercising refusals. */
  flags?: number
  /** Bytes of local-only extra field, to prove the payload offset comes from the local header. */
  localExtra?: number
}

function crc32(buf: Buffer): number {
  let crc = ~0
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

/** Builds a zip in memory: local headers, then a central directory, then an EOCD record. */
function makeZip(entries: FixtureEntry[], comment = ''): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 8
    const name = Buffer.from(entry.name, 'utf8')
    const payload = method === 8 ? deflateRawSync(entry.content) : entry.content
    const extra = Buffer.alloc(entry.localExtra ?? 0)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(entry.content), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.content.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    locals.push(local, name, extra, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(entry.content), 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + extra.length + payload.length
  }

  const centralDir = Buffer.concat(centrals)
  const commentBytes = Buffer.from(comment, 'utf8')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(commentBytes.length, 20)
  return Buffer.concat([...locals, centralDir, eocd, commentBytes])
}

describe('extractZipEntry', () => {
  let dir: string
  let zipPath: string
  let destPath: string

  beforeEach(() => {
    dir = tmpDir('unzip')
    zipPath = join(dir, 'archive.zip')
    destPath = join(dir, 'out.bin')
  })

  const write = (zip: Buffer): void => writeFileSync(zipPath, zip)

  it('extracts a deflated entry', async () => {
    // Long and repetitive so deflate actually compresses it. A stored-size fallback would
    // read the wrong number of bytes, and the assertion would catch it.
    const content = Buffer.from('ffmpeg version 6.1\n'.repeat(5000))
    write(makeZip([{ name: 'ffmpeg', content }]))
    await extractZipEntry(zipPath, 'ffmpeg', destPath)
    expect(readFileSync(destPath).equals(content)).toBe(true)
  })

  it('extracts a stored entry', async () => {
    const content = Buffer.from('not compressed at all')
    write(makeZip([{ name: 'ffmpeg', content, method: 0 }]))
    await extractZipEntry(zipPath, 'ffmpeg', destPath)
    expect(readFileSync(destPath).equals(content)).toBe(true)
  })

  it('extracts an empty entry', async () => {
    write(makeZip([{ name: 'empty', content: Buffer.alloc(0), method: 0 }]))
    await extractZipEntry(zipPath, 'empty', destPath)
    expect(readFileSync(destPath).length).toBe(0)
  })

  it('picks the named entry out of several, not the first one', async () => {
    const wanted = Buffer.from('the real ffmpeg'.repeat(100))
    write(
      makeZip([
        { name: 'README.txt', content: Buffer.from('read me'.repeat(100)) },
        { name: 'ffmpeg', content: wanted },
        { name: 'ffprobe', content: Buffer.from('probe'.repeat(100)) }
      ])
    )
    await extractZipEntry(zipPath, 'ffmpeg', destPath)
    expect(readFileSync(destPath).equals(wanted)).toBe(true)
  })

  it('reads the payload offset from the local header, not the central directory', async () => {
    // The local extra field is allowed to differ from the central copy. Taking the length from
    // the central directory (where this fixture reports zero) lands 64 bytes early.
    const content = Buffer.from('offset matters'.repeat(200))
    write(makeZip([{ name: 'ffmpeg', content, localExtra: 64 }]))
    await extractZipEntry(zipPath, 'ffmpeg', destPath)
    expect(readFileSync(destPath).equals(content)).toBe(true)
  })

  it('finds the trailer behind a zip comment', async () => {
    const content = Buffer.from('commented'.repeat(100))
    write(makeZip([{ name: 'ffmpeg', content }], 'built by ffbinaries'))
    await extractZipEntry(zipPath, 'ffmpeg', destPath)
    expect(readFileSync(destPath).equals(content)).toBe(true)
  })

  it('rejects a request for an entry that is not there', async () => {
    write(makeZip([{ name: 'ffprobe', content: Buffer.from('wrong binary') }]))
    await expect(extractZipEntry(zipPath, 'ffmpeg', destPath)).rejects.toThrow(
      /no entry named "ffmpeg"/
    )
  })

  it('rejects a truncated archive, whose trailer is gone', async () => {
    const zip = makeZip([{ name: 'ffmpeg', content: Buffer.from('x'.repeat(10000)) }])
    write(zip.subarray(0, Math.floor(zip.length / 2)))
    await expect(extractZipEntry(zipPath, 'ffmpeg', destPath)).rejects.toThrow(
      /no end-of-central-directory record/
    )
  })

  it('rejects an archive whose trailer survived but whose payload did not', async () => {
    // Trailer and central directory intact, entry data cut short: the shape a partial download
    // reassembled from cache would have. Caught before a single byte is inflated.
    const zip = makeZip([{ name: 'ffmpeg', content: Buffer.from('y'.repeat(10000)), method: 0 }])
    const cut = Buffer.concat([zip.subarray(0, 1000), zip.subarray(10000 + 30 + 6)])
    write(cut)
    await expect(extractZipEntry(zipPath, 'ffmpeg', destPath)).rejects.toThrow(/truncated/)
  })

  it('rejects a file that is not a zip at all', async () => {
    write(Buffer.from('#!/bin/sh\necho this is a script\n'))
    await expect(extractZipEntry(zipPath, 'ffmpeg', destPath)).rejects.toThrow(/Not a zip file/)
  })

  it('refuses an unsupported compression method rather than guessing', async () => {
    write(makeZip([{ name: 'ffmpeg', content: Buffer.from('lzma-ish'), method: 14 }]))
    await expect(extractZipEntry(zipPath, 'ffmpeg', destPath)).rejects.toThrow(
      /unsupported compression method 14/
    )
  })

  it('refuses an encrypted entry', async () => {
    write(makeZip([{ name: 'ffmpeg', content: Buffer.from('secret'), flags: 0x1 }]))
    await expect(extractZipEntry(zipPath, 'ffmpeg', destPath)).rejects.toThrow(/encrypted/)
  })

  it('rejects an entry whose data does not inflate to its declared size', async () => {
    // A central directory that lies about the uncompressed size is how a mis-parsed offset
    // would present if inflate happened to succeed on it anyway.
    const zip = makeZip([{ name: 'ffmpeg', content: Buffer.from('honest bytes'.repeat(50)) }])
    const eocdAt = zip.length - 22
    const centralAt = zip.readUInt32LE(eocdAt + 16)
    zip.writeUInt32LE(999_999, centralAt + 24)
    write(zip)
    await expect(extractZipEntry(zipPath, 'ffmpeg', destPath)).rejects.toThrow(
      /expected 999999|truncated/
    )
  })
})
