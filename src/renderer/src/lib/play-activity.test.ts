import { describe, expect, it } from 'vitest'
import { activity, localDay } from './play-activity'

const days = (...rows: [string, number][]): { day: string; plays: number }[] =>
  rows.map(([day, plays]) => ({ day, plays }))

describe('localDay', () => {
  it('spells a date the way the day buckets are keyed', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
    // Zero-padded on both parts: '2026-1-5' would sort before '2026-01-05' and after nothing.
    expect(localDay(new Date(2026, 10, 30, 0, 1))).toBe('2026-11-30')
  })
})

describe('activity: nothing recorded', () => {
  it('answers null, so the caller draws no chart rather than an empty one', () => {
    expect(activity([], '2026-09-12')).toBeNull()
  })
})

describe('activity: where the window starts and stops', () => {
  it('starts on the day of the first recorded play, never before it', () => {
    // The record starts mid-week and mid-month. Both of those are places a chart would
    // conventionally snap back to, and both would draw days Encore was not watching.
    const result = activity(days(['2026-03-11', 2]), '2026-03-13')
    expect(result?.blocks[0].start).toBe('2026-03-11')
  })

  it('runs to today, so a gap since the last play is visible rather than cropped', () => {
    const result = activity(days(['2026-03-01', 1]), '2026-03-10')
    expect(result?.blocks).toHaveLength(10)
    expect(result?.blocks.at(-1)?.start).toBe('2026-03-10')
    expect(result?.blocks.at(-1)?.plays).toBe(0)
    expect(result?.windowDays).toBe(10)
  })

  it('extends the window to a play dated after today rather than dropping it', () => {
    // A wrong clock, or a timezone Clone Hero wrote from. The play happened either way.
    const result = activity(days(['2026-03-01', 1], ['2026-03-20', 3]), '2026-03-10')
    expect(result?.windowDays).toBe(20)
    expect(result?.blocks.at(-1)?.plays).toBe(3)
  })

  it('is one block long when everything happened today', () => {
    const result = activity(days(['2026-09-12', 4]), '2026-09-12')
    expect(result?.blocks).toEqual([
      { start: '2026-09-12', end: '2026-09-12', plays: 4, partial: false }
    ])
    expect(result?.windowDays).toBe(1)
  })
})

describe('activity: how long a block is', () => {
  it('gives a bar per day while the history is short', () => {
    const result = activity(days(['2026-01-01', 1], ['2026-02-01', 1]), '2026-02-10')
    expect(result?.blockDays).toBe(1)
    expect(result?.blocks).toHaveLength(41)
  })

  it('moves to a week a bar once a day a bar would be a comb', () => {
    const result = activity(days(['2026-01-01', 1]), '2026-06-01')
    expect(result?.blockDays).toBe(7)
    expect(result?.blocks.length).toBeLessThanOrEqual(90)
  })

  it('moves to four weeks a bar over a couple of years', () => {
    const result = activity(days(['2024-01-01', 1]), '2026-01-01')
    expect(result?.blockDays).toBe(28)
  })

  it('keeps a decade of history inside the chart by computing a block length for it', () => {
    const result = activity(days(['2016-01-01', 1]), '2026-01-01')
    expect(result?.blocks.length).toBeLessThanOrEqual(90)
    expect(result?.blockDays).toBeGreaterThan(28)
  })
})

describe('activity: what lands in which block', () => {
  it('adds every day of a block together, and counts only days that had a play', () => {
    const result = activity(
      days(['2026-01-01', 2], ['2026-01-03', 5], ['2026-03-01', 1]),
      '2026-06-01'
    )
    expect(result?.blockDays).toBe(7)
    expect(result?.blocks[0]).toMatchObject({ start: '2026-01-01', plays: 7 })
    expect(result?.activeDays).toBe(3)
    expect(result?.peak).toBe(7)
  })

  it('names the busiest single day, not the busiest block', () => {
    const result = activity(days(['2026-01-01', 2], ['2026-01-03', 5]), '2026-06-01')
    expect(result?.busiest).toEqual({ day: '2026-01-03', plays: 5 })
  })

  it('marks the block the window ends inside as still filling', () => {
    // 15 days in, the third week is two days old. A short bar there is not a quiet week.
    const result = activity(days(['2026-01-01', 1]), '2026-05-01')
    const blocks = result?.blocks ?? []
    expect(blocks.at(-1)?.partial).toBe(true)
    expect(blocks.slice(0, -1).every((block) => !block.partial)).toBe(true)
  })

  it('clamps the last block to the end of the window', () => {
    const result = activity(days(['2026-01-01', 1]), '2026-03-01')
    expect(result?.blocks.at(-1)?.end).toBe('2026-03-01')
  })

  it('reads the ends by date rather than by the order the rows arrived in', () => {
    const result = activity(days(['2026-03-05', 1], ['2026-03-01', 2]), '2026-03-06')
    expect(result?.blocks[0]).toMatchObject({ start: '2026-03-01', plays: 2 })
    expect(result?.blocks).toHaveLength(6)
  })

  /**
   * Every block is exactly as long as every other, in days, whatever the calendar did in the
   * middle. Blocks are counted in UTC for this reason: local-time arithmetic across a
   * daylight-saving boundary either repeats a day or skips one.
   */
  it('counts days across a daylight-saving change without losing or repeating one', () => {
    // Europe's clocks went forward on 2026-03-29 and back on 2026-10-25.
    const result = activity(days(['2026-03-28', 1], ['2026-03-30', 1]), '2026-10-26')
    expect(result?.windowDays).toBe(213)
    const covered = (result?.blocks ?? []).reduce(
      (sum, block) =>
        sum + Math.round((Date.parse(block.end) - Date.parse(block.start)) / 86_400_000) + 1,
      0
    )
    expect(covered).toBe(213)
  })
})
