import { describe, expect, it } from 'vitest'
import { SngStream } from 'parse-sng'
import { makeSng, makeFixtureSng } from './make-sng'

async function extractSng(buffer: Buffer): Promise<{ fileName: string; data: Uint8Array }[]> {
  const extracted: { fileName: string; data: Uint8Array }[] = []
  const stream = new SngStream(new Blob([new Uint8Array(buffer)]).stream())
  await new Promise<void>((resolve, reject) => {
    stream.on('file', (fileName, fileStream, nextFile) => {
      void (async () => {
        const chunks: Uint8Array[] = []
        const reader = fileStream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        extracted.push({ fileName, data: new Uint8Array(Buffer.concat(chunks)) })
        if (nextFile) nextFile()
        else resolve()
      })().catch(reject)
    })
    stream.on('error', reject)
    stream.start()
  })
  return extracted
}

const FILES = [
  {
    fileName: 'song.ini',
    data: new TextEncoder().encode(
      '[song]\nname = Sng Song\nartist = Sng Artist\ncharter = Tester\ndiff_guitar = 3\n'
    )
  },
  {
    fileName: 'notes.chart',
    data: new TextEncoder().encode(
      '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n}\n'
    )
  }
]

describe('makeSng', () => {
  it('produces a buffer parse-sng can round-trip byte-identically', async () => {
    const buffer = makeSng(FILES)
    const extracted = await extractSng(buffer)

    const names = extracted.map((f) => f.fileName)
    expect(names).toContain('song.ini')
    expect(names).toContain('notes.chart')

    for (const original of FILES) {
      const found = extracted.find((f) => f.fileName === original.fileName)
      expect(found, `missing ${original.fileName}`).toBeDefined()
      expect(Buffer.from(found!.data).equals(Buffer.from(original.data))).toBe(true)
    }

    const ini = extracted.find((f) => f.fileName === 'song.ini')
    expect(new TextDecoder().decode(ini?.data)).toContain('Sng Artist')
  })

  it('rejects file names longer than 127 bytes', () => {
    expect(() => makeSng([{ fileName: 'a'.repeat(128), data: new Uint8Array(0) }])).toThrow()
  })
})

describe('makeFixtureSng', () => {
  it('returns a two-file chart with the expected metadata', async () => {
    const extracted = await extractSng(makeFixtureSng())

    expect(extracted.map((f) => f.fileName).sort()).toEqual(['notes.chart', 'song.ini'])

    const ini = new TextDecoder().decode(extracted.find((f) => f.fileName === 'song.ini')?.data)
    expect(ini).toContain('name = Sng Song')
    expect(ini).toContain('artist = Sng Artist')
    expect(ini).toContain('charter = Tester')
    expect(ini).toContain('diff_guitar = 3')

    const chart = new TextDecoder().decode(
      extracted.find((f) => f.fileName === 'notes.chart')?.data
    )
    expect(chart).toContain('[Song]')
    expect(chart).toContain('[SyncTrack]')
    expect(chart).toContain('[ExpertSingle]')
  })
})
