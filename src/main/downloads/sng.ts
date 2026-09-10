import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { SngStream } from 'parse-sng'

export interface SngEntry {
  fileName: string
  data: Uint8Array
}

/**
 * Read a `.sng` straight off disk, with the descriptor closed before the promise settles.
 *
 * Both readers below resolve on the last ENTRY rather than on the source stream's EOF, and
 * `Readable.toWeb` hands the descriptor to a stream parse-sng keeps locked, so nothing on the
 * read path closes it. Measured on Linux through /proc/self/fd: after either reader resolves the
 * descriptor is still open, and autoClose only gets to it some ticks later.
 *
 * That is invisible on Linux and is exactly the wrong shape for Windows, because both callers'
 * next move is to mutate the file they have just read: `writeSngAsset` renames its rebuilt temp
 * over the archive, `runDownload` unlinks the finished `.part`. Whether Windows would actually
 * refuse those depends on share modes that cannot be exercised from here; closing first removes
 * the question rather than leaving it to timing. It also drops the peak descriptor count of a
 * batch, which is a real if small win on every platform.
 *
 * Streaming rather than `readFileSync`: see the note on `sng-asset.ts`'s repack ceiling for what
 * the whole-file copies cost in peak RSS.
 */
export async function readSngFile<T>(
  path: string,
  read: (source: ReadableStream<Uint8Array>) => Promise<T>
): Promise<T> {
  const file = createReadStream(path)
  try {
    return await read(Readable.toWeb(file) as ReadableStream<Uint8Array>)
  } finally {
    // Awaited, not fire-and-forget: `destroy()` only schedules the close, so returning before
    // 'close' would leave the descriptor open for exactly the window this exists to shut.
    await new Promise<void>((resolve) => {
      if (file.closed) {
        resolve()
        return
      }
      file.once('close', resolve)
      file.destroy()
    })
  }
}

/**
 * Fully extracts a .sng archive into memory via parse-sng.
 *
 * Shared by the download finalize step (folder-format extraction) and the
 * library scanner (.sng metadata). Keep it free of download.ts internals.
 *
 * `generateSongIni` is REQUIRED, not an option. A .sng keeps the song's title, artist,
 * charter and difficulty ratings in its archive header, and parse-sng only materializes them
 * as a song.ini file when asked. Packing a real song.ini as a file entry is legal but rare:
 * none of the 137 archives in the library this was debugged against did. Without generation,
 * every consumer here breaks: scan-chart reported noMetadata for all 137, charts whose title
 * exists nowhere but the header showed as raw paths, and folder-format downloads landed on
 * disk with no song.ini for Clone Hero to read.
 *
 * parse-sng emits its generated song.ini unconditionally and first, so an archive that does
 * pack one yields the name twice. Deduping by name keeps the packed file (it can carry fields
 * the header does not) and, more importantly, stops scan-chart seeing two .ini files and
 * reporting a multipleIniFiles problem that isn't real.
 *
 * One regression is accepted: for an archive with an empty header, the generated song.ini is
 * a bare `[song]` line, so scan-chart now says invalidMetadata where it used to say
 * noMetadata. Same one row, slightly odd wording, and no such archive has been seen.
 */
export async function extractSngEntries(
  source: ReadableStream<Uint8Array> | Uint8Array
): Promise<SngEntry[]> {
  const stream =
    source instanceof Uint8Array
      ? (new Blob([source as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>)
      : source
  // Keyed by file name so a duplicate replaces rather than appends; a Map keeps the original
  // position, so the generated song.ini's slot is reused by the packed one.
  const entries = new Map<string, SngEntry>()
  await new Promise<void>((resolve, reject) => {
    const sng = new SngStream(stream, { generateSongIni: true })
    sng.on('file', (fileName, fileStream, nextFile) => {
      void (async () => {
        const chunks: Uint8Array[] = []
        const reader = fileStream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        entries.set(fileName, { fileName, data: new Uint8Array(Buffer.concat(chunks)) })
        if (nextFile) nextFile()
        else resolve()
      })().catch(reject)
    })
    sng.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    sng.start()
  })
  return [...entries.values()]
}

export interface SngForRepack {
  entries: SngEntry[]
  /** Arbitrary key/value pairs straight from the archive header; no key is guaranteed present. */
  metadata: Record<string, string>
}

/**
 * Read an archive exactly as it exists on disk: the real file entries, plus the header
 * metadata as its own value.
 *
 * Deliberately NOT extractSngEntries. That function asks parse-sng to synthesise a song.ini
 * from the header so scan-chart can read the metadata: correct for scanning, wrong for
 * repacking, where the synthetic file would be written into the rebuilt archive as a real
 * entry and become a second, diverging copy of the header. None of the 162 .sng archives in
 * the reference library packs a real song.ini (re-measured across all of them at the close of
 * M6, having first been measured at 137), so every one of them would have gained one.
 *
 * With `generateSongIni: false` parse-sng emits the header untouched, so `fileMeta` (and
 * therefore the `file` events) are exactly the archive's own entries (parse-sng index.js
 * only unshifts its synthetic song.ini when generation is on).
 */
export async function readSngForRepack(
  source: ReadableStream<Uint8Array> | Uint8Array
): Promise<SngForRepack> {
  const stream =
    source instanceof Uint8Array
      ? (new Blob([source as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>)
      : source
  const entries: SngEntry[] = []
  let metadata: Record<string, string> = {}
  await new Promise<void>((resolve, reject) => {
    const sng = new SngStream(stream, { generateSongIni: false })
    sng.on('header', (header) => {
      metadata = header.metadata
      // An archive with no entries emits `header` and then nothing: parse-sng only continues
      // by reading the first fileMeta entry, and there isn't one. Resolving solely from the
      // `file` handler below leaves this promise pending forever. Measured, not assumed.
      if (header.fileMeta.length === 0) resolve()
    })
    sng.on('file', (fileName, fileStream, nextFile) => {
      void (async () => {
        const chunks: Uint8Array[] = []
        const reader = fileStream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        entries.push({ fileName, data: new Uint8Array(Buffer.concat(chunks)) })
        if (nextFile) nextFile()
        else resolve()
      })().catch(reject)
    })
    sng.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))))
    sng.start()
  })
  return { entries, metadata }
}
