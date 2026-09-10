import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeMidi, type MidiEvent } from 'midi-file'
import { describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { tmpDir } from '../../../test/helpers/tmp'
import { injectLyrics } from '../assets/lyrics'
import { lyricLinesFromChartText, lyricLinesFromMidi, readLyricLines } from './lyric-lines'

// ─── .chart fixtures ─────────────────────────────────────────────────────────

/**
 * Resolution 192, 120 BPM to tick 768 and 240 BPM after: the same map as lyrics.test.ts's
 * MULTI_TEMPO_CHART, so the hand-computed millisecond values below are the same ones that file
 * already argues for: 2.6041666 ms/tick before the change, 1.3020833 after.
 */
const CHART_HEAD = [
  '[Song]',
  '{',
  '  Name = "Test Song"',
  '  Resolution = 192',
  '}',
  '[SyncTrack]',
  '{',
  '  0 = TS 4',
  '  0 = B 120000',
  '  768 = B 240000',
  '}'
]

const CHART_TAIL = ['[ExpertSingle]', '{', '  192 = N 0 0', '}', '']

const chartWith = (events: string[]): string =>
  [...CHART_HEAD, '[Events]', '{', ...events.map((e) => `  ${e}`), '}', ...CHART_TAIL].join('\n')

/**
 * Two phrases exercising every syllable convention this reader claims to handle: `-` joins the
 * next syllable with nothing between, `=` joins it through a visible hyphen, a lone `+` is a
 * slide and carries no text, `#` and `^` are pitch markers to strip, `_` is a space.
 */
const CHART_TWO_PHRASES = chartWith([
  '384 = E "section Intro"',
  '384 = E "phrase_start"',
  '384 = E "lyric Hel-"',
  '480 = E "lyric lo"',
  '576 = E "lyric +"',
  '672 = E "lyric world#"',
  '768 = E "phrase_end"',
  '768 = E "phrase_start"',
  '768 = E "lyric Se="',
  '960 = E "lyric cond_line^"',
  '1152 = E "phrase_end"'
])

// ─── .mid fixtures ───────────────────────────────────────────────────────────

type AbsEvent = { tick: number } & (
  | { type: 'setTempo'; microsecondsPerBeat: number }
  | { type: 'trackName'; text: string }
  | { type: 'text'; text: string }
  | { type: 'lyrics'; text: string }
  | { type: 'noteOn'; noteNumber: number; velocity: number }
  | { type: 'noteOff'; noteNumber: number }
)

/**
 * A track from events at absolute ticks. midi-file wants deltas and its own event shapes; this
 * keeps the fixtures readable as "what happens at which tick", which is what the assertions are
 * about. Tempo and name events need `meta: true` or midi-file writes them as channel events.
 */
function track(events: AbsEvent[]): MidiEvent[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick)
  const out: MidiEvent[] = []
  let at = 0
  for (const e of sorted) {
    const deltaTime = e.tick - at
    at = e.tick
    switch (e.type) {
      case 'setTempo':
        out.push({
          deltaTime,
          meta: true,
          type: 'setTempo',
          microsecondsPerBeat: e.microsecondsPerBeat
        })
        break
      case 'trackName':
      case 'text':
      case 'lyrics':
        out.push({ deltaTime, meta: true, type: e.type, text: e.text })
        break
      case 'noteOn':
        out.push({
          deltaTime,
          type: 'noteOn',
          channel: 0,
          noteNumber: e.noteNumber,
          velocity: e.velocity
        })
        break
      case 'noteOff':
        out.push({ deltaTime, type: 'noteOff', channel: 0, noteNumber: e.noteNumber, velocity: 0 })
        break
    }
  }
  out.push({ deltaTime: 0, meta: true, type: 'endOfTrack' })
  return out
}

/** Format 1, 480 ticks per beat, 120 BPM until tick 1920 (four beats, 2000 ms) then 240 BPM. */
function midiWith(tracks: MidiEvent[][]): Uint8Array {
  const tempo = track([
    { tick: 0, type: 'setTempo', microsecondsPerBeat: 500_000 },
    { tick: 1920, type: 'setTempo', microsecondsPerBeat: 250_000 }
  ])
  return new Uint8Array(
    writeMidi({
      header: { format: 1, numTracks: tracks.length + 1, ticksPerBeat: 480 },
      tracks: [tempo, ...tracks]
    })
  )
}

/** PART VOCALS with two phrases (note 105), pitch notes, a bracketed marker, and every convention. */
const VOCALS_TRACK = track([
  { tick: 0, type: 'trackName', text: 'PART VOCALS' },
  { tick: 0, type: 'text', text: '[range_shift]' },
  { tick: 480, type: 'noteOn', noteNumber: 105, velocity: 100 },
  { tick: 480, type: 'noteOn', noteNumber: 60, velocity: 100 },
  { tick: 480, type: 'lyrics', text: 'Hel-' },
  { tick: 600, type: 'noteOff', noteNumber: 60 },
  { tick: 600, type: 'lyrics', text: 'lo' },
  { tick: 700, type: 'lyrics', text: '+' },
  { tick: 800, type: 'lyrics', text: 'world#' },
  { tick: 960, type: 'noteOff', noteNumber: 105 },
  // Second phrase starts on the tick the first ends, as RB-style charts often do.
  { tick: 960, type: 'noteOn', noteNumber: 105, velocity: 100 },
  { tick: 960, type: 'lyrics', text: 'Se=' },
  { tick: 1200, type: 'lyrics', text: 'cond_line^' },
  { tick: 2400, type: 'noteOff', noteNumber: 105 }
])

// ─── .chart ──────────────────────────────────────────────────────────────────

describe('lyricLinesFromChartText', () => {
  it('groups lyric events into phrases, timed through the tempo map', () => {
    const result = lyricLinesFromChartText(CHART_TWO_PHRASES)
    expect(result).toHaveProperty('lines')
    if (!('lines' in result)) return
    expect(result.lines).toHaveLength(2)
    // 384 ticks at 2.6041666 ms/tick = 1000 ms; 768 = 2000 ms (the tempo boundary);
    // 1152 = 2000 + 384 × 1.3020833 = 2500 ms.
    expect(result.lines[0].ms).toBeCloseTo(1000, 6)
    expect(result.lines[0].endMs).toBeCloseTo(2000, 6)
    expect(result.lines[1].ms).toBeCloseTo(2000, 6)
    expect(result.lines[1].endMs).toBeCloseTo(2500, 6)
  })

  it('joins syllables by the Clone Hero conventions and drops slide markers', () => {
    const result = lyricLinesFromChartText(CHART_TWO_PHRASES)
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Hello world', 'Se-cond line'])
  })

  it('reports a chart with an [Events] section but no lyric events', () => {
    expect(lyricLinesFromChartText(chartWith(['384 = E "section Intro"']))).toEqual({
      none: 'No lyrics in this chart'
    })
  })

  it('reports a chart with no [Events] section at all', () => {
    expect(lyricLinesFromChartText([...CHART_HEAD, ...CHART_TAIL].join('\n'))).toEqual({
      none: 'No lyrics in this chart'
    })
  })

  // Some charts carry phrase_start markers only. Each one closes the phrase before it.
  it('closes a phrase at the next phrase_start when phrase_end is absent', () => {
    const result = lyricLinesFromChartText(
      chartWith([
        '384 = E "phrase_start"',
        '384 = E "lyric One"',
        '768 = E "phrase_start"',
        '768 = E "lyric Two"'
      ])
    )
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => [l.text, l.ms, l.endMs])).toEqual([
      ['One', 1000, 2000],
      // The last phrase never ends: it runs four beats past its start, as injectLyrics writes.
      ['Two', 2000, 3000]
    ])
  })

  // Lyrics before any phrase marker are still words someone charted; they open an implicit
  // phrase that the first real marker closes, rather than being silently dropped.
  it('keeps lyrics that sit outside any phrase', () => {
    const result = lyricLinesFromChartText(
      chartWith([
        '192 = E "lyric Stray"',
        '384 = E "phrase_start"',
        '384 = E "lyric In"',
        '768 = E "phrase_end"'
      ])
    )
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Stray', 'In'])
    expect(result.lines[0].endMs).toBeCloseTo(1000, 6)
  })

  // An empty phrase (start and end with nothing sung) is not a line.
  it('drops phrases with no words', () => {
    const result = lyricLinesFromChartText(
      chartWith([
        '384 = E "phrase_start"',
        '768 = E "phrase_end"',
        '768 = E "phrase_start"',
        '768 = E "lyric Word"',
        '960 = E "phrase_end"'
      ])
    )
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Word'])
  })

  it('reads a UTF-16 chart the way scan-chart does', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(CHART_TWO_PHRASES, 'utf16le')
    ])
    const result = lyricLinesFromChartText(new Uint8Array(utf16))
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines[0].text).toBe('Hello world')
  })

  // The events are scanned before scan-chart is asked for the tempo map, so a file with no
  // lyric events is "no lyrics" whatever else is wrong with it; the unreadable case is a file
  // that has lyrics and that scan-chart rejects (here: no [Song] section, so no Resolution).
  it('reports a file scan-chart cannot parse rather than throwing', () => {
    expect(lyricLinesFromChartText('[Events]\n{\n  0 = E "lyric Hi"\n}\n')).toEqual({
      none: 'The chart file could not be read'
    })
  })

  // Seen in the owner's library. `sto` `+-` `ry` (Dear Maria, Count Me In): the slide token
  // carries the join, so the word is "story", not "sto +ry". `Whoa=` `+oh`: a `+` at the head
  // of a syllable is still a slide. And a phrase holding only `-` (Belial writes hundreds, each
  // in a phrase of its own) has no words and is not a line.
  it('lets a bare slide carry its join to the next syllable', () => {
    const result = lyricLinesFromChartText(
      chartWith([
        '384 = E "phrase_start"',
        '384 = E "lyric sto"',
        '400 = E "lyric +-"',
        '480 = E "lyric ry"',
        '576 = E "lyric Whoa="',
        '600 = E "lyric +oh"',
        '768 = E "phrase_end"',
        '768 = E "phrase_start"',
        '768 = E "lyric -"',
        '960 = E "phrase_end"'
      ])
    )
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['story Whoa-oh'])
  })

  // Clone Hero renders TextMeshPro tags in lyrics and charters use them (`<i>` for backing
  // vocals is common; 843 of the 9288 lines in the owner's library carry one). The overlay
  // shows words only, and the tag has to go before the marker pass: `<color=#ff0000>` holds
  // both a `#` and an `=`, which would otherwise be read as a pitch marker and a join.
  it('strips rich-text tags from the words', () => {
    const result = lyricLinesFromChartText(
      chartWith([
        '384 = E "phrase_start"',
        '384 = E "lyric <i>You\'ve"',
        '480 = E "lyric got</i>"',
        '576 = E "lyric <b><color=#ff0000>    WAAA"',
        '768 = E "phrase_end"'
      ])
    )
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(["You've got WAAA"])
  })
})

// ─── .mid ────────────────────────────────────────────────────────────────────

describe('lyricLinesFromMidi', () => {
  it('reads PART VOCALS lyrics grouped by phrase notes, timed through the tempo track', () => {
    const result = lyricLinesFromMidi(midiWith([VOCALS_TRACK]))
    expect(result).toHaveProperty('lines')
    if (!('lines' in result)) return
    // 480 ticks per beat at 120 BPM is 500 ms per beat: tick 480 = 500 ms, 960 = 1000 ms,
    // 1920 = 2000 ms (tempo doubles), 2400 = 2000 + 480 × 0.5208333 = 2250 ms.
    expect(result.lines.map((l) => l.text)).toEqual(['Hello world', 'Se-cond line'])
    expect(result.lines[0].ms).toBeCloseTo(500, 6)
    expect(result.lines[0].endMs).toBeCloseTo(1000, 6)
    expect(result.lines[1].ms).toBeCloseTo(1000, 6)
    expect(result.lines[1].endMs).toBeCloseTo(2250, 6)
  })

  // Some charters put lyrics in text events (0x01) rather than lyric events (0x05); scan-chart
  // counts both as lyrics and so does this.
  it('accepts lyrics carried as text events', () => {
    const vocals = track([
      { tick: 0, type: 'trackName', text: 'PART VOCALS' },
      { tick: 480, type: 'noteOn', noteNumber: 105, velocity: 100 },
      { tick: 480, type: 'text', text: 'Spo-' },
      { tick: 600, type: 'text', text: 'ken' },
      { tick: 960, type: 'noteOff', noteNumber: 105 }
    ])
    const result = lyricLinesFromMidi(midiWith([vocals]))
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Spoken'])
  })

  // Rock Band's `[idle]`, `[play]`, `[intense]` directions are text events by the spec, but
  // RB3-era charts in the owner's library (A Prophecy, Action/Adventure) carry them as lyric
  // meta events, inside phrases. They are never sung, whichever event type carries them.
  it('drops bracketed directions carried as lyric meta events', () => {
    const vocals = track([
      { tick: 0, type: 'trackName', text: 'PART VOCALS' },
      { tick: 240, type: 'lyrics', text: '[idle]' },
      { tick: 480, type: 'noteOn', noteNumber: 105, velocity: 100 },
      { tick: 480, type: 'lyrics', text: '[intense]' },
      { tick: 500, type: 'lyrics', text: 'How#' },
      { tick: 600, type: 'lyrics', text: 'stub-#' },
      { tick: 700, type: 'lyrics', text: 'born#' },
      { tick: 960, type: 'noteOff', noteNumber: 105 }
    ])
    const result = lyricLinesFromMidi(midiWith([vocals]))
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => [l.text, l.ms])).toEqual([['How stubborn', 500]])
  })

  it('reports a .mid with no PART VOCALS track', () => {
    const guitar = track([
      { tick: 0, type: 'trackName', text: 'PART GUITAR' },
      { tick: 480, type: 'noteOn', noteNumber: 96, velocity: 100 },
      { tick: 600, type: 'noteOff', noteNumber: 96 }
    ])
    expect(lyricLinesFromMidi(midiWith([guitar]))).toEqual({
      none: 'No vocals track in this chart'
    })
  })

  it('reports a vocals track that holds only bracketed markers', () => {
    const vocals = track([
      { tick: 0, type: 'trackName', text: 'PART VOCALS' },
      { tick: 0, type: 'text', text: '[idle]' },
      { tick: 480, type: 'text', text: '[play]' }
    ])
    expect(lyricLinesFromMidi(midiWith([vocals]))).toEqual({
      none: 'No lyrics in the vocals track'
    })
  })

  it('reports bytes that are not a MIDI file rather than throwing', () => {
    expect(lyricLinesFromMidi(new Uint8Array([1, 2, 3, 4]))).toEqual({
      none: 'The chart file could not be read'
    })
  })
})

// ─── readLyricLines ──────────────────────────────────────────────────────────

describe('readLyricLines', () => {
  const CHART_ONLY_LYRIC = chartWith([
    '384 = E "phrase_start"',
    '384 = E "lyric Chart"',
    '768 = E "phrase_end"'
  ])
  const MID_ONLY_LYRIC = midiWith([
    track([
      { tick: 0, type: 'trackName', text: 'PART VOCALS' },
      { tick: 480, type: 'noteOn', noteNumber: 105, velocity: 100 },
      { tick: 480, type: 'lyrics', text: 'Midi' },
      { tick: 960, type: 'noteOff', noteNumber: 105 }
    ])
  ])

  it('reads a folder chart with notes.chart', async () => {
    const dir = tmpDir('lyric-folder')
    writeFileSync(join(dir, 'notes.chart'), CHART_ONLY_LYRIC)
    writeFileSync(join(dir, 'song.ogg'), new Uint8Array([1, 2, 3]))
    const result = await readLyricLines(dir, 'folder')
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Chart'])
  })

  it('reads a folder chart with notes.mid', async () => {
    const dir = tmpDir('lyric-folder-mid')
    writeFileSync(join(dir, 'notes.mid'), MID_ONLY_LYRIC)
    const result = await readLyricLines(dir, 'folder')
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Midi'])
  })

  // chart-preview's findChartFile takes the .mid when both exist, so the highway on screen is
  // the .mid's. Reading the .chart here would put the wrong file's lyrics under it.
  it('prefers notes.mid over notes.chart, as the preview does', async () => {
    const dir = tmpDir('lyric-folder-both')
    writeFileSync(join(dir, 'notes.chart'), CHART_ONLY_LYRIC)
    writeFileSync(join(dir, 'notes.mid'), MID_ONLY_LYRIC)
    const result = await readLyricLines(dir, 'folder')
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Midi'])
  })

  it('reports a folder with no chart file', async () => {
    const dir = tmpDir('lyric-folder-empty')
    writeFileSync(join(dir, 'song.ini'), '[song]\nname = X\n')
    expect(await readLyricLines(dir, 'folder')).toEqual({ none: 'No chart file in this chart' })
  })

  it('reads a .sng holding notes.chart without touching its audio', async () => {
    const dir = tmpDir('lyric-sng')
    const sngPath = join(dir, 'chart.sng')
    // Audio larger than the header read: if the reader pulled the archive whole it would still
    // pass, so this is a smoke test of the path, not of the byte count: sng-read-selective's
    // own tests cover that.
    writeFileSync(
      sngPath,
      makeSng(
        [
          { fileName: 'song.opus', data: new Uint8Array(200 * 1024) },
          { fileName: 'notes.chart', data: new TextEncoder().encode(CHART_ONLY_LYRIC) }
        ],
        { name: 'S' }
      )
    )
    const result = await readLyricLines(sngPath, 'sng')
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Chart'])
  })

  it('reads a .sng holding notes.mid', async () => {
    const dir = tmpDir('lyric-sng-mid')
    const sngPath = join(dir, 'chart.sng')
    writeFileSync(
      sngPath,
      makeSng([{ fileName: 'notes.mid', data: MID_ONLY_LYRIC }], { name: 'S' })
    )
    const result = await readLyricLines(sngPath, 'sng')
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Midi'])
  })

  it('reports a .sng with no chart file', async () => {
    const dir = tmpDir('lyric-sng-empty')
    const sngPath = join(dir, 'chart.sng')
    writeFileSync(
      sngPath,
      makeSng([{ fileName: 'song.opus', data: new Uint8Array(10) }], { name: 'S' })
    )
    expect(await readLyricLines(sngPath, 'sng')).toEqual({ none: 'No chart file in this chart' })
  })
})

// ─── round trip against the writer ───────────────────────────────────────────

describe('readLyricLines after injectLyrics', () => {
  const LRC = [
    '[ar: Someone]',
    '[00:01.00] Hello world',
    '[00:02.00] Second line',
    '[00:03.00] End',
    ''
  ].join('\n')

  function library(): { root: string; chartPath: string } {
    const root = tmpDir('lyric-roundtrip')
    const chartDir = join(root, 'Artist - Song (Charter)')
    mkdirSync(chartDir, { recursive: true })
    return { root, chartPath: join(chartDir, 'notes.chart') }
  }

  // The writer places every word of a line at the line's tick and the phrase_end at the next
  // line's tick, so the reader must hand back the LRC's own lines and timestamps: same words in
  // the same order, each starting where the LRC said and ending where the next begins.
  it('hands back the lines Encore wrote, at the LRC timestamps', async () => {
    const { root, chartPath } = library()
    writeFileSync(chartPath, [...CHART_HEAD, ...CHART_TAIL].join('\n'))
    await injectLyrics(chartPath, 'folder', LRC, [{ path: root }], null)

    const result = await readLyricLines(join(root, 'Artist - Song (Charter)'), 'folder')
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.text)).toEqual(['Hello world', 'Second line', 'End'])
    expect(result.lines.map((l) => l.ms)).toEqual([1000, 2000, 3000])
    // The last phrase_end is four beats after the last line: 1536 + 768 ticks at 240 BPM.
    expect(result.lines.map((l) => l.endMs)).toEqual([2000, 3000, 4000])
  })

  // With a [Song] Offset the writer stores chart time (lrcMs - offsetMs), and the reader
  // returns chart time too, which is what the preview's player-progress reports, because
  // chart-preview applies the offset to the audio start rather than to the notes.
  it('returns chart time, not audio time, on a chart with an Offset', async () => {
    const { root, chartPath } = library()
    const withOffset = [...CHART_HEAD, ...CHART_TAIL]
      .join('\n')
      .replace('  Resolution = 192', '  Offset = 0.5\n  Resolution = 192')
    writeFileSync(chartPath, withOffset)
    await injectLyrics(chartPath, 'folder', LRC, [{ path: root }], null)

    const result = await readLyricLines(join(root, 'Artist - Song (Charter)'), 'folder')
    if (!('lines' in result)) throw new Error('expected lines')
    expect(result.lines.map((l) => l.ms)).toEqual([500, 1500, 2500])
  })
})
