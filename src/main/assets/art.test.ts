import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { scanChartIssues } from '../catalog/issues'
import { readSngForRepack } from '../downloads/sng'
import { listBackups } from '../issues/backup-store'
import { restoreBackup } from '../issues/restore'
import { downloadArt, searchAlbumArt } from './art'
import { tmpDir } from '../../../test/helpers/tmp'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal mock fetch that returns a JSON body. */
function jsonFetch(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: () => Promise.resolve(body),
      headers: { get: () => null }
    } as unknown as Response)) as typeof fetch
}

/** Build a mock fetch that returns image bytes with the given content-type. */
function imageFetch(
  contentType: string,
  bytes: Uint8Array = new Uint8Array([1, 2, 3])
): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (h: string) => (h === 'content-type' ? contentType : null) },
      arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer)
    } as unknown as Response)) as typeof fetch
}

/** Build a mock fetch that returns non-200. */
function failFetch(status: number, statusText = 'Error'): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: false,
      status,
      statusText,
      headers: { get: () => null }
    } as unknown as Response)) as typeof fetch
}

// ─── searchAlbumArt ──────────────────────────────────────────────────────────

describe('searchAlbumArt', () => {
  it('returns parsed results with 600x600 fullUrl substitution', async () => {
    const mockBody = {
      results: [
        {
          artistName: 'Tool',
          collectionName: 'Lateralus',
          artworkUrl100: 'https://a1.mzstatic.com/us/r30/Music/001/100x100bb.jpg'
        },
        {
          artistName: 'Radiohead',
          collectionName: 'OK Computer',
          artworkUrl100: 'https://a2.mzstatic.com/us/r30/Music/002/100x100bb.jpg'
        }
      ]
    }
    const results = await searchAlbumArt('tool lateralus', jsonFetch(200, mockBody))
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      artist: 'Tool',
      album: 'Lateralus',
      thumbUrl: 'https://a1.mzstatic.com/us/r30/Music/001/100x100bb.jpg',
      fullUrl: 'https://a1.mzstatic.com/us/r30/Music/001/600x600bb.jpg'
    })
    expect(results[1].fullUrl).toContain('600x600')
  })

  it('skips entries missing artworkUrl100', async () => {
    const mockBody = {
      results: [
        { artistName: 'A', collectionName: 'B' }, // no artworkUrl100
        {
          artistName: 'C',
          collectionName: 'D',
          artworkUrl100: 'https://a.mzstatic.com/100x100bb.jpg'
        }
      ]
    }
    const results = await searchAlbumArt('test', jsonFetch(200, mockBody))
    expect(results).toHaveLength(1)
    expect(results[0].artist).toBe('C')
  })

  it('returns empty array when results is empty', async () => {
    const results = await searchAlbumArt('nothing', jsonFetch(200, { results: [] }))
    expect(results).toEqual([])
  })

  it('returns empty array when results key is absent', async () => {
    const results = await searchAlbumArt('nothing', jsonFetch(200, {}))
    expect(results).toEqual([])
  })

  it('throws on non-200 response', async () => {
    await expect(searchAlbumArt('foo', failFetch(503, 'Service Unavailable'))).rejects.toThrow(
      /503/
    )
  })

  it('throws with a clear message on invalid JSON', async () => {
    const badJsonFetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
        headers: { get: () => null }
      } as unknown as Response)) as typeof fetch
    await expect(searchAlbumArt('foo', badJsonFetch)).rejects.toThrow(/invalid JSON/i)
  })
})

// ─── downloadArt ─────────────────────────────────────────────────────────────

describe('downloadArt', () => {
  let root: string
  let library: string
  let chartDir: string

  beforeEach(() => {
    root = tmpDir('art')
    library = join(root, 'library')
    chartDir = join(library, 'Artist - Song (Charter)')
    mkdirSync(chartDir, { recursive: true })
  })

  const folders = (): { path: string }[] => [{ path: library }]
  const mzUrl = 'https://a1.mzstatic.com/us/r30/Music/600x600bb.jpg'

  it('writes album.png and returns the final path for image/png', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]) // PNG magic
    const path = await downloadArt(
      mzUrl,
      chartDir,
      'folder',
      folders(),
      null,
      imageFetch('image/png', bytes)
    )
    expect(path).toBe(join(chartDir, 'album.png'))
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes)
  })

  it('writes album.jpg and returns the final path for image/jpeg', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]) // JPEG magic
    const path = await downloadArt(
      mzUrl,
      chartDir,
      'folder',
      folders(),
      null,
      imageFetch('image/jpeg', bytes)
    )
    expect(path).toBe(join(chartDir, 'album.jpg'))
  })

  it('also writes album.jpg for image/jpeg; charset suffix is tolerated', async () => {
    const path = await downloadArt(
      mzUrl,
      chartDir,
      'folder',
      folders(),
      null,
      imageFetch('image/jpeg; charset=utf-8')
    )
    expect(path).toBe(join(chartDir, 'album.jpg'))
  })

  it('rejects a non-HTTPS url', async () => {
    await expect(
      downloadArt(
        'http://a1.mzstatic.com/art.jpg',
        chartDir,
        'folder',
        folders(),
        null,
        imageFetch('image/jpeg')
      )
    ).rejects.toThrow(/HTTPS/i)
  })

  it('rejects a url whose hostname does not end with .mzstatic.com', async () => {
    await expect(
      downloadArt(
        'https://evil.example.com/art.jpg',
        chartDir,
        'folder',
        folders(),
        null,
        imageFetch('image/jpeg')
      )
    ).rejects.toThrow(/mzstatic\.com/i)
  })

  it('rejects an invalid url', async () => {
    await expect(
      downloadArt('not-a-url', chartDir, 'folder', folders(), null, imageFetch('image/jpeg'))
    ).rejects.toThrow(/invalid/i)
  })

  it('rejects an unsupported content-type', async () => {
    await expect(
      downloadArt(mzUrl, chartDir, 'folder', folders(), null, imageFetch('image/webp'))
    ).rejects.toThrow(/content-type/i)
  })

  it('repacks the art into a .sng chart when the row says sng', async () => {
    const sngPath = join(library, 'Artist - Song.sng')
    writeFileSync(
      sngPath,
      makeSng([{ fileName: 'notes.chart', data: new TextEncoder().encode('[Song]\n{\n}\n') }], {
        name: 'Song'
      })
    )
    const bytes = new Uint8Array([137, 80, 78, 71])
    const path = await downloadArt(
      mzUrl,
      sngPath,
      'sng',
      folders(),
      null,
      imageFetch('image/png', bytes)
    )
    // The archive itself is what changed, so that is the path reported back.
    expect(path).toBe(sngPath)
    const back = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(back.entries.find((e) => e.fileName === 'album.png')?.data).toEqual(bytes)
  })

  // ─── replacing a cover that is already there ───────────────────────────────
  //
  // Art that arrives in a different format from the one already on disk used to leave both
  // files behind; scan-chart then reports multipleAlbumArt. Every one of the 16 charts in M6's
  // real-library probe hit this.

  const JPEG = new Uint8Array([0xff, 0xd8, 0xff])
  const PNG = new Uint8Array([137, 80, 78, 71])

  it('removes the stale sibling cover from a folder chart', async () => {
    writeFileSync(join(chartDir, 'album.jpg'), JPEG)
    await downloadArt(mzUrl, chartDir, 'folder', folders(), null, imageFetch('image/png', PNG))
    expect(readdirSync(chartDir).sort()).toEqual(['album.png'])
  })

  it('removes every other cover name and leaves everything else alone', async () => {
    writeFileSync(join(chartDir, 'album.jpg'), JPEG)
    writeFileSync(join(chartDir, 'album.jpeg'), JPEG)
    writeFileSync(join(chartDir, 'albumart.jpg'), JPEG) // not a cover name Clone Hero reads
    writeFileSync(join(chartDir, 'notes.chart'), new Uint8Array([1]))
    await downloadArt(mzUrl, chartDir, 'folder', folders(), null, imageFetch('image/png', PNG))
    expect(readdirSync(chartDir).sort()).toEqual(['album.png', 'albumart.jpg', 'notes.chart'])
  })

  it('removes a cover whose name differs only in case, such as Album.jpg', async () => {
    // A real chart in the user's library ships Album.jpg with a capital A. On Windows that IS
    // album.jpg, so it has to go either way; matching case-insensitively makes Linux agree.
    writeFileSync(join(chartDir, 'Album.jpg'), JPEG)
    await downloadArt(mzUrl, chartDir, 'folder', folders(), null, imageFetch('image/png', PNG))
    expect(readdirSync(chartDir).sort()).toEqual(['album.png'])
  })

  it('keeps a name that differs only in case from the file just written', async () => {
    // POSIX-only assertion: on a case-insensitive filesystem Album.PNG and album.png are one
    // file, and removing it by name would delete the cover just written. Leaving it is the
    // only choice that cannot end with no cover at all.
    writeFileSync(join(chartDir, 'Album.PNG'), PNG)
    await downloadArt(mzUrl, chartDir, 'folder', folders(), null, imageFetch('image/png', PNG))
    expect(readdirSync(chartDir).sort()).toEqual(['Album.PNG', 'album.png'])
  })

  it('keeps the existing cover when the new one fails to land', async () => {
    // The write is what earns the removal. A directory on the target path fails the rename,
    // and a failed art download must not cost the user the cover they already had.
    writeFileSync(join(chartDir, 'album.jpg'), JPEG)
    mkdirSync(join(chartDir, 'album.png'))
    await expect(
      downloadArt(mzUrl, chartDir, 'folder', folders(), null, imageFetch('image/png', PNG))
    ).rejects.toThrow()
    expect(new Uint8Array(readFileSync(join(chartDir, 'album.jpg')))).toEqual(JPEG)
  })

  it('replaces a packed cover inside a .sng in one repack', async () => {
    const sngPath = join(library, 'Artist - Song.sng')
    const notes = new TextEncoder().encode('[Song]\n{\n}\n')
    writeFileSync(
      sngPath,
      makeSng(
        [
          { fileName: 'notes.chart', data: notes },
          { fileName: 'album.jpg', data: JPEG }
        ],
        { name: 'Song', artist: 'Artist' }
      )
    )
    await downloadArt(mzUrl, sngPath, 'sng', folders(), null, imageFetch('image/png', PNG))
    const back = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(back.entries.map((e) => e.fileName).sort()).toEqual(['album.png', 'notes.chart'])
    expect(back.entries.find((e) => e.fileName === 'album.png')?.data).toEqual(PNG)
    // Every other entry and the header survive the rebuild untouched.
    expect(back.entries.find((e) => e.fileName === 'notes.chart')?.data).toEqual(notes)
    expect(back.metadata.name).toBe('Song')
    expect(back.metadata.artist).toBe('Artist')
    // No temp survives the swap. That the removal happens inside the one rebuild is what
    // sng-asset.test.ts pins down; from here only the outcome is visible.
    expect(readdirSync(library).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('rejects a chartDir outside the library (guarded write)', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    await expect(
      downloadArt(mzUrl, outside, 'folder', [{ path: library }], null, imageFetch('image/png'))
    ).rejects.toThrow(/library/i)
  })
})

// ─── undo ────────────────────────────────────────────────────────────────────

/**
 * The download keeps the cover it supersedes in the repairs' store, and the repairs' restore
 * puts it back. Asserted on BYTES, as restore.test.ts does: a cover of the right name proves the
 * chart looks unchanged, and only the bytes prove it is.
 */
describe('downloadArt undo', () => {
  let root: string
  let library: string
  let chartDir: string
  let store: string

  const NOTES = new TextEncoder().encode(
    '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n}\n'
  )
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff])
  const PNG = new Uint8Array([137, 80, 78, 71])

  beforeEach(() => {
    root = tmpDir('art-undo')
    library = join(root, 'library')
    chartDir = join(library, 'Artist - Song (Charter)')
    mkdirSync(chartDir, { recursive: true })
    writeFileSync(join(chartDir, 'notes.chart'), NOTES)
    // Outside the library, as `userData` is in production.
    store = join(root, 'fix-backups')
  })

  const folders = (): { path: string }[] => [{ path: library }]
  const mzUrl = 'https://a1.mzstatic.com/us/r30/Music/600x600bb.jpg'

  async function undo(): Promise<void> {
    const backups = listBackups(store)
    expect(backups).toHaveLength(1)
    await restoreBackup({ storeDir: store, libraryFolders: folders() }, backups[0].id)
  }

  it("puts a folder chart's superseded cover back, byte for byte, and removes the download", async () => {
    writeFileSync(join(chartDir, 'album.jpg'), JPEG)
    const before = await scanChartIssues(chartDir, 'folder')

    await downloadArt(mzUrl, chartDir, 'folder', folders(), store, imageFetch('image/png', PNG))
    expect(readdirSync(chartDir).sort()).toEqual(['album.png', 'notes.chart'])

    const [backup] = listBackups(store)
    expect(backup.describe).toBe('Album art')
    expect(backup.code).toBe('art')
    expect(backup.chartHash).toBe(before.chartHash)

    await undo()

    expect(readdirSync(chartDir).sort()).toEqual(['album.jpg', 'notes.chart'])
    expect(new Uint8Array(readFileSync(join(chartDir, 'album.jpg')))).toEqual(JPEG)
    expect((await scanChartIssues(chartDir, 'folder')).chartHash).toBe(before.chartHash)
    expect(listBackups(store)).toEqual([])
  })

  it('puts the cover back in place when the download replaced it under the same name', async () => {
    writeFileSync(join(chartDir, 'album.png'), JPEG)
    await downloadArt(mzUrl, chartDir, 'folder', folders(), store, imageFetch('image/png', PNG))
    expect(new Uint8Array(readFileSync(join(chartDir, 'album.png')))).toEqual(PNG)

    await undo()

    expect(new Uint8Array(readFileSync(join(chartDir, 'album.png')))).toEqual(JPEG)
  })

  it('removes the download from a chart that had no cover, leaving it as it was', async () => {
    await downloadArt(mzUrl, chartDir, 'folder', folders(), store, imageFetch('image/png', PNG))
    expect(existsSync(join(chartDir, 'album.png'))).toBe(true)

    await undo()

    expect(readdirSync(chartDir)).toEqual(['notes.chart'])
  })

  it("leaves a case-variant of the download's name exactly as it found it", async () => {
    // Album.PNG is spared by the sweep on Linux (see stale-siblings.ts) and would be overwritten
    // on Windows. Kept in the backup either way; here it survives the download and the undo with
    // its own bytes, and the undo removes only the name the download created.
    writeFileSync(join(chartDir, 'Album.PNG'), JPEG)
    await downloadArt(mzUrl, chartDir, 'folder', folders(), store, imageFetch('image/png', PNG))
    expect(readdirSync(chartDir).sort()).toEqual(['Album.PNG', 'album.png', 'notes.chart'])

    await undo()

    expect(readdirSync(chartDir).sort()).toEqual(['Album.PNG', 'notes.chart'])
    expect(new Uint8Array(readFileSync(join(chartDir, 'Album.PNG')))).toEqual(JPEG)
  })

  it("puts a .sng chart's superseded cover back, byte for byte, through a repack", async () => {
    const sngPath = join(library, 'Artist - Song.sng')
    writeFileSync(
      sngPath,
      makeSng(
        [
          { fileName: 'notes.chart', data: NOTES },
          { fileName: 'album.jpg', data: JPEG }
        ],
        { name: 'Song', artist: 'Artist' }
      )
    )
    const before = await scanChartIssues(sngPath, 'sng')

    await downloadArt(mzUrl, sngPath, 'sng', folders(), store, imageFetch('image/png', PNG))
    const written = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(written.entries.map((e) => e.fileName).sort()).toEqual(['album.png', 'notes.chart'])

    await undo()

    const back = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(back.entries.map((e) => e.fileName).sort()).toEqual(['album.jpg', 'notes.chart'])
    expect(back.entries.find((e) => e.fileName === 'album.jpg')?.data).toEqual(JPEG)
    expect(back.entries.find((e) => e.fileName === 'notes.chart')?.data).toEqual(NOTES)
    expect((await scanChartIssues(sngPath, 'sng')).chartHash).toBe(before.chartHash)
  })

  it('fails the download, with the chart untouched, when the backup cannot be taken', async () => {
    writeFileSync(join(chartDir, 'album.jpg'), JPEG)
    // A file where the store should be, so the store cannot be created.
    writeFileSync(store, 'not a directory')

    await expect(
      downloadArt(mzUrl, chartDir, 'folder', folders(), store, imageFetch('image/png', PNG))
    ).rejects.toThrow()

    expect(readdirSync(chartDir).sort()).toEqual(['album.jpg', 'notes.chart'])
    expect(new Uint8Array(readFileSync(join(chartDir, 'album.jpg')))).toEqual(JPEG)
  })
})
