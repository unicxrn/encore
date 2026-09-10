import { EventEmitter } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it } from 'vitest'
import { convertToWebm, MIN_VIDEO_BITRATE, type SpawnFn, type SpawnedProcess } from './convert'
import { tmpDir } from '../../../test/helpers/tmp'

let dir: string
let input: string
let output: string

beforeEach(() => {
  dir = tmpDir('convert')
  input = join(dir, 'video.mp4')
  output = join(dir, 'video.webm')
  writeFileSync(input, 'not really a video')
})

/** One spawned child a test can drive: push output, then close it with an exit code. */
class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed: NodeJS.Signals | number | undefined
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = signal
    return true
  }
  /** What a real child does on SIGTERM: exits, which is what the close handler waits for. */
  close(code: number | null): void {
    this.stdout.end()
    this.stderr.end()
    // A tick, so data pushed immediately before this has been delivered to listeners.
    setImmediate(() => this.emit('close', code))
  }
}

interface SpawnCall {
  command: string
  args: string[]
  child: FakeChild
}

/**
 * A spawn seam that records every call and hands back a child the test drives.
 *
 * `onSpawn` runs on the next tick rather than synchronously, because production attaches its
 * listeners after spawn returns; emitting inside the call would fire into nothing.
 */
function fakeSpawn(onSpawn: (call: SpawnCall) => void): { calls: SpawnCall[]; spawn: SpawnFn } {
  const calls: SpawnCall[] = []
  const spawn: SpawnFn = (command, args) => {
    const child = new FakeChild()
    const call = { command, args, child }
    calls.push(call)
    setImmediate(() => onSpawn(call))
    return child
  }
  return { calls, spawn }
}

/** ffprobe's `-print_format json -show_streams -show_format` shape, trimmed to what we read. */
function probeJson(opts: {
  duration?: string
  formatBitRate?: string
  size?: string
  videoBitRate?: string | null
  audio?: boolean
}): string {
  const streams: Record<string, unknown>[] = [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1280,
      height: 720,
      ...(opts.videoBitRate === null ? {} : { bit_rate: opts.videoBitRate ?? '853652' })
    }
  ]
  if (opts.audio !== false) {
    streams.push({ index: 1, codec_type: 'audio', codec_name: 'aac', bit_rate: '127999' })
  }
  // The third stream is the embedded cover art the real charts carry. It is codec_type
  // "video", which is exactly why the mapping has to be `0:v:0` and not "the video stream".
  streams.push({
    index: 2,
    codec_type: 'video',
    codec_name: 'png',
    disposition: { attached_pic: 1 }
  })
  return JSON.stringify({
    streams,
    format: {
      duration: opts.duration ?? '200.922268',
      bit_rate: opts.formatBitRate ?? '1036143',
      size: opts.size ?? '26023029'
    }
  })
}

/** Drives the probe child with `json`, and leaves the convert child to the caller. */
function withProbe(
  json: string,
  onConvert: (call: SpawnCall) => void
): ReturnType<typeof fakeSpawn> {
  let first = true
  return fakeSpawn((call) => {
    if (first) {
      first = false
      call.child.stdout.write(json)
      call.child.close(0)
      return
    }
    onConvert(call)
  })
}

describe('convertToWebm argument vector', () => {
  it('encodes VP8 + Vorbis with an explicit stream mapping and machine-readable progress', async () => {
    const { calls, spawn } = withProbe(probeJson({}), (call) => call.child.close(0))
    await convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })

    expect(calls).toHaveLength(2)
    expect(calls[1].command).toBe('/usr/bin/ffmpeg')
    expect(calls[1].args).toEqual([
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-loglevel',
      'error',
      '-y',
      '-progress',
      'pipe:1',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'libvpx',
      '-crf',
      '24',
      '-b:v',
      '854k',
      '-c:a',
      'libvorbis',
      '-f',
      'webm',
      output
    ])
  })

  it('probes with ffprobe next to the given ffmpeg', async () => {
    const { calls, spawn } = withProbe(probeJson({}), (call) => call.child.close(0))
    await convertToWebm({ ffmpegPath: '/opt/enc/ffmpeg', input, output }, { spawn })

    expect(calls[0].command).toBe('/opt/enc/ffprobe')
    expect(calls[0].args).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      input
    ])
  })

  it('keeps the .exe suffix when deriving ffprobe on Windows', async () => {
    const { calls, spawn } = withProbe(probeJson({}), (call) => call.child.close(0))
    await convertToWebm({ ffmpegPath: 'C:\\enc\\ffmpeg.exe', input, output }, { spawn })

    expect(calls[0].command).toMatch(/ffprobe\.exe$/)
  })

  it('omits the audio map and codec when the source has no audio stream', async () => {
    const { calls, spawn } = withProbe(probeJson({ audio: false }), (call) => call.child.close(0))
    await convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })

    expect(calls[1].args).not.toContain('0:a:0')
    expect(calls[1].args).not.toContain('libvorbis')
    expect(calls[1].args).toContain('0:v:0')
  })

  it('falls back to the container bitrate less the audio when the video stream reports none', async () => {
    const json = probeJson({ videoBitRate: null, formatBitRate: '1036143' })
    const { calls, spawn } = withProbe(json, (call) => call.child.close(0))
    await convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })

    // 1036143 - 127999 = 908144
    expect(calls[1].args[calls[1].args.indexOf('-b:v') + 1]).toBe('908k')
  })

  it('falls back to size over duration when no bitrate is reported at all', async () => {
    const json = probeJson({
      videoBitRate: null,
      formatBitRate: 'N/A',
      size: '26023029',
      duration: '200.922268'
    })
    const { calls, spawn } = withProbe(json, (call) => call.child.close(0))
    await convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })

    // 26023029 * 8 / 200.922268 = 1036143 bps, less the 127999 the audio stream declares.
    expect(calls[1].args[calls[1].args.indexOf('-b:v') + 1]).toBe('908k')
  })

  it('floors the target bitrate so a tiny source is not re-encoded into mush', async () => {
    const json = probeJson({ videoBitRate: '90000' })
    const { calls, spawn } = withProbe(json, (call) => call.child.close(0))
    await convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })

    expect(calls[1].args[calls[1].args.indexOf('-b:v') + 1]).toBe(`${MIN_VIDEO_BITRATE / 1000}k`)
  })
})

describe('convertToWebm progress', () => {
  it('reports a fraction of the probed duration from -progress out_time_us lines', async () => {
    const seen: number[] = []
    const { spawn } = withProbe(probeJson({ duration: '100.0' }), (call) => {
      call.child.stdout.write('frame=1\nfps=0.0\nout_time_us=10000000\nprogress=continue\n')
      call.child.stdout.write('frame=2\nout_time_us=50000000\nprogress=continue\n')
      call.child.stdout.write('out_time_us=100000000\nprogress=end\n')
      call.child.close(0)
    })
    await convertToWebm(
      { ffmpegPath: '/usr/bin/ffmpeg', input, output, onProgress: (f) => seen.push(f) },
      { spawn }
    )

    expect(seen).toEqual([0.1, 0.5, 1])
  })

  it('ignores N/A and never reports past 1', async () => {
    const seen: number[] = []
    const { spawn } = withProbe(probeJson({ duration: '100.0' }), (call) => {
      call.child.stdout.write('out_time_us=N/A\nprogress=continue\n')
      // ffmpeg's last out_time can exceed the probed duration by a frame or two.
      call.child.stdout.write('out_time_us=100400000\nprogress=end\n')
      call.child.close(0)
    })
    await convertToWebm(
      { ffmpegPath: '/usr/bin/ffmpeg', input, output, onProgress: (f) => seen.push(f) },
      { spawn }
    )

    expect(seen).toEqual([1])
  })

  it('deduplicates on whole percent so a long encode does not flood the caller', async () => {
    const seen: number[] = []
    const { spawn } = withProbe(probeJson({ duration: '100.0' }), (call) => {
      call.child.stdout.write('out_time_us=1000000\nprogress=continue\n')
      call.child.stdout.write('out_time_us=1004000\nprogress=continue\n')
      call.child.stdout.write('out_time_us=2000000\nprogress=continue\n')
      call.child.close(0)
    })
    await convertToWebm(
      { ffmpegPath: '/usr/bin/ffmpeg', input, output, onProgress: (f) => seen.push(f) },
      { spawn }
    )

    expect(seen).toEqual([0.01, 0.02])
  })

  it('handles a progress block split across two chunks', async () => {
    const seen: number[] = []
    const { spawn } = withProbe(probeJson({ duration: '100.0' }), (call) => {
      call.child.stdout.write('frame=1\nout_time_')
      call.child.stdout.write('us=25000000\nprogress=continue\n')
      call.child.close(0)
    })
    await convertToWebm(
      { ffmpegPath: '/usr/bin/ffmpeg', input, output, onProgress: (f) => seen.push(f) },
      { spawn }
    )

    expect(seen).toEqual([0.25])
  })

  it('reports nothing when the source duration is unknown', async () => {
    const seen: number[] = []
    const { spawn } = withProbe(probeJson({ duration: 'N/A' }), (call) => {
      call.child.stdout.write('out_time_us=10000000\nprogress=continue\n')
      call.child.close(0)
    })
    await convertToWebm(
      { ffmpegPath: '/usr/bin/ffmpeg', input, output, onProgress: (f) => seen.push(f) },
      { spawn }
    )

    expect(seen).toEqual([])
  })
})

describe('convertToWebm cancellation', () => {
  it('kills the child and unlinks the partial output', async () => {
    const controller = new AbortController()
    let convertChild: FakeChild | undefined
    const { spawn } = withProbe(probeJson({}), (call) => {
      convertChild = call.child
      writeFileSync(output, 'half a webm')
      controller.abort()
      // The real child exits some time after the signal; the partial file must survive
      // until it does, or ffmpeg would be writing into a deleted path.
      setImmediate(() => call.child.close(null))
    })

    await expect(
      convertToWebm(
        { ffmpegPath: '/usr/bin/ffmpeg', input, output, signal: controller.signal },
        { spawn }
      )
    ).rejects.toThrow(/cancel/i)

    expect(convertChild?.killed).toBe('SIGTERM')
    expect(existsSync(output)).toBe(false)
  })

  it('rejects without spawning anything when the signal is already aborted', async () => {
    const { calls, spawn } = fakeSpawn(() => {})
    await expect(
      convertToWebm(
        { ffmpegPath: '/usr/bin/ffmpeg', input, output, signal: AbortSignal.abort() },
        { spawn }
      )
    ).rejects.toThrow(/cancel/i)

    expect(calls).toHaveLength(0)
  })

  it('leaves an output it never created alone', async () => {
    const controller = new AbortController()
    const { spawn } = withProbe(probeJson({}), (call) => {
      controller.abort()
      setImmediate(() => call.child.close(null))
    })

    await expect(
      convertToWebm(
        { ffmpegPath: '/usr/bin/ffmpeg', input, output, signal: controller.signal },
        { spawn }
      )
    ).rejects.toThrow(/cancel/i)
    expect(existsSync(output)).toBe(false)
  })
})

describe('convertToWebm failures', () => {
  it('rejects with ffmpeg stderr and removes the partial output', async () => {
    const { spawn } = withProbe(probeJson({}), (call) => {
      writeFileSync(output, 'half a webm')
      call.child.stderr.write('[libvpx @ 0x1] Failed to initialize encoder: Invalid parameter\n')
      call.child.close(1)
    })

    await expect(
      convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })
    ).rejects.toThrow(/Failed to initialize encoder: Invalid parameter/)

    expect(existsSync(output)).toBe(false)
  })

  it('names the exit code in the rejection', async () => {
    const { spawn } = withProbe(probeJson({}), (call) => {
      call.child.stderr.write('boom\n')
      call.child.close(69)
    })

    await expect(
      convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })
    ).rejects.toThrow(/exit 69/)
  })

  it('rejects when the binary cannot be spawned', async () => {
    const { spawn } = withProbe(probeJson({}), (call) => {
      call.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    })

    await expect(
      convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })
    ).rejects.toThrow(/ENOENT/)
  })

  it('rejects when the input does not exist, without spawning', async () => {
    const { calls, spawn } = fakeSpawn(() => {})
    await expect(
      convertToWebm(
        { ffmpegPath: '/usr/bin/ffmpeg', input: join(dir, 'gone.mp4'), output },
        { spawn }
      )
    ).rejects.toThrow(/gone\.mp4/)
    expect(calls).toHaveLength(0)
  })

  it('rejects when the source has no video stream at all', async () => {
    const json = JSON.stringify({
      streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac', bit_rate: '128000' }],
      format: { duration: '100.0', bit_rate: '128000', size: '1600000' }
    })
    const { spawn } = withProbe(json, (call) => call.child.close(0))

    await expect(
      convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })
    ).rejects.toThrow(/no video stream/i)
  })
})

describe('convertToWebm probe fallback', () => {
  /**
   * The managed ffmpeg is a single binary with no ffprobe beside it, so the probe has to
   * survive that. These tests drive the first spawn as a failed ffprobe and the second as
   * `ffmpeg -i`, whose stream dump goes to stderr.
   */
  const FFMPEG_I_DUMP = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':",
    '  Metadata:',
    '    title           : Yellowcard - Ocean Avenue',
    '    description     : Duration: not a real one, Stream #9:9: Video: fake',
    '  Duration: 00:03:20.92, start: 0.000000, bitrate: 1036 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (avc1), yuv420p, 1280x720, 853 kb/s, 25 fps',
    '  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo, fltp, 127 kb/s',
    '  Stream #0:2: Video: png, rgba, 1280x720 (attached pic)',
    ''
  ].join('\n')

  function withFailedProbe(dump: string, onConvert: (call: SpawnCall) => void): SpawnFn {
    let n = 0
    return fakeSpawn((call) => {
      n += 1
      if (n === 1) {
        call.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      } else if (n === 2) {
        call.child.stderr.write(dump)
        // `ffmpeg -i` with no output exits non-zero after dumping the streams.
        call.child.close(1)
      } else {
        onConvert(call)
      }
    }).spawn
  }

  it('reads the streams out of ffmpeg -i when ffprobe is not there', async () => {
    const seen: string[][] = []
    const spawn = withFailedProbe(FFMPEG_I_DUMP, (call) => {
      seen.push(call.args)
      call.child.close(0)
    })
    await convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })

    expect(seen[0]).toContain('0:a:0')
    expect(seen[0]).toContain('libvorbis')
    // 853 kb/s off the stream line, not the 1036 kb/s container line and not the decoy
    // "Stream #9:9" inside the metadata.
    expect(seen[0][seen[0].indexOf('-b:v') + 1]).toBe('853k')
  })

  it('detects a missing audio stream from the ffmpeg -i dump', async () => {
    const dump = FFMPEG_I_DUMP.split('\n')
      .filter((l) => !l.includes('Audio:'))
      .join('\n')
    const seen: string[][] = []
    const spawn = withFailedProbe(dump, (call) => {
      seen.push(call.args)
      call.child.close(0)
    })
    await convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })

    expect(seen[0]).not.toContain('0:a:0')
  })

  it('takes the duration for progress from the ffmpeg -i dump', async () => {
    const seen: number[] = []
    const spawn = withFailedProbe(FFMPEG_I_DUMP, (call) => {
      // 00:03:20.92 = 200.92 s; half of it is 100.46 s.
      call.child.stdout.write('out_time_us=100460000\nprogress=continue\n')
      call.child.close(0)
    })
    await convertToWebm(
      { ffmpegPath: '/usr/bin/ffmpeg', input, output, onProgress: (f) => seen.push(f) },
      { spawn }
    )

    expect(seen).toEqual([0.5])
  })

  it('blames the binary, not the video, when ffmpeg itself cannot be run', async () => {
    const { spawn } = fakeSpawn((call) =>
      call.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    )
    await expect(
      convertToWebm({ ffmpegPath: '/gone/ffmpeg', input, output }, { spawn })
    ).rejects.toThrow(/Could not run ffmpeg \(\/gone\/ffmpeg\): spawn ENOENT/)
  })

  it('rejects when neither probe can read the source', async () => {
    const spawn = withFailedProbe('Invalid data found when processing input\n', () => {})
    await expect(
      convertToWebm({ ffmpegPath: '/usr/bin/ffmpeg', input, output }, { spawn })
    ).rejects.toThrow(/Invalid data found when processing input/)
  })
})
