import { readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { extractSngEntries, readSngFile, readSngForRepack } from './sng'
import { tmpDir } from '../../../test/helpers/tmp'

const encoder = new TextEncoder()
const NOTES = {
  fileName: 'notes.chart',
  data: encoder.encode('[Song]\n{\n  Resolution = 192\n}\n')
}

describe('extractSngEntries', () => {
  it('materializes song.ini from the archive header when the archive has none', async () => {
    // The .sng format keeps song details in the header, not as a file. Without this, every
    // .sng in the library scans as "no metadata" and .mid charts have no title anywhere.
    const sng = makeSng([NOTES], { name: 'Header Song', artist: 'Header Artist' })
    const entries = await extractSngEntries(new Uint8Array(sng))
    const ini = entries.find((e) => e.fileName === 'song.ini')
    expect(ini).toBeDefined()
    const text = new TextDecoder().decode(ini!.data)
    expect(text).toContain('Header Song')
    expect(text).toContain('Header Artist')
  })

  it('keeps the packed song.ini when the archive has one, without duplicating the name', async () => {
    // parse-sng emits its generated song.ini first and unconditionally, so both exist in the
    // stream. The packed file wins: it can carry fields the header does not.
    const packed = encoder.encode('[song]\nname = Packed Song\nartist = Packed Artist\n')
    const sng = makeSng([{ fileName: 'song.ini', data: packed }, NOTES], { name: 'Header Song' })
    const entries = await extractSngEntries(new Uint8Array(sng))
    expect(entries.filter((e) => e.fileName === 'song.ini')).toHaveLength(1)
    expect(
      new TextDecoder().decode(entries.find((e) => e.fileName === 'song.ini')!.data)
    ).toContain('Packed Song')
  })
})

describe('readSngForRepack', () => {
  it('returns the archive as it is on disk, with no synthesised song.ini', async () => {
    // extractSngEntries adds a generated song.ini from the header. Repacking its output would
    // bake that synthetic file into the archive, leaving the header and a file entry as two
    // copies of the metadata that then drift apart. Verified against the reference library:
    // 0 of 137 archives ship a real song.ini, so all of them would have gained one.
    const sng = makeSng([NOTES], { name: 'Header Song', artist: 'Header Artist' })
    const repack = await readSngForRepack(new Uint8Array(sng))
    expect(repack.entries.map((e) => e.fileName)).toEqual(['notes.chart'])
    expect(repack.metadata.name).toBe('Header Song')

    const extracted = await extractSngEntries(new Uint8Array(sng))
    expect(extracted.map((e) => e.fileName)).toContain('song.ini')
  })

  it('keeps a song.ini the archive genuinely packs', async () => {
    const packed = encoder.encode('[song]\nname = Packed\n')
    const sng = makeSng([{ fileName: 'song.ini', data: packed }, NOTES], { name: 'Header' })
    const repack = await readSngForRepack(new Uint8Array(sng))
    expect(repack.entries.map((e) => e.fileName).sort()).toEqual(['notes.chart', 'song.ini'])
  })

  it('returns rather than hangs on an archive with no file entries', async () => {
    // parse-sng only drives the read by calling readFile on the first fileMeta entry, so an
    // empty archive emits `header` and then nothing at all. Resolving only from the `file`
    // handler would leave this promise pending forever.
    const repack = await readSngForRepack(new Uint8Array(makeSng([], { name: 'Empty' })))
    expect(repack.entries).toEqual([])
    expect(repack.metadata.name).toBe('Empty')
  })
})

/**
 * The property under test, "no descriptor is left open", has no portable API. /proc/self/fd is
 * the only way to observe it directly, so these run on Linux alone; that is where the suite runs
 * and, more to the point, where the leak was measured in the first place. The platform this
 * protects is Windows, which cannot be tested from here at all: see readSngFile's comment.
 */
const observable = process.platform === 'linux'

function openUnder(dir: string): string[] {
  return readdirSync('/proc/self/fd').flatMap((fd) => {
    try {
      const target = readlinkSync(join('/proc/self/fd', fd))
      return target.startsWith(dir) ? [target] : []
    } catch {
      // The descriptor listing is itself a descriptor, and it closes underneath the loop.
      return []
    }
  })
}

function sngOnDisk(): { dir: string; path: string } {
  const dir = tmpDir('sng-fd')
  const path = join(dir, 'chart.sng')
  writeFileSync(path, makeSng([NOTES], { name: 'Song' }))
  return { dir, path }
}

describe('readSngFile', () => {
  it('reads the archive', async () => {
    const { path } = sngOnDisk()
    const repack = await readSngFile(path, readSngForRepack)
    expect(repack.entries.map((e) => e.fileName)).toEqual(['notes.chart'])
    expect(repack.metadata.name).toBe('Song')
  })

  it.skipIf(!observable)('leaves no descriptor open once it resolves', async () => {
    const { dir, path } = sngOnDisk()
    await readSngFile(path, readSngForRepack)
    expect(openUnder(dir)).toEqual([])
  })

  it.skipIf(!observable)('leaves no descriptor open when the read throws', async () => {
    const { dir, path } = sngOnDisk()
    await expect(
      readSngFile(path, () => Promise.reject(new Error('parse failed')))
    ).rejects.toThrow('parse failed')
    expect(openUnder(dir)).toEqual([])
  })

  it.skipIf(!observable)('leaves no descriptor open on an unreadable archive', async () => {
    // The failure arrives from parse-sng mid-stream rather than from a rejected callback, so the
    // source stream is abandoned in a different state than the test above leaves it.
    const dir = tmpDir('sng-fd-bad')
    const path = join(dir, 'chart.sng')
    writeFileSync(path, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
    await expect(readSngFile(path, readSngForRepack)).rejects.toThrow()
    expect(openUnder(dir)).toEqual([])
  })
})
