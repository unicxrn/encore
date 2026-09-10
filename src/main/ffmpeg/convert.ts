import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * One video file in, one WebM out. This module has never heard of a chart, an archive or an
 * issue row: it takes an ffmpeg it is handed, a source path and a destination path.
 */

/** The subset of a spawned child this module uses; the seam unit tests replace. */
export interface SpawnedProcess {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

export type SpawnFn = (command: string, args: string[]) => SpawnedProcess

export interface ConvertDeps {
  /** Injected so the argument vector can be asserted without encoding anything. */
  spawn?: SpawnFn
}

export interface ConvertOptions {
  ffmpegPath: string
  input: string
  output: string
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/**
 * Floor for the derived target bitrate.
 *
 * The bitrate is taken from the source (see `convertToWebm`), but a source that under-reports
 * (or genuinely is 90 kb/s because someone re-encoded it into the ground) would otherwise be
 * handed straight to libvpx and come back as mush. The working backgrounds in the reference
 * library sit around 1 Mb/s, so half of that is a floor that can only ever improve a file.
 */
export const MIN_VIDEO_BITRATE = 500_000

/**
 * Constant-quality level, paired with `-b:v` as a cap.
 *
 * Measured on a real 1280x720 / 200.9 s / 26,023,029-byte chart video: `-crf 24 -b:v 900k`
 * produced 25,582,162 bytes in 34 s and `-crf 26 -b:v 800k` produced 24,576,654 bytes in 35 s,
 * which is parity with the source either way. 24 is the better-looking of the two, and the cap
 * now comes from the source's own bitrate rather than a guess.
 */
const CRF = '24'

/** ffmpeg reports `out_time_us` in microseconds. */
const US_PER_SECOND = 1_000_000

/**
 * Convert a video to WebM: VP8 video, Vorbis audio.
 *
 * **VP8 and Vorbis, not VP9 and Opus. Do not "modernise" this.** Every background video known to
 * play in the reference Clone Hero library is VP8: three folder charts and the `.webm` entries
 * inside `.sng` archives, five samples, Vorbis wherever there is audio. VP9+Opus is the modern
 * default and is what any tutorial recommends, but a VP9 file is one scan-chart accepts and Clone
 * Hero does not play: the issue row disappears and the background stays black. A silent failure,
 * strictly worse than the loud one this fix exists to clear. Changing the codec pair requires new
 * evidence from the game, not from a codec comparison.
 *
 * `-map 0:v:0 -map 0:a:0` is likewise required rather than tidy. The real chart videos carry an
 * embedded PNG cover as a third stream (`codec_type` "video", `attached_pic` set), which
 * ffmpeg's default stream selection would mux into the WebM and break it. Verified on
 * Yellowcard - Ocean Avenue, whose `video.mp4` has exactly that shape.
 *
 * The target bitrate is derived from the source, never fixed. Measured on that same file, VP9 at
 * CRF 32 produced 53,966,400 bytes, 2.07x the source. These sources are around 1 Mb/s and any
 * fixed quality level inflates them; targeting the source's own video bitrate lands at parity.
 */
export async function convertToWebm(opts: ConvertOptions, deps: ConvertDeps = {}): Promise<void> {
  const spawn: SpawnFn = deps.spawn ?? ((command, args) => nodeSpawn(command, args))

  if (opts.signal?.aborted) throw new Error('Video conversion canceled')
  // Checked before the probe so a missing file reads as a missing file, rather than as
  // whatever ffprobe says about one.
  if (!existsSync(opts.input)) throw new Error(`No such video to convert: ${opts.input}`)

  const source = await probeSource(spawn, opts.ffmpegPath, opts.input)
  if (opts.signal?.aborted) throw new Error('Video conversion canceled')

  const bitrateK = Math.round(Math.max(source.videoBitrate, MIN_VIDEO_BITRATE) / 1000)
  const args = [
    // Global options, all of which have to precede -i.
    '-hide_banner',
    // Without this ffmpeg reads the inherited stdin and can consume the parent's, which in a
    // packaged app means swallowing input that was never meant for it.
    '-nostdin',
    // The stats ffmpeg writes to stderr are the human version of what -progress already gives
    // us on stdout, and stderr is what a failure gets reported with.
    '-nostats',
    '-loglevel',
    'error',
    // The caller owns the destination path; without -y ffmpeg stops and waits for an answer
    // nobody is there to give.
    '-y',
    '-progress',
    'pipe:1',
    '-i',
    opts.input,
    '-map',
    '0:v:0'
  ]
  if (source.hasAudio) args.push('-map', '0:a:0')
  args.push('-c:v', 'libvpx', '-crf', CRF, '-b:v', `${bitrateK}k`)
  if (source.hasAudio) args.push('-c:a', 'libvorbis')
  // Explicit, because the destination is often a temp file whose extension is not .webm.
  args.push('-f', 'webm', opts.output)

  try {
    await runFfmpeg(spawn, opts, args, source.durationSeconds)
  } catch (err) {
    // Whatever we half-wrote is worthless, and `-y` means the caller had already ceded this
    // path to us. Leaving a truncated WebM behind would leave a file that looks like a
    // finished conversion to anything that only checks for existence.
    await rm(opts.output, { force: true }).catch(() => {})
    throw err
  }
}

/** Runs the encode, resolving on a clean exit. */
function runFfmpeg(
  spawn: SpawnFn,
  opts: ConvertOptions,
  args: string[],
  durationSeconds: number | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.ffmpegPath, args)

    let cancelled = false
    const onAbort = (): void => {
      cancelled = true
      child.kill('SIGTERM')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (): void => opts.signal?.removeEventListener('abort', onAbort)

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

    if (durationSeconds !== null && opts.onProgress) {
      readProgress(child, durationSeconds, opts.onProgress)
    }

    child.on('error', (err: Error) => {
      done()
      reject(new Error(`Could not run ffmpeg (${opts.ffmpegPath}): ${err.message}`))
    })
    // The unlink is the caller's, and it waits for this event: killing the child does not stop
    // it instantly, and deleting the output from under a process still writing to it would
    // leave the bytes on an unlinked descriptor rather than removing them.
    child.on('close', (code: number | null) => {
      done()
      if (cancelled) reject(new Error('Video conversion canceled'))
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg failed (exit ${code}): ${tail(stderr)}`))
    })
  })
}

/**
 * Turn `-progress pipe:1` into a 0..1 fraction.
 *
 * That option exists precisely so this does not have to read stderr, whose layout ffmpeg has
 * never promised to keep and which carries no separator a parser could rely on. `-progress`
 * emits plain `key=value` lines terminated by `progress=continue` or `progress=end`.
 */
function readProgress(
  child: SpawnedProcess,
  durationSeconds: number,
  onProgress: (fraction: number) => void
): void {
  let buffered = ''
  // ffmpeg emits a block twice a second by default; a caller forwarding these to the renderer
  // does not need four decimal places of a percent it rounds anyway.
  let lastPercent = -1
  child.stdout?.on('data', (chunk: Buffer) => {
    buffered += chunk.toString()
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('out_time_us=')) continue
      const us = Number(line.slice('out_time_us='.length).trim())
      // ffmpeg writes `N/A` before the first frame lands.
      if (!Number.isFinite(us) || us < 0) continue
      // The last block can run a frame or two past the probed duration.
      const fraction = Math.min(1, us / US_PER_SECOND / durationSeconds)
      const percent = Math.round(fraction * 100)
      if (percent === lastPercent) continue
      lastPercent = percent
      onProgress(percent / 100)
    }
  })
}

interface SourceInfo {
  /** Bits per second to target for the output video. */
  videoBitrate: number
  hasAudio: boolean
  /** Null when nothing reported one, which only costs progress reporting. */
  durationSeconds: number | null
}

/**
 * What ffprobe would be given a path next to `ffmpegPath`, or null if the name gives no hint.
 *
 * A binary the user renamed is not one whose sibling can be guessed, and running ffmpeg itself
 * with ffprobe's arguments would fail in a way that reads like a broken install.
 */
function siblingFfprobe(ffmpegPath: string): string | null {
  const name = basename(ffmpegPath)
  const probeName = name.replace(/ffmpeg/i, 'ffprobe')
  if (probeName === name) return null
  return join(dirname(ffmpegPath), probeName)
}

/**
 * Read the source's duration, video bitrate and whether it has audio.
 *
 * ffprobe first, because its JSON is exact and machine-readable. It is not guaranteed to be
 * there: the managed ffmpeg is a single downloaded binary with no ffprobe beside it, so a
 * missing ffprobe has to degrade rather than fail, and the fallback reads the stream dump
 * `ffmpeg -i` writes for any input. That dump is only parsed when there is no better option,
 * because it interleaves the file's own metadata, which is arbitrary user text.
 */
async function probeSource(spawn: SpawnFn, ffmpegPath: string, input: string): Promise<SourceInfo> {
  const probePath = siblingFfprobe(ffmpegPath)
  if (probePath) {
    const probe = await run(spawn, probePath, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      input
    ])
    if (probe.code === 0) {
      const parsed = parseProbeJson(probe.stdout)
      if (parsed) return parsed
    }
  }

  const dump = await run(spawn, ffmpegPath, ['-hide_banner', '-i', input])
  // Separated from a probe that ran and disliked the file, because the two need different
  // things done about them: a path that no longer resolves is a broken install, not a bad video.
  if (dump.spawnError) throw new Error(`Could not run ffmpeg (${ffmpegPath}): ${dump.stderr}`)
  // `ffmpeg -i` with no output file always exits non-zero ("At least one output file must be
  // specified"), so the exit code says nothing; the stream dump is what matters.
  const parsed = parseFfmpegDump(dump.stderr)
  if (!parsed) throw new Error(`Could not read the video ${input}: ${tail(dump.stderr)}`)
  return parsed
}

interface ProbeStream {
  codec_type?: string
  bit_rate?: string
  disposition?: { attached_pic?: number }
}

/** ffprobe's JSON, reduced to the three facts the encode depends on. */
function parseProbeJson(stdout: string): SourceInfo | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const doc = raw as { streams?: unknown; format?: unknown }
  const streams: ProbeStream[] = Array.isArray(doc.streams) ? (doc.streams as ProbeStream[]) : []
  const format = (typeof doc.format === 'object' && doc.format !== null ? doc.format : {}) as {
    duration?: string
    bit_rate?: string
    size?: string
  }

  // Cover art is codec_type "video" too, which is why this cannot be "the video stream".
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video) throw new Error('That file has no video stream to convert.')
  const audio = streams.find((s) => s.codec_type === 'audio')

  const durationSeconds = positive(Number(format.duration))
  const audioBitrate = positive(Number(audio?.bit_rate)) ?? 0
  const containerBitrate =
    positive(Number(format.bit_rate)) ??
    (durationSeconds !== null && positive(Number(format.size)) !== null
      ? (Number(format.size) * 8) / durationSeconds
      : null)
  const videoBitrate =
    positive(Number(video.bit_rate)) ??
    // A container that reports its own bitrate but not the stream's: the audio's share is
    // known, so subtracting it is closer than handing the whole file's rate to the video.
    (containerBitrate !== null ? Math.max(containerBitrate - audioBitrate, 1) : null)
  if (videoBitrate === null) return null

  return { videoBitrate, hasAudio: audio !== undefined, durationSeconds }
}

/** `  Duration: 00:03:20.92, start: 0.000000, bitrate: 1036 kb/s` */
const DUMP_DURATION_RE = /^Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/
/** `  Stream #0:0[0x1](und): Video: h264 (avc1), yuv420p, 1280x720, 853 kb/s, 25 fps` */
const DUMP_STREAM_RE = /^Stream #0:\d+[^:]*:\s*(Video|Audio):\s*(.*)$/
const DUMP_STREAM_BITRATE_RE = /(\d+) kb\/s/

/**
 * The fallback parse of `ffmpeg -i`'s stream dump, used only when there is no ffprobe.
 *
 * Every pattern is anchored to the start of the trimmed line. That is what keeps the file's own
 * metadata out of the result: ffmpeg indents continuation lines of a multi-line tag with spaces
 * and a leading `:`, so a video description quoting "Duration:" or "Stream #0:0" cannot match.
 */
function parseFfmpegDump(stderr: string): SourceInfo | null {
  let durationSeconds: number | null = null
  let videoBitrate: number | null = null
  let containerBitrate: number | null = null
  let audioBitrate = 0
  let hasVideo = false
  let hasAudio = false

  for (const raw of stderr.split('\n')) {
    const line = raw.trim()
    const duration = DUMP_DURATION_RE.exec(line)
    if (duration) {
      durationSeconds =
        Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) || null
      const overall = /bitrate:\s*(\d+) kb\/s/.exec(line)
      if (overall) containerBitrate = Number(overall[1]) * 1000
      continue
    }
    const stream = DUMP_STREAM_RE.exec(line)
    if (!stream) continue
    const rate = DUMP_STREAM_BITRATE_RE.exec(stream[2])
    if (stream[1] === 'Video') {
      // Cover art, again: it is dumped as a Video stream and carries no bitrate.
      if (stream[2].includes('(attached pic)')) continue
      if (!hasVideo) {
        hasVideo = true
        videoBitrate = rate ? Number(rate[1]) * 1000 : null
      }
    } else if (!hasAudio) {
      hasAudio = true
      if (rate) audioBitrate = Number(rate[1]) * 1000
    }
  }

  if (!hasVideo) {
    // Distinguished from an unreadable file: this one parsed, it just has nothing to convert.
    if (hasAudio || durationSeconds !== null) {
      throw new Error('That file has no video stream to convert.')
    }
    return null
  }
  if (videoBitrate === null) {
    if (containerBitrate === null) return null
    videoBitrate = Math.max(containerBitrate - audioBitrate, 1)
  }
  return { videoBitrate, hasAudio, durationSeconds }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** The binary never started. `stderr` then holds the spawn error, not the child's output. */
  spawnError: boolean
}

/** Collects a short-lived child's output; never used for the encode, which streams. */
function run(spawn: SpawnFn, command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    // Resolves rather than rejects: a failed ffprobe is the expected case on a managed install,
    // and turning it into an exception here would make the fallback read like error recovery
    // instead of the ordinary second choice it is. probeSource decides what is fatal.
    child.on('error', (err: Error) =>
      resolve({ code: null, stdout, stderr: err.message, spawnError: true })
    )
    child.on('close', (code: number | null) => resolve({ code, stdout, stderr, spawnError: false }))
  })
}

function positive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Last few lines: ffmpeg puts the actionable message at the end, as yt-dlp does. */
function tail(stderr: string, maxLines = 5): string {
  return stderr.trim().split('\n').slice(-maxLines).join('\n')
}
