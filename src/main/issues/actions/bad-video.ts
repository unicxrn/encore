import { mkdirSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENCORE_TMP_DIR } from '../../../shared/constants'
import {
  fixForRow,
  fixSentence,
  isBadVideoName,
  videoNameFromRow
} from '../../../shared/issue-fixes'
import { writeSngAssetContent } from '../../assets/sng-asset'
import { writeChartAssetFromFile } from '../../assets/write'
import { chartTypeAt, type ChartIssueRow } from '../../catalog/issues'
import { extractSngEntryToFile } from '../../downloads/sng-read-selective'
import { readRepackPlan } from '../../downloads/sng-repack'
import type { FixAction, FixContext } from '../fix'

/**
 * `badVideo`: convert a chart's `video.mp4` (or `.avi`, or `.mpeg`) to `video.webm`.
 *
 * scan-chart raises this because those containers do not play on Linux; the background stays
 * black and the chart is otherwise fine. Six charts in the reference library carry it, all of
 * them `.sng`, all of them `video.mp4`, at archive sizes from 20.6 MiB to 155.7 MiB. Converting
 * the smallest of them for real took 63.6 s and took the archive from 21,550,000 to 22,029,921
 * bytes, which is parity, and that is what deriving the bitrate from the source buys (see
 * ffmpeg/convert.ts).
 *
 * The MP4 is REPLACED, not kept. Keeping it would leave the chart at roughly double the size and
 * would not clear the issue, because scan-chart flags the file's presence rather than its use.
 *
 * Nothing this action writes is hashed by `getChartHash`: video is not part of a chart's gameplay
 * identity, and neither the chart file nor `song.ini` is opened here. `applyFix` proves that
 * after the fact rather than taking it on trust; see issues/fix.ts.
 */

/**
 * scan-chart's `hasVideoName`, transcribed from node_modules/scan-chart/dist/index.js:125.
 *
 * Case-SENSITIVE on both halves, because scan-chart is: `getBasename(fileName) === "video"` and
 * `["mp4","avi","webm","vp8","ogv","mpeg"].includes(getExtension(fileName))`, neither of which
 * lower-cases. A `Video.MP4` is not a background to scan-chart, so it is not one here. Matching
 * it more loosely than the scanner does would mean acting on files the report never flagged.
 */
function isChartVideoName(fileName: string): boolean {
  const parts = fileName.split('.')
  if (parts.length < 2) return false
  const extension = parts[parts.length - 1]
  const base = parts.slice(0, -1).join('.')
  return base === 'video' && ['mp4', 'avi', 'webm', 'vp8', 'ogv', 'mpeg'].includes(extension)
}

/**
 * `isBadVideoName` and `videoNameFromRow` both live in shared/issue-fixes.ts, because the
 * renderer needs the same reading of a row to decide whether to draw a Fix button at all. The
 * first is scan-chart's `hasBadVideoName` (index.js:128), and the rule that keeps
 * `video.mp4.disabled` alone.
 * Re-exported here so this module still reads as the one place `badVideo` is understood.
 */
export { videoNameFromRow }

/** What the converted `video.webm` supersedes; the same set as `isChartVideoName`, minus webm. */
const SUPERSEDED_VIDEO_RE = /^video\.(mp4|avi|mpeg|vp8|ogv)$/

/** Distinguishes concurrent staging directories; see `stagingDirFor`. */
let stagingCounter = 0

/**
 * Where the extracted source and the converted output live while the fix runs.
 *
 * Inside the chart's own folder for a folder chart, and beside the archive for a `.sng`, for the
 * reason `downloadIntoSng` gives at length: it is the same filesystem by construction, so the
 * rename that installs the result is atomic and cannot fail with EXDEV, and it is inside a
 * library folder the user has already granted. `os.tmpdir()` is a tmpfs on many Linux systems,
 * which is the worst available place to put a 159 MB video.
 *
 * `ENCORE_TMP_DIR` is skipped by the scanner and, being a directory, is invisible to both chart
 * readers, which list files only. Removed on every exit path, including cancel and failure.
 */
function stagingDirFor(chartPath: string, chartType: 'folder' | 'sng'): string {
  const parent = chartType === 'folder' ? chartPath : dirname(chartPath)
  return join(parent, ENCORE_TMP_DIR, `fix-video-${process.pid}-${stagingCounter++}`)
}

/**
 * Refuse a chart that has more than one background video, naming them.
 *
 * The alternative is worse than it sounds. Converting `video.mp4` while the chart also holds a
 * `video.webm` would overwrite a background that already works with a re-encode of the broken
 * one, destroying the good file to fix the bad one. A chart with `video.mp4` and
 * `video.avi` raises two rows whose fixes would each clobber the other's output. Neither is
 * something a user asked for, and `scan-chart` already reports the underlying state as
 * `multipleVideo`, which is a different problem with a different answer (which one do you want?)
 * that Encore does not get to guess.
 *
 * No chart in the reference library is in this state: `multipleVideo` appears on zero of its 219
 * charts. This exists so that the one that is gets a sentence instead of a surprise.
 */
function assertSingleVideo(chartPath: string, videoNames: string[]): void {
  if (videoNames.length <= 1) return
  throw new Error(
    `${chartPath} has ${videoNames.length} background videos (${videoNames.sort().join(', ')}). ` +
      `Encore will not choose between them. Remove the ones you do not want, then fix the rest.`
  )
}

/**
 * Which file this row is about, checked against what the chart actually holds.
 *
 * Two independent readings have to agree: the row names a file, and the chart contains exactly
 * one video whose name scan-chart would flag. If the row named nothing usable (a changed
 * description format), the chart's own single candidate is used. If they disagree, that is a
 * chart that changed since the report was taken, and the fix stops.
 */
function resolveTarget(row: ChartIssueRow, videoNames: string[]): string {
  assertSingleVideo(row.chartPath, videoNames)
  const present = videoNames[0]
  if (present === undefined || !isBadVideoName(present)) {
    throw new Error(
      `${row.chartPath} no longer has a video Encore can convert. Scan the library again and retry.`
    )
  }
  const named = videoNameFromRow(row)
  if (named !== null && named !== present) {
    throw new Error(
      `${row.chartPath} holds ${present}, but this issue is about ${named}. Scan the library again and retry.`
    )
  }
  return present
}

/**
 * The bad video this row is about, read fresh from the chart.
 *
 * Split out so the backup and the conversion resolve it the same way rather than twice over. They
 * run back to back inside one chart lock, so agreeing is not optional: a backup of `video.avi`
 * followed by a conversion of `video.mp4` would leave an undo that puts back a file the repair
 * never removed.
 */
async function resolveVideoName(
  chartPath: string,
  chartType: 'folder' | 'sng',
  row: ChartIssueRow
): Promise<string> {
  if (chartType === 'folder') {
    return resolveTarget(
      row,
      readdirSync(chartPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(isChartVideoName)
    )
  }
  const plan = await readRepackPlan(chartPath)
  return resolveTarget(row, plan.entries.map((entry) => entry.fileName).filter(isChartVideoName))
}

export const badVideoAction: FixAction = {
  code: 'badVideo',

  // Both delegate to shared/issue-fixes.ts, so main and the renderer cannot form two opinions
  // about which rows this repairs or what it promises to do to them.
  appliesTo: (row) => fixForRow(row)?.actionCode === 'badVideo',

  describe: (row) => fixSentence(row, 'badVideo'),

  /**
   * Keep the original video, and remember that the conversion's output has to go.
   *
   * The one repair where the kept bytes are large (18-159 MB in the reference library), and the
   * one where keeping them matters most: a conversion the user dislikes is otherwise a video they
   * cannot get back at any price, because the source is gone and a re-encode of a re-encode is not
   * the same file.
   *
   * `remove` is `video.webm` unconditionally rather than the name the conversion happens to write,
   * because that name is fixed: this action always writes `video.webm`, whatever the source was
   * called. `assertSingleVideo` has already refused any chart that held a `video.webm` of its own,
   * so the file the undo deletes can only be one this repair created.
   */
  backup: async (row) => {
    const chartPath = row.chartPath
    const chartType = chartTypeAt(chartPath)
    const fileName = await resolveVideoName(chartPath, chartType, row)
    return {
      code: row.code,
      actionCode: 'badVideo',
      describe: fixSentence(row, 'badVideo'),
      files: [
        {
          fileName,
          content:
            chartType === 'sng'
              ? { kind: 'sngEntry', sngPath: chartPath }
              : { kind: 'copyFile', path: join(chartPath, fileName) }
        }
      ],
      remove: ['video.webm']
    }
  },

  availability: async (ctx) => {
    if (!ctx.video) {
      return { available: false, reason: 'Video conversion is not available in this build.' }
    }
    const reason = await ctx.video.unavailableReason()
    return { available: reason === null, reason }
  },

  apply: async (row, ctx) => {
    const converter = ctx.video
    if (!converter) throw new Error('Video conversion is not available in this build.')

    const chartPath = row.chartPath
    const chartType = chartTypeAt(chartPath)
    const staging = stagingDirFor(chartPath, chartType)
    mkdirSync(staging, { recursive: true })
    try {
      const output = join(staging, 'video.webm')
      const input =
        chartType === 'sng'
          ? await stageFromSng(chartPath, row, staging, ctx)
          : await stageFromFolder(chartPath, row)

      ctx.onProgress?.({ phase: 'converting', percent: 0 })
      await converter.convert({
        input,
        output,
        signal: ctx.signal,
        onProgress: (fraction) =>
          ctx.onProgress?.({ phase: 'converting', percent: Math.round(fraction * 100) })
      })

      ctx.onProgress?.({ phase: 'writing', percent: null })
      if (chartType === 'sng') {
        // A path, not bytes: the converted file runs to 159 MB in this library and both the
        // repack and its verification stream it. See AssetContent in assets/sng-asset.ts.
        await writeSngAssetContent(
          chartPath,
          'video.webm',
          { kind: 'file', path: output },
          ctx.libraryFolders,
          { removeMatching: SUPERSEDED_VIDEO_RE }
        )
      } else {
        // A rename inside the chart's own folder, so the video is never read back into memory
        // and the install is atomic. `removeMatching` then unlinks the original, after the new
        // file is in place and never before, so a failure costs the user nothing.
        writeChartAssetFromFile(chartPath, 'video.webm', output, ctx.libraryFolders, {
          removeMatching: SUPERSEDED_VIDEO_RE
        })
      }
    } finally {
      // Every exit path, cancel included. The extracted source is a full copy of the original
      // video; leaving it behind would silently double the chart's footprint on disk.
      rmSync(staging, { recursive: true, force: true })
      try {
        // And the .encore-tmp we may have created, but only when nothing else is using it:
        // rmdir is not recursive, so a directory still holding the download queue's resumable
        // `.part` files fails with ENOTEMPTY and is left exactly as it was.
        rmdirSync(dirname(staging))
      } catch {
        // Not ours to clean, or already gone. Either way an empty temp directory is not worth
        // failing a conversion that succeeded.
      }
    }
  }
}

/** Extract the archive's bad video to a real file, since ffmpeg cannot read inside a `.sng`. */
async function stageFromSng(
  chartPath: string,
  row: ChartIssueRow,
  staging: string,
  ctx: FixContext
): Promise<string> {
  ctx.onProgress?.({ phase: 'extracting', percent: null })
  const plan = await readRepackPlan(chartPath)
  const target = resolveTarget(
    row,
    plan.entries.map((entry) => entry.fileName).filter(isChartVideoName)
  )
  const input = join(staging, target)
  await extractSngEntryToFile(chartPath, plan, target, input)
  return input
}

/** A folder chart's video is already a file; ffmpeg reads it where it lies. */
async function stageFromFolder(chartPath: string, row: ChartIssueRow): Promise<string> {
  return join(chartPath, await resolveVideoName(chartPath, 'folder', row))
}

/**
 * Exported for the tests that pin these rules to scan-chart's own.
 *
 * They are not part of the action's interface: the point of the tests is that the two name rules
 * agree with `hasVideoName`/`hasBadVideoName` for every name either might see, and testing them
 * only through a conversion would mean encoding a video per case.
 */
export const badVideoNameRules = { isChartVideoName, isBadVideoName, SUPERSEDED_VIDEO_RE }
