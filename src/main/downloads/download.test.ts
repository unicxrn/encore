import { createServer, Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeFixtureSng } from '../../../test/helpers/make-sng'
import { runDownload } from './download'
import { tmpDir } from '../../../test/helpers/tmp'

const PAYLOAD = Buffer.from('sng-bytes-'.repeat(1000))
const FIXTURE_SNG = makeFixtureSng()

describe('runDownload', () => {
  let server: Server
  let baseUrl: string
  let dirs: { destDir: string; tmpDir: string }
  let seenRanges: (string | undefined)[]

  beforeEach(async () => {
    seenRanges = []
    server = createServer(async (req, res) => {
      if (req.url === '/ok.sng') {
        // Honors Range requests with 206 + Content-Range.
        seenRanges.push(req.headers.range)
        let start = 0
        const match = req.headers.range ? /^bytes=(\d+)-$/.exec(req.headers.range) : null
        if (match) {
          start = Number(match[1])
          if (start >= PAYLOAD.length) {
            res.writeHead(416, { 'Content-Range': `bytes */${PAYLOAD.length}` })
            res.end()
            return
          }
          res.writeHead(206, {
            'Content-Length': PAYLOAD.length - start,
            'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`
          })
        } else {
          res.writeHead(200, { 'Content-Length': PAYLOAD.length })
        }
        // Stream in sub-percent chunks so rounded progress would repeat without dedupe.
        const body = PAYLOAD.subarray(start)
        for (let i = 0; i < body.length; i += 25) {
          res.write(body.subarray(i, i + 25))
          await new Promise((r) => setImmediate(r))
        }
        res.end()
      } else if (req.url === '/no-range.sng') {
        // Ignores Range entirely: always 200 with the full payload.
        seenRanges.push(req.headers.range)
        res.writeHead(200, { 'Content-Length': PAYLOAD.length })
        res.end(PAYLOAD)
      } else if (req.url === '/half.sng') {
        res.writeHead(200, { 'Content-Length': PAYLOAD.length })
        res.write(PAYLOAD.subarray(0, PAYLOAD.length / 2))
        // Give the client time to flush received bytes, then kill the socket.
        await new Promise((r) => setTimeout(r, 20))
        res.destroy()
      } else if (req.url === '/fixture.sng') {
        res.writeHead(200, { 'Content-Length': FIXTURE_SNG.length })
        res.end(FIXTURE_SNG)
      } else if (req.url === '/bad-206-full.sng') {
        // Non-compliant: answers 206 but sends the whole body from byte 0.
        res.writeHead(206, {
          'Content-Length': PAYLOAD.length,
          'Content-Range': `bytes 0-${PAYLOAD.length - 1}/${PAYLOAD.length}`
        })
        res.end(PAYLOAD)
      } else if (req.url === '/bad-206-offset.sng') {
        // Non-compliant: 206 with a range start that matches neither the
        // requested offset nor 0.
        res.writeHead(206, {
          'Content-Length': PAYLOAD.length - 500,
          'Content-Range': `bytes 500-${PAYLOAD.length - 1}/${PAYLOAD.length}`
        })
        res.end(PAYLOAD.subarray(500))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, () => r()))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const root = tmpDir('dl')
    dirs = { destDir: join(root, 'library'), tmpDir: join(root, 'tmp') }
    mkdirSync(dirs.destDir, { recursive: true })
  })
  afterEach(() => server.close())

  it('downloads an sng to "<folderName>.sng" in the library', async () => {
    const percents: (number | null)[] = []
    const finalPath = await runDownload(
      {
        url: `${baseUrl}/ok.sng`,
        folderName: 'Artist - Song',
        format: 'sng',
        tmpKey: 'a'.repeat(32),
        ...dirs
      },
      (p) => percents.push(p.percent)
    )
    expect(finalPath).toBe(join(dirs.destDir, 'Artist - Song.sng'))
    expect(readFileSync(finalPath)).toEqual(PAYLOAD)
    expect(percents.at(-1)).toBe(100)
  })
  it('fails at the check step when the target already exists', async () => {
    writeFileSync(join(dirs.destDir, 'Artist - Song.sng'), 'existing')
    await expect(
      runDownload(
        {
          url: `${baseUrl}/ok.sng`,
          folderName: 'Artist - Song',
          format: 'sng',
          tmpKey: 'b'.repeat(32),
          ...dirs
        },
        () => {}
      )
    ).rejects.toMatchObject({ step: 'check', name: 'DownloadError' })
  })
  it('does not report consecutive duplicate percents while streaming', async () => {
    const percents: (number | null)[] = []
    await runDownload(
      {
        url: `${baseUrl}/ok.sng`,
        folderName: 'Dedupe - Song',
        format: 'sng',
        tmpKey: 'c'.repeat(32),
        ...dirs
      },
      (p) => percents.push(p.percent)
    )
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).not.toBe(percents[i - 1])
    }
    expect(percents.at(-1)).toBe(100)
  })
  it('fails at the fetch step on HTTP 404 and leaves no file in the library', async () => {
    await expect(
      runDownload(
        {
          url: `${baseUrl}/missing.sng`,
          folderName: 'Nope',
          format: 'sng',
          tmpKey: 'd'.repeat(32),
          ...dirs
        },
        () => {}
      )
    ).rejects.toMatchObject({ step: 'fetch' })
    expect(existsSync(join(dirs.destDir, 'Nope.sng'))).toBe(false)
  })

  it('resumes a partial download with a Range request', async () => {
    const tmpKey = 'e'.repeat(32)
    mkdirSync(dirs.tmpDir, { recursive: true })
    writeFileSync(join(dirs.tmpDir, `${tmpKey}.part`), PAYLOAD.subarray(0, 1000))
    const fetchPercents: number[] = []
    const finalPath = await runDownload(
      {
        url: `${baseUrl}/ok.sng`,
        folderName: 'Resume - Song',
        format: 'sng',
        tmpKey,
        ...dirs
      },
      (p) => {
        if (p.phase === 'fetch' && p.percent !== null) fetchPercents.push(p.percent)
      }
    )
    expect(seenRanges).toEqual(['bytes=1000-'])
    expect(readFileSync(finalPath)).toEqual(PAYLOAD)
    // 1000 of 10000 bytes were already on disk: progress starts at the head-start fraction.
    expect(fetchPercents[0]).toBeGreaterThanOrEqual(10)
  })

  it('restarts cleanly when the server ignores Range', async () => {
    const tmpKey = 'f'.repeat(32)
    mkdirSync(dirs.tmpDir, { recursive: true })
    writeFileSync(join(dirs.tmpDir, `${tmpKey}.part`), 'garbage-not-payload')
    const finalPath = await runDownload(
      {
        url: `${baseUrl}/no-range.sng`,
        folderName: 'Restart - Song',
        format: 'sng',
        tmpKey,
        ...dirs
      },
      () => {}
    )
    expect(seenRanges).toEqual(['bytes=19-'])
    expect(readFileSync(finalPath)).toEqual(PAYLOAD)
  })

  it('restarts when a non-compliant 206 sends the full body from byte 0', async () => {
    const tmpKey = '3'.repeat(32)
    mkdirSync(dirs.tmpDir, { recursive: true })
    writeFileSync(join(dirs.tmpDir, `${tmpKey}.part`), PAYLOAD.subarray(0, 1000))
    const finalPath = await runDownload(
      {
        url: `${baseUrl}/bad-206-full.sng`,
        folderName: 'BadRange - Song',
        format: 'sng',
        tmpKey,
        ...dirs
      },
      () => {}
    )
    // Appending would have produced head + full body; the guard must restart.
    expect(readFileSync(finalPath)).toEqual(PAYLOAD)
  })

  it('fails and drops the part when a 206 range matches neither offset nor 0', async () => {
    const tmpKey = '4'.repeat(32)
    mkdirSync(dirs.tmpDir, { recursive: true })
    writeFileSync(join(dirs.tmpDir, `${tmpKey}.part`), PAYLOAD.subarray(0, 1000))
    await expect(
      runDownload(
        {
          url: `${baseUrl}/bad-206-offset.sng`,
          folderName: 'CorruptRange - Song',
          format: 'sng',
          tmpKey,
          ...dirs
        },
        () => {}
      )
    ).rejects.toMatchObject({ step: 'fetch', name: 'DownloadError' })
    // The part can't be trusted for a retry: it must be gone to break the loop.
    expect(existsSync(join(dirs.tmpDir, `${tmpKey}.part`))).toBe(false)
  })

  it('keeps the part file after a mid-stream failure', async () => {
    const tmpKey = '1'.repeat(32)
    await expect(
      runDownload(
        {
          url: `${baseUrl}/half.sng`,
          folderName: 'Half - Song',
          format: 'sng',
          tmpKey,
          ...dirs
        },
        () => {}
      )
    ).rejects.toMatchObject({ step: 'fetch', name: 'DownloadError' })
    const partPath = join(dirs.tmpDir, `${tmpKey}.part`)
    expect(existsSync(partPath)).toBe(true)
    expect(statSync(partPath).size).toBeGreaterThan(0)
  })

  it('extracts a folder-format download via parse-sng', async () => {
    const tmpKey = '2'.repeat(32)
    const finalPath = await runDownload(
      {
        url: `${baseUrl}/fixture.sng`,
        folderName: 'Sng Artist - Sng Song',
        format: 'folder',
        tmpKey,
        ...dirs
      },
      () => {}
    )
    expect(finalPath).toBe(join(dirs.destDir, 'Sng Artist - Sng Song'))
    expect(statSync(finalPath).isDirectory()).toBe(true)
    const ini = readFileSync(join(finalPath, 'song.ini'), 'utf8')
    expect(ini).toContain('artist = Sng Artist')
    const chart = readFileSync(join(finalPath, 'notes.chart'), 'utf8')
    expect(chart).toContain('[ExpertSingle]')
    expect(existsSync(join(dirs.tmpDir, `${tmpKey}.part`))).toBe(false)
  })
})
