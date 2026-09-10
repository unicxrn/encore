import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeFixtureSng, makeHeaderMetadataSng, makeSng } from '../../../test/helpers/make-sng'
import { createV1Catalog } from '../../../test/helpers/v1-catalog'
import { ChartRecordSchema, JobProgress } from '../../shared/schemas'
import { openCatalog, SCAN_VERSION } from './db'
import { getChartByPath, countCharts, queryCharts, upsertChart } from './queries'
import { writeSngAsset } from '../assets/sng-asset'
import {
  cancelLibraryScan,
  findChartPaths,
  LibraryScanCanceled,
  scanChart,
  scanLibrary
} from './scanner'
import { tmpDir } from '../../../test/helpers/tmp'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(__dirname, '../../../test/fixtures/library')

/**
 * Art options pointing at a throwaway directory, with the identity function as the encoder.
 *
 * The real encoder (src/main/art-encode.ts) is built on Electron's `nativeImage`, which does
 * not exist outside the Electron runtime. The module imports fine here, but calling it throws.
 * That is why scanLibrary takes the encoder as a parameter at all. Identity also keeps the
 * cached bytes equal to the source bytes, which the two cover tests below rely on.
 */
const art = (): { dir: string; encode: (data: Uint8Array) => Uint8Array } => ({
  dir: tmpDir('art'),
  encode: (data) => data
})

const CHART_ONE_NOTE =
  '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n}\n'

// A 1x1 PNG. scan-chart only reads the image's dimensions, so this is enough to be recognised
// as a cover: it warns that it is not 512x512 but still hands back the bytes.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('findChartPaths', () => {
  it('finds the fixture chart folder', () => {
    const found = findChartPaths(FIXTURE)
    expect(found).toEqual([{ path: join(FIXTURE, 'Test Artist - Test Song'), type: 'folder' }])
  })
  it('finds nested chart folders and .sng files, ignores non-charts', () => {
    const root = tmpDir('walk')
    mkdirSync(join(root, 'Pack/Deep Song'), { recursive: true })
    writeFileSync(join(root, 'Pack/Deep Song/notes.mid'), '')
    writeFileSync(join(root, 'single.sng'), '')
    mkdirSync(join(root, 'Not A Chart'))
    writeFileSync(join(root, 'Not A Chart/readme.txt'), '')
    const found = findChartPaths(root)
    expect(found).toContainEqual({ path: join(root, 'Pack/Deep Song'), type: 'folder' })
    expect(found).toContainEqual({ path: join(root, 'single.sng'), type: 'sng' })
    expect(found).toHaveLength(2)
  })
  it('does not descend into a found chart folder', () => {
    const root = tmpDir('walk2')
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Song'), { recursive: true })
    mkdirSync(join(root, 'Song/extras'))
    writeFileSync(join(root, 'Song/extras/notes.chart'), '')
    expect(findChartPaths(root)).toHaveLength(1)
  })
  it('skips .encore-tmp directories during the walk', () => {
    const root = tmpDir('walk4')
    mkdirSync(join(root, '.encore-tmp'))
    writeFileSync(join(root, '.encore-tmp/leaked.sng'), '')
    mkdirSync(join(root, 'Real Song'))
    writeFileSync(join(root, 'Real Song/notes.chart'), '')
    expect(findChartPaths(root)).toEqual([{ path: join(root, 'Real Song'), type: 'folder' }])
  })
  it('returns at most `limit` charts, and stops looking once it has them', () => {
    const root = tmpDir('walk5')
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `song${i}.sng`), '')
    mkdirSync(join(root, 'Pack/Deep Song'), { recursive: true })
    writeFileSync(join(root, 'Pack/Deep Song/notes.chart'), '')
    expect(findChartPaths(root)).toHaveLength(6)
    expect(findChartPaths(root, 3)).toHaveLength(3)
    // A limit at or above the real total still returns the real total, so a caller can tell
    // "capped" from "that is all there is" by comparing length against the limit it passed.
    expect(findChartPaths(root, 6)).toHaveLength(6)
    expect(findChartPaths(root, 100)).toHaveLength(6)
  })
  it('follows symlinked chart folders', () => {
    const root = tmpDir('walk3')
    symlinkSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Linked Song'))
    const found = findChartPaths(root)
    expect(found).toContainEqual({ path: join(root, 'Linked Song'), type: 'folder' })
  })
})

describe('scanLibrary', () => {
  it('parses the fixture chart into the catalog', async () => {
    const db = openCatalog(join(tmpDir('scan'), 'catalog.db'))
    const progress: string[] = []
    await scanLibrary(db, [FIXTURE], (p) => progress.push(p.phase), art())
    const chart = getChartByPath(db, join(FIXTURE, 'Test Artist - Test Song'))
    expect(chart?.name).toBe('Test Song')
    expect(chart?.artist).toBe('Test Artist')
    expect(chart?.charter).toBe('Tester')
    expect(chart?.diffGuitar).toBe(4)
    expect(progress.at(-1)).toBe('complete')
  })
  it('skips unchanged charts on rescan', async () => {
    const db = openCatalog(join(tmpDir('scan2'), 'catalog.db'))
    await scanLibrary(db, [FIXTURE], () => {}, art())
    const first = getChartByPath(db, join(FIXTURE, 'Test Artist - Test Song'))
    await scanLibrary(db, [FIXTURE], () => {}, art())
    const second = getChartByPath(db, join(FIXTURE, 'Test Artist - Test Song'))
    expect(second?.modifiedTime).toBe(first?.modifiedTime)
    expect(countCharts(db, { search: '', offset: 0, limit: 100 })).toBe(1)
  })
  it('removes charts whose folders disappeared', async () => {
    const root = tmpDir('scan3')
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Song'), { recursive: true })
    const db = openCatalog(join(tmpDir('scan4'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    expect(countCharts(db, { search: '', offset: 0, limit: 100 })).toBe(1)
    rmSync(join(root, 'Song'), { recursive: true })
    await scanLibrary(db, [root], () => {}, art())
    expect(countCharts(db, { search: '', offset: 0, limit: 100 })).toBe(0)
  })
  it('isolates per-chart errors and still completes', async () => {
    const root = tmpDir('scan5')
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Good'), { recursive: true })
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Bad'), { recursive: true })
    chmodSync(join(root, 'Bad/notes.chart'), 0o000)
    const db = openCatalog(join(tmpDir('scan6'), 'catalog.db'))
    const events: JobProgress[] = []
    await scanLibrary(db, [root], (p) => events.push(p), art())
    expect(getChartByPath(db, join(root, 'Good'))?.name).toBe('Test Song')
    const last = events.at(-1)
    expect(last?.phase).toBe('complete')
    expect(last?.status).toBe('done')
    expect(last?.message).toContain('1 chart')
  })
  // The art sweep in main/index.ts refuses to run on found === 0, because a root that cannot be
  // read walks to nothing and takes every row under it with it. Both numbers are pinned here so
  // that guard keeps its input.
  it('reports how many charts it found and how many failed', async () => {
    const root = tmpDir('summary')
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Good'), { recursive: true })
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Bad'), { recursive: true })
    chmodSync(join(root, 'Bad/notes.chart'), 0o000)
    const db = openCatalog(join(tmpDir('summarydb'), 'catalog.db'))
    expect(await scanLibrary(db, [root], () => {}, art())).toEqual({ found: 2, failed: 1 })
  })

  it('reports zero found for a root it cannot read', async () => {
    const db = openCatalog(join(tmpDir('noroot'), 'catalog.db'))
    const missing = join(tmpDir('noroot2'), 'never-existed')
    expect(await scanLibrary(db, [missing], () => {}, art())).toEqual({ found: 0, failed: 0 })
  })

  it('parses a .sng file into full catalog metadata', async () => {
    const root = tmpDir('sng')
    writeFileSync(join(root, 'fixture.sng'), makeFixtureSng())
    const db = openCatalog(join(tmpDir('sngdb'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const chart = getChartByPath(db, join(root, 'fixture.sng'))
    expect(chart?.chartType).toBe('sng')
    expect(chart?.artist).toBe('Sng Artist')
    expect(chart?.diffGuitar).toBe(3)
  })
  it('reads .sng metadata from the archive header when there is no song.ini', async () => {
    // Real .sng files store song details in the header, not as a song.ini entry. A chart
    // whose title exists nowhere else is how we know the header was actually read.
    const root = tmpDir('snghdr')
    writeFileSync(join(root, 'header.sng'), makeHeaderMetadataSng())
    const db = openCatalog(join(tmpDir('snghdrdb'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const chart = getChartByPath(db, join(root, 'header.sng'))
    expect(chart?.name).toBe('Header Song')
    expect(chart?.artist).toBe('Header Artist')
    expect(chart?.charter).toBe('Header Charter')
    expect(chart?.diffGuitar).toBe(5)
    // -1 means unrated, not a tier. Stored raw it reaches the library list as "B-1".
    expect(chart?.diffBass).toBeNull()
  })
  it('skips unchanged .sng files on rescan', async () => {
    const root = tmpDir('sng2')
    writeFileSync(join(root, 'fixture.sng'), makeFixtureSng())
    const db = openCatalog(join(tmpDir('sngdb2'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const first = getChartByPath(db, join(root, 'fixture.sng'))
    await scanLibrary(db, [root], () => {}, art())
    const second = getChartByPath(db, join(root, 'fixture.sng'))
    expect(second?.modifiedTime).toBe(first?.modifiedTime)
    expect(countCharts(db, { search: '', offset: 0, limit: 100 })).toBe(1)
  })
  // The scan reads a chart's bytes selectively, so "did it read the audio?" is the whole
  // question and nothing in a catalog row answers it. Truncating the archive inside its audio
  // entry makes the answer observable: a reader that streams the archive end-to-end hits EOF
  // mid-entry and fails the chart, and one that never asks for those bytes does not notice.
  it('scans a .sng whose audio body is missing from the file', async () => {
    const root = tmpDir('sngtrunc')
    const path = join(root, 'truncated.sng')
    // Audio last, so the truncation lands in it rather than in the chart or the cover.
    writeFileSync(
      path,
      makeSng(
        [
          { fileName: 'notes.chart', data: new TextEncoder().encode(CHART_ONE_NOTE) },
          { fileName: 'song.ogg', data: randomBytes(512 * 1024) }
        ],
        { name: 'Truncated Song', artist: 'Truncated Artist' }
      )
    )
    truncateSync(path, statSync(path).size - 256 * 1024)
    const db = openCatalog(join(tmpDir('sngtruncdb'), 'catalog.db'))

    expect(await scanLibrary(db, [root], () => {}, art())).toEqual({ found: 1, failed: 0 })
    expect(getChartByPath(db, path)?.artist).toBe('Truncated Artist')
  })
  it('isolates corrupt .sng files and still completes', async () => {
    const root = tmpDir('sng3')
    writeFileSync(join(root, 'good.sng'), makeFixtureSng())
    writeFileSync(join(root, 'garbage.sng'), randomBytes(1024))
    const db = openCatalog(join(tmpDir('sngdb3'), 'catalog.db'))
    const events: JobProgress[] = []
    await scanLibrary(db, [root], (p) => events.push(p), art())
    expect(getChartByPath(db, join(root, 'good.sng'))?.artist).toBe('Sng Artist')
    const last = events.at(-1)
    expect(last?.phase).toBe('complete')
    expect(last?.status).toBe('done')
    expect(last?.message).toContain('1 chart')
  })
  it('scans a folder chart with an audio file: audio bytes not read, metadata correct', async () => {
    const root = tmpDir('audio')
    mkdirSync(join(root, 'Song With Audio'))
    writeFileSync(
      join(root, 'Song With Audio/song.ini'),
      '[song]\nname = Audio Song\nartist = Audio Artist\ncharter = Tester\ndiff_guitar = 2\n'
    )
    writeFileSync(
      join(root, 'Song With Audio/notes.chart'),
      '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n}\n'
    )
    // Garbage audio bytes. If the scanner tried to parse this, scan-chart would choke on it.
    writeFileSync(join(root, 'Song With Audio/song.ogg'), Buffer.from([0x00, 0xff, 0xde, 0xad]))
    const db = openCatalog(join(tmpDir('audiodb'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const chart = getChartByPath(db, join(root, 'Song With Audio'))
    expect(chart?.artist).toBe('Audio Artist')
    expect(chart?.hasVideo).toBe(false)
  })
  // A folder chart's big file is not always media by name. Clone Hero users turn a background
  // off by renaming it, and the reference library's three `video.mp4.disabled` files are 2.36
  // GiB of the 2.38 GiB the folder scan used to read. Unreadable rather than merely large:
  // opening it is then the difference between a chart that scans and one that fails.
  it('scans a folder chart without opening a file scan-chart never parses', async () => {
    const root = tmpDir('disabled')
    const dir = join(root, 'Song With Disabled Video')
    mkdirSync(dir)
    writeFileSync(join(dir, 'song.ini'), '[song]\nname = Disabled\nartist = Disabled Artist\n')
    writeFileSync(join(dir, 'notes.chart'), CHART_ONE_NOTE)
    writeFileSync(join(dir, 'video.mp4.disabled'), randomBytes(1024))
    chmodSync(join(dir, 'video.mp4.disabled'), 0o000)
    const db = openCatalog(join(tmpDir('disableddb'), 'catalog.db'))

    expect(await scanLibrary(db, [root], () => {}, art())).toEqual({ found: 1, failed: 0 })
    expect(getChartByPath(db, dir)?.artist).toBe('Disabled Artist')
  })
  // Regression: before scanVersion existed, .sng rows were written path-only (no name,
  // artist or difficulties). Because the file itself never changes, the folderHash check
  // matched forever and the improved parser never ran, so the library showed raw paths
  // with empty difficulty columns. A row below SCAN_VERSION must be re-parsed.
  it('re-parses a stale path-only .sng row even though the file is unchanged', async () => {
    const root = tmpDir('stale-sng')
    const sngPath = join(root, 'fixture.sng')
    writeFileSync(sngPath, makeFixtureSng())
    const db = openCatalog(join(tmpDir('staledb'), 'catalog.db'))
    // Exactly what the old scanner persisted: the path, the change-detection hash, nothing else.
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path: sngPath,
        chartType: 'sng',
        folderHash: String(statSync(sngPath).mtimeMs),
        modifiedTime: Date.now()
      })
    )
    expect(getChartByPath(db, sngPath)?.scanVersion).toBe(0)

    await scanLibrary(db, [root], () => {}, art())

    const chart = getChartByPath(db, sngPath)
    expect(chart?.name).toBe('Sng Song')
    expect(chart?.artist).toBe('Sng Artist')
    expect(chart?.diffGuitar).toBe(3)
    expect(chart?.scanVersion).toBe(SCAN_VERSION)
  })

  it('re-parses a stale folder row even though the folder is unchanged', async () => {
    const db = openCatalog(join(tmpDir('stalefolder'), 'catalog.db'))
    await scanLibrary(db, [FIXTURE], () => {}, art())
    const path = join(FIXTURE, 'Test Artist - Test Song')
    const scanned = getChartByPath(db, path)
    // Roll the row back to a pre-scanVersion state: same folderHash, no metadata.
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path,
        chartType: 'folder',
        folderHash: scanned?.folderHash,
        modifiedTime: scanned?.modifiedTime
      })
    )
    expect(getChartByPath(db, path)?.name).toBeNull()

    await scanLibrary(db, [FIXTURE], () => {}, art())

    const chart = getChartByPath(db, path)
    expect(chart?.name).toBe('Test Song')
    expect(chart?.diffGuitar).toBe(4)
    expect(chart?.scanVersion).toBe(SCAN_VERSION)
  })

  // A JSON column holding wrong-shaped elements throws out of any full-record parse. If the
  // freshness check is one of those parses, it throws before the staleness comparison, the
  // per-chart isolation below swallows it, and the upsert that would overwrite the bad value
  // never runs. That leaves the row unrepairable by any user action.
  it('re-scans a stale row whose JSON column holds wrong-shaped elements', async () => {
    const root = tmpDir('poison')
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Song'), { recursive: true })
    const db = openCatalog(join(tmpDir('poisondb'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())

    const path = join(root, 'Song')
    // scanVersion 0 is what any future SCAN_VERSION bump leaves behind on an existing row.
    db.prepare(`UPDATE charts SET noteCounts = ?, scanVersion = 0 WHERE path = ?`).run(
      '[{"nope":1}]',
      path
    )
    expect(() => getChartByPath(db, path)).toThrow()

    await scanLibrary(db, [root], () => {}, art())

    const repaired = getChartByPath(db, path)
    // The rescan overwrites the poisoned JSON with the chart's real counts, so the row parses
    // again, which is the point. (Before the scanner populated noteCounts this read as [].)
    expect(repaired?.noteCounts).toContainEqual({
      instrument: 'guitar',
      difficulty: 'expert',
      count: 3
    })
    expect(repaired?.name).toBe('Test Song')
    expect(repaired?.scanVersion).toBe(SCAN_VERSION)
    expect(queryCharts(db, { search: '', offset: 0, limit: 100 })).toHaveLength(1)
  })

  // The whole user-visible path in one test: the catalog they actually have on disk (a v1
  // database holding a path-only .sng row), the app upgrade that migrates it, and a single
  // rescan over an untouched file. It turns the report ("every .sng shows as a raw path with
  // empty difficulty columns") into an assertion.
  it('a path-only .sng row in a v1 database gains metadata after one rescan', async () => {
    const lib = tmpDir('v1lib')
    const sngPath = join(lib, 'Some Song.sng')
    writeFileSync(sngPath, makeFixtureSng())
    const dbFile = join(tmpDir('v1db'), 'catalog.db')
    createV1Catalog(dbFile, [
      { path: sngPath, chartType: 'sng', folderHash: String(statSync(sngPath).mtimeMs) }
    ])

    // Launching the upgraded app migrates the catalog in place.
    const db = openCatalog(dbFile)
    const before = getChartByPath(db, sngPath)
    expect([before?.name, before?.artist, before?.diffGuitar]).toEqual([null, null, null])

    const events: JobProgress[] = []
    await scanLibrary(db, [lib], (p) => events.push(p), art())

    const after = getChartByPath(db, sngPath)
    expect(after?.name).toBe('Sng Song')
    expect(after?.artist).toBe('Sng Artist')
    expect(after?.charter).toBe('Tester')
    expect(after?.diffGuitar).toBe(3)
    expect(after?.scanVersion).toBe(SCAN_VERSION)
    // The re-parse must succeed outright, not land in the swallowed-failure bucket.
    expect(events.at(-1)?.message).toBeNull()
  })

  it('still skips rows already at the current scan version', async () => {
    const root = tmpDir('current')
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), join(root, 'Song'), { recursive: true })
    writeFileSync(join(root, 'fixture.sng'), makeFixtureSng())
    const db = openCatalog(join(tmpDir('currentdb'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const firstFolder = getChartByPath(db, join(root, 'Song'))
    const firstSng = getChartByPath(db, join(root, 'fixture.sng'))
    expect(firstFolder?.scanVersion).toBe(SCAN_VERSION)
    expect(firstSng?.scanVersion).toBe(SCAN_VERSION)

    await scanLibrary(db, [root], () => {}, art())

    // modifiedTime is only rewritten on a re-parse, so a stable value proves the skip held.
    expect(getChartByPath(db, join(root, 'Song'))?.modifiedTime).toBe(firstFolder?.modifiedTime)
    expect(getChartByPath(db, join(root, 'fixture.sng'))?.modifiedTime).toBe(firstSng?.modifiedTime)
  })

  it('stores instruments, note counts and the rest of the scan result', async () => {
    const root = tmpDir('full')
    writeFileSync(join(root, 'header.sng'), makeHeaderMetadataSng())
    const db = openCatalog(join(tmpDir('fulldb'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const chart = getChartByPath(db, join(root, 'header.sng'))
    // The fixture charts ExpertSingle only, so guitar is the one instrument with notes.
    expect(chart?.instruments).toEqual(['guitar'])
    expect(chart?.noteCounts.some((c) => c.instrument === 'guitar' && c.count > 0)).toBe(true)
    expect(chart?.previewStartTime).toBe(45_000)
    // Null specifically, not merely falsy: scan-chart leaves `albumArt` absent rather than
    // null when a chart has no cover, so a row missing entirely (art handling threw) would
    // read as undefined here.
    expect(chart?.albumArtMd5).toBeNull()
  })

  it('caches a chart cover and stores its md5 on the row', async () => {
    const root = tmpDir('cover')
    mkdirSync(join(root, 'Song'))
    writeFileSync(join(root, 'Song/song.ini'), '[song]\nname = Cover\nartist = A\ncharter = C\n')
    writeFileSync(join(root, 'Song/notes.chart'), CHART_ONE_NOTE)
    writeFileSync(join(root, 'Song/album.png'), PNG_1X1)
    const db = openCatalog(join(tmpDir('coverdb'), 'catalog.db'))
    const options = art()
    await scanLibrary(db, [root], () => {}, options)
    const md5 = getChartByPath(db, join(root, 'Song'))?.albumArtMd5
    expect(md5).toMatch(/^[0-9a-f]{32}$/)
    // The identity encoder above means the cached bytes are the source bytes verbatim.
    expect(readFileSync(join(options.dir, `${md5}.jpg`))).toEqual(PNG_1X1)
  })

  // The art call is duplicated across the folder and .sng branches, and .sng is the majority
  // of a real library. Without this, deleting the .sng one is invisible.
  it('caches a cover packed inside a .sng archive', async () => {
    const root = tmpDir('sngcover')
    const encoder = new TextEncoder()
    writeFileSync(
      join(root, 'cover.sng'),
      makeSng(
        [
          { fileName: 'notes.chart', data: encoder.encode(CHART_ONE_NOTE) },
          { fileName: 'album.png', data: new Uint8Array(PNG_1X1) }
        ],
        { name: 'Sng Cover', artist: 'A', charter: 'C' }
      )
    )
    const db = openCatalog(join(tmpDir('sngcoverdb'), 'catalog.db'))
    const options = art()
    await scanLibrary(db, [root], () => {}, options)
    const chart = getChartByPath(db, join(root, 'cover.sng'))
    expect(chart?.chartType).toBe('sng')
    expect(chart?.albumArtMd5).toMatch(/^[0-9a-f]{32}$/)
    expect(readFileSync(join(options.dir, `${chart?.albumArtMd5}.jpg`))).toEqual(PNG_1X1)
  })

  // scan-chart's DrumType is the numeric enum 0|1|2, but the catalog column is TEXT. Stored
  // raw, ChartRecordSchema.parse() rejects the record and the per-chart isolation below turns
  // every drums chart into a silent scan failure with no row at all.
  it('stores a drums chart with a readable drum type', async () => {
    const root = tmpDir('drums')
    mkdirSync(join(root, 'Song'))
    writeFileSync(join(root, 'Song/song.ini'), '[song]\nname = Drums\nartist = A\ncharter = C\n')
    writeFileSync(
      join(root, 'Song/notes.chart'),
      '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertDrums]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 0\n}\n'
    )
    const db = openCatalog(join(tmpDir('drumsdb'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const chart = getChartByPath(db, join(root, 'Song'))
    expect(chart?.instruments).toEqual(['drums'])
    expect(chart?.drumType).toBe('fourLane')
  })

  // scan-chart copies its defaultMetadata onto every result that has a song.ini, so an absent
  // field arrives as a sentinel rather than as undefined and `?? null` never fires. This
  // song.ini sets none of them, so every field below must come back null rather than -1,
  // 16000, 0 or "". songLength is the one with teeth: msToTime dashes out null and negatives
  // but not 0, so a stored 0 renders as a real "0:00" runtime in the library and detail views.
  it('normalizes song.ini unset sentinels to null', async () => {
    const root = tmpDir('sentinel')
    mkdirSync(join(root, 'Song'))
    writeFileSync(join(root, 'Song/song.ini'), '[song]\nname = S\nartist = A\ncharter = C\n')
    writeFileSync(join(root, 'Song/notes.chart'), CHART_ONE_NOTE)
    const db = openCatalog(join(tmpDir('sentineldb'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const chart = getChartByPath(db, join(root, 'Song'))
    expect(chart?.name).toBe('S')
    expect(chart?.songLength).toBeNull()
    expect(chart?.previewStartTime).toBeNull()
    expect(chart?.albumTrack).toBeNull()
    expect(chart?.playlistTrack).toBeNull()
    expect(chart?.icon).toBeNull()
    expect(chart?.loadingPhrase).toBeNull()
  })

  it('reads symlinked files inside chart folders', async () => {
    const root = tmpDir('scan7')
    mkdirSync(join(root, 'Song'))
    cpSync(join(FIXTURE, 'Test Artist - Test Song/notes.chart'), join(root, 'Song/notes.chart'))
    symlinkSync(join(FIXTURE, 'Test Artist - Test Song/song.ini'), join(root, 'Song/song.ini'))
    const db = openCatalog(join(tmpDir('scan8'), 'catalog.db'))
    await scanLibrary(db, [root], () => {}, art())
    const chart = getChartByPath(db, join(root, 'Song'))
    expect(chart?.artist).toBe('Test Artist')
    expect(chart?.diffGuitar).toBe(4)
  })
})

/**
 * The targeted re-index Asset Studio runs after a write. The bug it exists to prevent: every
 * hasX flag the UI shows is decided here, and an asset write does not touch the catalog row, so
 * without this the user is told the asset they just added is still missing.
 *
 * writeSngAsset is used rather than a hand-rolled rewrite because the freshness check is the
 * load-bearing part: the row is only re-parsed if a real repack moves the .sng's mtime.
 */
describe('scanChart', () => {
  it('re-indexes a repacked .sng so the new asset shows on the row', async () => {
    const root = tmpDir('one')
    const sng = join(root, 'fixture.sng')
    writeFileSync(sng, makeFixtureSng())
    const db = openCatalog(join(tmpDir('onedb'), 'catalog.db'))
    const artOpts = art()
    await scanLibrary(db, [root], () => {}, artOpts)
    expect(getChartByPath(db, sng)?.hasAlbumArt).toBe(false)

    await writeSngAsset(sng, 'album.png', PNG_1X1, [{ path: root }])
    await scanChart(db, { path: sng, type: 'sng' }, artOpts)

    const row = getChartByPath(db, sng)
    expect(row?.hasAlbumArt).toBe(true)
    // A full re-parse, not a flag patch: the cover is cached and the metadata still round-trips.
    expect(row?.albumArtMd5).not.toBeNull()
    expect(row?.artist).toBe('Sng Artist')
  })

  it('re-indexes a folder chart that gained a background', async () => {
    const root = tmpDir('onefolder')
    const dir = join(root, 'Song')
    cpSync(join(FIXTURE, 'Test Artist - Test Song'), dir, { recursive: true })
    const db = openCatalog(join(tmpDir('onefolderdb'), 'catalog.db'))
    const artOpts = art()
    await scanLibrary(db, [root], () => {}, artOpts)
    expect(getChartByPath(db, dir)?.hasBackground).toBe(false)

    writeFileSync(join(dir, 'background.png'), PNG_1X1)
    await scanChart(db, { path: dir, type: 'folder' }, artOpts)

    expect(getChartByPath(db, dir)?.hasBackground).toBe(true)
  })

  it('leaves an unchanged chart row exactly as it was', async () => {
    const root = tmpDir('onefresh')
    const sng = join(root, 'fixture.sng')
    writeFileSync(sng, makeFixtureSng())
    const db = openCatalog(join(tmpDir('onefreshdb'), 'catalog.db'))
    const artOpts = art()
    await scanLibrary(db, [root], () => {}, artOpts)
    const before = getChartByPath(db, sng)
    await scanChart(db, { path: sng, type: 'sng' }, artOpts)
    expect(getChartByPath(db, sng)?.modifiedTime).toBe(before?.modifiedTime)
  })

  it('throws on a chart it cannot parse, so a caller can report it', async () => {
    const root = tmpDir('onebad')
    const sng = join(root, 'garbage.sng')
    writeFileSync(sng, randomBytes(1024))
    const db = openCatalog(join(tmpDir('onebaddb'), 'catalog.db'))
    await expect(scanChart(db, { path: sng, type: 'sng' }, art())).rejects.toThrow()
  })
})

describe('cancelLibraryScan', () => {
  /** Enough folder charts that a cancel fired on the first progress event lands mid-scan. */
  function makeManyCharts(count: number, prefix: string): string {
    const root = tmpDir(prefix)
    for (let i = 0; i < count; i++) {
      const dir = join(root, `Chart ${i}`)
      mkdirSync(dir)
      writeFileSync(join(dir, 'song.ini'), `[song]\nname = Chart ${i}\nartist = A\ncharter = C\n`)
      writeFileSync(join(dir, 'notes.chart'), CHART_ONE_NOTE)
    }
    return root
  }

  const catalogRows = (db: ReturnType<typeof openCatalog>): number =>
    countCharts(db, { search: '', offset: 0, limit: 1000 })

  it('rejects rather than resolving with a summary of a scan it did not finish', async () => {
    // A resolved ScanSummary is what main/index.ts feeds to the art sweep and what the renderer
    // reads as a finished scan. Neither is true of a scan that stopped early.
    const root = makeManyCharts(60, 'cancel-src')
    const db = openCatalog(join(tmpDir('cancel-db'), 'catalog.db'))

    await expect(
      scanLibrary(
        db,
        [root],
        (p) => {
          if (p.phase === 'scanning') cancelLibraryScan()
        },
        art()
      )
    ).rejects.toBeInstanceOf(LibraryScanCanceled)
  })

  it('ends on a canceled event at the percent it reached, never on a done one', async () => {
    const root = makeManyCharts(60, 'cancel-src2')
    const db = openCatalog(join(tmpDir('cancel-db2'), 'catalog.db'))
    const events: JobProgress[] = []

    await expect(
      scanLibrary(
        db,
        [root],
        (p) => {
          events.push(p)
          if (p.phase === 'scanning') cancelLibraryScan()
        },
        art()
      )
    ).rejects.toThrow(/cancel/i)

    const last = events.at(-1)!
    expect(last.status).toBe('canceled')
    expect(last.phase).toBe('canceled')
    // Not 100, and not 'done': the renderer decides "the scan finished" from this event alone,
    // so a cancel that reported either would refresh the library as though it were complete.
    expect(last.percent).toBeLessThan(100)
    expect(events.some((p) => p.status === 'done')).toBe(false)
  })

  it('keeps the rows it wrote before the cancel', async () => {
    // The deliberate choice: a chart scanned before the cancel was really read off disk, and its
    // row is as true as any other. Rolling those back would throw away correct work and, on a
    // rescan of an existing library, replace good rows with nothing.
    const root = makeManyCharts(60, 'cancel-src3')
    const db = openCatalog(join(tmpDir('cancel-db3'), 'catalog.db'))

    await expect(
      scanLibrary(
        db,
        [root],
        (p) => {
          if (p.phase === 'scanning') cancelLibraryScan()
        },
        art()
      )
    ).rejects.toThrow(/cancel/i)

    expect(catalogRows(db)).toBeGreaterThan(0)
    // Every row that IS there is a real chart, correctly parsed: a partial catalog, not a
    // wrong one.
    const rows = queryCharts(db, { search: '', offset: 0, limit: 1000 })
    for (const row of rows) expect(row.name).toMatch(/^Chart \d+$/)
  })

  it('stops opening charts instead of scanning them all and discarding the work', async () => {
    const root = makeManyCharts(60, 'cancel-src4')
    const db = openCatalog(join(tmpDir('cancel-db4'), 'catalog.db'))

    await expect(
      scanLibrary(
        db,
        [root],
        (p) => {
          if (p.phase === 'scanning') cancelLibraryScan()
        },
        art()
      )
    ).rejects.toThrow(/cancel/i)

    // Charts already handed to the limiter finish (up to SCAN_CONCURRENCY of them, and one
    // large `.sng` read is not interruptible partway), so the bound is generous. What it rules
    // out is the whole library being read anyway.
    expect(catalogRows(db)).toBeLessThan(60)
  })

  it('still removes vanished charts, because that happens before a cancel can arrive', async () => {
    // The delete pass runs synchronously, in the same turn scanLibrary was called in, so no
    // abort can be delivered before it. Pinned so a later refactor that moves it after an await
    // has to think about half-deleted catalogs rather than discovering them.
    const root = makeManyCharts(60, 'cancel-src5')
    const db = openCatalog(join(tmpDir('cancel-db5'), 'catalog.db'))
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path: join(root, 'Gone'),
        chartType: 'folder',
        folderHash: 'x',
        modifiedTime: 1,
        scanVersion: SCAN_VERSION
      })
    )

    await expect(
      scanLibrary(
        db,
        [root],
        (p) => {
          if (p.phase === 'scanning') cancelLibraryScan()
        },
        art()
      )
    ).rejects.toThrow(/cancel/i)

    expect(getChartByPath(db, join(root, 'Gone'))).toBeNull()
  })

  it('cancelling with no scan running is a no-op', () => {
    expect(() => cancelLibraryScan()).not.toThrow()
  })

  it('does not stop a scan that started after the cancelled one', async () => {
    const root = makeManyCharts(60, 'cancel-src6')
    const db = openCatalog(join(tmpDir('cancel-db6'), 'catalog.db'))
    await expect(
      scanLibrary(
        db,
        [root],
        (p) => {
          if (p.phase === 'scanning') cancelLibraryScan()
        },
        art()
      )
    ).rejects.toThrow(/cancel/i)

    // The slot must have been released, or every scan from here on is born aborted.
    const summary = await scanLibrary(db, [FIXTURE], () => {}, art())
    expect(summary).toEqual({ found: 1, failed: 0 })
  })
})
