import { describe, expect, it } from 'vitest'
import type { ChartData } from './api/enchor'
import {
  SURPRISE_COUNT,
  pageCount,
  randomPage,
  sampleCharts,
  usableChart,
  withoutSeen
} from './surprise-pick'

/**
 * A chart that is worth offering, so each test below can spoil exactly one thing about it.
 *
 * Note counts are on it by default: a result with no `notesData` is Chorus Encore's own way of
 * saying it has not finished processing the chart, and that is one of the three exclusions.
 */
function chart(over: Partial<ChartData> = {}): ChartData {
  return {
    chartId: 1,
    songId: 1,
    md5: 'a'.repeat(32),
    albumArtMd5: null,
    hasVideoBackground: false,
    name: 'Everlong',
    artist: 'Foo Fighters',
    album: '',
    genre: '',
    year: '1997',
    charter: 'CharterA',
    song_length: 250_000,
    diff_guitar: 4,
    diff_bass: null,
    diff_drums: null,
    diff_keys: null,
    diff_vocals: null,
    notesData: { noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 900 }] },
    ...over
  }
}

/** A generator that walks a fixed list, so every draw in a test is written down. */
function fixed(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

describe('pageCount', () => {
  it('counts the pages a catalog has', () => {
    expect(pageCount(95_299, 100)).toBe(953)
    expect(pageCount(100, 100)).toBe(1)
    expect(pageCount(101, 100)).toBe(2)
  })

  it('answers one page for a size nothing could read, rather than none', () => {
    // The catalog-size request failing leaves 0 behind, and page 1 exists whatever the size is.
    expect(pageCount(0, 100)).toBe(1)
    expect(pageCount(-5, 100)).toBe(1)
    expect(pageCount(Number.NaN, 100)).toBe(1)
  })
})

describe('randomPage', () => {
  it('spreads the draw over the whole catalog', () => {
    expect(randomPage(95_299, 100, () => 0)).toBe(1)
    expect(randomPage(95_299, 100, () => 0.5)).toBe(477)
    // A generator that answers 1 is out of contract, and clamping it is what stops a page past
    // the end being asked for.
    expect(randomPage(95_299, 100, () => 1)).toBe(953)
  })

  it('refuses the page the last roll drew, so two presses are not the same hundred charts', () => {
    // The same draw twice: without the guard this is the always-the-same failure mode.
    expect(randomPage(95_299, 100, () => 0.5, 477)).toBe(478)
    // The last page wraps to the first rather than running off the end.
    expect(randomPage(95_299, 100, () => 1, 953)).toBe(1)
  })

  it('still answers when there is only one page to draw', () => {
    // A single-page catalog has nowhere else to go, so avoiding the last draw cannot apply.
    expect(randomPage(40, 100, () => 0.9, 1)).toBe(1)
  })
})

describe('usableChart: what a surprise leaves out beyond ownership', () => {
  const linux = 'linux'

  it('offers a clean, playable chart', () => {
    expect(usableChart(chart(), linux)).toBe(true)
  })

  it('leaves out a chart with no md5, because there is no address to download', () => {
    // The API sends these: a chart it has not finished processing comes back with empty hashes.
    expect(usableChart(chart({ md5: '' }), linux)).toBe(false)
  })

  it('leaves out a chart with no notes data at all', () => {
    expect(usableChart(chart({ notesData: null }), linux)).toBe(false)
  })

  it('leaves out a chart whose note counts are all zero', () => {
    const empty = { noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 0 }] }
    expect(usableChart(chart({ notesData: empty }), linux)).toBe(false)
  })

  it('leaves out a chart Clone Hero cannot play', () => {
    const broken = chart({ folderIssues: [{ folderIssue: 'noAudio', description: 'No audio' }] })
    expect(usableChart(broken, linux)).toBe(false)
  })

  it('keeps a chart whose only issues are charting notes', () => {
    // `babySustain` is craft, not breakage: the chart plays. Refusing to offer somebody a song
    // over it would leave most of the catalog unreachable.
    const tidy = chart({
      notesData: {
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 900 }],
        chartIssues: [{ noteIssue: 'babySustain', description: 'Sustain is very short' }]
      }
    })
    expect(usableChart(tidy, linux)).toBe(true)
  })
})

describe('sampleCharts', () => {
  const pool = [1, 2, 3, 4, 5, 6, 7, 8].map((chartId) => chart({ chartId, songId: chartId }))

  it('draws the asked-for number without repeating one', () => {
    const drawn = sampleCharts(pool, SURPRISE_COUNT, fixed([0.9, 0.1, 0.5, 0.3, 0.7]))
    expect(drawn).toHaveLength(5)
    expect(new Set(drawn.map((c) => c.chartId)).size).toBe(5)
  })

  it('is the same five for the same draws, and different five for different ones', () => {
    const seed = [0.9, 0.1, 0.5, 0.3, 0.7]
    const a = sampleCharts(pool, SURPRISE_COUNT, fixed(seed)).map((c) => c.chartId)
    const b = sampleCharts(pool, SURPRISE_COUNT, fixed(seed)).map((c) => c.chartId)
    const c = sampleCharts(pool, SURPRISE_COUNT, fixed([0.1, 0.9, 0.2, 0.8, 0.4])).map(
      (x) => x.chartId
    )
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('leaves the caller its own array', () => {
    const before = pool.map((c) => c.chartId)
    sampleCharts(pool, SURPRISE_COUNT, fixed([0.9, 0.1, 0.5, 0.3, 0.7]))
    expect(pool.map((c) => c.chartId)).toEqual(before)
  })

  it('answers with everything it has when there is less than asked for', () => {
    const three = pool.slice(0, 3)
    expect(sampleCharts(three, SURPRISE_COUNT, fixed([0.5]))).toHaveLength(3)
    expect(sampleCharts([], SURPRISE_COUNT, fixed([0.5]))).toEqual([])
  })

  it('stays inside the pool when the generator answers 1', () => {
    // Out of contract, and an unclamped index would read past the end and return undefined rows.
    const drawn = sampleCharts(pool, SURPRISE_COUNT, () => 1)
    expect(drawn).toHaveLength(5)
    expect(drawn.every((c) => c !== undefined)).toBe(true)
  })
})

describe('withoutSeen', () => {
  it('drops the charts an earlier page already offered', () => {
    const page = [1, 2, 3].map((chartId) => chart({ chartId }))
    expect(withoutSeen(page, new Set([2])).map((c) => c.chartId)).toEqual([1, 3])
  })
})
