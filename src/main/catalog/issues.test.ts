import { chmodSync, mkdirSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { JobProgress } from '../../shared/schemas'
import { cancelIssueScan, IssueScanCanceled, lastIssueReport, scanIssues } from './issues'
import { tmpDir } from '../../../test/helpers/tmp'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(__dirname, '../../../test/fixtures/library')

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeIniOnly(root: string, name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'song.ini'),
    '[song]\nname = Missing Chart\nartist = Test Artist\ncharter = Tester\n'
  )
  return dir
}

function makeCorruptSng(root: string, name: string): string {
  const path = join(root, `${name}.sng`)
  writeFileSync(path, Buffer.from('NOTVALIDSNG!!!!CORRUPT', 'latin1'))
  return path
}

function makeGoodSng(root: string, name: string): string {
  const encoder = new TextEncoder()
  const buf = makeSng([
    {
      fileName: 'song.ini',
      data: encoder.encode(
        '[song]\nname = Sng Song\nartist = Sng Artist\ncharter = Tester\ndiff_guitar = 3\n'
      )
    },
    {
      fileName: 'notes.chart',
      data: encoder.encode(
        '[Song]\n{\n  Name = "Sng Song"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
      )
    }
  ])
  const path = join(root, `${name}.sng`)
  writeFileSync(path, buf)
  return path
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scanIssues', () => {
  it('returns rows for the good fixture chart (noAlbumArt, noAudio, metadataIssues, chartIssues)', async () => {
    const progress: JobProgress[] = []
    const rows = await scanIssues([FIXTURE], (p) => progress.push(p))

    // folderIssues: noAlbumArt and noAudio (fixture has no audio/album art files)
    const folderRows = rows.filter((r) => r.kind === 'folder')
    expect(folderRows.map((r) => r.code)).toContain('noAlbumArt')
    expect(folderRows.map((r) => r.code)).toContain('noAudio')

    // metadataIssues: missingValue x3 (album, genre, year)
    const metaRows = rows.filter((r) => r.kind === 'metadata')
    expect(metaRows.filter((r) => r.code === 'missingValue').length).toBeGreaterThanOrEqual(3)

    // chartIssues: isDefaultBPM, noSections, smallLeadingSilence
    const chartRows = rows.filter((r) => r.kind === 'chart')
    const chartCodes = chartRows.map((r) => r.code)
    expect(chartCodes).toContain('isDefaultBPM')
    expect(chartCodes).toContain('noSections')
    expect(chartCodes).toContain('smallLeadingSilence')

    // All rows reference the fixture chart path
    const fixturePath = join(FIXTURE, 'Test Artist - Test Song')
    expect(rows.every((r) => r.chartPath === fixturePath)).toBe(true)
  })

  it('chartIssue descriptions include instrument/difficulty context when present', async () => {
    const rows = await scanIssues([FIXTURE], () => {})
    const smallLeading = rows.find((r) => r.code === 'smallLeadingSilence')
    expect(smallLeading).toBeDefined()
    // smallLeadingSilence is per-instrument (guitar/expert in fixture)
    expect(smallLeading!.description).toMatch(/guitar|expert/i)
  })

  it('records a scanFailed row for a corrupt .sng file', async () => {
    const root = tmpDir('issues')
    makeCorruptSng(root, 'corrupt')
    const rows = await scanIssues([root], () => {})
    const failed = rows.find((r) => r.kind === 'chart' && r.code === 'scanFailed')
    expect(failed).toBeDefined()
    expect(failed!.chartPath).toMatch(/corrupt\.sng$/)
    expect(failed!.description.length).toBeGreaterThan(0)
  })

  it('produces a noChart folderIssue for a folder with only song.ini', async () => {
    const root = tmpDir('issues')
    makeIniOnly(root, 'Missing Notes')
    const rows = await scanIssues([root], () => {})
    const noChart = rows.find((r) => r.kind === 'folder' && r.code === 'noChart')
    expect(noChart).toBeDefined()
  })

  it('handles mixed library: good folder + ini-only + corrupt sng', async () => {
    const root = tmpDir('issues')
    // Copy good fixture chart into root
    mkdirSync(join(root, 'Good Song'), { recursive: true })
    const encoder = new TextEncoder()
    writeFileSync(
      join(root, 'Good Song/notes.chart'),
      encoder.encode(
        '[Song]\n{\n  Name = "Good"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  960 = N 0 0\n}\n'
      )
    )
    writeFileSync(
      join(root, 'Good Song/song.ini'),
      '[song]\nname = Good\nartist = A\ncharter = C\n'
    )
    makeIniOnly(root, 'Ini Only')
    makeCorruptSng(root, 'corrupt')
    const rows = await scanIssues([root], () => {})

    const paths = [...new Set(rows.map((r) => r.chartPath))]
    expect(paths).toHaveLength(3)

    const failed = rows.filter((r) => r.code === 'scanFailed')
    expect(failed).toHaveLength(1)

    const noChart = rows.filter((r) => r.code === 'noChart')
    expect(noChart).toHaveLength(1)
  })

  it('does NOT produce a false-positive noAudio when an audio file is present', async () => {
    const root = tmpDir('issues')
    mkdirSync(join(root, 'Has Audio'))
    const encoder = new TextEncoder()
    writeFileSync(
      join(root, 'Has Audio/notes.chart'),
      encoder.encode(
        '[Song]\n{\n  Name = "Has Audio"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  960 = N 0 0\n}\n'
      )
    )
    writeFileSync(
      join(root, 'Has Audio/song.ini'),
      '[song]\nname = Has Audio\nartist = A\ncharter = C\n'
    )
    // Add an audio file. This should suppress the noAudio issue
    writeFileSync(join(root, 'Has Audio/guitar.ogg'), Buffer.alloc(16, 0))
    const rows = await scanIssues([root], () => {})
    const noAudio = rows.filter((r) => r.code === 'noAudio')
    expect(noAudio).toHaveLength(0)
  })

  it('reports progress with discovering → scanning percent → complete', async () => {
    const progress: JobProgress[] = []
    await scanIssues([FIXTURE], (p) => progress.push(p))
    expect(progress[0].phase).toBe('discovering')
    expect(progress[0].jobId).toBe('issue-scan')
    expect(progress[0].kind).toBe('asset')
    const scanning = progress.filter((p) => p.phase === 'scanning')
    expect(scanning.length).toBeGreaterThan(0)
    const last = progress.at(-1)!
    expect(last.phase).toBe('complete')
    expect(last.status).toBe('done')
    expect(last.percent).toBe(100)
  })

  it('returns empty array and completes for an empty root', async () => {
    const root = tmpDir('issues')
    const progress: JobProgress[] = []
    const rows = await scanIssues([root], (p) => progress.push(p))
    expect(rows).toHaveLength(0)
    expect(progress.at(-1)?.phase).toBe('complete')
  })

  it('caches the last report in lastIssueReport()', async () => {
    const progress: JobProgress[] = []
    const rows = await scanIssues([FIXTURE], (p) => progress.push(p))
    expect(lastIssueReport()).toEqual(rows)
  })

  // The issue scan skips media by name, which misses the file that actually costs: a video
  // renamed to turn it off is not media by name and was read whole. Unreadable rather than
  // merely large, so opening it is the difference between a report and a scanFailed row.
  it('scans a folder chart without opening a file scan-chart never parses', async () => {
    const root = tmpDir('issues')
    const dir = join(root, 'Song With Disabled Video')
    mkdirSync(dir)
    writeFileSync(join(dir, 'song.ini'), '[song]\nname = Disabled\nartist = A\ncharter = C\n')
    writeFileSync(
      join(dir, 'notes.chart'),
      '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  960 = N 0 0\n}\n'
    )
    writeFileSync(join(dir, 'video.mp4.disabled'), Buffer.alloc(1024, 3))
    chmodSync(join(dir, 'video.mp4.disabled'), 0o000)

    const rows = await scanIssues([root], () => {})

    expect(rows.filter((r) => r.code === 'scanFailed')).toHaveLength(0)
    expect(rows.filter((r) => r.chartPath === dir).length).toBeGreaterThan(0)
  })

  // Same probe as scanner.test.ts's: the issue scan is also supposed to leave audio bytes on
  // disk, and truncating the archive inside its audio entry is what makes that observable.
  it('scans a .sng whose audio body is missing from the file', async () => {
    const root = tmpDir('issues')
    const path = join(root, 'truncated.sng')
    // Audio last, so the truncation lands in it rather than in the chart file.
    writeFileSync(
      path,
      makeSng(
        [
          {
            fileName: 'notes.chart',
            data: new TextEncoder().encode(
              '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  960 = N 0 0\n}\n'
            )
          },
          { fileName: 'song.ogg', data: Buffer.alloc(512 * 1024, 7) }
        ],
        { name: 'Truncated', artist: 'A' }
      )
    )
    truncateSync(path, statSync(path).size - 256 * 1024)

    const rows = await scanIssues([root], () => {})

    expect(rows.filter((r) => r.code === 'scanFailed')).toHaveLength(0)
    // The audio is named in the header, so its absence from disk is not a missing-audio report.
    expect(rows.filter((r) => r.code === 'noAudio')).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  /** A root holding `count` cheap, valid folder charts, enough to outlast one cancel. */
  function makeManyCharts(count: number): string {
    const root = tmpDir('issues-cancel')
    for (let i = 0; i < count; i++) {
      const dir = join(root, `Chart ${i}`)
      mkdirSync(dir)
      writeFileSync(join(dir, 'song.ini'), `[song]\nname = Chart ${i}\nartist = A\ncharter = C\n`)
      writeFileSync(
        join(dir, 'notes.chart'),
        '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  960 = N 0 0\n}\n'
      )
    }
    return root
  }

  it('rejects rather than handing back a partial report when cancelled', async () => {
    // The failure this guards: a short list of rows, indistinguishable from a complete report,
    // read as "only 3 charts have problems" for a library most of which was never opened.
    const root = makeManyCharts(60)
    const scan = scanIssues([root], (p) => {
      if (p.phase === 'scanning') cancelIssueScan()
    })

    await expect(scan).rejects.toBeInstanceOf(IssueScanCanceled)
  })

  it('leaves the previous complete report in place after a cancel', async () => {
    const complete = await scanIssues([FIXTURE], () => {})
    expect(lastIssueReport()).toEqual(complete)

    const root = makeManyCharts(60)
    await expect(
      scanIssues([root], (p) => {
        if (p.phase === 'scanning') cancelIssueScan()
      })
    ).rejects.toThrow(/cancel/i)

    // Still the fixture's rows: a cancelled scan caches nothing, so what the tab shows next is
    // the last report that was actually finished.
    expect(lastIssueReport()).toEqual(complete)
  })

  it('ends a cancelled scan on a canceled event, at the percent it actually reached', async () => {
    const progress: JobProgress[] = []
    const root = makeManyCharts(60)

    await expect(
      scanIssues([root], (p) => {
        progress.push(p)
        if (p.phase === 'scanning') cancelIssueScan()
      })
    ).rejects.toThrow(/cancel/i)

    const last = progress.at(-1)!
    expect(last.status).toBe('canceled')
    expect(last.phase).toBe('canceled')
    // Not 100: the scan did not reach the end, and its last event must not claim it did.
    expect(last.percent).toBeLessThan(100)
    expect(progress.some((p) => p.status === 'done')).toBe(false)
  })

  it('stops opening charts once cancelled, rather than merely discarding the results', async () => {
    // A cancel that only threw at the end would still read all 60 charts, which on a real
    // library is the minute the user was trying to get back.
    const root = makeManyCharts(60)
    let scanned = 0

    await expect(
      scanIssues([root], (p) => {
        if (p.phase !== 'scanning') return
        scanned = p.percent ?? 0
        cancelIssueScan()
      })
    ).rejects.toThrow(/cancel/i)

    // Charts already in flight finish (up to the concurrency limit), so the bound is generous;
    // what it rules out is the whole library being read anyway.
    expect(scanned).toBeLessThan(100)
  })

  it('cancelling with no scan running is a no-op', () => {
    expect(() => cancelIssueScan()).not.toThrow()
  })

  it('a cancel does not poison the next scan', async () => {
    const root = makeManyCharts(60)
    await expect(
      scanIssues([root], (p) => {
        if (p.phase === 'scanning') cancelIssueScan()
      })
    ).rejects.toThrow(/cancel/i)

    const rows = await scanIssues([FIXTURE], () => {})
    expect(rows.length).toBeGreaterThan(0)
    expect(lastIssueReport()).toEqual(rows)
  })

  it('scans a valid .sng file and extracts issues from it', async () => {
    const root = tmpDir('issues')
    makeGoodSng(root, 'valid')
    const rows = await scanIssues([root], () => {})
    // sng file should produce issues (noAlbumArt, noAudio at minimum since sng has no audio)
    const sngPath = join(root, 'valid.sng')
    const sngRows = rows.filter((r) => r.chartPath === sngPath)
    expect(sngRows.length).toBeGreaterThan(0)
    // Should have folder issue codes (not scanFailed)
    expect(sngRows.every((r) => r.code !== 'scanFailed')).toBe(true)
  })
})
