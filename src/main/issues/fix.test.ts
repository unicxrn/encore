import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePng } from '../../../test/helpers/make-png'
import { makeSng } from '../../../test/helpers/make-sng'
import { pendingChartLockCount } from '../assets/write'
import { scanChartIssues, type ChartIssueRow } from '../catalog/issues'
import { badVideoAction } from './actions/bad-video'
import {
  applyFix,
  assertChartHashUnchanged,
  cancelFix,
  describeFix,
  fixableCodes,
  pendingFixCount,
  resolveFixAction,
  runFix,
  type FixAction,
  type AlbumArtSquarer,
  type FixContext,
  type VideoConverter
} from './fix'
import { tmpDir } from '../../../test/helpers/tmp'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

const NOTES = bytes(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
)

/** Two of the seven keys `getChartHash` mixes in, both away from their defaults. */
const SONG_INI = bytes(
  '[song]\nname = Fixture\nartist = Tester\ncharter = Tester\nalbum = Fixtures\npro_drums = True\nhopo_frequency = 3\n'
)

const VIDEO = new Uint8Array(4096).map((_, i) => (i * 13 + 3) % 256)

const scratchDirs: string[] = []

function scratch(): string {
  const dir = tmpDir('fix')
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

function folderChart(): string {
  const dir = join(scratch(), 'Tester - Fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.chart'), NOTES)
  writeFileSync(join(dir, 'song.ini'), SONG_INI)
  writeFileSync(join(dir, 'video.mp4'), VIDEO)
  return dir
}

function sngChart(): string {
  const path = join(scratch(), 'fixture.sng')
  writeFileSync(
    path,
    makeSng(
      [
        { fileName: 'notes.chart', data: NOTES },
        { fileName: 'song.ini', data: SONG_INI },
        { fileName: 'video.mp4', data: VIDEO }
      ],
      { name: 'Fixture', artist: 'Tester', charter: 'Tester' }
    )
  )
  return path
}

function badVideoRow(chartPath: string): ChartIssueRow {
  return {
    chartPath,
    kind: 'folder',
    code: 'badVideo',
    description: '"video.mp4" will not work on Linux and should be converted to .webm.'
  }
}

const converter: VideoConverter = {
  unavailableReason: async () => null,
  convert: async ({ input, output }) => {
    writeFileSync(output, Buffer.concat([Buffer.from('WEBM:'), readFileSync(input)]))
  }
}

/**
 * Stands in for `encodeSquareAlbumArt`, which cannot run here: it is built on Electron's
 * `nativeImage`, and under vitest the `electron` import is a CJS stub whose `nativeImage` is
 * undefined. Producing a real 512x512 PNG rather than a marker string, so the post-fix re-scan
 * exercises exifreader for real and the row actually clears.
 */
const squareArt: AlbumArtSquarer = () => makePng(512, 512)

function ctxFor(chartPath: string, over: Partial<FixContext> = {}): FixContext {
  return {
    libraryFolders: [{ path: join(chartPath, '..') }],
    video: converter,
    backupDir: join(scratch(), 'fix-backups'),
    ...over
  }
}

/** A minimal action over the same row, so framework behaviour can be tested without a video. */
function stubAction(over: Partial<FixAction> = {}): FixAction {
  return {
    code: 'badVideo',
    appliesTo: (row) => row.code === 'badVideo',
    describe: () => 'stub',
    // Backs up nothing by default. `FixAction.backup` is required for the reason the four real
    // actions exist, but the tests below are about the framework's ordering and locking, and a
    // stub that copied a file would make every one of them assert something else as well.
    backup: async (row) => ({
      code: row.code,
      actionCode: 'badVideo',
      describe: 'stub',
      files: []
    }),
    apply: async () => {},
    ...over
  }
}

describe('applyFix', () => {
  it("applies the action and returns that chart's fresh rows", async () => {
    const chart = folderChart()

    const rows = await applyFix(badVideoRow(chart), ctxFor(chart))

    expect(rows.map((r) => r.code)).not.toContain('badVideo')
    // The rows really are this chart's, not the library's.
    expect(rows.every((r) => r.chartPath === chart)).toBe(true)
  })

  it('refuses a row nothing can fix', async () => {
    const chart = folderChart()
    const row = { ...badVideoRow(chart), code: 'difficultyForbiddenNote' }

    await expect(applyFix(row, ctxFor(chart))).rejects.toThrow(/no fix for difficultyForbiddenNote/)
  })

  it('refuses before doing anything when the action cannot run', async () => {
    const chart = folderChart()
    const apply = vi.fn()

    await expect(
      applyFix(badVideoRow(chart), { libraryFolders: [], backupDir: null }, [
        stubAction({
          apply,
          availability: async () => ({ available: false, reason: 'ffmpeg is not installed' })
        })
      ])
    ).rejects.toThrow(/ffmpeg is not installed/)
    expect(apply).not.toHaveBeenCalled()
  })

  it("holds the chart's write lock while the action runs", async () => {
    const chart = folderChart()
    let lockedDuringApply = 0

    await applyFix(badVideoRow(chart), ctxFor(chart), [
      stubAction({
        apply: async () => {
          lockedDuringApply = pendingChartLockCount()
        }
      })
    ])

    // The lock is what stops a batch asset write landing between the before-hash and the
    // after-hash and being blamed on this fix.
    expect(lockedDuringApply).toBe(1)
    expect(pendingChartLockCount()).toBe(0)
  })
})

/**
 * The invariant, and the tests that would fail if it were removed.
 *
 * Clone Hero matches charts between players by `getChartHash`
 * (node_modules/scan-chart/dist/index.js:2572): the chart file's bytes, plus seven ini keys, and
 * only when those differ from their defaults. A fix that changes it makes the user's chart
 * un-playable with anyone who has the original, which they would discover socially, weeks later.
 *
 * Two of these tests are mutations: actions that deliberately break the rule, asserting that
 * `applyFix` catches them. Without those, the passing cases below prove only that the fixes
 * happen not to change the hash, not that anything is checking.
 */
describe('the multiplayer hash invariant', () => {
  it("leaves a folder chart's hash byte-identical across a real fix", async () => {
    const chart = folderChart()
    const before = await scanChartIssues(chart, 'folder')

    await applyFix(badVideoRow(chart), ctxFor(chart))

    const after = await scanChartIssues(chart, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.chartHash).not.toBeNull()
  })

  it("leaves a .sng chart's hash byte-identical across a full repack", async () => {
    const chart = sngChart()
    const before = await scanChartIssues(chart, 'sng')

    await applyFix(badVideoRow(chart), ctxFor(chart))

    const after = await scanChartIssues(chart, 'sng')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.chartHash).not.toBeNull()
  })

  it('MUTATION: catches an action that also edits the chart file', async () => {
    const chart = folderChart()
    const mutating = stubAction({
      apply: async (row) => {
        // One byte, in a comment-free chart file: the smallest edit that is still an edit.
        appendFileSync(join(row.chartPath, 'notes.chart'), '\n')
      }
    })

    await expect(applyFix(badVideoRow(chart), ctxFor(chart), [mutating])).rejects.toThrow(
      /changed the chart hash/
    )
    // The edit really happened: this test would pass vacuously if the action were a no-op.
    expect(readFileSync(join(chart, 'notes.chart')).length).toBe(NOTES.length + 1)
  })

  it('MUTATION: catches an action that changes one of the seven hashed ini keys', async () => {
    const chart = folderChart()
    const mutating = stubAction({
      apply: async (row) => {
        // pro_drums is hashed; this is the failure mode Task 5's song.ini editing walks straight
        // into, and the reason the assertion is not "did the chart file change".
        writeFileSync(
          join(row.chartPath, 'song.ini'),
          Buffer.from(SONG_INI).toString().replace('pro_drums = True', 'pro_drums = False')
        )
      }
    })

    await expect(applyFix(badVideoRow(chart), ctxFor(chart), [mutating])).rejects.toThrow(
      /changed the chart hash/
    )
  })

  it('allows an action that changes an ini key the hash does not cover', async () => {
    const chart = folderChart()
    const editing = stubAction({
      apply: async (row) => {
        writeFileSync(
          join(row.chartPath, 'song.ini'),
          Buffer.from(SONG_INI).toString().replace('album = Fixtures', 'album = Something Else')
        )
      }
    })

    // The discriminating case. If this threw too, the two mutations above would be proving only
    // that the chart was touched at all, and the whole check would be useless for Task 5's ini
    // fixes, which must be able to write `album`, `year`, `genre` and `charter`.
    await expect(applyFix(badVideoRow(chart), ctxFor(chart), [editing])).resolves.toBeDefined()
    expect(readFileSync(join(chart, 'song.ini')).toString()).toContain('album = Something Else')
  })

  it('names the chart and both hashes when it fires', () => {
    expect(() => assertChartHashUnchanged('/lib/chart.sng', 'aaa', 'bbb')).toThrow(
      /\/lib\/chart\.sng.*aaa.*bbb/s
    )
  })

  it('treats a chart that never had a hash as unchanged, but not one that lost it', () => {
    expect(() => assertChartHashUnchanged('/lib/chart', null, null)).not.toThrow()
    expect(() => assertChartHashUnchanged('/lib/chart', 'aaa', null)).toThrow(/none/)
    expect(() => assertChartHashUnchanged('/lib/chart', null, 'aaa')).toThrow(/none/)
  })
})

describe('runFix and cancelFix', () => {
  /**
   * A converter that never finishes on its own; only the signal ends it. Stands in for the
   * 35-70 second encode this cancellation exists for.
   *
   * `started` resolves once the conversion is actually under way, so the tests below cancel a fix
   * that has reached the slow part rather than one still resolving its action. The second would
   * pass even if `runFix` never wired the signal through to the converter at all.
   */
  function blockingConverter(): { converter: VideoConverter; started: Promise<void> } {
    let announce!: () => void
    const started = new Promise<void>((resolve) => (announce = resolve))
    const converter: VideoConverter = {
      unavailableReason: async () => null,
      convert: ({ signal }) =>
        new Promise((_resolve, reject) => {
          const stop = (): void => reject(new Error('Video conversion cancelled'))
          announce()
          if (signal?.aborted) stop()
          else signal?.addEventListener('abort', stop, { once: true })
        })
    }
    return { converter, started }
  }

  it('cancels a conversion already under way, and forgets it afterwards', async () => {
    const chart = folderChart()
    const { converter: video, started } = blockingConverter()

    const running = runFix(badVideoRow(chart), ctxFor(chart, { video }))
    expect(pendingFixCount()).toBe(1)
    await started
    cancelFix(chart)

    await expect(running).rejects.toThrow(/cancelled/i)
    expect(pendingFixCount()).toBe(0)
    // Cancelled means nothing was written, not half-written.
    expect(readFileSync(join(chart, 'video.mp4')).length).toBe(VIDEO.length)
    expect(existsSync(join(chart, 'video.webm'))).toBe(false)
  })

  it('cancels by a path spelled differently', async () => {
    const chart = folderChart()
    const { converter: video, started } = blockingConverter()

    const running = runFix(badVideoRow(chart), ctxFor(chart, { video }))
    await started
    // A redundant segment: one chart, two spellings, one key. Same rule as the write lock.
    cancelFix(join(chart, '.'))

    await expect(running).rejects.toThrow(/cancelled/i)
  })

  it('cancelling a chart with no fix in flight does nothing', () => {
    expect(() => cancelFix('/lib/nothing-here')).not.toThrow()
    expect(pendingFixCount()).toBe(0)
  })

  it('respects a signal the caller brought', async () => {
    const chart = folderChart()
    const { converter: video, started } = blockingConverter()
    const controller = new AbortController()

    const running = runFix(badVideoRow(chart), ctxFor(chart, { video, signal: controller.signal }))
    await started
    controller.abort()

    await expect(running).rejects.toThrow(/cancelled/i)
  })
})

describe('resolveFixAction and describeFix', () => {
  it('finds the video action for a badVideo folder row', () => {
    const row = badVideoRow('/lib/chart')
    expect(resolveFixAction(row)).toBe(badVideoAction)
    expect(describeFix(row)).toContain('video.webm')
  })

  it('offers nothing for a code with no action', () => {
    const row = { ...badVideoRow('/lib/chart'), code: 'badSustainGap', kind: 'chart' as const }
    expect(resolveFixAction(row)).toBe(null)
    expect(describeFix(row)).toBe(null)
  })
})

describe('fixableCodes', () => {
  it('reports every code fixable when both capabilities are wired up', async () => {
    const ctx = { libraryFolders: [], backupDir: null, video: converter, image: squareArt }
    expect(await fixableCodes(ctx)).toEqual([
      { code: 'badVideo', available: true, reason: null },
      { code: 'extraValue', available: true, reason: null },
      { code: 'albumArtSize', available: true, reason: null },
      { code: 'invalidIni', available: true, reason: null }
    ])
  })

  it('reports badVideo as not currently fixable, with the reason, when ffmpeg is missing', async () => {
    const missing: VideoConverter = {
      unavailableReason: async () => 'ffmpeg is not installed',
      convert: async () => {
        throw new Error('unreachable')
      }
    }

    // The UI needs the reason, not just a false: it offers the install in place of a button
    // that would fail 70 seconds into an encode.
    const codes = await fixableCodes({
      libraryFolders: [],
      backupDir: null,
      video: missing,
      image: squareArt
    })
    expect(codes).toContainEqual({
      code: 'badVideo',
      available: false,
      reason: 'ffmpeg is not installed'
    })
    // The others do not depend on ffmpeg and must not be hidden along with it.
    expect(codes.filter((c) => c.available).map((c) => c.code)).toEqual([
      'extraValue',
      'albumArtSize',
      'invalidIni'
    ])
  })

  it('reports albumArtSize as not fixable when no image encoder is wired up', async () => {
    const codes = await fixableCodes({ libraryFolders: [], backupDir: null, video: converter })
    expect(codes).toContainEqual({
      code: 'albumArtSize',
      available: false,
      reason: 'Image encoding is not available in this build.'
    })
  })
})
