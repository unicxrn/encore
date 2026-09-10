import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { scanChartIssues } from '../catalog/issues'
import { readSngForRepack } from '../downloads/sng'
import { listBackups } from '../issues/backup-store'
import { restoreBackup } from '../issues/restore'
import { injectLyrics, msToTick, parseSongOffsetMs, parseTempoMap, searchLyrics } from './lyrics'
import { tmpDir } from '../../../test/helpers/tmp'

// ─── chart fixtures ──────────────────────────────────────────────────────────

/** 120 BPM throughout, resolution 192 (fixture-chart conventions). */
const SINGLE_TEMPO_CHART = [
  '[Song]',
  '{',
  '  Name = "Test Song"',
  '  Resolution = 192',
  '}',
  '[SyncTrack]',
  '{',
  '  0 = TS 4',
  '  0 = B 120000',
  '}',
  '[ExpertSingle]',
  '{',
  '  192 = N 0 0',
  '}',
  ''
].join('\n')

/** 120 BPM from tick 0, doubling to 240 BPM at tick 768. */
const MULTI_TEMPO_CHART = [
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
  '}',
  '[Events]',
  '{',
  '  384 = E "section Intro"',
  '}',
  '[ExpertSingle]',
  '{',
  '  192 = N 0 0',
  '}',
  ''
].join('\n')

// ─── parseTempoMap ───────────────────────────────────────────────────────────

describe('parseTempoMap', () => {
  it('reads Resolution and a single B event (milli-BPM)', () => {
    const map = parseTempoMap(SINGLE_TEMPO_CHART)
    expect(map.resolution).toBe(192)
    expect(map.tempos).toHaveLength(1)
    // 120 BPM at resolution 192: msPerTick = 60000 / (120 * 192) = 2.6041666...
    expect(map.tempos[0].tick).toBe(0)
    expect(map.tempos[0].msAtTick).toBe(0)
    expect(map.tempos[0].msPerTick).toBeCloseTo(60000 / (120 * 192), 10)
  })

  it('precomputes cumulative ms at each tempo change', () => {
    const map = parseTempoMap(MULTI_TEMPO_CHART)
    expect(map.tempos).toHaveLength(2)
    // Segment 0: 120 BPM → 2.6041666... ms/tick. 768 ticks * 2.6041666... = 2000ms.
    expect(map.tempos[1].tick).toBe(768)
    expect(map.tempos[1].msAtTick).toBeCloseTo(2000, 6)
    // Segment 1: 240 BPM → 60000 / (240 * 192) = 1.3020833... ms/tick.
    expect(map.tempos[1].msPerTick).toBeCloseTo(60000 / (240 * 192), 10)
  })

  it('defaults to 120 BPM at tick 0 when [SyncTrack] is missing', () => {
    const map = parseTempoMap('[Song]\n{\n  Resolution = 192\n}\n')
    expect(map.resolution).toBe(192)
    expect(map.tempos).toEqual([{ tick: 0, msPerTick: 60000 / (120 * 192), msAtTick: 0 }])
  })

  it('defaults to 120 BPM when [SyncTrack] has no B events', () => {
    const chart = '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n}\n'
    const map = parseTempoMap(chart)
    expect(map.tempos).toEqual([{ tick: 0, msPerTick: 60000 / (120 * 192), msAtTick: 0 }])
  })

  it('inserts 120 BPM at tick 0 when the first B event starts later', () => {
    const chart = '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  768 = B 240000\n}\n'
    const map = parseTempoMap(chart)
    expect(map.tempos).toHaveLength(2)
    expect(map.tempos[0]).toEqual({ tick: 0, msPerTick: 60000 / (120 * 192), msAtTick: 0 })
    expect(map.tempos[1].tick).toBe(768)
    expect(map.tempos[1].msAtTick).toBeCloseTo(2000, 6)
  })

  it('defaults Resolution to 192 when [Song] omits it (scan-chart convention)', () => {
    const map = parseTempoMap('[SyncTrack]\n{\n  0 = B 120000\n}\n')
    expect(map.resolution).toBe(192)
  })
})

// ─── parseSongOffsetMs ───────────────────────────────────────────────────────

describe('parseSongOffsetMs', () => {
  const songSection = (...body: string[]): string =>
    ['[Song]', '{', ...body.map((l) => `  ${l}`), '}', '[SyncTrack]', '{', '}', ''].join('\n')

  it('returns 0 when [Song] has no Offset and when [Song] is missing', () => {
    expect(parseSongOffsetMs(songSection('Name = "Test"', 'Resolution = 192'))).toBe(0)
    expect(parseSongOffsetMs('[SyncTrack]\n{\n  0 = B 120000\n}\n')).toBe(0)
  })

  it('converts seconds to milliseconds', () => {
    // The three nonzero values in the reference library, which is also the
    // evidence that the unit is seconds: 0.6 ms would be a meaningless offset.
    expect(parseSongOffsetMs(songSection('Offset = 0.6'))).toBe(600)
    expect(parseSongOffsetMs(songSection('Offset = 3'))).toBe(3000)
    expect(parseSongOffsetMs(songSection('Offset = -5.05'))).toBe(-5050)
  })

  it('keeps an explicit zero as zero', () => {
    expect(parseSongOffsetMs(songSection('Offset = 0'))).toBe(0)
  })

  it('falls back to 0 rather than NaN on an unparseable value', () => {
    expect(parseSongOffsetMs(songSection('Offset = later'))).toBe(0)
    expect(parseSongOffsetMs(songSection('Offset ='))).toBe(0)
  })

  it('lets the last Offset win, as parseTempoMap does for Resolution', () => {
    expect(parseSongOffsetMs(songSection('Offset = 1', 'Offset = 2'))).toBe(2000)
  })
})

// ─── msToTick ────────────────────────────────────────────────────────────────

describe('msToTick', () => {
  it('converts on a single 120 BPM segment at resolution 192', () => {
    const map = parseTempoMap(SINGLE_TEMPO_CHART)
    // msPerTick = 60000 / (120 * 192) = 2.6041666... ms/tick.
    // 1000ms / 2.6041666... = 384.0 ticks exactly (1000 * 120 * 192 / 60000 = 384).
    expect(msToTick(map, 1000)).toBe(384)
    // 500ms → 192 ticks (one beat at 120 BPM is 500ms = 192 ticks).
    expect(msToTick(map, 500)).toBe(192)
  })

  it('returns 0 at ms=0 and clamps negative ms to 0', () => {
    const map = parseTempoMap(SINGLE_TEMPO_CHART)
    expect(msToTick(map, 0)).toBe(0)
    expect(msToTick(map, -50)).toBe(0)
  })

  it('walks both segments for a time after a tempo change', () => {
    const map = parseTempoMap(MULTI_TEMPO_CHART)
    // Segment 0 covers 0..2000ms (768 ticks at 2.6041666... ms/tick).
    // 3000ms: remainder 1000ms in segment 1 at 1.3020833... ms/tick
    //   = 1000 * 240 * 192 / 60000 = 768 ticks → 768 + 768 = 1536.
    expect(msToTick(map, 3000)).toBe(1536)
    // Before the change only segment 0 applies: 1000ms → 384.
    expect(msToTick(map, 1000)).toBe(384)
  })

  it('maps a boundary ms exactly onto the tempo-change tick', () => {
    const map = parseTempoMap(MULTI_TEMPO_CHART)
    // 2000ms is exactly where the 240 BPM segment begins (tick 768).
    expect(msToTick(map, 2000)).toBe(768)
  })

  it('rounds to the nearest tick (half up)', () => {
    // Resolution 100 at 120 BPM gives an exact 5ms per tick:
    // msPerTick = 60000 / (120 * 100) = 5.
    const chart = '[Song]\n{\n  Resolution = 100\n}\n[SyncTrack]\n{\n  0 = B 120000\n}\n'
    const map = parseTempoMap(chart)
    expect(msToTick(map, 12.4)).toBe(2) // 2.48 ticks → 2
    expect(msToTick(map, 12.5)).toBe(3) // 2.5 ticks → 3 (half rounds up)
    expect(msToTick(map, 2.4)).toBe(0) // 0.48 → 0
    expect(msToTick(map, 2.5)).toBe(1) // 0.5 → 1
  })
})

// ─── injectLyrics ────────────────────────────────────────────────────────────

const LRC_THREE_LINES = [
  '[ar: Someone]',
  '[ti: Test Song]',
  '[00:01.00] Hello world',
  '[00:02.00] Second line',
  '[00:03.00] End',
  ''
].join('\n')

/**
 * 120 BPM at resolution 192 (2.604166… ms/tick, 192 ticks per 500 ms), with an
 * optional `[Song] Offset` in seconds. The offset cases and the no-offset case
 * differ in that one line and nothing else, so a tick difference between them
 * can only come from the offset.
 */
const offsetChart = (offsetSeconds: number | null): string =>
  [
    '[Song]',
    '{',
    '  Name = "Test Song"',
    ...(offsetSeconds === null ? [] : [`  Offset = ${offsetSeconds}`]),
    '  Resolution = 192',
    '}',
    '[SyncTrack]',
    '{',
    '  0 = TS 4',
    '  0 = B 120000',
    '}',
    '[ExpertSingle]',
    '{',
    '  192 = N 0 0',
    '}',
    ''
  ].join('\n')

/** The `[Events]` block `offsetChart` + `LRC_THREE_LINES` should produce. */
const expectedEvents = (t0: number, t1: number, t2: number, end: number): string =>
  [
    '[Events]',
    '{',
    `  ${t0} = E "phrase_start"`,
    `  ${t0} = E "lyric Hello"`,
    `  ${t0} = E "lyric world"`,
    `  ${t1} = E "phrase_end"`,
    `  ${t1} = E "phrase_start"`,
    `  ${t1} = E "lyric Second"`,
    `  ${t1} = E "lyric line"`,
    `  ${t2} = E "phrase_end"`,
    `  ${t2} = E "phrase_start"`,
    `  ${t2} = E "lyric End"`,
    `  ${end} = E "phrase_end"`,
    '}'
  ].join('\n')

describe('injectLyrics', () => {
  let root: string
  let library: string
  let chartDir: string
  let chartPath: string

  beforeEach(() => {
    root = tmpDir('lyrics')
    library = join(root, 'library')
    chartDir = join(library, 'Artist - Song (Charter)')
    mkdirSync(chartDir, { recursive: true })
    chartPath = join(chartDir, 'notes.chart')
  })

  const folders = (): { path: string }[] => [{ path: library }]

  it('injects LRC lines as phrase/lyric events at tempo-mapped ticks', async () => {
    writeFileSync(chartPath, MULTI_TEMPO_CHART)
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    const text = readFileSync(chartPath, 'utf8')
    // Hand-computed ticks against MULTI_TEMPO_CHART (res 192, 120→240 BPM at 768):
    //   [00:01.00] = 1000ms → 384   (1000 / 2.6041666...)
    //   [00:02.00] = 2000ms → 768   (exactly the tempo boundary)
    //   [00:03.00] = 3000ms → 1536  (768 + 1000 / 1.3020833...)
    //   last phrase_end = 1536 + 4 beats = 1536 + 4 * 192 = 2304
    const expected = [
      '[Events]',
      '{',
      '  384 = E "section Intro"',
      '  384 = E "phrase_start"',
      '  384 = E "lyric Hello"',
      '  384 = E "lyric world"',
      '  768 = E "phrase_end"',
      '  768 = E "phrase_start"',
      '  768 = E "lyric Second"',
      '  768 = E "lyric line"',
      '  1536 = E "phrase_end"',
      '  1536 = E "phrase_start"',
      '  1536 = E "lyric End"',
      '  2304 = E "phrase_end"',
      '}'
    ].join('\n')
    expect(text).toContain(expected)
    // Non-Events sections survive untouched.
    expect(text).toContain('  192 = N 0 0')
    expect(text).toContain('  768 = B 240000')
  })

  it('is idempotent: injecting twice yields identical bytes', async () => {
    writeFileSync(chartPath, MULTI_TEMPO_CHART)
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    const first = readFileSync(chartPath)
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    const second = readFileSync(chartPath)
    expect(second.equals(first)).toBe(true)
  })

  it('replaces existing lyric events instead of duplicating them', async () => {
    const withLyrics = MULTI_TEMPO_CHART.replace(
      '[Events]\n{\n  384 = E "section Intro"\n}',
      [
        '[Events]',
        '{',
        '  100 = E "phrase_start"',
        '  100 = E "lyric Old"',
        '  200 = E "phrase_end"',
        '  384 = E "section Intro"',
        '}'
      ].join('\n')
    )
    writeFileSync(chartPath, withLyrics)
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    const text = readFileSync(chartPath, 'utf8')
    expect(text).not.toContain('lyric Old')
    expect(text).not.toContain('100 = E')
    expect(text).toContain('  384 = E "section Intro"')
    expect(text).toContain('  384 = E "lyric Hello"')
    // Exactly one phrase_start per LRC line.
    expect(text.match(/phrase_start/g)).toHaveLength(3)
  })

  it('creates the [Events] section when the chart has none', async () => {
    writeFileSync(chartPath, SINGLE_TEMPO_CHART)
    await injectLyrics(chartPath, 'folder', '[00:01.00] Hello', folders(), null)
    const text = readFileSync(chartPath, 'utf8')
    expect(text).toContain('[Events]')
    expect(text).toContain('  384 = E "phrase_start"')
    expect(text).toContain('  384 = E "lyric Hello"')
    // last line phrase_end: 384 + 4 * 192 = 1152
    expect(text).toContain('  1152 = E "phrase_end"')
    // Other sections still intact.
    expect(text).toContain('[ExpertSingle]')
  })

  it('tolerates millisecond LRC timestamps and skips metadata/empty lines', async () => {
    writeFileSync(chartPath, SINGLE_TEMPO_CHART)
    const lrc = '[by: someone]\n[00:01.000] Milli line\n[00:02.00]\n'
    await injectLyrics(chartPath, 'folder', lrc, folders(), null)
    const text = readFileSync(chartPath, 'utf8')
    expect(text).toContain('  384 = E "lyric Milli"')
    expect(text).toContain('  384 = E "lyric line"')
    // The empty [00:02.00] line produces no phrase of its own.
    expect(text.match(/phrase_start/g)).toHaveLength(1)
  })

  it('rejects .mid charts with a clear message', async () => {
    const midPath = join(chartDir, 'notes.mid')
    writeFileSync(midPath, 'MThd')
    await expect(injectLyrics(midPath, 'folder', '[00:01.00] Hi', folders(), null)).rejects.toThrow(
      /\.chart/i
    )
  })

  it('rejects a folder chart whose file is a .sng with a clear message', async () => {
    // chartType says folder, so the path is treated as a chart file on disk, and a .sng is
    // not one. (A real .sng chart arrives as chartType 'sng'; see the archive tests below.)
    const sngPath = join(chartDir, 'song.sng')
    writeFileSync(sngPath, 'SNGPKG')
    await expect(injectLyrics(sngPath, 'folder', '[00:01.00] Hi', folders(), null)).rejects.toThrow(
      /\.chart/i
    )
  })

  it('rejects LRC text with no synced lines', async () => {
    writeFileSync(chartPath, SINGLE_TEMPO_CHART)
    await expect(
      injectLyrics(chartPath, 'folder', '[ar: nobody]\nplain text\n', folders(), null)
    ).rejects.toThrow(/no synced/i)
  })

  it('rejects a chart path outside the library (guarded write)', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const outsideChart = join(outside, 'notes.chart')
    writeFileSync(outsideChart, SINGLE_TEMPO_CHART)
    await expect(
      injectLyrics(outsideChart, 'folder', '[00:01.00] Hi', folders(), null)
    ).rejects.toThrow(/library/i)
  })

  // LRC timestamps are positions in the audio file. `[Song] Offset` (seconds)
  // is how much later than the audio the chart's tick 0 sits, so the chart-time
  // of an LRC line is `lrcMs - offsetMs`. See parseSongOffsetMs in lyrics.ts.

  it('places lyrics on raw tempo-map ticks when [Song] has no Offset', async () => {
    // The regression guard for every chart in existence: 1000/2000/3000 ms at
    // 2.604166… ms/tick are 384/768/1152, last phrase_end + 4 beats = 1920.
    writeFileSync(chartPath, offsetChart(null))
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    expect(readFileSync(chartPath, 'utf8')).toContain(expectedEvents(384, 768, 1152, 1920))
  })

  it('is byte-identical with Offset = 0 and with no Offset at all', async () => {
    writeFileSync(chartPath, offsetChart(null))
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    const withoutKey = readFileSync(chartPath, 'utf8')

    const zeroPath = join(chartDir, 'zero.chart')
    writeFileSync(zeroPath, offsetChart(0))
    await injectLyrics(zeroPath, 'folder', LRC_THREE_LINES, folders(), null)
    const withZero = readFileSync(zeroPath, 'utf8')

    expect(withZero).toBe(withoutKey.replace('  Name = "Test Song"', '$&\n  Offset = 0'))
  })

  it('pulls lyrics earlier by a positive Offset (the chart starts after the audio)', async () => {
    // Offset 0.5 s: chart-time = lrcMs - 500, so 500/1500/2500 ms → 192/576/960,
    // and the last phrase_end is 960 + 4 * 192 = 1728.
    writeFileSync(chartPath, offsetChart(0.5))
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    expect(readFileSync(chartPath, 'utf8')).toContain(expectedEvents(192, 576, 960, 1728))
  })

  it('pushes lyrics later by a negative Offset', async () => {
    // Offset -0.5 s: chart-time = lrcMs + 500, so 1500/2500/3500 ms →
    // 576/960/1344, and the last phrase_end is 1344 + 4 * 192 = 2112.
    writeFileSync(chartPath, offsetChart(-0.5))
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    expect(readFileSync(chartPath, 'utf8')).toContain(expectedEvents(576, 960, 1344, 2112))
  })

  it('clamps to tick 0 a lyric that a positive Offset pushes before the chart', async () => {
    // Offset 1.5 s puts the first line at -500 ms. There is no negative tick, so
    // it lands at 0; the rest are 500/1500 ms → 192/576, phrase_end 576 + 768.
    writeFileSync(chartPath, offsetChart(1.5))
    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), null)
    expect(readFileSync(chartPath, 'utf8')).toContain(expectedEvents(0, 192, 576, 1344))
  })
})

// ─── injectLyrics into a .sng archive ────────────────────────────────────────

describe('injectLyrics (.sng)', () => {
  const ART = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7, 7])
  const encoder = new TextEncoder()
  const chartEntry = (text = MULTI_TEMPO_CHART): { fileName: string; data: Uint8Array } => ({
    fileName: 'notes.chart',
    data: encoder.encode(text)
  })

  let library: string
  let sngPath: string

  beforeEach(() => {
    library = tmpDir('snglyrics')
    sngPath = join(library, 'Artist - Song.sng')
  })

  const folders = (): { path: string }[] => [{ path: library }]

  const readBack = async (): Promise<{ fileName: string; data: Uint8Array }[]> =>
    (await readSngForRepack(new Uint8Array(readFileSync(sngPath)))).entries

  it('injects lyrics into the archived notes.chart without disturbing its other files', async () => {
    writeFileSync(
      sngPath,
      makeSng([chartEntry(), { fileName: 'album.png', data: ART }], { name: 'Song' })
    )
    await injectLyrics(sngPath, 'sng', LRC_THREE_LINES, folders(), null)

    const entries = await readBack()
    const chart = new TextDecoder().decode(entries.find((e) => e.fileName === 'notes.chart')!.data)
    // Same ticks the folder-chart test pins, so the archive path shares the tempo mapping.
    expect(chart).toContain('  384 = E "phrase_start"')
    expect(chart).toContain('  384 = E "lyric Hello"')
    expect(chart).toContain('  2304 = E "phrase_end"')
    expect(chart).toContain('  384 = E "section Intro"')
    // The sibling asset survives byte-identical, and nothing is added or dropped.
    expect(entries.find((e) => e.fileName === 'album.png')?.data).toEqual(ART)
    expect(entries.map((e) => e.fileName).sort()).toEqual(['album.png', 'notes.chart'])
  })

  it('replaces the archived chart rather than adding a second copy', async () => {
    writeFileSync(sngPath, makeSng([chartEntry()], { name: 'Song' }))
    await injectLyrics(sngPath, 'sng', LRC_THREE_LINES, folders(), null)
    await injectLyrics(sngPath, 'sng', LRC_THREE_LINES, folders(), null)
    const entries = await readBack()
    expect(entries.map((e) => e.fileName)).toEqual(['notes.chart'])
    const chart = new TextDecoder().decode(entries[0].data)
    expect(chart.match(/phrase_start/g)).toHaveLength(3)
  })

  it('rejects an archived .mid with exactly the message a .mid on disk gets', async () => {
    const rejection = async (promise: Promise<void>): Promise<Error> => {
      const caught: unknown = await promise.then(
        () => null,
        (err: unknown) => err
      )
      if (!(caught instanceof Error)) throw new Error('expected injectLyrics to reject')
      return caught
    }

    const chartDir = join(library, 'Artist - Song (Charter)')
    mkdirSync(chartDir)
    const midPath = join(chartDir, 'notes.mid')
    writeFileSync(midPath, 'MThd')
    const onDisk = await rejection(
      injectLyrics(midPath, 'folder', '[00:01.00] Hi', folders(), null)
    )

    writeFileSync(
      sngPath,
      makeSng([{ fileName: 'notes.mid', data: encoder.encode('MThd') }], { name: 'Song' })
    )
    const inArchive = await rejection(
      injectLyrics(sngPath, 'sng', '[00:01.00] Hi', folders(), null)
    )

    // Same limitation, same explanation: a .sng must not invent a second story for it.
    expect(inArchive.message).toBe(onDisk.message)
    expect(onDisk.message).toMatch(/\.mid is not supported/)
  })

  it('rejects an archive that holds no chart file at all', async () => {
    writeFileSync(sngPath, makeSng([{ fileName: 'album.png', data: ART }], { name: 'Song' }))
    await expect(injectLyrics(sngPath, 'sng', '[00:01.00] Hi', folders(), null)).rejects.toThrow(
      /no chart file/i
    )
  })

  it('leaves the archive untouched when the LRC has no synced lines', async () => {
    writeFileSync(sngPath, makeSng([chartEntry()], { name: 'Song' }))
    const before = readFileSync(sngPath)
    await expect(injectLyrics(sngPath, 'sng', 'plain text\n', folders(), null)).rejects.toThrow(
      /no synced/i
    )
    expect(readFileSync(sngPath).equals(before)).toBe(true)
  })

  it('rejects an archive outside the library', async () => {
    const outside = tmpDir('snglyrics-out')
    const outsideSng = join(outside, 'Artist - Song.sng')
    writeFileSync(outsideSng, makeSng([chartEntry()], { name: 'Song' }))
    await expect(injectLyrics(outsideSng, 'sng', LRC_THREE_LINES, folders(), null)).rejects.toThrow(
      /library/i
    )
  })
})

// ─── searchLyrics ────────────────────────────────────────────────────────────

describe('searchLyrics', () => {
  /** Mock fetch returning a JSON body, recording the requested URL. */
  function jsonFetch(status: number, body: unknown, seenUrls: string[] = []): typeof fetch {
    return ((url: string) => {
      seenUrls.push(url)
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        json: () => Promise.resolve(body)
      } as unknown as Response)
    }) as typeof fetch
  }

  it('returns parsed results with synced derived from syncedLyrics', async () => {
    const body = [
      {
        id: 1,
        trackName: 'Lateralus',
        artistName: 'Tool',
        syncedLyrics: '[00:01.00] hi',
        plainLyrics: 'hi'
      },
      {
        id: 2,
        trackName: 'Lateralus (live)',
        artistName: 'Tool',
        syncedLyrics: null,
        plainLyrics: 'hi'
      }
    ]
    const results = await searchLyrics('Tool', 'Lateralus', jsonFetch(200, body))
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      id: 1,
      trackName: 'Lateralus',
      artistName: 'Tool',
      synced: true,
      syncedLyrics: '[00:01.00] hi',
      plainLyrics: 'hi'
    })
    expect(results[1].synced).toBe(false)
    expect(results[1].syncedLyrics).toBeNull()
  })

  it('encodes artist and track into the query string', async () => {
    const seen: string[] = []
    await searchLyrics('AC/DC', 'T.N.T. & more', jsonFetch(200, [], seen))
    expect(seen[0]).toBe(
      'https://lrclib.net/api/search?artist_name=AC%2FDC&track_name=T.N.T.%20%26%20more'
    )
  })

  it('rejects on non-200 responses', async () => {
    await expect(searchLyrics('a', 'b', jsonFetch(503, []))).rejects.toThrow(/503/)
  })

  it('rejects on invalid JSON', async () => {
    const badJson = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.reject(new SyntaxError('Unexpected token'))
      } as unknown as Response)) as typeof fetch
    await expect(searchLyrics('a', 'b', badJson)).rejects.toThrow(/invalid JSON/i)
  })

  it('rejects when the response is not an array', async () => {
    await expect(searchLyrics('a', 'b', jsonFetch(200, { nope: true }))).rejects.toThrow(
      /unexpected/i
    )
  })
})

// ─── undo ────────────────────────────────────────────────────────────────────

/**
 * Injection is the one asset write that changes what Clone Hero matches the chart by: the
 * chart file is what `getChartHash` hashes, and injection rewrites it. So the round trip here
 * proves three things the others do not have to: the hash MOVED on the write, the backup
 * recorded the hash from before it, and the restore landed exactly back on that value (the
 * second of `assertRestoreHash`'s two acceptable outcomes, and the only one a lyrics undo can
 * reach).
 */
describe('injectLyrics undo', () => {
  let root: string
  let library: string
  let chartDir: string
  let chartPath: string
  let store: string

  beforeEach(() => {
    root = tmpDir('lyrics-undo')
    library = join(root, 'library')
    chartDir = join(library, 'Artist - Song (Charter)')
    mkdirSync(chartDir, { recursive: true })
    chartPath = join(chartDir, 'notes.chart')
    store = join(root, 'fix-backups')
  })

  const folders = (): { path: string }[] => [{ path: library }]

  async function undo(): Promise<void> {
    const backups = listBackups(store)
    expect(backups).toHaveLength(1)
    await restoreBackup({ storeDir: store, libraryFolders: folders() }, backups[0].id)
  }

  it("puts a folder chart's notes.chart back byte for byte, on the hash it had before", async () => {
    writeFileSync(chartPath, MULTI_TEMPO_CHART)
    const original = readFileSync(chartPath)
    const before = await scanChartIssues(chartDir, 'folder')
    expect(before.chartHash).not.toBeNull()

    await injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), store)

    // The write did what it says: the chart text, and with it the hash, changed.
    expect(readFileSync(chartPath).equals(original)).toBe(false)
    const written = await scanChartIssues(chartDir, 'folder')
    expect(written.chartHash).not.toBe(before.chartHash)

    // The backup is filed under the FOLDER (the catalog path), names the chart file, and carries
    // the hash from before the write, which is the value the restore is held to.
    const [backup] = listBackups(store)
    expect(backup.chartPath).toBe(chartDir)
    expect(backup.chartType).toBe('folder')
    expect(backup.describe).toBe('Lyrics')
    expect(backup.code).toBe('lyrics')
    expect(backup.files.map((f) => f.fileName)).toEqual(['notes.chart'])
    expect(backup.remove).toEqual([])
    expect(backup.chartHash).toBe(before.chartHash)

    await undo()

    expect(readFileSync(chartPath).equals(original)).toBe(true)
    expect((await scanChartIssues(chartDir, 'folder')).chartHash).toBe(before.chartHash)
    expect(listBackups(store)).toEqual([])
  })

  it("puts a .sng chart's notes.chart entry back byte for byte, on the hash it had before", async () => {
    const sngPath = join(library, 'Artist - Song.sng')
    const ART = new Uint8Array([137, 80, 78, 71])
    const original = new TextEncoder().encode(MULTI_TEMPO_CHART)
    writeFileSync(
      sngPath,
      makeSng(
        [
          { fileName: 'notes.chart', data: original },
          { fileName: 'album.png', data: ART }
        ],
        { name: 'Song' }
      )
    )
    const before = await scanChartIssues(sngPath, 'sng')
    expect(before.chartHash).not.toBeNull()

    await injectLyrics(sngPath, 'sng', LRC_THREE_LINES, folders(), store)
    expect((await scanChartIssues(sngPath, 'sng')).chartHash).not.toBe(before.chartHash)
    expect(listBackups(store)[0].chartHash).toBe(before.chartHash)

    await undo()

    const entries = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(entries.entries.map((e) => e.fileName).sort()).toEqual(['album.png', 'notes.chart'])
    expect(entries.entries.find((e) => e.fileName === 'notes.chart')?.data).toEqual(original)
    expect(entries.entries.find((e) => e.fileName === 'album.png')?.data).toEqual(ART)
    expect((await scanChartIssues(sngPath, 'sng')).chartHash).toBe(before.chartHash)
  })

  it('fails the injection, with the chart untouched, when the backup cannot be taken', async () => {
    writeFileSync(chartPath, MULTI_TEMPO_CHART)
    writeFileSync(store, 'not a directory')

    await expect(
      injectLyrics(chartPath, 'folder', LRC_THREE_LINES, folders(), store)
    ).rejects.toThrow()

    expect(readFileSync(chartPath, 'utf8')).toBe(MULTI_TEMPO_CHART)
  })

  it('keeps no backup when the LRC has no synced lines, because nothing was written', async () => {
    writeFileSync(chartPath, MULTI_TEMPO_CHART)
    await expect(
      injectLyrics(chartPath, 'folder', 'plain text\n', folders(), store)
    ).rejects.toThrow(/no synced/i)
    expect(existsSync(store) ? listBackups(store) : []).toEqual([])
  })
})
