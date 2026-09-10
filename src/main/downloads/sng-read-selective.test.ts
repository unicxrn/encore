import { readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractSngEntries, type SngEntry } from './sng'
import { buildSng } from './sng-write'
import {
  extractSngEntryToFile,
  generateSongIniText,
  readSngEntriesForScan
} from './sng-read-selective'
import { readRepackPlan } from './sng-repack'
import { tmpDir } from '../../../test/helpers/tmp'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)
const text = (data: Uint8Array): string => new TextDecoder().decode(data)

/** Not sng-write's default mask: every byte compared below must survive a real unmask. */
const MASK = new Uint8Array(16).map((_, i) => (i * 37 + 5) % 256)

const NOTES = bytes('[Song]\n{\n  Resolution = 192\n}\n')
const ART = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])

/** Stands in for audio and video: far larger than the header, and never needed by the scan. */
const media = (seed: number): Uint8Array =>
  new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * seed + 13) % 256)

/**
 * Ordered so that a naive `Object.keys` walk would emit a different file from parse-sng's:
 * `custom_key` is an extra and must land after every default key that is written, and
 * `diff_bass` holds its own default value, which parse-sng omits.
 */
const METADATA: Record<string, string> = {
  custom_key: 'custom value',
  diff_bass: '-1',
  name: 'Bloom',
  artist: 'Of Mice & Men',
  charter: 'SirMonkfish',
  album_track: '3',
  loading_phrase: ''
}

const ENTRIES: SngEntry[] = [
  { fileName: 'notes.chart', data: NOTES },
  { fileName: 'song.ogg', data: media(31) },
  { fileName: 'album.png', data: ART },
  { fileName: 'video.webm', data: media(17) }
]

function scratch(): string {
  return tmpDir('scan-read')
}

function writeSng(entries = ENTRIES, metadata = METADATA): string {
  const path = join(scratch(), 'chart.sng')
  writeFileSync(path, buildSng(entries, metadata, MASK))
  return path
}

/** What the scanner reads today: parse-sng streaming every entry out of the whole archive. */
function fullExtraction(path: string): Promise<SngEntry[]> {
  return extractSngEntries(new Uint8Array(readFileSync(path)))
}

function byName(entries: SngEntry[], fileName: string): SngEntry {
  const entry = entries.find((e) => e.fileName === fileName)
  if (!entry) throw new Error(`no entry named ${fileName}`)
  return entry
}

describe('readSngEntriesForScan', () => {
  it('returns real bytes for the files scan-chart reads', async () => {
    const path = writeSng()

    const { entries } = await readSngEntriesForScan(path)

    expect(byName(entries, 'notes.chart').data).toEqual(NOTES)
    expect(byName(entries, 'album.png').data).toEqual(ART)
  })

  it('returns every other file named but empty', async () => {
    const path = writeSng()

    const { entries } = await readSngEntriesForScan(path)

    expect(byName(entries, 'song.ogg').data).toEqual(new Uint8Array(0))
    expect(byName(entries, 'video.webm').data).toEqual(new Uint8Array(0))
  })

  it('reads a small fraction of the archive', async () => {
    const path = writeSng()
    const archiveBytes = statSync(path).size

    const { bytesRead } = await readSngEntriesForScan(path)

    // The point of the module. One header read plus the two files above. Nothing else on disk
    // is touched, so the cost does not grow with the audio and video that dominate a real chart.
    expect(bytesRead).toBeLessThanOrEqual(65536 + NOTES.length + ART.length)
    expect(bytesRead / archiveBytes).toBeLessThan(0.05)
  })

  it('reads every .ini and every chart file whole', async () => {
    const path = writeSng([
      { fileName: 'notes.mid', data: bytes('MThd fake') },
      { fileName: 'guitar.chart', data: bytes('[Song]\n') },
      { fileName: 'setlist.ini', data: bytes('[setlist]\nname = x\n') },
      { fileName: 'background.jpg', data: bytes('jpeg-ish') }
    ])

    const { entries } = await readSngEntriesForScan(path)

    expect(byName(entries, 'notes.mid').data).toEqual(bytes('MThd fake'))
    expect(byName(entries, 'guitar.chart').data).toEqual(bytes('[Song]\n'))
    expect(byName(entries, 'setlist.ini').data).toEqual(bytes('[setlist]\nname = x\n'))
    // Not read by scan-chart at any point: only album art bytes are ever inspected.
    expect(byName(entries, 'background.jpg').data).toEqual(new Uint8Array(0))
  })

  it('names entries in the same order as a full extraction', async () => {
    const path = writeSng()

    const { entries } = await readSngEntriesForScan(path)

    expect(entries.map((e) => e.fileName)).toEqual(
      (await fullExtraction(path)).map((e) => e.fileName)
    )
  })

  it('generates the same song.ini parse-sng would have', async () => {
    const path = writeSng()

    const { entries } = await readSngEntriesForScan(path)

    expect(byName(entries, 'song.ini').data).toEqual(
      byName(await fullExtraction(path), 'song.ini').data
    )
  })

  it('generates the same song.ini for an archive with no header metadata', async () => {
    const path = writeSng(ENTRIES, {})

    const { entries } = await readSngEntriesForScan(path)

    expect(byName(entries, 'song.ini').data).toEqual(
      byName(await fullExtraction(path), 'song.ini').data
    )
  })

  it('prefers a packed song.ini, in the slot the generated one holds', async () => {
    const packed = bytes('[Song]\nname = Packed\n')
    const path = writeSng([
      { fileName: 'notes.chart', data: NOTES },
      { fileName: 'song.ini', data: packed },
      { fileName: 'song.ogg', data: media(31) }
    ])

    const { entries } = await readSngEntriesForScan(path)

    const full = await fullExtraction(path)
    expect(entries.map((e) => e.fileName)).toEqual(full.map((e) => e.fileName))
    expect(byName(entries, 'song.ini').data).toEqual(packed)
    expect(byName(full, 'song.ini').data).toEqual(packed)
  })

  it('handles an archive with no entries at all', async () => {
    const path = writeSng([], { name: 'Bare' })

    const { entries } = await readSngEntriesForScan(path)

    expect(entries.map((e) => e.fileName)).toEqual(['song.ini'])
    expect(text(byName(entries, 'song.ini').data)).toBe('[song]\nname = Bare\n')
  })

  it('fails, naming the entry, when the archive ends inside a file it needs', async () => {
    // Album art last, so the truncation lands in a file this module actually reads. A short
    // read of one it only names is invisible by design, because it never asks for those bytes.
    const path = writeSng([
      { fileName: 'song.ogg', data: media(31) },
      { fileName: 'album.png', data: ART }
    ])
    truncateSync(path, statSync(path).size - 4)

    await expect(readSngEntriesForScan(path)).rejects.toThrow(/album\.png/)
  })
})

describe('extractSngEntryToFile', () => {
  it('writes a multi-megabyte entry to disk byte for byte', async () => {
    const path = writeSng()
    const dest = join(dirname(path), 'video.out')

    const written = await extractSngEntryToFile(
      path,
      await readRepackPlan(path),
      'video.webm',
      dest
    )

    // Against the reader the app already trusts, not against the fixture: this has to agree with
    // what parse-sng would have handed the scanner, and the entry spans several chunks, so a
    // mask index restarted per chunk would show up here and nowhere else.
    expect(written).toBe(media(17).length)
    expect(new Uint8Array(readFileSync(dest))).toEqual(
      byName(await fullExtraction(path), 'video.webm').data
    )
  })

  it('refuses to overwrite a file already at the destination', async () => {
    const path = writeSng()
    const dest = join(dirname(path), 'video.out')
    writeFileSync(dest, 'left over from a previous attempt')

    await expect(
      extractSngEntryToFile(path, await readRepackPlan(path), 'video.webm', dest)
    ).rejects.toThrow(/EEXIST/)
    // Untouched: a caller that believed this wrote would hand ffmpeg someone else's file.
    expect(text(new Uint8Array(readFileSync(dest)))).toBe('left over from a previous attempt')
  })

  it('names the entry it cannot find', async () => {
    const path = writeSng()
    await expect(
      extractSngEntryToFile(path, await readRepackPlan(path), 'video.mp4', join(scratch(), 'o'))
    ).rejects.toThrow(/video\.mp4/)
  })
})

describe('generateSongIniText', () => {
  it('writes known keys in parse-sng order, then the rest', () => {
    expect(text(generateSongIniText(METADATA))).toBe(
      '[song]\nname = Bloom\nartist = Of Mice & Men\ncharter = SirMonkfish\nalbum_track = 3\ncustom_key = custom value\n'
    )
  })

  it('omits a key whose value is the one parse-sng treats as unset', () => {
    expect(text(generateSongIniText({ name: 'X', diff_guitar: '-1', icon: '' }))).toBe(
      '[song]\nname = X\n'
    )
  })

  it('writes a bare section for empty metadata', () => {
    expect(text(generateSongIniText({}))).toBe('[song]\n')
  })
})
