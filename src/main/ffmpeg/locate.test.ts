import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateFfmpegLocation, locateFfmpeg, type FfmpegProbe } from './locate'

const SIDECAR_DIR = '/userData/sidecars'
const MANAGED = join(SIDECAR_DIR, 'ffmpeg')

/**
 * A trimmed `-encoders` table. Rows are `<flags> <name> <description>`, and real ffmpeg repeats
 * the encoder name inside the description column, which is what the vp9 test below turns on.
 */
const encoders = (...names: string[]): string =>
  [
    'Encoders:',
    ' V..... = Video',
    ' ------',
    ...names.map((n) => ` V....D ${n.padEnd(20)} ${n} something (codec x)`)
  ].join('\n')

const USABLE = encoders('libvpx', 'libvpx-vp9', 'libvorbis')

/** Probe stub: every path not listed behaves as "no such binary". */
const probeOf = (outputs: Record<string, string>): FfmpegProbe =>
  vi.fn(async (binPath: string) => outputs[binPath] ?? null)

describe('locateFfmpeg', () => {
  beforeEach(() => invalidateFfmpegLocation())

  it('uses the PATH binary when it has both encoders', async () => {
    const probe = probeOf({ ffmpeg: USABLE })
    expect(await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })).toEqual({
      ok: true,
      path: 'ffmpeg',
      source: 'path'
    })
    // The managed copy is never probed once PATH answers: the first usable one wins.
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('falls back to the managed copy when nothing is on PATH', async () => {
    const probe = probeOf({ [MANAGED]: USABLE })
    expect(await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })).toEqual({
      ok: true,
      path: MANAGED,
      source: 'managed'
    })
  })

  it('skips a PATH binary that lacks the encoders in favour of a managed one that has them', async () => {
    const probe = probeOf({ ffmpeg: encoders('libx264', 'aac'), [MANAGED]: USABLE })
    expect(await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })).toEqual({
      ok: true,
      path: MANAGED,
      source: 'managed'
    })
  })

  it('reports missing-encoders when a binary runs but cannot encode WebM', async () => {
    const probe = probeOf({ ffmpeg: encoders('libvpx', 'libvpx-vp9', 'aac') })
    expect(await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })).toEqual({
      ok: false,
      reason: 'missing-encoders'
    })
  })

  it('does not mistake the libvpx-vp9 row for libvpx', async () => {
    // The vp9 row's description column reads "libvpx VP9", so a substring search over the
    // whole listing passes on a build that cannot encode VP8, the format Clone Hero plays.
    const probe = probeOf({ ffmpeg: encoders('libvpx-vp9', 'libvorbis') })
    expect(await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })).toEqual({
      ok: false,
      reason: 'missing-encoders'
    })
  })

  it('reports not-installed when no candidate runs', async () => {
    const probe = probeOf({})
    expect(await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })).toEqual({
      ok: false,
      reason: 'not-installed'
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('looks for ffmpeg.exe on Windows', async () => {
    const probe = probeOf({})
    await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'win32' })
    expect(probe).toHaveBeenNthCalledWith(1, 'ffmpeg.exe')
    expect(probe).toHaveBeenNthCalledWith(2, join(SIDECAR_DIR, 'ffmpeg.exe'))
  })

  it('probes once per process, including for a negative result', async () => {
    const probe = probeOf({})
    await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })
    await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('shares one probe run between concurrent callers', async () => {
    const probe = probeOf({ ffmpeg: USABLE })
    const [a, b] = await Promise.all([
      locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' }),
      locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })
    ])
    expect(a).toEqual(b)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('picks up a newly installed binary after invalidation', async () => {
    const empty = probeOf({})
    expect(
      await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe: empty, platform: 'linux' })
    ).toEqual({ ok: false, reason: 'not-installed' })
    invalidateFfmpegLocation()
    const installed = probeOf({ [MANAGED]: USABLE })
    expect(
      await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe: installed, platform: 'linux' })
    ).toEqual({ ok: true, path: MANAGED, source: 'managed' })
  })

  it('does not cache a probe that threw, so a transient spawn failure is retried', async () => {
    const probe = vi
      .fn<FfmpegProbe>()
      .mockRejectedValueOnce(new Error('EAGAIN'))
      .mockResolvedValue(USABLE)
    await expect(
      locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })
    ).rejects.toThrow('EAGAIN')
    expect(await locateFfmpeg({ sidecarDir: SIDECAR_DIR, probe, platform: 'linux' })).toEqual({
      ok: true,
      path: 'ffmpeg',
      source: 'path'
    })
  })
})
