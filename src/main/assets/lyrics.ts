import { readFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { readSngForRepack } from '../downloads/sng'
import { assertUnderLibrary } from './library-guard'
import { writeSngAsset } from './sng-asset'
import { chartFileContent, writeWithUndo } from './undoable-write'
import { writeChartAsset } from './write'

// ─── tempo map ───────────────────────────────────────────────────────────────

export interface TempoSegment {
  /** Tick where this tempo takes effect. */
  tick: number
  /** Milliseconds per tick while this tempo is active. */
  msPerTick: number
  /** Cumulative milliseconds from tick 0 to this segment's start tick. */
  msAtTick: number
}

export interface TempoMap {
  resolution: number
  /** Sorted by tick; always starts with a segment at tick 0. */
  tempos: TempoSegment[]
}

const DEFAULT_RESOLUTION = 192
/** scan-chart's convention: charts without tempo info are treated as 120 BPM. */
const DEFAULT_MILLI_BPM = 120000

/**
 * Extract the body lines of a `[Name] { ... }` chart section. Line-based on
 * purpose: a `}` inside a quoted value cannot terminate the section because
 * only a line that IS `}` (after trimming) closes it.
 */
function extractSection(chartText: string, name: string): string[] | null {
  const lines = chartText.split(/\r?\n/)
  const header = `[${name.toLowerCase()}]`
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== header) continue
    const body: string[] = []
    let j = i + 1
    if (lines[j]?.trim() === '{') j++
    for (; j < lines.length && lines[j].trim() !== '}'; j++) body.push(lines[j])
    return body
  }
  return null
}

/**
 * Parse the chart's [Song] Resolution and [SyncTrack] B events (milli-BPM:
 * `0 = B 120000` is 120 BPM) into cumulative tempo segments. A chart without
 * a SyncTrack or without B events gets the 120 BPM default at tick 0.
 */
export function parseTempoMap(chartText: string): TempoMap {
  let resolution = DEFAULT_RESOLUTION
  const song = extractSection(chartText, 'Song')
  for (const line of song ?? []) {
    const m = line.match(/^\s*Resolution\s*=\s*(\d+)\s*$/i)
    if (m) resolution = Number(m[1])
  }

  const raw: { tick: number; milliBpm: number }[] = []
  for (const line of extractSection(chartText, 'SyncTrack') ?? []) {
    const m = line.match(/^\s*(\d+)\s*=\s*B\s+(\d+)\s*$/)
    if (m) raw.push({ tick: Number(m[1]), milliBpm: Number(m[2]) })
  }
  raw.sort((a, b) => a.tick - b.tick)
  if (raw.length === 0 || raw[0].tick > 0) {
    raw.unshift({ tick: 0, milliBpm: DEFAULT_MILLI_BPM })
  }
  // Duplicate ticks: the later event wins (charts occasionally re-state a BPM).
  const deduped = raw.filter((t, i) => i === raw.length - 1 || raw[i + 1].tick !== t.tick)

  const tempos: TempoSegment[] = []
  for (const { tick, milliBpm } of deduped) {
    // bpm = milliBpm / 1000; msPerTick = 60000 / (bpm * resolution).
    const msPerTick = 60_000_000 / (milliBpm * resolution)
    const prev = tempos[tempos.length - 1]
    const msAtTick = prev ? prev.msAtTick + (tick - prev.tick) * prev.msPerTick : 0
    tempos.push({ tick, msPerTick, msAtTick })
  }
  return { resolution, tempos }
}

/**
 * Read `[Song] Offset` and return it in milliseconds (0 when absent or
 * unparseable). Positive means the chart's tick 0 sits that far INTO the audio,
 * so a position in the audio maps to chart time `audioMs - offsetMs`.
 *
 * Both halves of that were checked against sources, because a sign or unit
 * error here is silent: the lyrics still appear, just in the wrong place.
 *
 * UNIT: seconds, not milliseconds, and the same quantity as song.ini's `delay`
 * rather than its opposite. Two independent implementations say so. YARG's
 * SongRunner.cs names both keys in one breath: "song offsets (`delay = 1234` in
 * song.ini, `Offset = 1.234` in .chart)". Same value, same sign, ms vs s. And
 * scan-chart converts one into the other: chart/chart-parser.ts writes
 * `delay: Number(metadata['Offset']) * 1000` under the comment `"Offset" and
 * "PreviewStart" are in units of seconds`, while ini/ini-scanner.ts marks
 * song.ini's `delay` `Units of ms`. The reference library agrees on magnitude:
 * its three nonzero values are 0.6, 3 and -5.05, sane as seconds and absurd as
 * ms.
 *
 * DIRECTION: a positive Offset delays the notes relative to the audio. Same
 * SongRunner.cs, which is the code that actually plays a chart: it stores
 * `SongOffset = -songOffset` under the remark "Be aware that this value is
 * negated! Positive offsets in the .ini or .chart will result in a negative
 * number here", computes `AudioTime => AudioPlaybackTime + SongOffset`, and
 * works the example "with an offset of 15 seconds, the 0-point for input time
 * will be 15 seconds into audio playback". Clone Hero's own song.ini guide says
 * of `delay`: "Positive numbers will make the chart start later." Both give
 * chartTime = audioTime - offset, which is what the caller applies.
 *
 * Deliberately NOT part of parseTempoMap/TempoMap: an offset is song-level
 * audio alignment, not tempo data, and msToTick is exported and asserted on its
 * own as a pure tempo-grid conversion. Folding the offset in would silently
 * change what every one of those assertions means.
 *
 * Do not reach for scan-chart's `ScannedChart.chart_offset` instead of this.
 * Its typedoc says seconds, but index.ts assigns it `chartData.metadata?.delay`,
 * which that same parser produced in milliseconds, so it is off by 1000.
 */
export function parseSongOffsetMs(chartText: string): number {
  let offsetSeconds = 0
  for (const line of extractSection(chartText, 'Song') ?? []) {
    // Last wins, matching how parseTempoMap treats a repeated Resolution.
    const m = line.match(/^\s*Offset\s*=\s*([-+]?\d*\.?\d+)\s*$/i)
    if (m) offsetSeconds = Number(m[1])
  }
  return offsetSeconds * 1000
}

/**
 * Convert a millisecond position to the nearest tick by walking the tempo
 * segments: find the segment containing `ms`, convert the remainder at that
 * segment's tick rate, round to nearest (half up), clamp at 0.
 */
export function msToTick(map: TempoMap, ms: number): number {
  if (ms <= 0) return 0
  let segment = map.tempos[0]
  for (const t of map.tempos) {
    if (t.msAtTick <= ms) segment = t
    else break
  }
  const tick = segment.tick + (ms - segment.msAtTick) / segment.msPerTick
  return Math.max(0, Math.round(tick))
}

// ─── LRC parsing ─────────────────────────────────────────────────────────────

interface LrcLine {
  ms: number
  text: string
}

// `[mm:ss.xx] text`, where the fraction may be tenths, hundredths, or milliseconds.
// Metadata lines like `[ar: ...]` do not match (seconds must be two digits).
const LRC_LINE_RE = /^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/

/** Parse synced LRC text into ms-sorted lines; empty-text lines are dropped. */
function parseLrc(lrc: string): LrcLine[] {
  const out: LrcLine[] = []
  for (const rawLine of lrc.split(/\r?\n/)) {
    const m = rawLine.trim().match(LRC_LINE_RE)
    if (!m) continue
    const text = m[4].trim()
    if (!text) continue // instrumental gap markers carry no words
    const fractionMs = m[3] ? Number(m[3].padEnd(3, '0')) : 0
    out.push({ ms: Number(m[1]) * 60_000 + Number(m[2]) * 1000 + fractionMs, text })
  }
  return out.sort((a, b) => a.ms - b.ms)
}

// ─── .chart lyric injection ──────────────────────────────────────────────────

interface ChartEvent {
  tick: number
  text: string
}

const EVENT_LINE_RE = /^\s*(\d+)\s*=\s*E\s+"(.*)"\s*$/

function isLyricEvent(text: string): boolean {
  return (
    text === 'phrase_start' ||
    text === 'phrase_end' ||
    text === 'lyric' ||
    text.startsWith('lyric ')
  )
}

function renderEventsSection(events: ChartEvent[], eol: string): string {
  const body = events.map((e) => `  ${e.tick} = E "${e.text}"`)
  return ['[Events]', '{', ...body, '}'].join(eol)
}

/**
 * The one explanation for "we cannot put lyrics in this kind of chart file".
 *
 * Callers pass the chart file's extension, whether it came from a path on disk or from an entry
 * inside a `.sng`. The limitation is identical in both places, since binary MIDI surgery is out
 * of scope, so the user must not be given two different stories about it.
 */
function unsupportedChartFileError(ext: string): Error {
  return new Error(
    `Lyrics can only be injected into .chart files; ${ext || 'this file'} is not supported yet`
  )
}

/**
 * Rewrite a .chart file's [Events] section around synced LRC lyrics, returning the new text.
 *
 * Pure: it neither reads nor writes, so the caller decides where the text comes from (a file on
 * disk, or an entry unpacked from a `.sng`) and where it goes.
 *
 * SIMPLIFICATION (documented v1): Clone Hero lyric events are per-syllable
 * with per-syllable timing; LRC only times whole lines. We emit a
 * `phrase_start` at the line's tick, every word of the line as `lyric <word>`
 * at that same tick (the words display together), and `phrase_end` at the
 * next line's tick (or line tick + 4 beats for the last line). Bridge does a
 * smarter within-line distribution; that is backlog for a later pass.
 */
function injectIntoChartText(original: string, syncedLrc: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const map = parseTempoMap(original)
  const offsetMs = parseSongOffsetMs(original)

  const lrcLines = parseLrc(syncedLrc)
  if (lrcLines.length === 0) {
    throw new Error('No synced lyric lines found in the LRC text')
  }

  // Existing [Events] entries minus all lyric/phrase events (replace, never
  // duplicate). Anything that fails to parse as an event line is dropped,
  // because [Events] bodies contain only `tick = E "..."` lines by format.
  const kept: ChartEvent[] = []
  for (const line of extractSection(original, 'Events') ?? []) {
    const m = line.match(EVENT_LINE_RE)
    if (!m) continue
    const text = m[2]
    if (!isLyricEvent(text)) kept.push({ tick: Number(m[1]), text })
  }

  const injected: ChartEvent[] = []
  // LRC timestamps are positions in the audio file; the chart's timeline is
  // offset from it. msToTick clamps, so a line the offset pushes before tick 0
  // lands on 0 rather than at a negative tick the format cannot express.
  const ticks = lrcLines.map((l) => msToTick(map, l.ms - offsetMs))
  for (let i = 0; i < lrcLines.length; i++) {
    injected.push({ tick: ticks[i], text: 'phrase_start' })
    for (const word of lrcLines[i].text.split(/\s+/)) {
      // Strip embedded double quotes so a word cannot break the quoted syntax.
      injected.push({ tick: ticks[i], text: `lyric ${word.replace(/"/g, '')}` })
    }
    const endTick = i + 1 < lrcLines.length ? ticks[i + 1] : ticks[i] + 4 * map.resolution
    injected.push({ tick: endTick, text: 'phrase_end' })
  }

  // Stable sort keeps kept-before-injected order within a tick, which makes
  // re-injection byte-identical (idempotent).
  const events = [...kept, ...injected].sort((a, b) => a.tick - b.tick)
  const section = renderEventsSection(events, eol)

  // Splice the rebuilt section into the file, replacing the old [Events]
  // block or inserting a new one after [SyncTrack] (or at the end).
  const lines = original.split(eol)
  const headerIdx = lines.findIndex((l) => l.trim().toLowerCase() === '[events]')
  let updated: string
  if (headerIdx >= 0) {
    let closeIdx = headerIdx + 1
    while (closeIdx < lines.length && lines[closeIdx].trim() !== '}') closeIdx++
    updated = [...lines.slice(0, headerIdx), section, ...lines.slice(closeIdx + 1)].join(eol)
  } else {
    const syncIdx = lines.findIndex((l) => l.trim().toLowerCase() === '[synctrack]')
    let insertAt = lines.length
    if (syncIdx >= 0) {
      let closeIdx = syncIdx + 1
      while (closeIdx < lines.length && lines[closeIdx].trim() !== '}') closeIdx++
      insertAt = closeIdx + 1
    }
    updated = [...lines.slice(0, insertAt), section, ...lines.slice(insertAt)].join(eol)
  }
  if (!updated.endsWith(eol)) updated += eol
  return updated
}

/**
 * Inject synced LRC lyrics into a chart, whichever shape the chart is.
 *
 * For a folder chart `chartPath` is the `notes.chart` file itself (main/index.ts resolves it out
 * of the catalog's folder path); for a `.sng` it is the archive, and the chart text is unpacked
 * from it and written back through the repacking dispatcher.
 *
 * `chartType` comes from the chart's catalog row rather than the path's suffix, on the same
 * reasoning as `writeChartFile`.
 *
 * `backupDir` is where the chart file's previous bytes are kept so the injection can be undone,
 * or `null` for no undo. This is the one asset write that changes what Clone Hero matches the
 * chart by, since `getChartHash` hashes the chart file, so the backup records the hash before
 * the write and the undo is held to landing exactly back on it; see `writeWithUndo`.
 *
 * `.mid` injection is DEFERRED (it needs binary MIDI surgery) and is rejected identically
 * whether the `.mid` sits on disk or inside an archive.
 *
 * THE ONE PATH M10 DID NOT MAKE BOUNDED, and now the only one. `writeSngAsset` never holds the
 * archive: `repackSng` and `verifyRepack` both copy and compare a chunk at a time, so a 519.2 MiB
 * chart costs 128 MiB of peak RSS. This function still reads the whole thing before any of that
 * runs, and reads it the wasteful way: `readFileSync` + the `Uint8Array` + the `Blob`
 * readSngForRepack wraps it in are three whole copies of the file before the first entry is parsed.
 * Measured at 750 MiB: about 10 s and 4.6 GB of allocation.
 *
 * The waste is real, not theoretical. An earlier version of this note claimed the reference library
 * "tops out around 16 MB". It does not: 23 of its 162 archives are over 16 MiB, six are over
 * 100 MB, and the largest is 519.2 MiB. Reading the chart text through a stream, the way
 * `readRepackPlan` reads a header, is the fix; it is not done today.
 *
 * What changed with the ceiling: there is no longer a size at which this refuses. `MAX_REPACK_BYTES`
 * used to bound the archive plus the asset, so an archive over 640 MiB got a message, but only
 * after this function had already read it. Its replacement bounds the incoming asset alone (see
 * `MAX_ASSET_BYTES`), and an LRC's worth of chart text is never near it, so the only limit on the
 * archive this path will attempt is the memory it can get. That is a real widening, and the
 * streaming read above is what closes it.
 */
export async function injectLyrics(
  chartPath: string,
  chartType: 'folder' | 'sng',
  syncedLrc: string,
  libraryFolders: { path: string }[],
  backupDir: string | null
): Promise<void> {
  // Guard the read as well as the write: a renderer-supplied path must never
  // become an arbitrary-file primitive.
  assertUnderLibrary(chartPath, libraryFolders)

  if (chartType === 'sng') {
    const chart = { chartPath, chartType, backupDir }
    // The read happens inside the lock, with the write: the text this rewrites has to be the
    // text on disk at the moment of rewriting, or a write that landed in between would be
    // silently undone by this one.
    await writeWithUndo(chart, 'lyrics', async () => {
      const { entries } = await readSngForRepack(new Uint8Array(readFileSync(chartPath)))
      // Same names main/index.ts looks for in a folder chart, so an archive and a folder are
      // judged by one rule.
      const chartEntry = entries.find((e) => /^notes\.chart$/i.test(e.fileName))
      if (!chartEntry) {
        if (entries.some((e) => /^notes\.mid$/i.test(e.fileName))) {
          throw unsupportedChartFileError('.mid')
        }
        throw new Error(
          `This .sng contains no chart file (no notes.chart or notes.mid): ${chartPath}`
        )
      }
      const updated = injectIntoChartText(new TextDecoder().decode(chartEntry.data), syncedLrc)
      return {
        // The entry as it is, extracted out of the archive by the store. Replaced in place under
        // its own name, so there is nothing for the undo to remove.
        files: [
          { fileName: chartEntry.fileName, content: chartFileContent(chart, chartEntry.fileName) }
        ],
        // The entry's own name, not a hardcoded 'notes.chart': writeSngAsset replaces by exact
        // name, so a differently-cased entry would otherwise be left in place and the archive
        // would come back holding two chart files.
        write: () =>
          writeSngAsset(chartPath, chartEntry.fileName, Buffer.from(updated), libraryFolders)
      }
    })
    return
  }

  const ext = extname(chartPath).toLowerCase()
  if (ext !== '.chart') throw unsupportedChartFileError(ext)
  // The chart the backup is filed under is the FOLDER, not the file: that is the catalog path,
  // the path the lock is keyed on, and the path the restore writes back into.
  const chart = { chartPath: dirname(chartPath), chartType, backupDir }
  const fileName = basename(chartPath)
  await writeWithUndo(chart, 'lyrics', async () => {
    const updated = injectIntoChartText(readFileSync(chartPath, 'utf8'), syncedLrc)
    return {
      files: [{ fileName, content: chartFileContent(chart, fileName) }],
      // writeChartAsset directly, which is the folder half of `writeChartFile`: it re-asserts the
      // library guard and does tmp+rename in the chart's own directory, so the .chart swap stays
      // atomic. Not `writeChartFile` itself, because that takes the per-chart lock and
      // `writeWithUndo` already holds it, and the lock is not re-entrant.
      write: async () => {
        writeChartAsset(chart.chartPath, fileName, Buffer.from(updated), libraryFolders)
      }
    }
  })
}

// ─── LRCLIB search ───────────────────────────────────────────────────────────

export interface LyricsSearchResult {
  id: number
  trackName: string
  artistName: string
  /** True when syncedLyrics is present. Only synced results can be injected. */
  synced: boolean
  syncedLyrics: string | null
  plainLyrics: string | null
}

/**
 * Search LRCLIB for lyrics by artist and track name. Throws on non-200
 * responses, invalid JSON, or a non-array payload.
 */
export async function searchLyrics(
  artist: string,
  track: string,
  fetchFn: typeof fetch = fetch
): Promise<LyricsSearchResult[]> {
  const url =
    `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}` +
    `&track_name=${encodeURIComponent(track)}`
  const response = await fetchFn(url)
  if (!response.ok) {
    throw new Error(`LRCLIB returned ${response.status}: ${response.statusText}`)
  }
  let json: unknown
  try {
    json = await response.json()
  } catch (err) {
    throw new Error(
      `LRCLIB returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!Array.isArray(json)) {
    throw new Error('LRCLIB returned an unexpected (non-array) response')
  }
  return json.map((item) => {
    const r = item as Record<string, unknown>
    const syncedLyrics = typeof r['syncedLyrics'] === 'string' ? r['syncedLyrics'] : null
    return {
      id: typeof r['id'] === 'number' ? r['id'] : 0,
      trackName: typeof r['trackName'] === 'string' ? r['trackName'] : '',
      artistName: typeof r['artistName'] === 'string' ? r['artistName'] : '',
      synced: syncedLyrics !== null,
      syncedLyrics,
      plainLyrics: typeof r['plainLyrics'] === 'string' ? r['plainLyrics'] : null
    }
  })
}
