import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanChartFolder } from 'scan-chart'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../../test/helpers/make-sng'
import { ENCORE_TMP_DIR } from '../../../shared/constants'
import { chartTypeAt, scanChartIssues, type ChartIssueRow } from '../../catalog/issues'
import { extractSngEntries } from '../../downloads/sng'
import type { FixContext, VideoConverter } from '../fix'
import { badVideoAction, badVideoNameRules, videoNameFromRow } from './bad-video'
import { tmpDir } from '../../../../test/helpers/tmp'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

const NOTES = bytes(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
)

/**
 * `pro_drums` and `hopo_frequency` are two of the seven keys `getChartHash` mixes in, and both
 * are set away from their defaults so they actually contribute. A fix that rewrote song.ini (by
 * dropping a key, reordering, or "tidying") changes the hash, and every test below that compares
 * hashes would be comparing two hashes of a chart file alone if these were left at default.
 */
const SONG_INI = bytes(
  '[song]\nname = Fixture\nartist = Tester\ncharter = Tester\ndiff_guitar = 3\npro_drums = True\nhopo_frequency = 3\n'
)

/** Bigger than the repacker's 1 MiB chunk, so extraction and repack both cross boundaries. */
const VIDEO = new Uint8Array(1_500_000).map((_, i) => (i * 29 + 7) % 256)

const scratchDirs: string[] = []

function scratch(): string {
  const dir = tmpDir('badvideo')
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  // These fixtures are megabytes each and /tmp is not ours to fill.
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

function folderChart(files: Record<string, Uint8Array> = {}): string {
  const root = scratch()
  const dir = join(root, 'Tester - Fixture')
  mkdirSync(dir, { recursive: true })
  const all = { 'notes.chart': NOTES, 'song.ini': SONG_INI, 'video.mp4': VIDEO, ...files }
  for (const [name, data] of Object.entries(all)) writeFileSync(join(dir, name), data)
  return dir
}

function sngChart(files: Record<string, Uint8Array> = {}): string {
  const root = scratch()
  const all = { 'notes.chart': NOTES, 'song.ini': SONG_INI, 'video.mp4': VIDEO, ...files }
  const path = join(root, 'fixture.sng')
  writeFileSync(
    path,
    makeSng(
      Object.entries(all).map(([fileName, data]) => ({ fileName, data })),
      { name: 'Fixture', artist: 'Tester', charter: 'Tester' }
    )
  )
  return path
}

function row(chartPath: string, fileName = 'video.mp4'): ChartIssueRow {
  return {
    chartPath,
    kind: 'folder',
    code: 'badVideo',
    // scan-chart's own wording, verbatim from index.js:2675.
    description: `"${fileName}" will not work on Linux and should be converted to .webm.`
  }
}

/**
 * A converter that writes a marker plus whatever it was given.
 *
 * Deriving the output from the INPUT is the point: it proves the action handed the converter the
 * real video (extracted out of the archive, unmasked, whole) rather than an empty placeholder
 * that would look like a successful conversion in every other assertion.
 */
function fakeConverter(options: { reason?: string; onConvert?: () => void } = {}): VideoConverter {
  return {
    unavailableReason: async () => options.reason ?? null,
    convert: async ({ input, output, signal, onProgress }) => {
      options.onConvert?.()
      if (signal?.aborted) throw new Error('Video conversion cancelled')
      onProgress?.(0.5)
      const source = readFileSync(input)
      writeFileSync(output, Buffer.concat([Buffer.from('WEBM:'), source]))
      onProgress?.(1)
    }
  }
}

function expectedWebm(): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from('WEBM:'), Buffer.from(VIDEO)]))
}

function ctxFor(chartPath: string, over: Partial<FixContext> = {}): FixContext {
  return {
    libraryFolders: [{ path: join(chartPath, '..') }],
    video: fakeConverter(),
    // A real store, so every conversion below also proves its backup is taken. See
    // album-art-size.test.ts for why that is worth the copy.
    backupDir: join(scratch(), 'fix-backups'),
    ...over
  }
}

async function entriesOf(sngPath: string): Promise<Map<string, Uint8Array>> {
  const entries = await extractSngEntries(new Uint8Array(readFileSync(sngPath)))
  return new Map(entries.map((e) => [e.fileName, e.data]))
}

describe('badVideoAction name rules', () => {
  /**
   * The rules are checked against scan-chart itself rather than against a list someone wrote
   * down. `hasVideoName` and `hasBadVideoName` are private to scan-chart, so the observable form
   * is whether a folder holding that one file raises the `badVideo` folder issue.
   *
   * `video.mp4.disabled` is the row that matters. Three of those exist in the reference library
   * totalling 2,357.5 MiB, deliberately switched off by the user, and the ONLY thing keeping
   * Encore away from them is that neither scan-chart nor this action treats `disabled` as a
   * video extension. A regex loosened to `/^video\.(mp4|avi|mpeg)/` (no anchor) or given the `i`
   * flag would still pass every other test in this file.
   */
  const names = [
    'video.mp4',
    'video.avi',
    'video.mpeg',
    'video.webm',
    'video.ogv',
    'video.vp8',
    'video.mp4.disabled',
    'video.webm.disabled',
    'video.MP4',
    'Video.mp4',
    'videos.mp4',
    'myvideo.mp4',
    'video'
  ]

  it.each(names)('agrees with scan-chart about whether %s is a bad video', (name) => {
    const scanned = scanChartFolder(
      [
        { fileName: 'notes.chart', data: NOTES },
        { fileName: 'song.ini', data: SONG_INI },
        { fileName: name, data: new Uint8Array(0) }
      ],
      { includeMd5: false, includeBTrack: false }
    )
    const flagged = scanned.folderIssues.some((issue) => issue.folderIssue === 'badVideo')

    expect(badVideoNameRules.isBadVideoName(name)).toBe(flagged)
  })

  it('never treats a disabled video as a video at all', () => {
    for (const name of ['video.mp4.disabled', 'video.avi.disabled', 'video.webm.disabled']) {
      expect(badVideoNameRules.isBadVideoName(name)).toBe(false)
      expect(badVideoNameRules.isChartVideoName(name)).toBe(false)
      // The superseded-sibling pattern is the second way a disabled file could be deleted:
      // it is handed to the folder writer and to the repacker as "what video.webm replaces".
      expect(badVideoNameRules.SUPERSEDED_VIDEO_RE.test(name)).toBe(false)
    }
  })

  it('does not supersede the webm it is about to write, or a name scan-chart ignores', () => {
    expect(badVideoNameRules.SUPERSEDED_VIDEO_RE.test('video.mp4')).toBe(true)
    expect(badVideoNameRules.SUPERSEDED_VIDEO_RE.test('video.webm')).toBe(false)
    // .mpg is not a video name to scan-chart, so it is not ours to delete.
    expect(badVideoNameRules.SUPERSEDED_VIDEO_RE.test('video.mpg')).toBe(false)
  })
})

describe('badVideoAction.describe', () => {
  it('names the exact file written and the exact file removed', () => {
    const text = badVideoAction.describe(row(join(tmpdir(), 'x')))

    expect(text).toContain('video.mp4')
    expect(text).toContain('video.webm')
    expect(text).toMatch(/remove video\.mp4/)
  })

  it("reads the file name out of scan-chart's own description", () => {
    expect(videoNameFromRow(row(join(tmpdir(), 'x'), 'video.avi'))).toBe('video.avi')
    // A name the rules refuse is not a name we will act on, however it got into the row.
    expect(videoNameFromRow(row(join(tmpdir(), 'x'), 'video.mp4.disabled'))).toBe(null)
    expect(videoNameFromRow({ ...row(join(tmpdir(), 'x')), description: 'no quotes here' })).toBe(
      null
    )
  })
})

describe('badVideoAction.availability', () => {
  it('is unavailable, with the reason, when there is no converter', async () => {
    expect(await badVideoAction.availability?.({ libraryFolders: [], backupDir: null })).toEqual({
      available: false,
      reason: 'Video conversion is not available in this build.'
    })
  })

  it("passes the converter's own reason through", async () => {
    const ctx = {
      libraryFolders: [],
      backupDir: null,
      video: fakeConverter({ reason: 'ffmpeg is not installed' })
    }

    expect(await badVideoAction.availability?.(ctx)).toEqual({
      available: false,
      reason: 'ffmpeg is not installed'
    })
  })
})

describe('badVideoAction.apply: folder charts', () => {
  it('replaces video.mp4 with the converted video.webm', async () => {
    const chart = folderChart()

    await badVideoAction.apply(row(chart), ctxFor(chart))

    expect(new Uint8Array(readFileSync(join(chart, 'video.webm')))).toEqual(expectedWebm())
    expect(existsSync(join(chart, 'video.mp4'))).toBe(false)
    // The chart's own files are not this action's business and must come through untouched.
    expect(new Uint8Array(readFileSync(join(chart, 'notes.chart')))).toEqual(NOTES)
    expect(new Uint8Array(readFileSync(join(chart, 'song.ini')))).toEqual(SONG_INI)
  })

  it('clears the issue it was fixing', async () => {
    const chart = folderChart()
    expect((await scanChartIssues(chart, 'folder')).rows.map((r) => r.code)).toContain('badVideo')

    await badVideoAction.apply(row(chart), ctxFor(chart))

    expect((await scanChartIssues(chart, 'folder')).rows.map((r) => r.code)).not.toContain(
      'badVideo'
    )
  })

  it('leaves a deliberately disabled video alone', async () => {
    const disabled = new Uint8Array([9, 8, 7, 6, 5])
    const chart = folderChart({ 'video.mp4.disabled': disabled })

    await badVideoAction.apply(row(chart), ctxFor(chart))

    expect(new Uint8Array(readFileSync(join(chart, 'video.mp4.disabled')))).toEqual(disabled)
  })

  it('removes its staging directory, converted or not', async () => {
    const chart = folderChart()

    await badVideoAction.apply(row(chart), ctxFor(chart))
    expect(existsSync(join(chart, ENCORE_TMP_DIR))).toBe(false)

    const broken = folderChart()
    const ctx = ctxFor(broken, {
      video: {
        unavailableReason: async () => null,
        convert: async () => {
          throw new Error('ffmpeg failed (exit 1): boom')
        }
      }
    })
    await expect(badVideoAction.apply(row(broken), ctx)).rejects.toThrow(/boom/)
    expect(existsSync(join(broken, ENCORE_TMP_DIR))).toBe(false)
    // And the chart is exactly as it was: a failed conversion costs the user nothing.
    expect(new Uint8Array(readFileSync(join(broken, 'video.mp4')))).toEqual(VIDEO)
    expect(existsSync(join(broken, 'video.webm'))).toBe(false)
  })

  it('stops on a cancelled signal without touching the chart', async () => {
    const chart = folderChart()
    const controller = new AbortController()
    controller.abort()

    await expect(
      badVideoAction.apply(row(chart), ctxFor(chart, { signal: controller.signal }))
    ).rejects.toThrow(/cancelled/i)

    expect(new Uint8Array(readFileSync(join(chart, 'video.mp4')))).toEqual(VIDEO)
    expect(existsSync(join(chart, 'video.webm'))).toBe(false)
    expect(existsSync(join(chart, ENCORE_TMP_DIR))).toBe(false)
  })

  it('reports conversion progress', async () => {
    const chart = folderChart()
    const seen: { phase: string; percent: number | null }[] = []

    await badVideoAction.apply(row(chart), ctxFor(chart, { onProgress: (p) => seen.push(p) }))

    expect(seen).toContainEqual({ phase: 'converting', percent: 50 })
    expect(seen).toContainEqual({ phase: 'converting', percent: 100 })
    expect(seen.map((p) => p.phase)).toContain('writing')
  })

  it('refuses a chart with more than one background video, naming them', async () => {
    const chart = folderChart({ 'video.webm': bytes('an existing background that works') })
    let converted = false
    const ctx = ctxFor(chart, { video: fakeConverter({ onConvert: () => (converted = true) }) })

    await expect(badVideoAction.apply(row(chart), ctx)).rejects.toThrow(/video\.mp4, video\.webm/)

    // Nothing was encoded and nothing was overwritten: the working background is still the
    // user's, byte for byte.
    expect(converted).toBe(false)
    expect(new Uint8Array(readFileSync(join(chart, 'video.webm')))).toEqual(
      bytes('an existing background that works')
    )
  })

  it('refuses when the chart no longer holds the file the row names', async () => {
    const chart = folderChart({})
    rmSync(join(chart, 'video.mp4'))

    await expect(badVideoAction.apply(row(chart), ctxFor(chart))).rejects.toThrow(
      /Scan the library again/
    )
  })
})

describe('badVideoAction.apply: .sng charts', () => {
  it('repacks the archive around the converted video', async () => {
    const chart = sngChart()

    await badVideoAction.apply(row(chart), ctxFor(chart))

    const entries = await entriesOf(chart)
    expect(entries.get('video.webm')).toEqual(expectedWebm())
    expect(entries.has('video.mp4')).toBe(false)
    // Every other entry survives the rebuild byte for byte, including the chart file, which is
    // the one the multiplayer hash is taken over.
    expect(entries.get('notes.chart')).toEqual(NOTES)
    expect(entries.get('song.ini')).toEqual(SONG_INI)
  })

  it('clears the issue it was fixing', async () => {
    const chart = sngChart()
    expect((await scanChartIssues(chart, 'sng')).rows.map((r) => r.code)).toContain('badVideo')

    await badVideoAction.apply(row(chart), ctxFor(chart))

    expect((await scanChartIssues(chart, 'sng')).rows.map((r) => r.code)).not.toContain('badVideo')
  })

  it('leaves a disabled video entry in the archive alone', async () => {
    const disabled = new Uint8Array([4, 4, 4, 4])
    const chart = sngChart({ 'video.mp4.disabled': disabled })

    await badVideoAction.apply(row(chart), ctxFor(chart))

    expect((await entriesOf(chart)).get('video.mp4.disabled')).toEqual(disabled)
  })

  it('removes its staging directory beside the archive', async () => {
    const chart = sngChart()

    await badVideoAction.apply(row(chart), ctxFor(chart))

    expect(existsSync(join(chart, '..', ENCORE_TMP_DIR))).toBe(false)
  })

  it('leaves the archive untouched when the conversion fails', async () => {
    const chart = sngChart()
    const before = readFileSync(chart)
    const ctx = ctxFor(chart, {
      video: {
        unavailableReason: async () => null,
        convert: async () => {
          throw new Error('ffmpeg failed (exit 1): boom')
        }
      }
    })

    await expect(badVideoAction.apply(row(chart), ctx)).rejects.toThrow(/boom/)

    expect(readFileSync(chart)).toEqual(before)
  })

  it('refuses when the row names a different video from the one in the archive', async () => {
    const chart = sngChart()

    await expect(badVideoAction.apply(row(chart, 'video.avi'), ctxFor(chart))).rejects.toThrow(
      /video\.avi/
    )
  })
})

describe('chartTypeAt', () => {
  it('tells the two chart shapes apart by asking the filesystem', () => {
    expect(chartTypeAt(folderChart())).toBe('folder')
    expect(chartTypeAt(sngChart())).toBe('sng')
  })
})
