import { open, rm, type FileHandle } from 'node:fs/promises'
import { readRepackPlanFromStream, type RepackPlan } from './sng-repack'
import { maskChunk } from './sng-write'
import type { SngEntry } from './sng'

/**
 * Reads a `.sng` the way the scanner uses one: the few files scan-chart opens, and the names of
 * everything else.
 *
 * `extractSngEntries` pulls the whole archive into memory and XOR-decrypts every byte of it, and
 * the scanner then throws the audio and video away. Measured across 25 archives of the reference
 * library: 441.6 MiB read, 11.1 MiB used, or 2.5%. A 15 MiB chart needs 0.28 MiB of itself.
 *
 * This module reads the header, decides per entry whether scan-chart will ever look at its
 * bytes, and fetches only those by positional read. Two facts from M10's repack work make that
 * possible, and `sng-repack.ts` documents both at length:
 *
 * 1. The whole layout (names, lengths, absolute offsets, metadata, mask) arrives with
 *    parse-sng's `header` event, one 64 KiB read even on a 519 MiB archive.
 * 2. The XOR mask keys off each byte's index WITHIN ITS OWN FILE, so an entry decrypts from a
 *    positional read with nothing before it touched.
 *
 * What it costs is the one thing parse-sng was doing for us: the synthesised `song.ini`. A .sng
 * keeps title, artist, charter and difficulties in its header, not in a file, and scan-chart
 * reads metadata from `song.ini` or not at all. M5 exists because that generation was missing.
 * Positional reads bypass the file streaming that produced it, so `generateSongIniText` below
 * reproduces parse-sng's own generator. That function is the risk in this module; its comment
 * says what "reproduces" had to mean.
 */

export interface SelectiveSngRead {
  /**
   * The same shape, names and order `extractSngEntries` returns, with `data` empty for every
   * file scan-chart only counts rather than reads.
   */
  entries: SngEntry[]
  /** Bytes actually read from the archive, header included. The reason this module exists. */
  bytesRead: number
}

/**
 * How much of the archive is fetched before the header is parsed.
 *
 * parse-sng is handed chunks until it has the whole header; 64 KiB has covered it in one read
 * for every archive measured, and an oversized one simply costs a second read rather than
 * failing. This is also the module's floor: a chart whose needed files total 20 KiB still costs
 * this much.
 */
const HEADER_READ_BYTES = 64 * 1024

/**
 * parse-sng emits its generated song.ini under exactly this name, and `extractSngEntries` keys
 * its dedupe on it. Both are matched here.
 */
const SONG_INI = 'song.ini'

/** An entry as the header describes it: a name and a byte range. */
interface ArchiveEntry {
  fileName: string
  offset: number
  byteLength: number
}

/**
 * scan-chart's own extension rule, not a regular expression over the name.
 *
 * `getExtension` in scan-chart/src/utils.ts is `_.last(fileName.split('.'))`, which returns the
 * whole name when there is no dot. A file named `chart` is therefore a chart file to scan-chart,
 * and a `/\.chart$/` test here would hand it zero bytes and turn a parse into a `badChart` issue.
 */
function extensionOf(fileName: string): string {
  return (fileName.split('.').pop() ?? '').toLowerCase()
}

/** Extensions whose bytes scan-chart parses: `.ini` in ini-scanner, `.chart`/`.mid` in chart-scanner. */
const PARSED_EXTENSIONS = ['ini', 'chart', 'mid']

/**
 * scan-chart's `hasAlbumName` matches three lower-case names exactly. This is deliberately the
 * case-insensitive form: the extra file it can pull in is one small image, and the alternative
 * is a module that silently starves scan-chart of album art the day that matcher relaxes.
 */
const ALBUM_ART = /^album\.(png|jpe?g)$/i

/**
 * Whether scan-chart will read this file's bytes, as opposed to only noticing that it exists.
 *
 * Exported because the folder branch of the scan needs the same answer, and the rule is worth
 * having in one place: it is a transcription of scan-chart's source, not a guess anyone should
 * make twice.
 *
 * Established from scan-chart 8's source rather than assumed: `file.data` is consumed in exactly
 * four places. ini-scanner (any `.ini`, including one not named song.ini, which it may still
 * fall back to), chart-scanner (`.chart`/`.mid`) and image-scanner (album art) read it.
 * audio-scanner and video-scanner collect it into locals they never inspect: `noAudio`,
 * `multipleAudio`, `invalidAudio`, `badVideo`, `multipleVideo` and `hasVideoBackground` are all
 * decided from file names alone. The fifth reader is the whole-folder md5, which both of this
 * app's scan callers disable with `includeMd5: false`; a caller that turned it on would get a
 * different hash through this path, and it would be meaningless either way with the audio gone.
 */
export function isParsedByScanChart(fileName: string): boolean {
  return PARSED_EXTENSIONS.includes(extensionOf(fileName)) || ALBUM_ART.test(fileName)
}

/**
 * A plan read off disk describes every entry as a copy from where it already sits; the `data`
 * variant only appears once a caller adds an entry, which nothing here does. `flatMap` narrows
 * the union on that fact without inventing a branch that cannot run.
 */
function archiveEntries(plan: RepackPlan): ArchiveEntry[] {
  return plan.entries.flatMap((entry) =>
    entry.source.kind === 'copy'
      ? [
          {
            fileName: entry.fileName,
            offset: entry.source.offset,
            byteLength: entry.source.byteLength
          }
        ]
      : []
  )
}

/**
 * Read one entry whole and decrypt it.
 *
 * The buffer is exact-sized and its own, never a view into a reused one, because scan-chart
 * hands album art to exifreader as `data.buffer`, the underlying ArrayBuffer rather than the
 * view. A subarray of a scratch buffer would have exifreader reading whatever surrounded the
 * image and reporting `badAlbumArt` for a perfectly good cover.
 *
 * Unmasking in place is the XOR being its own inverse, at `entryIndex` 0 because the mask counts
 * from the start of each file rather than from the start of the archive.
 */
async function readEntry(
  handle: FileHandle,
  entry: ArchiveEntry,
  xorMask: Uint8Array
): Promise<Uint8Array> {
  const data = new Uint8Array(entry.byteLength)
  let at = 0
  while (at < entry.byteLength) {
    // A short read here means the archive no longer holds what its header promised: it was
    // truncated, or the header lied. Padding the rest with zeroes would scan as a corrupt chart
    // file.
    const { bytesRead } = await handle.read(data, at, entry.byteLength - at, entry.offset + at)
    if (bytesRead <= 0) {
      throw new Error(
        `.sng ended before ${entry.fileName} could be read (wanted ${entry.byteLength} bytes at ${entry.offset}, got ${at})`
      )
    }
    at += bytesRead
  }
  maskChunk(data, data, 0, xorMask)
  return data
}

/**
 * Read `sngPath` as scan-chart input, touching as little of it as the scan allows.
 *
 * The returned list is `extractSngEntries`' list. song.ini comes first, generated from the header
 * or taken from the archive's own if it packs one, then every entry in header order, deduped by
 * name with the later occurrence's data in the earlier one's slot. That is not cosmetic. scan-chart
 * resolves duplicate .ini, chart, art and video files by position, so an order that differs from
 * the old path's is a chart that scans differently.
 */
export async function readSngEntriesForScan(sngPath: string): Promise<SelectiveSngRead> {
  const handle = await open(sngPath, 'r')
  let bytesRead = 0
  try {
    let headerParsed = false
    let position = 0
    const source = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          // Only reachable if parse-sng is still asking; once the plan has resolved the stream
          // is abandoned mid-archive, and a pull that outlived it must not read a closing fd.
          if (headerParsed) {
            controller.close()
            return
          }
          const buffer = new Uint8Array(HEADER_READ_BYTES)
          const read = await handle.read(buffer, 0, HEADER_READ_BYTES, position)
          bytesRead += read.bytesRead
          position += read.bytesRead
          if (read.bytesRead === 0) {
            controller.close()
            return
          }
          controller.enqueue(buffer.subarray(0, read.bytesRead))
        }
      },
      // A queue of zero, so a chunk is read only when parse-sng is waiting on one. At the
      // default of one chunk the stream would prefetch the 64 KiB after the header: bytes
      // nobody ever reads, on every chart in the library.
      { highWaterMark: 0 }
    )
    const plan = await readRepackPlanFromStream(source)
    headerParsed = true

    // Keyed by name, and seeded with the generated song.ini, exactly as extractSngEntries is: a
    // packed song.ini then replaces its data while keeping its slot, and no chart ends up with
    // two .ini files where the archive has one.
    const entries = new Map<string, SngEntry>()
    entries.set(SONG_INI, { fileName: SONG_INI, data: generateSongIniText(plan.metadata) })
    for (const entry of archiveEntries(plan)) {
      let data: Uint8Array = new Uint8Array(0)
      if (isParsedByScanChart(entry.fileName)) {
        data = await readEntry(handle, entry, plan.xorMask)
        bytesRead += entry.byteLength
      }
      entries.set(entry.fileName, { fileName: entry.fileName, data })
    }
    return { entries: [...entries.values()], bytesRead }
  } finally {
    await handle.close()
  }
}

/**
 * How much of an entry is decrypted at once by `extractSngEntryToFile`. Same reasoning as the
 * repacker's chunk: large enough that a 159 MB video is ~160 round trips, small enough that the
 * peak is a constant.
 */
const EXTRACT_CHUNK_BYTES = 1024 * 1024

/**
 * Write one entry's decrypted bytes to `destPath`, holding a chunk at a time.
 *
 * `readEntry` above allocates the whole entry, which is right for the files scan-chart parses (a
 * song.ini or a cover) and wrong for the one caller that wants a video. M14's `badVideo` fix has
 * to hand ffmpeg a real file, and the videos in the reference library run to 159 MB. The
 * unmasking is identical; only where the bytes land differs.
 *
 * `destPath` must not already exist (opened `wx`), so a leftover from a previous attempt is a
 * loud failure rather than a file the caller believes it just wrote. On any failure the partial
 * destination is removed.
 *
 * Returns the number of bytes written, which is the entry's declared length.
 */
export async function extractSngEntryToFile(
  sngPath: string,
  plan: RepackPlan,
  fileName: string,
  destPath: string
): Promise<number> {
  const entry = archiveEntries(plan).find((e) => e.fileName === fileName)
  if (!entry) throw new Error(`${sngPath} has no entry named ${fileName}`)

  const chunk = Buffer.allocUnsafe(Math.min(EXTRACT_CHUNK_BYTES, Math.max(entry.byteLength, 1)))
  const handle = await open(sngPath, 'r')
  try {
    const dest = await open(destPath, 'wx')
    try {
      let at = 0
      while (at < entry.byteLength) {
        const want = Math.min(chunk.length, entry.byteLength - at)
        let got = 0
        while (got < want) {
          const { bytesRead } = await handle.read(chunk, got, want - got, entry.offset + at + got)
          if (bytesRead <= 0) {
            throw new Error(
              `.sng ended before ${fileName} could be read (wanted ${entry.byteLength} bytes at ${entry.offset}, got ${at + got})`
            )
          }
          got += bytesRead
        }
        // In place, from this chunk's offset WITHIN THE ENTRY: the mask counts from the start of
        // each file, so a chunk read at `at` must be unmasked at `at`, not at 0.
        maskChunk(chunk, chunk.subarray(0, want), at, plan.xorMask)
        // A positional write is allowed to be short; a partial write treated as complete would
        // hand ffmpeg a file with a hole in it.
        let written = 0
        while (written < want) {
          const { bytesWritten } = await dest.write(chunk, written, want - written, at + written)
          if (bytesWritten <= 0) {
            throw new Error(`Writing ${fileName} made no progress at offset ${at + written}`)
          }
          written += bytesWritten
        }
        at += want
      }
      await dest.close()
    } catch (err) {
      await dest.close().catch(() => {})
      await rm(destPath, { force: true }).catch(() => {})
      throw err
    }
  } finally {
    await handle.close()
  }
  return entry.byteLength
}

/**
 * parse-sng's `defaultMetadata`, copied from parse-sng 4.0.3's index.ts.
 *
 * Both halves of it are load-bearing. The values decide which keys are omitted as unset, and the
 * KEY ORDER decides the order of the generated file's lines, because `generateIniFileText` walks
 * `Object.keys(defaultMetadata)`. Rearranging this object rewrites every generated song.ini.
 *
 * It is not scan-chart's `defaultMetadata`, which is a different list (it adds
 * `sustain_cutoff_threshold` and `chord_snap_threshold`, drops `playlist`, and types values
 * rather than stringifying them). The file has to match what parse-sng would have written, so
 * this table follows parse-sng.
 */
const PARSE_SNG_DEFAULT_METADATA: Record<string, string> = {
  name: 'Unknown Name',
  artist: 'Unknown Artist',
  album: 'Unknown Album',
  genre: 'Unknown Genre',
  year: 'Unknown Year',
  charter: 'Unknown Charter',
  song_length: '0',
  diff_band: '-1',
  diff_guitar: '-1',
  diff_guitar_coop: '-1',
  diff_rhythm: '-1',
  diff_bass: '-1',
  diff_drums: '-1',
  diff_drums_real: '-1',
  diff_keys: '-1',
  diff_guitarghl: '-1',
  diff_guitar_coop_ghl: '-1',
  diff_rhythm_ghl: '-1',
  diff_bassghl: '-1',
  diff_vocals: '-1',
  preview_start_time: '-1',
  icon: '',
  loading_phrase: '',
  album_track: '16000',
  playlist_track: '16000',
  playlist: '',
  modchart: 'False',
  delay: '0',
  hopo_frequency: '0',
  eighthnote_hopo: 'False',
  multiplier_note: '0',
  video_start_time: '0',
  five_lane_drums: 'False',
  pro_drums: 'False',
  end_events: 'True'
}

const PARSE_SNG_DEFAULT_KEYS = Object.keys(PARSE_SNG_DEFAULT_METADATA)

/**
 * The `song.ini` parse-sng would have synthesised from this header metadata.
 *
 * A reimplementation of parse-sng's internal, unexported `generateIniFileText`, transcribed from
 * parse-sng 4.0.3's index.ts and kept deliberately literal. Every apparent quirk below is a
 * quirk of the file scan-chart has always been given:
 *
 * - The section header is lower-case `[song]`. scan-chart accepts `song`, `Song` or `SONG`, so
 *   this is invisible to it, and it is what a chart's own tooling would see.
 * - Known keys come first, in this module's table order, and only when the value is non-empty
 *   AND differs from the default. A key holding its default is left out entirely, which is what
 *   makes scan-chart report `missingValue` for it. That is the existing behaviour rather than a
 *   bug introduced here.
 * - Unknown keys follow, in the header's own order, with NO empty-value check. An extra key set
 *   to the empty string does emit a `key = ` line. parse-sng only guards the known ones.
 * - The separator is exactly `key = value`, and nothing is escaped or quoted. scan-chart splits
 *   on the first `=` and trims, so a value containing `=` survives; a value containing a newline
 *   does not, in either implementation.
 * - Empty metadata yields a bare `[song]` line rather than no file, which is why an archive with
 *   an empty header scans as `invalidMetadata` rather than `noMetadata`. Also pre-existing; see
 *   the note on `extractSngEntries`.
 *
 * Exported for its own tests. The equivalence that matters is asserted against parse-sng itself:
 * this module's tests compare the generated bytes to `extractSngEntries`' on the same archive.
 */
export function generateSongIniText(metadata: Record<string, string>): Uint8Array {
  const keys = Object.keys(metadata)
  if (keys.length === 0) return new TextEncoder().encode('[song]\n')

  let ini = '[song]\n'
  for (const key of PARSE_SNG_DEFAULT_KEYS) {
    if (metadata[key] && metadata[key] !== PARSE_SNG_DEFAULT_METADATA[key]) {
      ini += `${key} = ${metadata[key]}\n`
    }
  }
  for (const key of keys) {
    // `includes` on the key list, not `in` on the object: `in` would also match every key
    // Object.prototype carries, so metadata holding a `constructor` or `toString` key would
    // lose it here and keep it in parse-sng's output.
    if (PARSE_SNG_DEFAULT_KEYS.includes(key)) continue
    ini += `${key} = ${metadata[key]}\n`
  }
  return new TextEncoder().encode(ini)
}
