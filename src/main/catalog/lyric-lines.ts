import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMidi, type MidiEvent } from 'midi-file'
import { parseChartFile } from 'scan-chart'
import { readSngEntriesForScan } from '../downloads/sng-read-selective'

/**
 * Reads a chart's lyrics as timed lines, for the preview's lyrics overlay.
 *
 * Nothing else in the app keeps lyric events. scan-chart reduces them to a boolean (`hasLyrics`)
 * for both formats, and `assets/lyrics.ts` is a writer (LRC in, chart events out) with no way
 * back. So this is the one place the events are parsed for display: `[Events]` lines in a .chart,
 * `PART VOCALS` in a .mid.
 *
 * Time is CHART time, in milliseconds from tick 0 through the tempo map, with no offset applied.
 * That is deliberately the timeline `player-progress` reports: chart-preview's `currentMs` is its
 * `chartCurrentTimeMs`, and the song's `delay`/`Offset` is applied to the audio start
 * (`startDelayMs`), not to the notes. A lyric converted the same way as a note lands under it.
 *
 * The tempo map comes from scan-chart's `parseChartFile` for both formats rather than from
 * `assets/lyrics.ts`'s `parseTempoMap`, so the conversion is the one the highway's notes went
 * through. The writer's map is checked against it by the round-trip test.
 */

export interface LyricLine {
  /** Chart time the line starts, ms. */
  ms: number
  /** Chart time the line ends, ms; always greater than or equal to `ms`. */
  endMs: number
  text: string
}

/** Lines, or the one reason there are none, shown as the disabled toggle's title. */
export type LyricLinesResult = { lines: LyricLine[] } | { none: string }

export const NO_CHART_FILE = 'No chart file in this chart'
export const NO_LYRICS = 'No lyrics in this chart'
export const NO_VOCALS_TRACK = 'No vocals track in this chart'
export const NO_LYRICS_IN_VOCALS = 'No lyrics in the vocals track'
export const UNREADABLE = 'The chart file could not be read'

// ─── tempo ───────────────────────────────────────────────────────────────────

interface TempoSegment {
  tick: number
  msTime: number
  msPerTick: number
}

/**
 * scan-chart's timed tempos as segments a tick can be placed against. scan-chart guarantees a
 * tempo at tick 0 (it inserts 120 BPM when the file has none), so the first segment always
 * covers tick 0; the fallback below only guards a shape this code never expects to see.
 */
function tempoSegments(parsed: {
  resolution: number
  tempos: { tick: number; beatsPerMinute: number; msTime: number }[]
}): TempoSegment[] {
  const segments = parsed.tempos.map((t) => ({
    tick: t.tick,
    msTime: t.msTime,
    msPerTick: 60_000 / (t.beatsPerMinute * parsed.resolution)
  }))
  if (segments.length === 0 || segments[0].tick > 0) {
    segments.unshift({ tick: 0, msTime: 0, msPerTick: 60_000 / (120 * parsed.resolution) })
  }
  return segments
}

/** Whole milliseconds: a lyric does not need finer, and the IPC payload stays compact. */
function tickToMs(segments: TempoSegment[], tick: number): number {
  let segment = segments[0]
  for (const s of segments) {
    if (s.tick <= tick) segment = s
    else break
  }
  return Math.round(segment.msTime + (tick - segment.tick) * segment.msPerTick)
}

// ─── phrase grouping ─────────────────────────────────────────────────────────

/**
 * The three things either format says about lyrics, reduced to one vocabulary so both formats
 * are grouped by one rule. A .chart says them as `phrase_start`, `phrase_end` and `lyric …`
 * events; a .mid as phrase notes going on and off and lyric meta events.
 */
interface RawEvent {
  tick: number
  kind: 'start' | 'end' | 'lyric'
  text: string
}

interface Phrase {
  startTick: number
  endTick: number
  syllables: string[]
}

/**
 * At one tick, ends come before starts and starts before lyrics: a phrase that ends where the
 * next begins (every phrase injectLyrics writes, and most RB-style phrase notes) must hand the
 * lyrics on that tick to the phrase that is starting, not the one that just closed.
 */
const KIND_ORDER = { end: 0, start: 1, lyric: 2 } as const

/**
 * Group events into phrases. Lyrics that arrive with no phrase open start an implicit one. They
 * are words someone charted, and dropping them silently would look like a chart with fewer lines
 * than it has. An implicit phrase closes at the next marker like any other. A phrase still open
 * at the end runs four beats past its last syllable, the same allowance `injectLyrics` gives its
 * last line; `beatTicks` is the chart's resolution.
 */
function groupPhrases(events: RawEvent[], beatTicks: number): Phrase[] {
  const sorted = [...events].sort(
    (a, b) => a.tick - b.tick || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  )
  const phrases: Phrase[] = []
  let open: { startTick: number; lastTick: number; syllables: string[] } | null = null
  const close = (endTick: number): void => {
    if (open) phrases.push({ startTick: open.startTick, endTick, syllables: open.syllables })
    open = null
  }
  for (const e of sorted) {
    if (e.kind === 'end') {
      close(e.tick)
    } else if (e.kind === 'start') {
      close(e.tick)
      open = { startTick: e.tick, lastTick: e.tick, syllables: [] }
    } else {
      if (!open) open = { startTick: e.tick, lastTick: e.tick, syllables: [] }
      open.syllables.push(e.text)
      open.lastTick = e.tick
    }
  }
  if (open !== null) {
    const { lastTick } = open as { lastTick: number }
    close(lastTick + 4 * beatTicks)
  }
  return phrases
}

/**
 * Syllables to a displayable line, by the conventions Clone Hero and Rock Band share: a trailing
 * `-` joins the next syllable with nothing between (`dev-` `il` is "devil"), a trailing `=` joins
 * it through a visible hyphen, `+` is a pitch slide and never text, `#` `^` `*` are pitch-style
 * markers and `%` `$` range and harmony markers, all of them display-invisible, and `_` (Clone
 * Hero) or `§` (Rock Band) stands for a space inside one syllable. TextMeshPro tags (`<i>`,
 * `<b>`, `<color=#ff0000>`) are Clone Hero's lyric styling and are dropped whole.
 *
 * Order matters twice. Tags go first because `<color=#ff0000>` holds a `#` and an `=` that are
 * neither a marker nor a join. Markers go before the trailing join character is read, because
 * charts write both `syl-#` and `syl#-`, and because a slide can carry a join: `sto` `+-` `ry`
 * (seen in the owner's library) is "story", so a token left with no text still hands its join
 * to the next syllable.
 *
 * Enough to read the words, not to sing them: per-syllable timing and pitch are not carried out
 * of here.
 */
function joinSyllables(syllables: string[]): string {
  let text = ''
  let glue = ' '
  for (const raw of syllables) {
    let s = raw
      .replace(/<[^>]*>/g, '')
      .replace(/[#^*%$+]/g, '')
      .replace(/[_§]/g, ' ')
    let next = ' '
    if (s.endsWith('-')) {
      s = s.slice(0, -1)
      next = ''
    } else if (s.endsWith('=')) {
      s = s.slice(0, -1)
      next = '-'
    }
    s = s.trim()
    if (s === '') {
      if (next !== ' ') glue = next
      continue
    }
    text = text === '' ? s : text + glue + s
    glue = next
  }
  return text.replace(/\s+/g, ' ').trim()
}

function toLines(phrases: Phrase[], segments: TempoSegment[]): LyricLine[] {
  const lines: LyricLine[] = []
  for (const phrase of phrases) {
    const text = joinSyllables(phrase.syllables)
    if (text === '') continue
    const ms = tickToMs(segments, phrase.startTick)
    lines.push({ ms, endMs: Math.max(ms, tickToMs(segments, phrase.endTick)), text })
  }
  return lines
}

// ─── .chart ──────────────────────────────────────────────────────────────────

/** Same line shape `assets/lyrics.ts` writes, so what it wrote is exactly what this reads. */
const EVENT_LINE_RE = /^\s*(\d+)\s*=\s*E\s+"(.*)"\s*$/

/**
 * The body lines of `[Events]`, or null when the section is absent. Line-based like the writer's
 * `extractSection`: only a line that IS `}` closes the section, so a brace inside a quoted lyric
 * cannot end it early.
 */
function eventsSection(chartText: string): string[] | null {
  const lines = chartText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[events]') continue
    const body: string[] = []
    let j = i + 1
    if (lines[j]?.trim() === '{') j++
    for (; j < lines.length && lines[j].trim() !== '}'; j++) body.push(lines[j])
    return body
  }
  return null
}

/**
 * scan-chart's `getEncoding`, which its package does not export: a UTF-16 byte-order mark picks
 * the decoder, and everything else is read as UTF-8. Transcribed rather than approximated so a
 * chart scan-chart parses is a chart this decodes the same way.
 */
function decodeChartText(data: Uint8Array): string {
  let encoding = 'utf-8'
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) encoding = 'utf-16le'
    else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'utf-16be'
  }
  return new TextDecoder(encoding).decode(data)
}

/**
 * Lyric lines of a .chart file's text (or its bytes, decoded as scan-chart would).
 *
 * The events are scanned here; the tempo map is scan-chart's. A file scan-chart cannot parse is
 * reported, not thrown: the caller shows the reason on a disabled toggle, and a throw over IPC
 * would be an error dialog for a chart that plays fine without lyrics.
 */
export function lyricLinesFromChartText(chart: string | Uint8Array): LyricLinesResult {
  const bytes = typeof chart === 'string' ? new TextEncoder().encode(chart) : chart
  const text = typeof chart === 'string' ? chart : decodeChartText(chart)

  const events: RawEvent[] = []
  for (const line of eventsSection(text) ?? []) {
    const m = line.match(EVENT_LINE_RE)
    if (!m) continue
    const tick = Number(m[1])
    const body = m[2]
    if (body === 'phrase_start') events.push({ tick, kind: 'start', text: '' })
    else if (body === 'phrase_end') events.push({ tick, kind: 'end', text: '' })
    else if (body.startsWith('lyric ')) events.push({ tick, kind: 'lyric', text: body.slice(6) })
  }
  if (!events.some((e) => e.kind === 'lyric')) return { none: NO_LYRICS }

  let parsed: ReturnType<typeof parseChartFile>
  try {
    parsed = parseChartFile(bytes, 'chart')
  } catch {
    return { none: UNREADABLE }
  }
  const lines = toLines(groupPhrases(events, parsed.resolution), tempoSegments(parsed))
  return lines.length > 0 ? { lines } : { none: NO_LYRICS }
}

// ─── .mid ────────────────────────────────────────────────────────────────────

/**
 * Rock Band's phrase markers on PART VOCALS: note 105 is the phrase, 106 the second player's in
 * versus mode. Both delimit lyrics; a chart using both for one phrase yields the same words.
 */
const PHRASE_NOTES = new Set([105, 106])

/**
 * `[idle]`, `[play]`, `[intense]`, `[range_shift]` and the like: track directions, never sung.
 * Text events by the Rock Band spec, but RB3-era charts in the owner's library carry them as
 * lyric meta events too, inside phrases, so both event types are filtered by this.
 */
const MARKER_RE = /^\s*\[.*\]\s*$/

/**
 * The events of the track named PART VOCALS, at absolute ticks, or null. The name rule is
 * scan-chart's `getTracks`: a `trackName` meta event among the leading zero-delta events.
 */
function vocalsTrack(tracks: MidiEvent[][]): { tick: number; event: MidiEvent }[] | null {
  for (const track of tracks) {
    let named = false
    for (const event of track) {
      if (event.deltaTime !== 0) break
      if (event.type === 'trackName' && event.text === 'PART VOCALS') named = true
    }
    if (!named) continue
    let tick = 0
    return track.map((event) => {
      tick += event.deltaTime
      return { tick, event }
    })
  }
  return null
}

/**
 * Lyric lines of a .mid file's bytes. Lyrics are `lyrics` meta events or `text` events, either
 * way minus bracketed directions: scan-chart counts both toward `hasLyrics`, and charters use
 * both.
 */
export function lyricLinesFromMidi(data: Uint8Array): LyricLinesResult {
  let parsed: ReturnType<typeof parseChartFile>
  let vocals: ReturnType<typeof vocalsTrack>
  try {
    vocals = vocalsTrack(parseMidi(data).tracks)
    parsed = parseChartFile(data, 'mid')
  } catch {
    return { none: UNREADABLE }
  }
  if (vocals === null) return { none: NO_VOCALS_TRACK }

  const events: RawEvent[] = []
  for (const { tick, event } of vocals) {
    switch (event.type) {
      case 'lyrics':
      case 'text':
        if (!MARKER_RE.test(event.text)) events.push({ tick, kind: 'lyric', text: event.text })
        break
      case 'noteOn':
        // Velocity 0 is a note-off by MIDI convention, and midi-file reports it as noteOn.
        if (PHRASE_NOTES.has(event.noteNumber)) {
          events.push({ tick, kind: event.velocity > 0 ? 'start' : 'end', text: '' })
        }
        break
      case 'noteOff':
        if (PHRASE_NOTES.has(event.noteNumber)) events.push({ tick, kind: 'end', text: '' })
        break
    }
  }
  if (!events.some((e) => e.kind === 'lyric')) return { none: NO_LYRICS_IN_VOCALS }

  const lines = toLines(groupPhrases(events, parsed.resolution), tempoSegments(parsed))
  return lines.length > 0 ? { lines } : { none: NO_LYRICS_IN_VOCALS }
}

// ─── file resolution ─────────────────────────────────────────────────────────

/**
 * chart-preview's `findChartFile`, transcribed: the first `.mid` wins, then the first `.chart`.
 * The overlay has to read the file the highway was built from, and on a chart shipping both
 * that is the .mid. A `.chart`-first rule here would put one file's words under the other's
 * notes.
 */
function findChartFile<T extends { fileName: string }>(
  files: T[]
): (T & { format: 'mid' | 'chart' }) | null {
  const mid = files.find((f) => f.fileName.toLowerCase().endsWith('.mid'))
  if (mid) return { ...mid, format: 'mid' }
  const chart = files.find((f) => f.fileName.toLowerCase().endsWith('.chart'))
  if (chart) return { ...chart, format: 'chart' }
  return null
}

function linesOf(format: 'mid' | 'chart', data: Uint8Array): LyricLinesResult {
  return format === 'mid' ? lyricLinesFromMidi(data) : lyricLinesFromChartText(data)
}

/**
 * Lyric lines of the chart at `path`: a chart folder, or a `.sng` archive.
 *
 * A folder is listed and only the chart file is read. An archive goes through the scanner's
 * selective reader, which fetches the header and the parsed files by positional read, so a chart
 * with 500 MB of video costs the same as one with none. Not guarded by `assertUnderLibrary`, on
 * the same footing as `readChartFiles`, the preview's other read: what comes back is parsed
 * lines, never bytes.
 */
export async function readLyricLines(
  path: string,
  chartType: 'folder' | 'sng'
): Promise<LyricLinesResult> {
  if (chartType === 'folder') {
    const names = readdirSync(path, { withFileTypes: true })
      .filter((e) => !e.isDirectory())
      .map((e) => ({ fileName: e.name }))
    const pick = findChartFile(names)
    if (!pick) return { none: NO_CHART_FILE }
    return linesOf(pick.format, new Uint8Array(readFileSync(join(path, pick.fileName))))
  }
  const { entries } = await readSngEntriesForScan(path)
  const pick = findChartFile(entries)
  if (!pick) return { none: NO_CHART_FILE }
  return linesOf(pick.format, pick.data)
}
