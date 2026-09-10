import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ENCORE_TMP_DIR } from '../../shared/constants'
import { assertUnderLibrary, canonicalize } from '../assets/library-guard'
import { assertAssetSize, MAX_ASSET_BYTES } from '../assets/sng-asset'
import { writeChartFile } from '../assets/write'
import type { JobProgress } from '../shared-types'

export interface VideoSearchResult {
  id: string
  title: string
  channel: string | null
  durationSeconds: number | null
  thumbnailUrl: string | null
}

/**
 * YouTube video id shape. Defense in depth: the id lands in a URL that becomes
 * a child-process argv entry, so reject anything that is not a plain id token.
 */
export const VIDEO_ID_RE = /^[\w-]{6,16}$/

/** Last few stderr lines, because yt-dlp puts the actionable message at the end. */
function stderrTail(stderr: string, maxLines = 5): string {
  return stderr.trim().split('\n').slice(-maxLines).join('\n')
}

/**
 * Search YouTube via yt-dlp's ytsearch pseudo-URL with --flat-playlist
 * (metadata only, one NDJSON line per hit, with no per-video page fetches).
 */
export function searchVideos(
  binPath: string,
  query: string,
  limit = 10
): Promise<VideoSearchResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, [
      `ytsearch${limit}:${query}`,
      '--dump-json',
      '--flat-playlist',
      '--no-warnings'
    ])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp search failed (exit ${code}): ${stderrTail(stderr)}`))
        return
      }
      resolve(parseSearchOutput(stdout))
    })
  })
}

/** Tolerant NDJSON parse: unparseable/id-less lines are dropped, fields default null-safe. */
function parseSearchOutput(stdout: string): VideoSearchResult[] {
  const results: VideoSearchResult[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof raw !== 'object' || raw === null) continue
    const obj = raw as Record<string, unknown>
    if (typeof obj.id !== 'string' || !obj.id) continue
    const thumbnails = Array.isArray(obj.thumbnails) ? obj.thumbnails : []
    const lastThumb = thumbnails.at(-1) as { url?: unknown } | undefined
    results.push({
      id: obj.id,
      title: typeof obj.title === 'string' ? obj.title : '',
      channel:
        typeof obj.channel === 'string'
          ? obj.channel
          : typeof obj.uploader === 'string'
            ? obj.uploader
            : null,
      durationSeconds: typeof obj.duration === 'number' ? Math.round(obj.duration) : null,
      thumbnailUrl:
        typeof lastThumb?.url === 'string'
          ? lastThumb.url
          : typeof obj.thumbnail === 'string'
            ? obj.thumbnail
            : null
    })
  }
  return results
}

const PROGRESS_RE = /^\[download\]\s+(\d+(?:\.\d+)?)%/

/**
 * yt-dlp's own refusal when `--max-filesize` is exceeded. Measured against yt-dlp 2026.08.19:
 * it prints this on STDOUT, once per stream it skipped, and then exits 0 having written
 * nothing, so the line is the only evidence that a "successful" run refused the video. The
 * first number is the size it read off the format.
 */
const MAX_FILESIZE_RE = /File is larger than max-filesize \((\d+) bytes > (\d+) bytes\)/

/**
 * The file yt-dlp actually produced for the `video.%(ext)s` template.
 *
 * The extension is not known in advance, because yt-dlp picks the container, so this globs instead
 * of assuming one. The single-dot shape also excludes what yt-dlp leaves around a download it did
 * not finish or merge: `video.webm.part` and per-format `video.f399.webm` fragments both carry a
 * second dot.
 */
const PRODUCED_VIDEO_RE = /^video\.[^.]+$/

type Report = (
  percent: number | null,
  status: JobProgress['status'],
  message: string | null
) => void

interface YtdlpRun {
  binPath: string
  videoId: string
  outDir: string
  /** Handed to yt-dlp as `--max-filesize` when set; omitted entirely when not. */
  maxBytes?: number
  report: Report
  signal: AbortSignal | undefined
}

/**
 * Run one yt-dlp download into `outDir`, reporting percent progress as it goes.
 *
 * Terminal events are deliberately NOT reported here. For a `.sng` the repack still has to run
 * after the child exits, and `done` is what re-enables the UI, so downloadVideo owns the
 * terminal event for both chart shapes.
 *
 * Resolves with the largest size yt-dlp refused for exceeding `--max-filesize`, if it refused
 * one. See MAX_FILESIZE_RE for why a caller cannot tell that case from a zero-exit success
 * any other way.
 */
function runYtdlp(run: YtdlpRun): Promise<{ overLimitBytes: number | null }> {
  return new Promise((resolve, reject) => {
    const args = [
      `https://www.youtube.com/watch?v=${run.videoId}`,
      '-f',
      'bv*[height<=1080]+ba/b[height<=1080]',
      '-o',
      join(run.outDir, 'video.%(ext)s'),
      '--newline',
      '--no-warnings'
    ]
    if (run.maxBytes !== undefined) args.push('--max-filesize', String(run.maxBytes))
    const child = spawn(run.binPath, args)
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      child.kill('SIGTERM')
    }
    run.signal?.addEventListener('abort', onAbort, { once: true })

    let stderr = ''
    let buffered = ''
    // Deduped integer percent (counter pattern shared with the download path).
    let lastPercent = -1
    let overLimitBytes: number | null = null
    const consume = (line: string): void => {
      const over = MAX_FILESIZE_RE.exec(line)
      if (over) {
        overLimitBytes = Math.max(overLimitBytes ?? 0, Number(over[1]))
        return
      }
      const match = PROGRESS_RE.exec(line)
      if (!match) return
      const percent = Math.min(100, Math.round(Number(match[1])))
      if (percent !== lastPercent) {
        lastPercent = percent
        run.report(percent, 'running', null)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) consume(line)
    })
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (err) => {
      run.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      run.signal?.removeEventListener('abort', onAbort)
      // stdout has ended by the time close fires, so whatever is still buffered is a final
      // line yt-dlp wrote without a trailing newline. The max-filesize notice is one of the
      // possibilities, and dropping it would cost the user the size in the error message.
      if (buffered) consume(buffered)
      if (aborted) reject(new Error('Video download aborted'))
      else if (code === 0) resolve({ overLimitBytes })
      else reject(new Error(`yt-dlp download failed (exit ${code}): ${stderrTail(stderr)}`))
    })
  })
}

export interface VideoDownloadOptions {
  /**
   * Override for the asset ceiling, used for `--max-filesize` and the post-download check. A
   * test seam: MAX_ASSET_BYTES is just under 2 GiB and no test can produce a file that size. It
   * does not weaken the writer, since writeSngAsset re-checks against the production ceiling.
   */
  maxAssetBytes?: number
}

/** Distinguishes concurrent staging dirs; see downloadIntoSng. */
let stagingCounter = 0

/**
 * Download a video into a chart as `video.<ext>`.
 *
 * For a folder chart yt-dlp writes directly into chartPath (no tmp+rename of ours): it stages
 * its own `.part` files and renames them itself on completion, so a killed or failed download
 * never leaves a half-written `video.*` behind. That is acceptable atomicity without
 * double-buffering multi-hundred-MB files. A `.sng` has no folder to write into, so it goes through
 * downloadIntoSng.
 *
 * `chartType` is passed in rather than inferred from the path, for the reason spelled out in
 * assets/write.ts: the scanner decides a chart's shape and sniffing the suffix here would be a
 * second opinion that can disagree with it.
 */
export function downloadVideo(
  binPath: string,
  videoId: string,
  chartPath: string,
  chartType: 'folder' | 'sng',
  onProgress: (p: JobProgress) => void,
  signal: AbortSignal | undefined,
  libraryFolders: { path: string }[],
  options: VideoDownloadOptions = {}
): Promise<void> {
  // Both guards run before any spawn: path containment and id shape.
  // Rejections (never sync throws) so callers get a uniform promise contract.
  try {
    assertUnderLibrary(chartPath, libraryFolders)
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)))
  }
  if (!VIDEO_ID_RE.test(videoId)) {
    return Promise.reject(new Error(`Invalid video id: ${JSON.stringify(videoId)}`))
  }
  if (signal?.aborted) {
    return Promise.reject(new Error('Video download aborted'))
  }

  const jobId = `video:${chartPath}`
  const report: Report = (percent, status, message): void =>
    onProgress({ jobId, kind: 'asset', phase: 'download', percent, message, status })

  const run = async (): Promise<void> => {
    if (chartType === 'sng') {
      await downloadIntoSng({
        binPath,
        videoId,
        sngPath: chartPath,
        report,
        signal,
        libraryFolders,
        maxAssetBytes: options.maxAssetBytes ?? MAX_ASSET_BYTES
      })
    } else {
      // Snapshotted before the spawn so a cancel can delete exactly what this run produced.
      // Nothing sweeps a chart folder, so yt-dlp's leftovers would otherwise sit there for
      // good; and the folder may already hold a video the user means to keep, which a cancel
      // must not cost them.
      const before = new Set(listNames(chartPath))
      try {
        await runYtdlp({ binPath, videoId, outDir: chartPath, report, signal })
      } catch (err) {
        // Only on cancel. A failed download keeps its leftovers, as it always has. The
        // difference is intent: a cancel is the user withdrawing the request, so nothing the
        // request created should outlive it.
        if (signal?.aborted) removeNewVideoFiles(chartPath, before)
        throw err
      }
    }
    report(100, 'done', null)
  }

  return run().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err))
    // Which terminal status this is comes from the signal, not the error: a SIGTERM'd child
    // rejects with a message about an abort, but so does anything else that happened to fail
    // while a cancel was in flight, and a user who asked for this should not be shown a failure.
    report(null, signal?.aborted ? 'canceled' : 'error', error.message)
    throw error
  })
}

/**
 * Directory listing that tolerates a missing directory.
 *
 * chartPath comes off a catalog row, which can name a folder the user has since deleted. The
 * download is about to fail with yt-dlp's own account of that; replacing it with an ENOENT
 * thrown by a listing taken speculatively, for a cancel that may never come, would be a worse
 * error message for the same outcome. An empty snapshot simply leaves nothing to clean up.
 */
function listNames(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Remove what a cancelled download added to a folder chart: the `.part` yt-dlp was still filling
 * and any per-format fragments it never merged.
 *
 * Scoped two ways so it cannot take a file the user wanted. Only names absent from the
 * pre-download snapshot, so a `video.mp4` the chart already had survives a cancelled attempt to
 * replace it; and only names yt-dlp's own `-o video.%(ext)s` template can produce, so whatever
 * else appeared in the folder meanwhile is not this function's business. Directories are
 * skipped, since `rmSync` without `recursive` cannot remove one and nothing yt-dlp writes here
 * is one.
 */
function removeNewVideoFiles(chartDir: string, before: Set<string>): void {
  try {
    for (const entry of readdirSync(chartDir, { withFileTypes: true })) {
      if (entry.isDirectory() || before.has(entry.name)) continue
      if (!entry.name.startsWith('video.')) continue
      rmSync(join(chartDir, entry.name), { force: true })
    }
  } catch (err) {
    // Logged, not thrown, for the reason the staging cleanup gives below: the caller is about
    // to be told why its download ended, and a failure to tidy up must not replace that. The
    // cost is a stray file in the chart folder.
    console.warn(`Could not clear the cancelled video download in ${chartDir}:`, err)
  }
}

/**
 * Chart paths with a per-chart download in flight → the controller that stops it.
 *
 * The batch queue keeps its AbortController inside the object that owns the job (assets/batch.ts):
 * one download at a time, and a `cancel()` method to hang it on. The per-chart path has neither.
 * Its two IPC calls arrive independently and share nothing but the chart path, which is already
 * this job's identity everywhere else as `video:<chartPath>`, so that is what this keys on.
 * Canonicalized for the reason the per-chart write lock canonicalizes (assets/write.ts): two
 * spellings of one chart must not become two entries, or the cancel misses the download.
 */
const perChartDownloads = new Map<string, AbortController>()

/**
 * downloadVideo for the per-chart UI path, with a cancel handle filed under the chart path.
 *
 * Kept separate from downloadVideo rather than folded into it because the batch has to keep
 * supplying its own signal: it cancels a run of charts, not the one chart a user is looking at,
 * and a download it started is not one the video button should be able to stop.
 */
export function downloadVideoForChart(
  binPath: string,
  videoId: string,
  chartPath: string,
  chartType: 'folder' | 'sng',
  onProgress: (p: JobProgress) => void,
  libraryFolders: { path: string }[],
  options: VideoDownloadOptions = {}
): Promise<void> {
  const key = canonicalize(chartPath)
  const controller = new AbortController()
  perChartDownloads.set(key, controller)
  return downloadVideo(
    binPath,
    videoId,
    chartPath,
    chartType,
    onProgress,
    controller.signal,
    libraryFolders,
    options
  ).finally(() => {
    // Only ever clear our own entry. A second download started on this chart has already
    // replaced it, and dropping that one would leave the newer download uncancellable.
    if (perChartDownloads.get(key) === controller) perChartDownloads.delete(key)
  })
}

/**
 * Stop the per-chart download running on `chartPath`.
 *
 * A no-op when there is none, which is the normal outcome of a cancel that lost the race to the
 * download's own end: the click and the last byte crossed, and the user gets the video.
 */
export function cancelChartVideoDownload(chartPath: string): void {
  perChartDownloads.get(canonicalize(chartPath))?.abort()
}

/** Test seam: how many charts have a cancellable download in flight. Production code never asks. */
export function pendingVideoDownloadCount(): number {
  return perChartDownloads.size
}

/**
 * Download into a staging directory beside the archive, then repack it in.
 *
 * yt-dlp cannot write into an archive, so the bytes have to land somewhere real first.
 * Staging goes in the chart's OWN directory rather than the app's tmp dir for two reasons. It
 * is on the same filesystem by construction. os.tmpdir() is a tmpfs on many Linux systems,
 * and staging a several-hundred-MB video in RAM in front of a repack that already peaks at
 * gigabytes is the worst available place to put it, quite apart from the cross-device copy
 * the download pipeline already had to design around (see ENCORE_TMP_DIR). And it is inside a
 * library folder the user has already granted, so it needs no write access the app does not
 * already have. The directory is named ENCORE_TMP_DIR because the scanner skips that name
 * (catalog/scanner.ts), so a scan that runs mid-download does not walk into it at all.
 *
 * The per-download subdirectory is removed on every exit path, including cancel and failure.
 * The shared ENCORE_TMP_DIR is NOT removed, because the download queue keeps resumable `.part`
 * files in it, so an empty directory can survive a download into a library root. What survives a
 * hard kill is the staged file itself: no `finally` runs, and the startup sweep only visits
 * ENCORE_TMP_DIR at library ROOTS, so a chart in a subfolder can leak one until the user
 * deletes it. Same exposure the download queue's own `.part` files carry.
 */
async function downloadIntoSng(job: {
  binPath: string
  videoId: string
  sngPath: string
  report: Report
  signal: AbortSignal | undefined
  libraryFolders: { path: string }[]
  maxAssetBytes: number
}): Promise<void> {
  // The budget is the ceiling itself, with nothing subtracted for the archive. It used to be
  // `ceiling - archiveSize`, because the repack held both in memory at once; a streaming repack
  // holds only the video, so the archive's size buys the video no less room. That arithmetic was
  // also what left the reference library's largest chart 120.8 MiB for a video.
  const { sngPath, maxAssetBytes } = job

  const stagingDir = join(
    dirname(sngPath),
    ENCORE_TMP_DIR,
    `video-${process.pid}-${stagingCounter++}`
  )
  // Derived from the chart path the guard above already cleared, so it cannot point outside
  // the library. Checked anyway: it costs one call, and it means a later edit to the path
  // above cannot quietly turn into a write outside the library.
  assertUnderLibrary(stagingDir, job.libraryFolders)
  mkdirSync(stagingDir, { recursive: true })
  try {
    // --max-filesize is the pre-check: yt-dlp knows a format's size the moment it picks one,
    // so it can refuse before transferring 500 MB the repack would then have to reject. It is
    // advisory only: measured against 2026.08.19 it compares per stream rather than against
    // the merged result, and it can only act on a size the chosen format actually reports.
    // (The figure cannot come from the search results instead: searchVideos runs
    // --flat-playlist, whose JSON carries no filesize or filesize_approx field at all.)
    const { overLimitBytes } = await runYtdlp({
      binPath: job.binPath,
      videoId: job.videoId,
      outDir: stagingDir,
      maxBytes: maxAssetBytes,
      report: job.report,
      signal: job.signal
    })
    const produced = findProducedVideo(stagingDir)
    if (!produced) {
      throw new Error(
        overLimitBytes !== null
          ? `Video is too large to write into a chart: yt-dlp reported ${overLimitBytes} bytes, over the ${maxAssetBytes} byte limit`
          : 'yt-dlp exited successfully but produced no video file'
      )
    }
    // The decisive check: the size of the file that actually landed, not the one a format
    // advertised. Before the read, so an oversized video is refused without first being pulled
    // into memory.
    assertAssetSize(basename(produced), statSync(produced).size, maxAssetBytes)
    // A repack of a large chart runs for seconds. Keeping the job 'running' with a message of
    // its own stops the UI from reporting the video saved while the archive is still being
    // rebuilt.
    job.report(100, 'running', 'Packing into the archive')
    // A cancel is not acted on from here on. writeChartFile takes no signal, and nothing between
    // the download and it yields to the event loop. The child's `close` handler resolves
    // runYtdlp and everything from there to the call below is sync work and microtasks, so an
    // abort delivered by an IPC message cannot land in that gap. It can land INSIDE the call:
    // writeChartFile queues behind any other write on this chart, which for a chart the batch is
    // rebuilding is seconds. Neither case is a risk to the chart, and that is the M6 repack
    // design rather than luck: the archive is rebuilt into a uniquely named temp beside it,
    // that temp is read back and verified, and only then is it renamed over the original
    // (sng-asset.ts). The original survives until an atomic rename on every path, so no cancel
    // can leave a damaged chart; the worst it can do is get the user the video a moment after
    // they asked to stop.
    // The entry takes the produced file's own name, so a chart gets video.webm or video.mp4
    // exactly as Clone Hero expects to find it. An older video entry under a DIFFERENT name
    // stays in the archive, which is the same thing that happens when yt-dlp writes video.webm
    // next to an existing video.mp4 in a folder chart.
    await writeChartFile(
      sngPath,
      'sng',
      basename(produced),
      readFileSync(produced),
      job.libraryFolders
    )
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      // Cleanup must not replace the reason the download failed. `force` already swallows a
      // missing directory; what is left is the likes of a read-only parent, where throwing
      // from a finally would discard the original error and leave the caller debugging the
      // wrong failure. The chart is untouched either way; the cost is a stray staging file.
    }
  }
}

function findProducedVideo(dir: string): string | null {
  const names = readdirSync(dir)
    .filter((name) => PRODUCED_VIDEO_RE.test(name))
    .sort()
  return names.length > 0 ? join(dir, names[0]) : null
}
