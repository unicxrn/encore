import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePng } from '../../../../test/helpers/make-png'
import { makeSng } from '../../../../test/helpers/make-sng'
import { scanChartIssues, type ChartIssueRow } from '../../catalog/issues'
import { readSngEntriesForScan } from '../../downloads/sng-read-selective'
import { applyFix, type AlbumArtSquarer, type FixContext } from '../fix'
import { albumArtNameRules, albumArtSizeAction } from './album-art-size'
import { tmpDir } from '../../../../test/helpers/tmp'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

const NOTES = bytes(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
)

/** `pro_drums` and `hopo_frequency` away from their defaults, so they really feed getChartHash. */
const SONG_INI = bytes(
  '[song]\nname = Fixture\nartist = Tester\ncharter = Tester\ndiff_guitar = 3\npro_drums = True\nhopo_frequency = 3\n'
)

/** A size scan-chart rejects: it accepts exactly "500x500" and "512x512" and nothing else. */
const SMALL_ART = makePng(300, 300)

const scratchDirs: string[] = []

function scratch(): string {
  const dir = tmpDir('albumart')
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

function folderChart(files: Record<string, Uint8Array> = {}): string {
  const dir = join(scratch(), 'Tester - Fixture')
  mkdirSync(dir, { recursive: true })
  const all = { 'notes.chart': NOTES, 'song.ini': SONG_INI, 'album.png': SMALL_ART, ...files }
  for (const [name, data] of Object.entries(all)) writeFileSync(join(dir, name), data)
  return dir
}

function sngChart(files: Record<string, Uint8Array> = {}): string {
  const path = join(scratch(), 'fixture.sng')
  const all = { 'notes.chart': NOTES, 'song.ini': SONG_INI, 'album.png': SMALL_ART, ...files }
  writeFileSync(
    path,
    makeSng(
      Object.entries(all).map(([fileName, data]) => ({ fileName, data })),
      { name: 'Fixture', artist: 'Tester', charter: 'Tester' }
    )
  )
  return path
}

/** scan-chart's own wording, verbatim from index.js:2648. */
function row(chartPath: string, size = '300x300'): ChartIssueRow {
  return {
    chartPath,
    kind: 'folder',
    code: 'albumArtSize',
    description: `This chart's album art is ${size}, and should be 512x512.`
  }
}

/**
 * Stands in for `encodeSquareAlbumArt`, which cannot run here: the real one is built on Electron's
 * `nativeImage`, and under vitest `electron` resolves to a CJS stub whose `nativeImage` is
 * undefined, which is the same reason the scanner takes its art encoder as a parameter.
 *
 * It returns a real, parseable 512x512 PNG rather than a marker, so the post-fix re-scan runs
 * exifreader for real and the row genuinely clears instead of turning into `badAlbumArt`.
 */
const squareArt: AlbumArtSquarer = () => makePng(512, 512)

function ctxFor(chartPath: string, over: Partial<FixContext> = {}): FixContext {
  return {
    libraryFolders: [{ path: join(chartPath, '..') }],
    image: squareArt,
    // A real store rather than `null`: every repair exercised below then also takes its backup,
    // so an action whose `backup` reads the wrong file fails here and not only in restore.test.ts.
    backupDir: join(scratch(), 'fix-backups'),
    ...over
  }
}

describe('the name rules', () => {
  it("matches scan-chart's hasAlbumName exactly, and nothing wider", () => {
    // Deliberately NOT the case-insensitive ALBUM_ART_RE the art writer uses. `Album.PNG` is not
    // a cover to scan-chart, so it cannot be the file this row is about, and re-encoding it would
    // be acting on a file the report never mentioned.
    for (const name of ['album.jpg', 'album.jpeg', 'album.png']) {
      expect(albumArtNameRules.isAlbumName(name)).toBe(true)
    }
    for (const name of ['Album.PNG', 'album.PNG', 'album.webp', 'albums.png', 'cover.png']) {
      expect(albumArtNameRules.isAlbumName(name)).toBe(false)
    }
  })

  it('writes back the container it read', () => {
    expect(albumArtNameRules.formatOf('album.png')).toBe('png')
    expect(albumArtNameRules.formatOf('album.jpg')).toBe('jpeg')
    expect(albumArtNameRules.formatOf('album.jpeg')).toBe('jpeg')
  })

  it('only claims rows from the folder issue array', () => {
    expect(albumArtSizeAction.appliesTo(row('/lib/c'))).toBe(true)
    expect(albumArtSizeAction.appliesTo({ ...row('/lib/c'), kind: 'metadata' })).toBe(false)
  })
})

describe('albumArtSize on a folder chart', () => {
  it("clears the row, keeping the cover's name and format", async () => {
    const chart = folderChart()

    const after = await applyFix(row(chart), ctxFor(chart))

    expect(after.map((r) => r.code)).not.toContain('albumArtSize')
    // Same name, so nothing is superseded and the chart does not gain a second cover.
    expect(after.map((r) => r.code)).not.toContain('multipleAlbumArt')
    expect(readFileSync(join(chart, 'album.png')).length).toBe(makePng(512, 512).length)
  })

  it("hands the encoder the cover's real bytes", async () => {
    const chart = folderChart()
    const encode = vi.fn<AlbumArtSquarer>(() => makePng(512, 512))

    await applyFix(row(chart), ctxFor(chart, { image: encode }))

    // Deriving nothing from the input would let every other assertion here pass over an empty
    // placeholder. The format argument is what keeps a `.png` from coming back as JPEG.
    expect(encode).toHaveBeenCalledWith(SMALL_ART, 'png')
  })

  it('leaves the multiplayer hash byte-identical', async () => {
    const chart = folderChart()
    const before = await scanChartIssues(chart, 'folder')

    await applyFix(row(chart), ctxFor(chart))

    const after = await scanChartIssues(chart, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.chartHash).not.toBeNull()
    // And the number Clone Hero itself records, which is the chart file's bytes alone.
    expect(after.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
    expect(after.cloneHeroChecksum).not.toBeNull()
  })

  it('re-encodes the cover scan-chart reads, not whichever it finds first', async () => {
    // `findAlbumData` keeps the LAST album-named file it walks past, and the scan walks a folder
    // in `readdirSync` order. Fixing the other one would leave the flagged file exactly where it
    // was and the row exactly where it was. The expectation is computed from the same call the
    // scan makes rather than hardcoded, because readdir order is the filesystem's to choose.
    const OTHER_ART = makePng(400, 400)
    const chart = folderChart({ 'album.jpg': OTHER_ART })
    const covers = readdirSync(chart).filter((name) => name === 'album.jpg' || name === 'album.png')
    const read = covers[covers.length - 1]
    const untouched = read === 'album.png' ? 'album.jpg' : 'album.png'
    const encode = vi.fn<AlbumArtSquarer>(() => makePng(512, 512))

    await applyFix(row(chart), ctxFor(chart, { image: encode }))

    expect(encode).toHaveBeenCalledWith(
      read === 'album.png' ? SMALL_ART : OTHER_ART,
      read === 'album.png' ? 'png' : 'jpeg'
    )
    expect(new Uint8Array(readFileSync(join(chart, read)))).toEqual(makePng(512, 512))
    // The cover this row was not about keeps its bytes. `multipleAlbumArt` is a different
    // question (which one do you want?), and this fix does not answer it either way.
    expect(new Uint8Array(readFileSync(join(chart, untouched)))).toEqual(
      untouched === 'album.png' ? SMALL_ART : OTHER_ART
    )
  })

  it('reports why it cannot run when no encoder is wired up', async () => {
    const chart = folderChart()

    await expect(
      applyFix(row(chart), { libraryFolders: [{ path: join(chart, '..') }], backupDir: null })
    ).rejects.toThrow(/Image encoding is not available/)
  })

  it('fails rather than inventing a cover when the art has gone', async () => {
    const chart = folderChart()
    rmSync(join(chart, 'album.png'))

    await expect(applyFix(row(chart), ctxFor(chart))).rejects.toThrow(/no longer has album art/)
  })
})

describe('albumArtSize on a .sng chart', () => {
  it('clears the row through a full repack and keeps the hash', async () => {
    const chart = sngChart()
    const before = await scanChartIssues(chart, 'sng')
    expect(before.rows.map((r) => r.code)).toContain('albumArtSize')

    const after = await applyFix(row(chart), ctxFor(chart))

    expect(after.map((r) => r.code)).not.toContain('albumArtSize')
    const rescan = await scanChartIssues(chart, 'sng')
    expect(rescan.chartHash).toBe(before.chartHash)
    expect(rescan.chartHash).not.toBeNull()
    // And the number Clone Hero itself records, which is the chart file's bytes alone.
    expect(rescan.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
    expect(rescan.cloneHeroChecksum).not.toBeNull()
  })

  it('replaces the entry rather than adding a second one', async () => {
    const chart = sngChart()

    await applyFix(row(chart), ctxFor(chart))

    const { entries } = await readSngEntriesForScan(chart)
    expect(entries.filter((e) => e.fileName === 'album.png')).toHaveLength(1)
    expect(entries.map((e) => e.fileName).sort()).toEqual(['album.png', 'notes.chart', 'song.ini'])
  })
})
