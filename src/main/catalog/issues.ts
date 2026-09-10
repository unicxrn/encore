import Bottleneck from 'bottleneck'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanChartFolder } from 'scan-chart'
import type { JobProgress } from '../../shared/schemas'
import { isParsedByScanChart, readSngEntriesForScan } from '../downloads/sng-read-selective'
import { findChartPaths } from './scanner'

export interface ChartIssueRow {
  chartPath: string
  kind: 'folder' | 'metadata' | 'chart'
  code: string
  description: string
}

// Module-level cache for the most recent issue scan result.
let _lastReport: ChartIssueRow[] | null = null

/** Returns the result of the most recent scanIssues() call, or null if none has run. */
export function lastIssueReport(): ChartIssueRow[] | null {
  return _lastReport
}

const ISSUE_SCAN_CONCURRENCY = 20

/**
 * The abort handle of the scan currently running, or null.
 *
 * A single slot rather than the per-chart map `fix.ts` keeps, because there is only ever one
 * library-wide scan: the Issues tab disables its button for the duration, and unlike a fix there
 * is no second copy of this job to confuse it with. Held here rather than passed in because the
 * canceller is an IPC handler, which has no way to hold state between two invocations.
 */
let activeScan: AbortController | null = null

/**
 * Stop the running issue scan. A no-op when there is none.
 *
 * What "stop" can mean, precisely: charts already handed to the scanner run to completion (up to
 * `ISSUE_SCAN_CONCURRENCY` of them, and reading one large `.sng` is not interruptible), while
 * everything still queued is dropped. On the reference library that is a fraction of a second.
 */
export function cancelIssueScan(): void {
  activeScan?.abort()
}

/**
 * What `scanIssues` rejects with when it was cancelled.
 *
 * A rejection, NOT a short report. Handing back the rows gathered so far would put a partial
 * report on screen with nothing to distinguish it from a complete one. The user would read "12
 * charts have problems" off a library where 180 charts were never looked at. The class exists so
 * main-process callers can test for it; across IPC only the message survives, which is why the
 * renderer decides "this was a cancel" from the button it just pressed rather than from the text.
 */
export class IssueScanCanceled extends Error {
  constructor() {
    super('Issue scan canceled')
    this.name = 'IssueScanCanceled'
  }
}

/**
 * Read a chart folder for issue scanning: every file named, bytes only for the ones scan-chart
 * parses. Everything else is a zero-byte placeholder, which is what the presence-based checks
 * (noAudio, multipleVideo and the rest) have always been given.
 *
 * The placeholders used to be reserved for names that looked like media, which let the biggest
 * files through: a background video turned off by renaming it to `video.mp4.disabled` is not
 * media by name, and three of those are 2.36 GiB of the 2.38 GiB this read across the reference
 * library's 45 folder charts. Widening the rule to "does scan-chart parse it" brings that to
 * 22.0 MiB and changes no output: all 45 produce an identical ScannedChart, issue arrays
 * included, through both readers.
 */
function readFolderForIssues(dir: string): { fileName: string; data: Uint8Array }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({
      fileName: e.name,
      data: isParsedByScanChart(e.name)
        ? new Uint8Array(readFileSync(join(dir, e.name)))
        : new Uint8Array(0)
    }))
}

/** Flatten a ScannedChart's three issue arrays into ChartIssueRow[]. */
function flattenIssues(
  chartPath: string,
  scanned: ReturnType<typeof scanChartFolder>
): ChartIssueRow[] {
  const rows: ChartIssueRow[] = []

  for (const issue of scanned.folderIssues) {
    rows.push({
      chartPath,
      kind: 'folder',
      code: issue.folderIssue,
      description: issue.description
    })
  }

  for (const issue of scanned.metadataIssues) {
    rows.push({
      chartPath,
      kind: 'metadata',
      code: issue.metadataIssue,
      description: issue.description
    })
  }

  if (scanned.notesData) {
    for (const issue of scanned.notesData.chartIssues) {
      // Include per-instrument/difficulty context in the description when present.
      let description = issue.description
      const ctx: string[] = []
      if (issue.instrument != null) ctx.push(`instrument: ${issue.instrument}`)
      if (issue.difficulty != null) ctx.push(`difficulty: ${issue.difficulty}`)
      if (ctx.length > 0) {
        description = `[${ctx.join(', ')}] ${description}`
      }
      rows.push({
        chartPath,
        kind: 'chart',
        code: issue.noteIssue,
        description
      })
    }
  }

  return rows
}

/**
 * Which shape the chart at `chartPath` is.
 *
 * Everywhere else in the app `chartType` travels with the chart. The scanner decides it and the
 * catalog row carries it, and sniffing a path would be a second opinion that can disagree with
 * the first. An issue row carries no such field: `scanIssues` walks the filesystem rather than
 * the catalog, and a chart with issues need not have a catalog row at all. So this asks the
 * filesystem the one question that settles it. A directory cannot be a `.sng` archive and an
 * archive cannot be a directory, which is the same fact `findChartPaths` uses to classify a
 * chart in the first place.
 *
 * Throws if the path is gone, which is what a caller about to write to it needs to hear.
 */
export function chartTypeAt(chartPath: string): 'folder' | 'sng' {
  return statSync(chartPath).isDirectory() ? 'folder' : 'sng'
}

export interface SingleChartScan {
  rows: ChartIssueRow[]
  /**
   * What Clone Hero matches charts by: the chart file's bytes plus the seven gameplay ini keys
   * that differ from their defaults (`getChartHash`, scan-chart/dist/index.js:2572). Null when
   * the chart has no readable chart file, which is itself an issue row.
   */
  chartHash: string | null
}

/**
 * Scan one chart, the same way `scanIssues` scans each of many, and hand back its hash as well.
 *
 * The hash is why this is separate from the loop below rather than folded into it: the M14 fix
 * framework re-scans a chart it has just repaired and refuses the result unless `chartHash` is
 * byte-identical to what it was before (see `issues/fix.ts`). Sharing this function with the
 * library-wide scan is what makes that comparison meaningful: a fix is judged by the same
 * reader that produced the row it was fixing, so the two cannot disagree about what a chart is.
 *
 * Errors are NOT isolated here, unlike in the batch scan. One chart failing to parse mid-scan is
 * a row; one chart failing to parse right after we wrote to it is something the caller has to
 * hear about as a failure.
 */
export async function scanChartIssues(
  chartPath: string,
  chartType: 'folder' | 'sng'
): Promise<SingleChartScan> {
  const scanned = await scanOneChart(chartPath, chartType)
  return { rows: flattenIssues(chartPath, scanned), chartHash: scanned.chartHash ?? null }
}

/** Read a chart whichever shape it is and run scan-chart over it. */
async function scanOneChart(
  chartPath: string,
  chartType: 'folder' | 'sng'
): Promise<ReturnType<typeof scanChartFolder>> {
  if (chartType === 'folder') {
    return scanChartFolder(readFolderForIssues(chartPath), {
      includeMd5: false,
      includeBTrack: false
    })
  }
  // .sng: the selective reader already returns media named and empty, so the placeholders this
  // scan used to synthesise now cost nothing to obtain, because the bytes are never read off
  // disk at all rather than read and then thrown away.
  const { entries } = await readSngEntriesForScan(chartPath)
  return scanChartFolder(entries, { includeMd5: false, includeBTrack: false })
}

/**
 * Scan all charts under the given roots for issues using scan-chart.
 *
 * Mirrors the discovery + concurrency + error-isolation pattern from scanLibrary() in
 * scanner.ts. A chart that fails to parse gets a synthetic scanFailed row instead of
 * aborting the whole scan.
 *
 * Both branches read the same way: a chart's files are all named, and only the ones scan-chart
 * parses are read. Everything else is a zero-byte placeholder, which keeps the presence-based
 * checks (noAudio, noVideo and the rest) honest without their bytes. A .sng goes one better:
 * readSngEntriesForScan never fetches those bytes off disk at all.
 *
 * Like scanLibrary, this stays on the main process. M13 re-profiled both before deciding, and
 * this is the cheaper of the two: 3.4-3.6 s against that scan's 3.9-4.2 s over the same 207
 * charts, reading 71.0 MiB against its 71.5 MiB. It does the same parsing and skips the catalog
 * writes and the album-art encoding, so there is less here to move, not more. scanLibrary carries
 * the full reasoning.
 *
 * The completed report is cached in lastIssueReport(). A CANCELLED one is not. See
 * `IssueScanCanceled` for why a partial report is never handed back at all.
 */
export async function scanIssues(
  roots: string[],
  onProgress: (p: JobProgress) => void
): Promise<ChartIssueRow[]> {
  const report = (
    phase: string,
    percent: number | null,
    status: JobProgress['status'] = 'running'
  ): void =>
    onProgress({ jobId: 'issue-scan', kind: 'asset', phase, percent, message: null, status })

  const controller = new AbortController()
  activeScan = controller
  const { signal } = controller
  try {
    report('discovering', null)
    // Wrapped rather than point-free: flatMap passes the index as a second argument, which
    // findChartPaths reads as `limit`, so the first root would be capped at 0 charts.
    // Not cancellable: this is one synchronous directory walk with no point to break at. It is
    // also the short half of the job (the per-chart parsing below is the 3.4 s), so the first
    // thing a cancel can act on is the loop after it.
    const found = roots.flatMap((root) => findChartPaths(root))

    if (found.length === 0) {
      report('complete', 100, 'done')
      _lastReport = []
      return []
    }

    const limiter = new Bottleneck({ maxConcurrent: ISSUE_SCAN_CONCURRENCY })
    const allRows: ChartIssueRow[] = []
    let done = 0
    let percent = 0

    await Promise.all(
      found.map((chart) =>
        limiter.schedule(async () => {
          // Checked when the job STARTS, not when it was queued: everything Bottleneck has not
          // reached yet lands here and returns without opening a file, which is what makes a
          // cancel take effect within one chart rather than one library.
          if (signal.aborted) return
          try {
            const scanned = await scanOneChart(chart.path, chart.type)
            allRows.push(...flattenIssues(chart.path, scanned))
          } catch (err) {
            // Per-chart isolation: one unreadable/corrupt chart must not abort the whole scan.
            allRows.push({
              chartPath: chart.path,
              kind: 'chart',
              code: 'scanFailed',
              description: err instanceof Error ? err.message : String(err)
            })
          } finally {
            done++
            percent = Math.round((done / found.length) * 100)
            // Still reported after a cancel: the charts already in flight are genuinely being
            // finished, and a progress line frozen at the moment of the click would look like a
            // hang. The terminal event below is what says the scan stopped.
            report('scanning', percent)
          }
        })
      )
    )

    if (signal.aborted) {
      // The percent reached, not 100: a cancelled scan did not get to the end and its last
      // event must not claim otherwise. `_lastReport` is deliberately left alone, because the
      // previous complete report is still true, and a partial one presented as complete is the
      // failure this whole path exists to avoid.
      report('canceled', percent, 'canceled')
      throw new IssueScanCanceled()
    }

    report('complete', 100, 'done')
    _lastReport = allRows
    return allRows
  } finally {
    // Only ever clear our own entry, on the same reasoning as `runFix`: a scan started after this
    // one has already replaced the slot, and dropping it would leave the newer scan uncancellable.
    if (activeScan === controller) activeScan = null
  }
}
