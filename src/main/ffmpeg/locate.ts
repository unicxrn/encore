import { spawn } from 'node:child_process'
import { join } from 'node:path'

export type FfmpegLocation =
  | { ok: true; path: string; source: 'path' | 'managed' }
  | { ok: false; reason: 'not-installed' | 'missing-encoders' }

/** Runs `<bin> -encoders` and returns its stdout, or null when the binary is absent or fails. */
export type FfmpegProbe = (binPath: string) => Promise<string | null>

export interface LocateFfmpegOptions {
  /** Directory the managed copy lives in (production: `userData/sidecars`). */
  sidecarDir: string
  /** Defaults to a real spawn; injectable so tests never start a process. */
  probe?: FfmpegProbe
  /** Defaults to process.platform; injectable so tests pin the executable name. */
  platform?: NodeJS.Platform
}

/** The encoders a WebM conversion needs. VP8 + Vorbis, not VP9 + Opus (see the M14 design). */
const REQUIRED_ENCODERS = ['libvpx', 'libvorbis']

/**
 * `-encoders` prints `<flags> <name> <description>`, and the descriptions repeat the library
 * name: the libvpx-vp9 row reads "libvpx VP9". Searching the whole listing for "libvpx" would
 * therefore accept a VP9-only build, which produces a file Clone Hero will not play. Match the
 * name column instead.
 */
function hasEncoder(listing: string, name: string): boolean {
  return new RegExp(String.raw`^\s*\S+\s+${name}\s`, 'm').test(listing)
}

export function ffmpegExeName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

let cached: Promise<FfmpegLocation> | null = null

/**
 * Finds an ffmpeg that can actually do the conversion: PATH first, then the managed sidecar copy.
 * A binary without the encoders we need is not a usable ffmpeg, so a candidate that runs but
 * cannot encode VP8/Vorbis is skipped rather than returned, because failing that check
 * mid-conversion would cost the user minutes of encoding first.
 *
 * The result is cached for the life of the process; call `invalidateFfmpegLocation()` after
 * installing a managed copy so it becomes visible without an app restart.
 */
export function locateFfmpeg(options: LocateFfmpegOptions): Promise<FfmpegLocation> {
  // Cache the promise, not the value, so concurrent callers share one round of spawns. A
  // rejected probe is dropped so a transient spawn failure does not stick for the whole session.
  cached ??= probeCandidates(options).catch((err) => {
    cached = null
    throw err
  })
  return cached
}

export function invalidateFfmpegLocation(): void {
  cached = null
}

async function probeCandidates(options: LocateFfmpegOptions): Promise<FfmpegLocation> {
  const { sidecarDir, probe = spawnProbe, platform = process.platform } = options
  const exe = ffmpegExeName(platform)
  // A bare name is enough for PATH: spawn resolves it the same way `which` would, in one call
  // instead of two, and tells us apart "no such binary" from "ran but lacks encoders".
  const candidates = [
    { path: exe, source: 'path' as const },
    { path: join(sidecarDir, exe), source: 'managed' as const }
  ]

  let sawUnusable = false
  for (const candidate of candidates) {
    const listing = await probe(candidate.path)
    if (listing === null) continue
    if (REQUIRED_ENCODERS.every((name) => hasEncoder(listing, name))) {
      return { ok: true, path: candidate.path, source: candidate.source }
    }
    sawUnusable = true
  }
  return { ok: false, reason: sawUnusable ? 'missing-encoders' : 'not-installed' }
}

/** Milliseconds before a non-answering candidate is given up on and killed. */
const PROBE_TIMEOUT_MS = 10_000

const spawnProbe: FfmpegProbe = (binPath) =>
  new Promise((resolve) => {
    const child = spawn(binPath, ['-hide_banner', '-encoders'])
    let out = ''
    // Listing encoders is local work that takes milliseconds; anything that hangs here is broken.
    // Without the timeout it would hang the Issues tab's "can this be fixed?" check instead.
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out : null)
    })
  })
