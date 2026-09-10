import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { ENCORE_TMP_DIR } from '../../shared/constants'
import { readSngForRepack } from '../downloads/sng'
import { JobProgress } from '../shared-types'
import {
  cancelChartVideoDownload,
  downloadVideo,
  downloadVideoForChart,
  pendingVideoDownloadCount,
  searchVideos
} from './ytdlp'
import { tmpDir } from '../../../test/helpers/tmp'

let dir: string
let library: string
let chartDir: string
let sngPath: string

const encoder = new TextEncoder()
const NOTES = {
  fileName: 'notes.chart',
  data: encoder.encode('[Song]\n{\n  Resolution = 192\n}\n')
}

beforeEach(() => {
  dir = tmpDir('ytdlp')
  library = join(dir, 'library')
  chartDir = join(library, 'Artist - Song (Charter)')
  mkdirSync(chartDir, { recursive: true })
  sngPath = join(library, 'Artist - Song (Charter).sng')
  writeFileSync(sngPath, makeSng([NOTES], { name: 'Song', artist: 'Artist' }))
})

const folders = (): { path: string }[] => [{ path: library }]

function stub(name: string, script: string): string {
  const path = join(dir, name)
  writeFileSync(path, script, { mode: 0o755 })
  return path
}

/**
 * Shell lines that recover the `-o` template out of the stub's own argv into `$out`.
 *
 * Every stub that writes a file derives its name this way rather than being handed one, because
 * that is the only thing the production code and the real yt-dlp agree on: yt-dlp is told
 * `video.%(ext)s` and picks the container itself.
 */
const OUT_FROM_ARGS = [
  'out=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [ "$prev" = "-o" ]; then out="$a"; fi',
  '  prev="$a"',
  'done'
]

// Realistic flat-playlist NDJSON lines (subset of yt-dlp's fields).
const FULL_LINE = JSON.stringify({
  id: 'dQw4w9WgXcQ',
  title: 'Song Title (Official Video)',
  channel: 'ArtistVEVO',
  uploader: 'ignored-when-channel-present',
  duration: 213.4,
  thumbnails: [
    { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg' },
    { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }
  ]
})
// Tolerance case: missing channel/duration/thumbnails, uploader fallback.
const SPARSE_LINE = JSON.stringify({ id: 'abc-def_123', title: 'Live Bootleg' })

describe('searchVideos', () => {
  it('spawns yt-dlp with a ytsearch query and parses NDJSON results', async () => {
    const bin = stub(
      'yt-dlp-search',
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${join(dir, 'args.txt')}"`,
        `echo '${FULL_LINE}'`,
        `echo '${SPARSE_LINE}'`,
        ''
      ].join('\n')
    )
    const results = await searchVideos(bin, 'artist song', 5)
    expect(results).toEqual([
      {
        id: 'dQw4w9WgXcQ',
        title: 'Song Title (Official Video)',
        channel: 'ArtistVEVO',
        durationSeconds: 213,
        thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
      },
      {
        id: 'abc-def_123',
        title: 'Live Bootleg',
        channel: null,
        durationSeconds: null,
        thumbnailUrl: null
      }
    ])
    const args = readFileSync(join(dir, 'args.txt'), 'utf8').trim().split('\n')
    expect(args).toEqual([
      'ytsearch5:artist song',
      '--dump-json',
      '--flat-playlist',
      '--no-warnings'
    ])
  })

  it('defaults the limit to 10', async () => {
    const bin = stub(
      'yt-dlp-limit',
      ['#!/bin/sh', `printf '%s\\n' "$1" > "${join(dir, 'args.txt')}"`, ''].join('\n')
    )
    await searchVideos(bin, 'query')
    expect(readFileSync(join(dir, 'args.txt'), 'utf8').trim()).toBe('ytsearch10:query')
  })

  it('uses uploader when channel is absent and single thumbnail field as fallback', async () => {
    const line = JSON.stringify({
      id: 'xyz789abc',
      title: 'T',
      uploader: 'Some Uploader',
      duration: 10,
      thumbnail: 'https://i.ytimg.com/vi/xyz789abc/default.jpg'
    })
    const bin = stub('yt-dlp-fallback', ['#!/bin/sh', `echo '${line}'`, ''].join('\n'))
    const results = await searchVideos(bin, 'q')
    expect(results).toEqual([
      {
        id: 'xyz789abc',
        title: 'T',
        channel: 'Some Uploader',
        durationSeconds: 10,
        thumbnailUrl: 'https://i.ytimg.com/vi/xyz789abc/default.jpg'
      }
    ])
  })

  it('rejects on non-zero exit with the stderr tail', async () => {
    const bin = stub(
      'yt-dlp-fail',
      ['#!/bin/sh', 'echo "ERROR: Sign in to confirm" >&2', 'exit 1', ''].join('\n')
    )
    await expect(searchVideos(bin, 'query')).rejects.toThrow(/Sign in to confirm/)
  })
})

describe('downloadVideo', () => {
  // Emits progress lines like the real yt-dlp (--newline), then creates the
  // output file derived from the -o template.
  const downloadStub = (): string =>
    stub(
      'yt-dlp-download',
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${join(dir, 'dl-args.txt')}"`,
        ...OUT_FROM_ARGS,
        'out=$(printf %s "$out" | sed "s/%(ext)s$/mp4/")',
        'echo "[youtube] Extracting URL"',
        'echo "[download]   0.0% of 10.00MiB"',
        'echo "[download]  25.5% of 10.00MiB"',
        'echo "[download]  25.7% of 10.00MiB"',
        'echo "[download] 100.0% of 10.00MiB"',
        'touch "$out"',
        ''
      ].join('\n')
    )

  it('reports deduped integer progress, terminal done, and produces the file', async () => {
    const events: JobProgress[] = []
    await downloadVideo(
      downloadStub(),
      'dQw4w9WgXcQ',
      chartDir,
      'folder',
      (p) => events.push(p),
      undefined,
      folders()
    )

    // yt-dlp writes straight into the chart folder: no staging directory of
    // ours, and no --max-filesize in the args below.
    expect(readdirSync(chartDir)).toEqual(['video.mp4'])
    expect(existsSync(join(chartDir, ENCORE_TMP_DIR))).toBe(false)

    const args = readFileSync(join(dir, 'dl-args.txt'), 'utf8').trim().split('\n')
    expect(args).toEqual([
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      '-f',
      'bv*[height<=1080]+ba/b[height<=1080]',
      '-o',
      join(chartDir, 'video.%(ext)s'),
      '--newline',
      '--no-warnings'
    ])

    for (const e of events) {
      expect(e.jobId).toBe(`video:${chartDir}`)
      expect(e.kind).toBe('asset')
      expect(e.phase).toBe('download')
    }
    // 25.5 and 25.7 both round to 26, so the two collapse into a single report.
    const running = events.filter((e) => e.status === 'running')
    expect(running.map((e) => e.percent)).toEqual([0, 26, 100])
    const last = events.at(-1)
    expect(last?.status).toBe('done')
    expect(last?.percent).toBe(100)
  })

  it('rejects on non-zero exit with the stderr tail and reports an error event', async () => {
    const bin = stub(
      'yt-dlp-dlfail',
      ['#!/bin/sh', 'echo "ERROR: Video unavailable" >&2', 'exit 1', ''].join('\n')
    )
    const events: JobProgress[] = []
    await expect(
      downloadVideo(
        bin,
        'dQw4w9WgXcQ',
        chartDir,
        'folder',
        (p) => events.push(p),
        undefined,
        folders()
      )
    ).rejects.toThrow(/Video unavailable/)
    expect(events.at(-1)?.status).toBe('error')
  })

  it('kills the child, clears what it left in the chart folder, and reports canceled', async () => {
    // The stub records its pid, drops the two kinds of leftover a killed yt-dlp leaves behind
    // (a `.part` for the stream it was pulling and a per-format fragment it never merged), then
    // execs into a long sleep (exec so the pid we signal IS the sleeping process, matching real
    // yt-dlp's single process). The only way the promise settles quickly is a delivered SIGTERM.
    const bin = stub(
      'yt-dlp-slow',
      [
        '#!/bin/sh',
        `echo $$ > "${join(dir, 'pid.txt')}"`,
        ...OUT_FROM_ARGS,
        `printf %s 'HALF' > "$(printf %s "$out" | sed "s/%(ext)s$/webm.part/")"`,
        `printf %s 'FRAG' > "$(printf %s "$out" | sed "s/%(ext)s$/f399.webm/")"`,
        'exec sleep 30',
        ''
      ].join('\n')
    )
    // Two files this download did not create. The one that matters is the video the chart
    // already had: cleaning up after a cancel must not cost the user a video they kept.
    writeFileSync(join(chartDir, 'notes.chart'), NOTES.data)
    writeFileSync(join(chartDir, 'video.mp4'), 'OLD VIDEO')
    const controller = new AbortController()
    const events: JobProgress[] = []
    const promise = downloadVideo(
      bin,
      'dQw4w9WgXcQ',
      chartDir,
      'folder',
      (p) => events.push(p),
      controller.signal,
      folders()
    )
    // Give the stub a beat to start, then abort.
    await new Promise((r) => setTimeout(r, 100))
    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)
    // The recorded child pid must be gone (kill 0 probes for existence).
    const pid = Number(readFileSync(join(dir, 'pid.txt'), 'utf8').trim())
    await new Promise((r) => setTimeout(r, 50))
    expect(() => process.kill(pid, 0)).toThrow()

    expect(readdirSync(chartDir).sort()).toEqual(['notes.chart', 'video.mp4'])
    expect(readFileSync(join(chartDir, 'video.mp4'), 'utf8')).toBe('OLD VIDEO')
    expect(events.at(-1)?.status).toBe('canceled')
  }, 5000)

  it('cancels a per-chart download by chart path and forgets it once it settles', async () => {
    const bin = stub(
      'yt-dlp-perchart',
      [
        '#!/bin/sh',
        ...OUT_FROM_ARGS,
        `printf %s 'HALF' > "$(printf %s "$out" | sed "s/%(ext)s$/webm.part/")"`,
        'exec sleep 30',
        ''
      ].join('\n')
    )
    const events: JobProgress[] = []
    const promise = downloadVideoForChart(
      bin,
      'dQw4w9WgXcQ',
      chartDir,
      'folder',
      (p) => events.push(p),
      folders()
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(pendingVideoDownloadCount()).toBe(1)
    cancelChartVideoDownload(chartDir)
    await expect(promise).rejects.toThrow(/abort/i)
    expect(readdirSync(chartDir)).toEqual([])
    expect(events.at(-1)?.status).toBe('canceled')
    // The registry must not keep an entry per chart ever downloaded: a cancel arriving after
    // this point has nothing to abort and must stay a no-op.
    expect(pendingVideoDownloadCount()).toBe(0)
    expect(() => cancelChartVideoDownload(chartDir)).not.toThrow()
  }, 5000)

  it('cancelling a chart with no download running does nothing', () => {
    expect(() => cancelChartVideoDownload(chartDir)).not.toThrow()
    expect(pendingVideoDownloadCount()).toBe(0)
  })

  it('drops the registry entry after a download finishes normally', async () => {
    await downloadVideoForChart(
      downloadStub(),
      'dQw4w9WgXcQ',
      chartDir,
      'folder',
      () => {},
      folders()
    )
    expect(pendingVideoDownloadCount()).toBe(0)
  })

  it('rejects a chartDir outside the library BEFORE spawning', async () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    const marker = join(dir, 'spawned.txt')
    const bin = stub('yt-dlp-guard', ['#!/bin/sh', `touch "${marker}"`, ''].join('\n'))
    await expect(
      downloadVideo(bin, 'dQw4w9WgXcQ', outside, 'folder', () => {}, undefined, folders())
    ).rejects.toThrow(/library/i)
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects a malformed videoId before spawning', async () => {
    const marker = join(dir, 'spawned2.txt')
    const bin = stub('yt-dlp-idguard', ['#!/bin/sh', `touch "${marker}"`, ''].join('\n'))
    await expect(
      downloadVideo(bin, '"; rm -rf /', chartDir, 'folder', () => {}, undefined, folders())
    ).rejects.toThrow(/video id/i)
    await expect(
      downloadVideo(bin, 'a'.repeat(17), chartDir, 'folder', () => {}, undefined, folders())
    ).rejects.toThrow(/video id/i)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('downloadVideo into a .sng chart', () => {
  const VIDEO_BYTES = 'FAKEVIDEODATA'

  /**
   * Like downloadStub, but writes real bytes (the repack needs something to pack) and takes
   * the container yt-dlp "chose", because the production code must not assume an extension.
   */
  const producingStub = (name: string, ext: string, payload = VIDEO_BYTES): string =>
    stub(
      name,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > "${join(dir, 'dl-args.txt')}"`,
        ...OUT_FROM_ARGS,
        `out=$(printf %s "$out" | sed "s/%(ext)s$/${ext}/")`,
        'echo "[download] 100.0% of 10.00MiB"',
        `printf %s '${payload}' > "$out"`,
        ''
      ].join('\n')
    )

  /**
   * What our staging left behind. The shared `.encore-tmp` directory itself is NOT ours to
   * delete (the download queue keeps resumable .part files in it), so the assertion is that
   * our per-download subdirectory is gone, not that the convention directory never existed.
   */
  const stagingLeftovers = (): string[] => {
    const tmp = join(library, ENCORE_TMP_DIR)
    return existsSync(tmp) ? readdirSync(tmp) : []
  }

  const archive = (): Promise<Awaited<ReturnType<typeof readSngForRepack>>> =>
    readSngForRepack(new Uint8Array(readFileSync(sngPath)))

  it('repacks the downloaded video in under its real name and leaves no staging behind', async () => {
    const events: JobProgress[] = []
    await downloadVideo(
      producingStub('yt-dlp-sng', 'webm'),
      'dQw4w9WgXcQ',
      sngPath,
      'sng',
      (p) => events.push(p),
      undefined,
      folders()
    )

    const back = await archive()
    // webm, not mp4: the entry name is whatever yt-dlp actually produced.
    expect(back.entries.map((e) => e.fileName).sort()).toEqual(['notes.chart', 'video.webm'])
    expect(back.entries.find((e) => e.fileName === 'video.webm')?.data).toEqual(
      encoder.encode(VIDEO_BYTES)
    )
    expect(back.entries.find((e) => e.fileName === 'notes.chart')?.data).toEqual(NOTES.data)
    expect(back.metadata.name).toBe('Song')
    expect(back.metadata.artist).toBe('Artist')

    expect(stagingLeftovers()).toEqual([])
    expect(readdirSync(library).filter((n) => n !== ENCORE_TMP_DIR)).toEqual([
      'Artist - Song (Charter)',
      'Artist - Song (Charter).sng'
    ])

    for (const e of events) expect(e.jobId).toBe(`video:${sngPath}`)
    // The repack takes seconds on a real chart. 'done' is terminal (the UI re-enables its
    // buttons on it), so it must not fire until the archive has actually been replaced.
    const running = events.filter((e) => e.status === 'running')
    expect(running.at(-1)?.percent).toBe(100)
    expect(running.at(-1)?.message).toMatch(/pack/i)
    expect(events.at(-1)?.status).toBe('done')
  })

  it('gives yt-dlp the whole asset ceiling as --max-filesize, undiminished by the archive', async () => {
    // The cap is smaller than the archive it is being written into. Under the old
    // `ceiling - archiveSize` budget this was a negative number and the download was refused
    // before it spawned; the archive is not resident during a repack, so it buys the video no
    // less room. This is the previously-refused case in miniature.
    const archiveBytes = statSync(sngPath).size
    const cap = Math.floor(archiveBytes / 2)
    expect(cap).toBeGreaterThan(VIDEO_BYTES.length)
    await downloadVideo(
      producingStub('yt-dlp-budget', 'mp4'),
      'dQw4w9WgXcQ',
      sngPath,
      'sng',
      () => {},
      undefined,
      folders(),
      { maxAssetBytes: cap }
    )
    const args = readFileSync(join(dir, 'dl-args.txt'), 'utf8').trim().split('\n')
    const at = args.indexOf('--max-filesize')
    expect(at).toBeGreaterThan(-1)
    expect(args[at + 1]).toBe(String(cap))
    expect((await archive()).entries.map((e) => e.fileName).sort()).toEqual([
      'notes.chart',
      'video.mp4'
    ])
  })

  it('refuses after the download when the file that landed is over the asset ceiling', async () => {
    const before = readFileSync(sngPath)
    // The cap is positive and above what --max-filesize would have been told about, so the
    // download runs; the stub then writes more than the cap. yt-dlp's own --max-filesize is
    // advisory (it only knows the sizes a format reports), so the post-check on the file that
    // actually landed is the one that decides.
    const cap = VIDEO_BYTES.length - 1
    const events: JobProgress[] = []
    await expect(
      downloadVideo(
        producingStub('yt-dlp-toobig', 'mp4'),
        'dQw4w9WgXcQ',
        sngPath,
        'sng',
        (p) => events.push(p),
        undefined,
        folders(),
        { maxAssetBytes: cap }
      )
    ).rejects.toThrow(new RegExp(`video\\.mp4.*${VIDEO_BYTES.length}.*${cap}`))
    expect(readFileSync(sngPath)).toEqual(before)
    expect(stagingLeftovers()).toEqual([])
    expect(events.at(-1)?.status).toBe('error')
  })

  it('names the size yt-dlp reported when it aborts on the budget without producing a file', async () => {
    // Real yt-dlp behaviour, measured against 2026.08.19: --max-filesize prints this line on
    // stdout and exits 0, having written nothing.
    const bin = stub(
      'yt-dlp-maxsize',
      [
        '#!/bin/sh',
        'echo "[download] File is larger than max-filesize (900000000 bytes > 5 bytes). Aborting."',
        ''
      ].join('\n')
    )
    const before = readFileSync(sngPath)
    await expect(
      downloadVideo(bin, 'dQw4w9WgXcQ', sngPath, 'sng', () => {}, undefined, folders(), {
        maxAssetBytes: 5
      })
    ).rejects.toThrow(/900000000.*\b5\b/)
    expect(readFileSync(sngPath)).toEqual(before)
    expect(stagingLeftovers()).toEqual([])
  })

  it('removes the staging directory when the download fails part-way', async () => {
    const before = readFileSync(sngPath)
    const bin = stub(
      'yt-dlp-sngfail',
      [
        '#!/bin/sh',
        ...OUT_FROM_ARGS,
        // yt-dlp's own staging file, left behind by a download that died mid-stream.
        `printf %s 'HALF' > "$(printf %s "$out" | sed "s/%(ext)s$/webm.part/")"`,
        'echo "ERROR: Video unavailable" >&2',
        'exit 1',
        ''
      ].join('\n')
    )
    await expect(
      downloadVideo(bin, 'dQw4w9WgXcQ', sngPath, 'sng', () => {}, undefined, folders())
    ).rejects.toThrow(/Video unavailable/)
    expect(stagingLeftovers()).toEqual([])
    expect(readFileSync(sngPath)).toEqual(before)
  })

  it('removes the staging directory when the download is aborted', async () => {
    const bin = stub(
      'yt-dlp-sngslow',
      [
        '#!/bin/sh',
        ...OUT_FROM_ARGS,
        `printf %s 'HALF' > "$(printf %s "$out" | sed "s/%(ext)s$/webm.part/")"`,
        'exec sleep 30',
        ''
      ].join('\n')
    )
    const before = readFileSync(sngPath)
    const controller = new AbortController()
    const events: JobProgress[] = []
    const promise = downloadVideo(
      bin,
      'dQw4w9WgXcQ',
      sngPath,
      'sng',
      (p) => events.push(p),
      controller.signal,
      folders()
    )
    await new Promise((r) => setTimeout(r, 100))
    controller.abort()
    await expect(promise).rejects.toThrow(/abort/i)
    expect(stagingLeftovers()).toEqual([])
    expect(readFileSync(sngPath)).toEqual(before)
    expect(events.at(-1)?.status).toBe('canceled')
  }, 5000)

  // The per-chart path's version of the test above. A staged video is the one cancel leftover
  // nothing ever sweeps, because `.encore-tmp` beside a chart in a subfolder is not visited by
  // the startup sweep, which only looks at library roots. A cancel that leaves the staged file
  // there is a silent disk leak measured in hundreds of megabytes.
  it('cancels a .sng download by chart path, leaving no staging and the archive untouched', async () => {
    // Worse than the half-written case above: this stub finishes the video and is still running
    // when the cancel arrives, so a staging directory that survived would hold a COMPLETE file,
    // and the archive would be one repack away from gaining it.
    const bin = stub(
      'yt-dlp-sngperchart',
      [
        '#!/bin/sh',
        ...OUT_FROM_ARGS,
        `printf %s 'FAKEVIDEODATA' > "$(printf %s "$out" | sed "s/%(ext)s$/webm/")"`,
        `printf %s 'HALF' > "$(printf %s "$out" | sed "s/%(ext)s$/mp4.part/")"`,
        'exec sleep 30',
        ''
      ].join('\n')
    )
    const before = readFileSync(sngPath)
    const events: JobProgress[] = []
    const promise = downloadVideoForChart(
      bin,
      'dQw4w9WgXcQ',
      sngPath,
      'sng',
      (p) => events.push(p),
      folders()
    )
    await new Promise((r) => setTimeout(r, 100))
    cancelChartVideoDownload(sngPath)
    await expect(promise).rejects.toThrow(/abort/i)
    expect(stagingLeftovers()).toEqual([])
    expect(readFileSync(sngPath)).toEqual(before)
    expect(events.at(-1)?.status).toBe('canceled')
    expect(pendingVideoDownloadCount()).toBe(0)
  }, 5000)
})
