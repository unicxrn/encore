import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ffmpegExeName, invalidateFfmpegLocation } from '../ffmpeg/locate'
import type { JobProgress } from '../shared-types'
import { extractZipEntry } from './unzip'

export type SidecarName = 'ytdlp' | 'ffmpeg'

/**
 * How a download's bytes are authenticated before anything is installed.
 *
 * `pinned` is the strong form and the one to prefer: the URL names an immutable release asset and
 * the hash lives in our source, so a compromised upstream cannot silently swap the binary.
 *
 * `manifest` is for an artifact behind a floating "latest" URL, where a pin is impossible,
 * because it would break on the publisher's next release. It reads the `<sha256>  <name>`
 * checksum file the release publishes beside the asset. That is weaker, because the same origin
 * serves both and a compromise could rewrite them together; it is still a strict improvement on
 * Content-Length, which passes any substitution that happens to be the same length.
 */
export type SidecarChecksum =
  { kind: 'pinned'; sha256: string } | { kind: 'manifest'; url: string; assetName: string }

export interface SidecarSource {
  url: string
  /** Name the runnable binary lands at inside `dir` (for an archive, the *extracted* name). */
  fileName: string
  checksum: SidecarChecksum
  /** Set when the download is a zip: the entry to extract. Absent means the URL is the binary. */
  archiveEntry?: string
}

export interface SidecarManagerConfig {
  /** Directory the binaries live in (production: `userData/sidecars`). */
  dir: string
  sources: Record<SidecarName, SidecarSource>
  /** Defaults to process.platform; injectable so tests pin behavior. */
  platform?: NodeJS.Platform
}

export interface SidecarStatus {
  installed: boolean
  version: string | null
  path: string
}

const YTDLP_LATEST = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

/**
 * ffmpeg version, pinned. The hashes below are hashes *of this version's* archives, so the two
 * move together. Bumping the version without recomputing the hashes makes ffmpeg uninstallable.
 */
const FFMPEG_VERSION = '6.1'
const FFBINARIES = `https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v${FFMPEG_VERSION}`

/**
 * SHA-256 of each ffbinaries archive, computed by downloading it. ffbinaries publishes no
 * checksums of its own, so pinning here is the only thing standing between a swapped upstream
 * asset and an executable we run on the user's machine.
 */
const FFMPEG_ZIP_SHA256: Record<'win' | 'macos' | 'linux', string> = {
  win: 'b0fb4bcef9d4b5f7a77d2e4854f80d4ce3e43809bc29fd1f97caa1b467f96993',
  macos: 'ffcd56ce5ef50c4d36d675b0ee80674f5a0869f94746460ff5d058a33cbd3128',
  linux: '8bb4a27f5fd02f3dd9a5e75c9eddf6ace1d50a08929ee0d20bbf17eb467fb711'
}

/**
 * Default download sources.
 *
 * yt-dlp: official GitHub release assets. The `releases/latest/download/<asset>` URL is a stable
 * redirect GitHub maintains to the newest release, so no API call or version pinning is needed,
 * and yt-dlp keeps these asset names constant. Because the URL floats, its hash cannot be pinned;
 * the release's own `SHA2-256SUMS` is used instead (see `SidecarChecksum`).
 *
 * ffmpeg: ffbinaries, which publishes a **zip on every platform**. That is what makes this
 * installable at all: the previous source (BtbN) shipped `.tar.xz` on Linux, and Node has no xz
 * decompression, whereas zip entries are raw Deflate that `node:zlib` already handles. Each
 * archive holds a single entry, the binary itself, at the same name it must run under.
 *
 * `fileName` is `ffmpegExeName()` rather than the archive's name, and comes from `locate.ts` on
 * purpose: that module looks for the managed copy at exactly `join(sidecarDir, ffmpegExeName())`.
 * Naming it here independently is how a successful install would still read as "not installed".
 */
export function defaultSidecarSources(
  platform: NodeJS.Platform = process.platform
): Record<SidecarName, SidecarSource> {
  const win = platform === 'win32'
  const ytdlpAsset = win ? 'yt-dlp.exe' : platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp'
  const ffmpegExe = ffmpegExeName(platform)
  const ffmpegArch = win ? 'win-64' : platform === 'darwin' ? 'macos-64' : 'linux-64'
  const ffmpegKey = win ? 'win' : platform === 'darwin' ? 'macos' : 'linux'
  return {
    ytdlp: {
      url: `${YTDLP_LATEST}/${ytdlpAsset}`,
      // The macOS asset is `yt-dlp_macos` upstream but installs under the plain name, so
      // everything downstream can spawn one path regardless of platform.
      fileName: win ? 'yt-dlp.exe' : 'yt-dlp',
      checksum: {
        kind: 'manifest',
        url: `${YTDLP_LATEST}/SHA2-256SUMS`,
        assetName: ytdlpAsset
      }
    },
    ffmpeg: {
      url: `${FFBINARIES}/ffmpeg-${FFMPEG_VERSION}-${ffmpegArch}.zip`,
      fileName: ffmpegExe,
      archiveEntry: ffmpegExe,
      checksum: { kind: 'pinned', sha256: FFMPEG_ZIP_SHA256[ffmpegKey] }
    }
  }
}

export class SidecarManager {
  private readonly platform: NodeJS.Platform

  constructor(private config: SidecarManagerConfig) {
    this.platform = config.platform ?? process.platform
  }

  binPath(name: SidecarName): string {
    return join(this.config.dir, this.config.sources[name].fileName)
  }

  async status(name: SidecarName): Promise<SidecarStatus> {
    const path = this.binPath(name)
    if (!existsSync(path)) return { installed: false, version: null, path }
    return { installed: true, version: await readVersion(path, VERSION_ARGS[name]), path }
  }

  async install(name: SidecarName, onProgress: (p: JobProgress) => void): Promise<void> {
    const jobId = `sidecar:${name}`
    const report = (
      percent: number | null,
      status: JobProgress['status'],
      message: string | null
    ): void => onProgress({ jobId, kind: 'asset', phase: 'download', percent, message, status })

    const source = this.config.sources[name]
    const { url } = source
    const finalPath = this.binPath(name)
    mkdirSync(this.config.dir, { recursive: true })
    const partPath = `${finalPath}.part`
    // Where an extracted binary is staged. `.part` holds the archive, so the binary it yields
    // needs a name of its own before either can take the final path.
    const stagedPath = `${finalPath}.staged`
    try {
      report(0, 'running', null)
      const response = await fetch(url)
      if (!response.ok || !response.body) {
        throw new Error(`Sidecar download failed: HTTP ${response.status}`)
      }
      const contentLength = Number(response.headers.get('content-length')) || null
      let received = 0
      let lastPercent = 0
      const counter = async function* (
        source: AsyncIterable<Uint8Array>
      ): AsyncGenerator<Uint8Array> {
        for await (const chunk of source) {
          received += chunk.length
          if (contentLength) {
            const percent = Math.min(100, Math.round((received / contentLength) * 100))
            if (percent !== lastPercent) {
              lastPercent = percent
              report(percent, 'running', null)
            }
          }
          yield chunk
        }
      }
      await pipeline(
        counter(Readable.fromWeb(response.body as import('stream/web').ReadableStream<Uint8Array>)),
        createWriteStream(partPath)
      )
      // The stream can end cleanly short of Content-Length (or long, if the
      // server lied). A size mismatch means a corrupt binary, so reject it.
      if (contentLength !== null && received !== contentLength) {
        throw new Error(`Sidecar download truncated: got ${received} of ${contentLength} bytes`)
      }

      // Length only proves nothing was dropped in transit; the hash proves these are the bytes
      // we meant to run. Both checks precede anything that touches the final path.
      report(100, 'running', 'Verifying download')
      const expected = (await expectedSha256(source.checksum)).toLowerCase()
      const actual = await sha256File(partPath)
      if (actual !== expected) {
        throw new Error(`Sidecar checksum mismatch: expected ${expected}, got ${actual}`)
      }

      // Extraction sits before the rename, never after: a failed unzip must not be able to leave
      // anything at the final path, because the next run would find it and believe it.
      let installFrom = partPath
      if (source.archiveEntry) {
        report(100, 'running', 'Extracting')
        await extractZipEntry(partPath, source.archiveEntry, stagedPath)
        // The archive has served its purpose. Drop it now rather than leaving 55 MB of zip
        // sitting in the sidecar directory for the life of the install.
        rmSync(partPath, { force: true })
        installFrom = stagedPath
      }

      if (this.platform !== 'win32') chmodSync(installFrom, 0o755)
      renameSync(installFrom, finalPath)
    } catch (err) {
      // Unlike chart downloads there is no resume: a partial binary is useless.
      rmSync(partPath, { force: true })
      rmSync(stagedPath, { force: true })
      report(null, 'error', err instanceof Error ? err.message : String(err))
      throw err
    }
    // locateFfmpeg caches its answer for the life of the process, so without this the binary we
    // just installed stays invisible until the app is restarted.
    if (name === 'ffmpeg') invalidateFfmpegLocation()
    report(100, 'done', finalPath)
  }

  async update(name: SidecarName, onProgress: (p: JobProgress) => void = () => {}): Promise<void> {
    if (name === 'ytdlp') {
      // yt-dlp updates itself in place via its -U flag. -U emits no parseable
      // percent, so progress is a running/terminal pair, which is enough for the
      // UI to disable the button while it runs and refresh status when it lands.
      const report = (
        percent: number | null,
        status: JobProgress['status'],
        message: string | null
      ): void =>
        onProgress({
          jobId: `sidecar:${name}`,
          kind: 'asset',
          phase: 'update',
          percent,
          message,
          status
        })
      report(null, 'running', null)
      try {
        await runExpectingExitZero(this.binPath(name), ['-U'])
      } catch (err) {
        // Matches install's error contract: report, then rethrow.
        report(null, 'error', err instanceof Error ? err.message : String(err))
        throw err
      }
      report(100, 'done', null)
      return
    }
    // ffmpeg has no self-update: re-download the latest build.
    await this.install(name, onProgress)
  }
}

/** SHA-256 of a file on disk, lowercase hex. Streamed, because these files reach 130 MB. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** One line of a `sha256sum` manifest: the digest, whitespace, then the file name. */
const SUMS_LINE_RE = /^([0-9a-f]{64})\s+\*?(\S+)$/i

async function expectedSha256(checksum: SidecarChecksum): Promise<string> {
  if (checksum.kind === 'pinned') return checksum.sha256
  const response = await fetch(checksum.url)
  if (!response.ok) {
    throw new Error(`Sidecar checksum download failed: HTTP ${response.status}`)
  }
  const manifest = await response.text()
  for (const line of manifest.split('\n')) {
    const match = SUMS_LINE_RE.exec(line.trim())
    if (match && match[2] === checksum.assetName) return match[1]
  }
  // Also the shape a release published between the two fetches takes, since the asset and the
  // manifest are separate `latest` redirects. Retrying resolves both to the same release.
  throw new Error(`Sidecar checksum manifest has no entry for ${checksum.assetName}`)
}

/**
 * How to ask each sidecar its version. The two disagree, and a shared flag cannot serve both.
 *
 * Measured, on ffmpeg n9.0.1 and yt-dlp 2026.08.19:
 *
 *   yt-dlp --version   exit 0, stdout "2026.08.19"
 *   yt-dlp -version    exit 2
 *   ffmpeg  -version   exit 0, stdout "ffmpeg version n9.0.1 Copyright (c) …"
 *   ffmpeg  --version  exit 8, stdout EMPTY, stderr "Unrecognized option '-version'.
 *                      Error splitting the argument list: Option not found"
 *
 * ffmpeg strips one leading dash before looking an option up, so `--version` arrives as the
 * unknown `-version` and the run aborts. That failed this probe twice over (a non-zero exit and
 * nothing on stdout), so an ffmpeg that was installed and working reported `version: null`
 * forever, which reads in the UI as a broken install.
 *
 * The banner ffmpeg prints on stderr under `--version` is not a version response; ffmpeg prints
 * that on every startup unless given -hide_banner. Reading stderr instead of fixing the flag would
 * have looked like it worked and reported the wrong thing on a genuine failure.
 */
const VERSION_ARGS: Record<SidecarName, readonly string[]> = {
  ytdlp: ['--version'],
  ffmpeg: ['-version']
}

/** First line of the binary's version output on stdout, or null when the spawn or exit fails. */
// TODO(sidecars): no spawn timeout, so a pathological binary can hang status indefinitely.
function readVersion(binPath: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // stderr is discarded rather than piped-and-ignored. ffmpeg writes its ~1.7 KB startup banner
    // there on every invocation, and an unread pipe stops being free once a binary exceeds the
    // 64 KB buffer: the child blocks on write, never exits, and this promise never settles.
    const child = spawn(binPath, [...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const firstLine = out.split('\n')[0]?.trim()
      resolve(code === 0 && firstLine ? firstLine : null)
    })
  })
}

// TODO(sidecars): no spawn timeout, so yt-dlp -U on a slow network can hang update
// indefinitely.
function runExpectingExitZero(binPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args)
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(`${binPath} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`)
        )
    })
  })
}
