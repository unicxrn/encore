import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { JobProgress } from '../shared-types'
import { extractSngEntries, readSngFile } from './sng'

export type DownloadStep = 'check' | 'fetch' | 'finalize'

export class DownloadError extends Error {
  constructor(
    public step: DownloadStep,
    message: string
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

export interface DownloadJob {
  url: string
  folderName: string
  format: 'sng' | 'folder'
  destDir: string
  tmpDir: string
  /** Stable identifier (the chart md5) keying the resumable .part file. */
  tmpKey: string
  signal?: AbortSignal
}

export async function runDownload(
  job: DownloadJob,
  onProgress: (p: JobProgress) => void
): Promise<string> {
  const report = (phase: DownloadStep, percent: number | null): void =>
    onProgress({
      jobId: job.url,
      kind: 'download',
      phase,
      percent,
      message: null,
      status: 'running'
    })

  // Step 1: check
  report('check', null)
  const finalPath = join(
    job.destDir,
    job.format === 'sng' ? `${job.folderName}.sng` : job.folderName
  )
  if (existsSync(finalPath))
    throw new DownloadError('check', 'This chart is already in your library')
  mkdirSync(job.tmpDir, { recursive: true })
  const partPath = join(job.tmpDir, `${job.tmpKey}.part`)
  const partSize = existsSync(partPath) ? statSync(partPath).size : 0

  // Step 2: fetch. Resume from the part file when one exists.
  report('fetch', partSize > 0 ? null : 0)
  try {
    const headers: HeadersInit = partSize > 0 ? { Range: `bytes=${partSize}-` } : {}
    const response = await fetch(job.url, { signal: job.signal, headers })
    if (response.status === 416) {
      // Requested range starts at/after the end: the part file is already
      // complete, but if the server reports its total, verify the sizes match.
      const totalMatch = /^bytes \*\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
      if (totalMatch && Number(totalMatch[1]) !== partSize) {
        rmSync(partPath, { force: true })
        throw new DownloadError(
          'fetch',
          `Part file size ${partSize} does not match server total ${totalMatch[1]}`
        )
      }
    } else {
      if (!response.ok || !response.body) {
        throw new DownloadError('fetch', `Download failed: HTTP ${response.status}`)
      }
      // 206 → verify the range actually continues our part file before appending;
      // 200 → server ignored Range, restart fresh.
      let head = 0
      if (response.status === 206) {
        const rangeMatch = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(
          response.headers.get('content-range') ?? ''
        )
        const start = rangeMatch ? Number(rangeMatch[1]) : NaN
        if (start === partSize) {
          head = partSize
        } else if (start !== 0) {
          // A range that neither continues the part nor restarts from 0 would
          // corrupt the file, and the part can't be trusted for a retry either.
          rmSync(partPath, { force: true })
          throw new DownloadError(
            'fetch',
            `Server returned unusable Content-Range "${response.headers.get('content-range')}" for Range: bytes=${partSize}-`
          )
        }
        // start === 0: treat as a full restart (truncate path below).
      }
      const contentLength = Number(response.headers.get('content-length')) || null
      const total = contentLength === null ? null : head + contentLength
      let received = head
      // Matches the report just above (head-start percent, or 0 for a fresh
      // download) so a first sub-percent chunk isn't repeated.
      let lastPercent = total ? Math.round((received / total) * 100) : 0
      if (head > 0 && total) report('fetch', lastPercent)
      const counter = async function* (
        source: AsyncIterable<Uint8Array>
      ): AsyncGenerator<Uint8Array> {
        for await (const chunk of source) {
          received += chunk.length
          if (total) {
            const percent = Math.round((received / total) * 100)
            if (percent !== lastPercent) {
              lastPercent = percent
              report('fetch', percent)
            }
          }
          yield chunk
        }
      }
      await pipeline(
        counter(Readable.fromWeb(response.body as import('stream/web').ReadableStream<Uint8Array>)),
        createWriteStream(partPath, { flags: head > 0 ? 'a' : 'w' })
      )
    }
  } catch (err) {
    // Keep the part file: it is the resume point for the next attempt. A non-ok
    // status wrote nothing for that response, so the existing part stays valid.
    if (err instanceof DownloadError) throw err
    throw new DownloadError('fetch', err instanceof Error ? err.message : String(err))
  }

  // Step 3: finalize
  report('finalize', null)
  try {
    if (job.format === 'sng') {
      renameSync(partPath, finalPath)
    } else {
      // readSngFile, not a bare stream: the rmSync below unlinks this same file, and the catch
      // that a failed unlink would land in deletes the chart folder that was just extracted
      // successfully. Holding a descriptor across that is not worth the risk on a platform this
      // has never run on.
      const entries = await readSngFile(partPath, extractSngEntries)
      mkdirSync(finalPath, { recursive: true })
      for (const entry of entries) {
        // .sng entries are flat file names; strip any path components so a
        // malicious archive cannot write outside finalPath.
        const safeName = basename(entry.fileName.replaceAll('\\', '/'))
        if (!safeName || safeName === '.' || safeName === '..') {
          throw new DownloadError('finalize', `Unsafe entry name in archive: ${entry.fileName}`)
        }
        writeFileSync(join(finalPath, safeName), entry.data)
      }
      rmSync(partPath, { force: true })
    }
  } catch (err) {
    // The completed part file is still a valid archive, so keep it and drop
    // only the partially written destination directory.
    if (job.format === 'folder') rmSync(finalPath, { recursive: true, force: true })
    if (err instanceof DownloadError) throw err
    throw new DownloadError('finalize', err instanceof Error ? err.message : String(err))
  }
  onProgress({
    jobId: job.url,
    kind: 'download',
    phase: 'finalize',
    percent: 100,
    message: finalPath,
    status: 'done'
  })
  return finalPath
}
