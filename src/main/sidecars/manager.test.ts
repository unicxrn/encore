import { createHash } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobProgress } from '../shared-types'
import { defaultSidecarSources, SidecarManager, type SidecarChecksum } from './manager'
import { tmpDir } from '../../../test/helpers/tmp'

// A stub "binary": a shell script that reports a version and, when invoked with
// -U (the yt-dlp self-update flag), drops a marker file next to itself.
const STUB_BINARY = [
  '#!/bin/sh',
  'if [ "$1" = "-U" ]; then',
  '  touch "$(dirname "$0")/updated-marker"',
  'fi',
  'echo "fake-ytdlp 2025.01.01"',
  ''
].join('\n')

const FAILING_UPDATER = ['#!/bin/sh', 'if [ "$1" = "-U" ]; then exit 1; fi', 'echo v1', ''].join(
  '\n'
)

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

/**
 * A single-entry zip, built here with Node's own deflate. The real ffmpeg archives have exactly
 * this shape (one Deflate entry named for the binary), so the fixture is the thing, in miniature.
 */
function makeZip(entryName: string, content: Buffer): Buffer {
  const name = Buffer.from(entryName, 'utf8')
  const payload = deflateRawSync(content)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(payload.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42)

  const centralDir = Buffer.concat([central, name])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(30 + name.length + payload.length, 16)
  return Buffer.concat([local, name, payload, centralDir, eocd])
}

const FFMPEG_ZIP = makeZip('ffmpeg', Buffer.from(STUB_BINARY))

describe('SidecarManager', () => {
  let server: Server
  let baseUrl: string
  let dir: string
  let requests: string[]

  beforeEach(async () => {
    requests = []
    server = createServer(async (req, res) => {
      requests.push(req.url ?? '')
      if (req.url === '/ytdlp') {
        const body = Buffer.from(STUB_BINARY)
        res.writeHead(200, { 'Content-Length': body.length })
        // Stream in small chunks so progress gets multiple reports.
        for (let i = 0; i < body.length; i += 16) {
          res.write(body.subarray(i, i + 16))
          await new Promise((r) => setImmediate(r))
        }
        res.end()
      } else if (req.url === '/fail-update') {
        const body = Buffer.from(FAILING_UPDATER)
        res.writeHead(200, { 'Content-Length': body.length })
        res.end(body)
      } else if (req.url === '/ffmpeg.zip') {
        res.writeHead(200, { 'Content-Length': FFMPEG_ZIP.length })
        res.end(FFMPEG_ZIP)
      } else if (req.url === '/not-a-zip') {
        const body = Buffer.from('this is not an archive')
        res.writeHead(200, { 'Content-Length': body.length })
        res.end(body)
      } else if (req.url === '/sums') {
        // The `sha256sum` output format yt-dlp publishes as SHA2-256SUMS.
        const body = [
          `${sha256(FAILING_UPDATER)}  yt-dlp_other`,
          `${sha256(STUB_BINARY)}  yt-dlp`,
          ''
        ].join('\n')
        res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) })
        res.end(body)
      } else if (req.url === '/sums-missing') {
        const body = `${sha256(STUB_BINARY)}  some-other-asset\n`
        res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) })
        res.end(body)
      } else if (req.url === '/short') {
        // Corrupted download: declares more bytes than it sends, then kills the
        // socket so the stream ends early.
        const body = Buffer.from(STUB_BINARY)
        res.writeHead(200, { 'Content-Length': body.length * 2 })
        res.write(body)
        await new Promise((r) => setTimeout(r, 20))
        res.destroy()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = tmpDir('sidecars')
  })
  afterEach(() => server.close())

  interface ManagerOverrides {
    ytdlp?: string
    ytdlpChecksum?: SidecarChecksum
    ffmpeg?: string
    ffmpegChecksum?: SidecarChecksum
    ffmpegArchiveEntry?: string | null
  }

  const makeManager = (overrides: ManagerOverrides = {}): SidecarManager =>
    new SidecarManager({
      dir,
      sources: {
        ytdlp: {
          url: overrides.ytdlp ?? `${baseUrl}/ytdlp`,
          fileName: 'yt-dlp',
          checksum: overrides.ytdlpChecksum ?? { kind: 'pinned', sha256: sha256(STUB_BINARY) }
        },
        ffmpeg: {
          url: overrides.ffmpeg ?? `${baseUrl}/ffmpeg.zip`,
          fileName: 'ffmpeg',
          checksum: overrides.ffmpegChecksum ?? { kind: 'pinned', sha256: sha256(FFMPEG_ZIP) },
          ...(overrides.ffmpegArchiveEntry === null
            ? {}
            : { archiveEntry: overrides.ffmpegArchiveEntry ?? 'ffmpeg' })
        }
      },
      platform: 'linux'
    })

  it('reports not installed before install', async () => {
    const status = await makeManager().status('ytdlp')
    expect(status).toEqual({ installed: false, version: null, path: join(dir, 'yt-dlp') })
  })

  it('installs the binary: executable file, progress to 100, version readable', async () => {
    const manager = makeManager()
    const events: JobProgress[] = []
    await manager.install('ytdlp', (p) => events.push(p))

    const binPath = join(dir, 'yt-dlp')
    expect(existsSync(binPath)).toBe(true)
    expect(statSync(binPath).mode & 0o111).not.toBe(0)
    expect(readFileSync(binPath, 'utf8')).toBe(STUB_BINARY)

    // No stray .part files left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])

    for (const e of events) {
      expect(e.jobId).toBe('sidecar:ytdlp')
      expect(e.kind).toBe('asset')
      expect(e.phase).toBe('download')
    }
    const last = events.at(-1)
    expect(last?.status).toBe('done')
    expect(last?.percent).toBe(100)
    // No consecutive duplicate reports while running (counter dedupe pattern). Compared on the
    // percent *and* the message, because the post-download phases report at a pinned 100 and are
    // distinguished only by what they say they are doing.
    const running = events.filter((e) => e.status === 'running')
    for (let i = 1; i < running.length; i++) {
      expect([running[i].percent, running[i].message]).not.toEqual([
        running[i - 1].percent,
        running[i - 1].message
      ])
    }

    const status = await manager.status('ytdlp')
    expect(status).toEqual({ installed: true, version: 'fake-ytdlp 2025.01.01', path: binPath })
  })

  it('rejects a corrupted download and leaves no file behind', async () => {
    const manager = makeManager({ ytdlp: `${baseUrl}/short` })
    const events: JobProgress[] = []
    await expect(manager.install('ytdlp', (p) => events.push(p))).rejects.toThrow()
    expect(existsSync(join(dir, 'yt-dlp'))).toBe(false)
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
    expect(events.at(-1)?.status).toBe('error')
  })

  it('rejects on HTTP error status and leaves no file behind', async () => {
    const manager = makeManager({ ytdlp: `${baseUrl}/missing` })
    await expect(manager.install('ytdlp', () => {})).rejects.toThrow(/404/)
    expect(existsSync(join(dir, 'yt-dlp'))).toBe(false)
  })

  it('replaces an existing binary on reinstall', async () => {
    const binPath = join(dir, 'yt-dlp')
    writeFileSync(binPath, '#!/bin/sh\necho old-version\n', { mode: 0o755 })
    await makeManager().install('ytdlp', () => {})
    expect(readFileSync(binPath, 'utf8')).toBe(STUB_BINARY)
  })

  it('reports version null when the binary cannot be spawned', async () => {
    // Present but not executable and not a valid script.
    writeFileSync(join(dir, 'yt-dlp'), 'not a binary')
    const status = await makeManager().status('ytdlp')
    expect(status.installed).toBe(true)
    expect(status.version).toBe(null)
  })

  it('updates yt-dlp by running the binary with -U, emitting running then done', async () => {
    const manager = makeManager()
    await manager.install('ytdlp', () => {})
    const events: JobProgress[] = []
    await manager.update('ytdlp', (p) => events.push(p))
    expect(existsSync(join(dir, 'updated-marker'))).toBe(true)
    expect(events.map((e) => e.status)).toEqual(['running', 'done'])
    for (const e of events) {
      expect(e.jobId).toBe('sidecar:ytdlp')
      expect(e.kind).toBe('asset')
      expect(e.phase).toBe('update')
    }
    expect(events.at(-1)?.percent).toBe(100)
  })

  it('rejects when the yt-dlp self-update exits non-zero, emitting an error event', async () => {
    const manager = makeManager({
      ytdlp: `${baseUrl}/fail-update`,
      ytdlpChecksum: { kind: 'pinned', sha256: sha256(FAILING_UPDATER) }
    })
    await manager.install('ytdlp', () => {})
    const events: JobProgress[] = []
    await expect(manager.update('ytdlp', (p) => events.push(p))).rejects.toThrow(/exit/i)
    expect(events.map((e) => e.status)).toEqual(['running', 'error'])
    expect(events.at(-1)?.message).toMatch(/exit/i)
  })

  it('updates ffmpeg by re-running the install', async () => {
    const manager = makeManager()
    expect(existsSync(join(dir, 'ffmpeg'))).toBe(false)
    await manager.update('ffmpeg')
    expect(existsSync(join(dir, 'ffmpeg'))).toBe(true)
    expect(requests).toContain('/ffmpeg.zip')
  })

  describe('checksum verification', () => {
    it('rejects a binary whose hash does not match the pin, leaving no file behind', async () => {
      // The substitution Content-Length cannot see: right length, wrong bytes.
      const wrong = sha256(Buffer.alloc(Buffer.byteLength(STUB_BINARY), 0x41))
      const manager = makeManager({ ytdlpChecksum: { kind: 'pinned', sha256: wrong } })
      const events: JobProgress[] = []
      await expect(manager.install('ytdlp', (p) => events.push(p))).rejects.toThrow(
        /checksum mismatch/
      )
      expect(existsSync(join(dir, 'yt-dlp'))).toBe(false)
      expect(readdirSync(dir)).toEqual([])
      expect(events.at(-1)?.status).toBe('error')
    })

    it('accepts a pin written in uppercase hex', async () => {
      const manager = makeManager({
        ytdlpChecksum: { kind: 'pinned', sha256: sha256(STUB_BINARY).toUpperCase() }
      })
      await manager.install('ytdlp', () => {})
      expect(readFileSync(join(dir, 'yt-dlp'), 'utf8')).toBe(STUB_BINARY)
    })

    it('verifies yt-dlp against the SHA2-256SUMS the release publishes', async () => {
      const manager = makeManager({
        ytdlpChecksum: { kind: 'manifest', url: `${baseUrl}/sums`, assetName: 'yt-dlp' }
      })
      await manager.install('ytdlp', () => {})
      expect(requests).toContain('/sums')
      expect(readFileSync(join(dir, 'yt-dlp'), 'utf8')).toBe(STUB_BINARY)
    })

    it('rejects when the checksum manifest does not list the asset', async () => {
      const manager = makeManager({
        ytdlpChecksum: { kind: 'manifest', url: `${baseUrl}/sums-missing`, assetName: 'yt-dlp' }
      })
      await expect(manager.install('ytdlp', () => {})).rejects.toThrow(/no entry for yt-dlp/)
      expect(existsSync(join(dir, 'yt-dlp'))).toBe(false)
    })

    it('rejects when the checksum manifest cannot be fetched', async () => {
      const manager = makeManager({
        ytdlpChecksum: { kind: 'manifest', url: `${baseUrl}/missing`, assetName: 'yt-dlp' }
      })
      await expect(manager.install('ytdlp', () => {})).rejects.toThrow(/checksum download failed/)
      expect(existsSync(join(dir, 'yt-dlp'))).toBe(false)
    })
  })

  // The two sidecars do not answer to the same version flag, and the probe used to send both
  // `--version`. On ffmpeg that is not a version request at all: ffmpeg strips one leading dash
  // before looking an option up, so it arrives as the unknown `-version`, nothing reaches stdout
  // and the process exits 8. Both halves of the old check (exit code zero, non-empty stdout)
  // therefore failed, and an ffmpeg that was installed and working reported `version: null`
  // permanently. The stubs below reproduce each binary's argument handling, measured against
  // ffmpeg n9.0.1 and yt-dlp 2026.08.19; the shared STUB_BINARY could not catch this because it
  // prints a version whatever it is passed.
  describe('version probe', () => {
    const install = (fileName: string, script: string): void =>
      writeFileSync(join(dir, fileName), script, { mode: 0o755 })

    // Exits 8 on anything but `-version`, and prints its startup banner to stderr either way.
    // That banner is not a version response, and reading it would fake a success on a real error.
    const FFMPEG_STUB = [
      '#!/bin/sh',
      'echo "ffmpeg version 6.1 Copyright (c) 2000-2023 the FFmpeg developers" >&2',
      'if [ "$1" != "-version" ]; then',
      '  echo "Unrecognized option \'${1#-}\'." >&2',
      '  exit 8',
      'fi',
      'echo "ffmpeg version 6.1 Copyright (c) 2000-2023 the FFmpeg developers"',
      'echo "built with gcc 13"',
      ''
    ].join('\n')

    // The mirror image: yt-dlp exits 2 on the single-dash spelling. A probe that "fixed" ffmpeg by
    // sending `-version` to both would break yt-dlp instead, which is why this case is here.
    const YTDLP_STUB = [
      '#!/bin/sh',
      'if [ "$1" != "--version" ]; then exit 2; fi',
      'echo "2026.08.19"',
      ''
    ].join('\n')

    it('asks ffmpeg with -version, the only spelling it answers', async () => {
      install('ffmpeg', FFMPEG_STUB)
      expect((await makeManager().status('ffmpeg')).version).toBe(
        'ffmpeg version 6.1 Copyright (c) 2000-2023 the FFmpeg developers'
      )
    })

    it('asks yt-dlp with --version, the only spelling it answers', async () => {
      install('yt-dlp', YTDLP_STUB)
      expect((await makeManager().status('ytdlp')).version).toBe('2026.08.19')
    })

    it('still reports null when the binary genuinely fails', async () => {
      install('ffmpeg', ['#!/bin/sh', 'echo boom >&2', 'exit 1', ''].join('\n'))
      expect((await makeManager().status('ffmpeg')).version).toBe(null)
    })

    // stderr is routed to /dev/null rather than piped and left unread. A pipe nobody drains holds
    // 64 KB before the writer blocks; ffmpeg alone puts ~1.7 KB there on every run, so the margin
    // is thinner than it looks. If this regresses the child never exits, `status()` never settles,
    // and this test hangs rather than failing. Hence the explicit timeout, so a regression costs
    // ten seconds instead of the suite-wide thirty.
    it('does not deadlock on a binary that floods stderr', async () => {
      install(
        'ffmpeg',
        [
          '#!/bin/sh',
          'i=0',
          'while [ $i -lt 200 ]; do printf "%1024s" "" >&2; i=$((i+1)); done',
          'echo "ffmpeg version 6.1 Copyright (c) 2000-2023 the FFmpeg developers"',
          ''
        ].join('\n')
      )
      expect((await makeManager().status('ffmpeg')).version).toBe(
        'ffmpeg version 6.1 Copyright (c) 2000-2023 the FFmpeg developers'
      )
    }, 10_000)
  })

  describe('archive extraction', () => {
    it('installs ffmpeg by extracting the zip entry, not by saving the zip', async () => {
      const manager = makeManager()
      const events: JobProgress[] = []
      await manager.install('ffmpeg', (p) => events.push(p))

      const binPath = join(dir, 'ffmpeg')
      // The extracted binary, not the archive that carried it.
      expect(readFileSync(binPath, 'utf8')).toBe(STUB_BINARY)
      expect(statSync(binPath).mode & 0o111).not.toBe(0)
      // And it runs, which is the whole point: the old behaviour left an unrunnable archive.
      expect((await manager.status('ffmpeg')).version).toBe('fake-ytdlp 2025.01.01')

      // Neither the archive nor the extraction staging area survives.
      expect(readdirSync(dir)).toEqual(['ffmpeg'])
      expect(events.some((e) => e.message === 'Extracting')).toBe(true)
      expect(events.at(-1)?.status).toBe('done')
    })

    it('leaves nothing at the final path when extraction fails', async () => {
      // Hash matches, so the failure is the unzip itself. That is the case that must not be able
      // to strand a half-written file where a later run would find it and trust it.
      const manager = makeManager({
        ffmpeg: `${baseUrl}/not-a-zip`,
        ffmpegChecksum: { kind: 'pinned', sha256: sha256('this is not an archive') }
      })
      await expect(manager.install('ffmpeg', () => {})).rejects.toThrow(/Not a zip file/)
      expect(existsSync(join(dir, 'ffmpeg'))).toBe(false)
      expect(readdirSync(dir)).toEqual([])
    })

    it('leaves nothing behind when the zip lacks the entry we asked for', async () => {
      const manager = makeManager({ ffmpegArchiveEntry: 'ffmpeg.exe' })
      await expect(manager.install('ffmpeg', () => {})).rejects.toThrow(
        /no entry named "ffmpeg.exe"/
      )
      expect(readdirSync(dir)).toEqual([])
    })

    it('does not try to extract a source that is not an archive', async () => {
      const manager = makeManager({
        ffmpeg: `${baseUrl}/ytdlp`,
        ffmpegChecksum: { kind: 'pinned', sha256: sha256(STUB_BINARY) },
        ffmpegArchiveEntry: null
      })
      await manager.install('ffmpeg', () => {})
      expect(readFileSync(join(dir, 'ffmpeg'), 'utf8')).toBe(STUB_BINARY)
    })
  })

  describe('defaultSidecarSources', () => {
    // locate.ts looks for the managed ffmpeg at join(sidecarDir, 'ffmpeg' | 'ffmpeg.exe'). If
    // install put it anywhere else (the archive's name, say), a successful install would still
    // read as "not installed", so the two names are pinned together here.
    it.each([
      ['linux', 'ffmpeg'],
      ['darwin', 'ffmpeg'],
      ['win32', 'ffmpeg.exe']
    ] as const)('installs ffmpeg under the name locate.ts looks for on %s', (platform, exe) => {
      const sources = defaultSidecarSources(platform)
      expect(sources.ffmpeg.fileName).toBe(exe)
      expect(sources.ffmpeg.archiveEntry).toBe(exe)
      expect(new SidecarManager({ dir, sources, platform }).binPath('ffmpeg')).toBe(join(dir, exe))
    })

    it.each(['linux', 'darwin', 'win32'] as const)('pins the ffmpeg zip hash on %s', (platform) => {
      const { checksum, url } = defaultSidecarSources(platform).ffmpeg
      expect(url).toMatch(/\.zip$/)
      // A pin, not a checksum fetched from the same place as the artifact: ffbinaries publishes
      // no checksums, so this is the only barrier to a swapped upstream asset.
      expect(checksum.kind).toBe('pinned')
      expect(checksum).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    })

    it.each(['linux', 'darwin', 'win32'] as const)(
      'verifies yt-dlp against its published sums on %s',
      (platform) => {
        const { checksum, url, fileName } = defaultSidecarSources(platform).ytdlp
        // The URL floats to whatever release is latest, so a pin here would break on yt-dlp's
        // next release; the manifest is the only hash that tracks it.
        expect(checksum).toEqual({
          kind: 'manifest',
          url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
          assetName: url.split('/').pop()
        })
        expect(fileName).toBe(platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
      }
    )

    it('gives every platform an ffmpeg zip with a distinct pinned hash', () => {
      const hashes = (['linux', 'darwin', 'win32'] as const).map((p) => {
        const { checksum } = defaultSidecarSources(p).ffmpeg
        return checksum.kind === 'pinned' ? checksum.sha256 : ''
      })
      // A copy-paste slip that reused one platform's hash would make ffmpeg permanently
      // uninstallable on another, and nothing else in the suite would notice.
      expect(new Set(hashes).size).toBe(3)
    })
  })
})
