import type { PlayDay } from '../../../shared/play'

/**
 * The play history as a row of blocks a chart can draw, and nothing else.
 *
 * Pure, and in its own module rather than inside Stats.svelte, for the reason `shortcuts.ts`
 * is: the node test project can compile a `.ts` file and cannot compile a component, so the
 * whole of this decision table is testable without a DOM. What to PAINT is the component's
 * business; what a block covers and how many plays are in it is this file's.
 *
 * ## The window, and why it starts where it does
 *
 * The first block starts on the day of the first recorded play, never earlier. Encore's history
 * begins the first time it saw Clone Hero's score file change (see shared/play.ts), so an axis
 * that ran back to the start of that calendar month, or to a Monday before it, would be drawing
 * empty days that are not evidence of anything: nobody can tell "you did not play" from "Encore
 * was not watching". Blocks are therefore counted FORWARD from that day in fixed lengths, not
 * snapped to weeks or months.
 *
 * The window ends today, so a gap since the last play is visible rather than cropped away. The
 * block today falls in is marked `partial`: it is still being filled, and a half-finished block
 * drawn next to whole ones reads as a drop that has not happened.
 */

/** Most blocks a chart of this size can carry and still be a chart rather than a comb. */
const MAX_BLOCKS = 90

/** The block lengths tried in order, longest window first. Beyond these the length is computed. */
const BLOCK_STEPS = [1, 7, 28] as const

export interface ActivityBlock {
  /** First day in the block, `YYYY-MM-DD` local, as `PlayDay.day` is. */
  start: string
  /** Last day in the block, inclusive, clamped to the end of the window. */
  end: string
  plays: number
  /** True for the block the window ends inside, which has days still to come. */
  partial: boolean
}

export interface Activity {
  blocks: ActivityBlock[]
  /** How many days one block covers. 1 means the chart is a bar per day. */
  blockDays: number
  /** The busiest block's count, which is what the bars are scaled against. */
  peak: number
  /** The single busiest day, for the line under the chart. Null only when nothing is recorded. */
  busiest: PlayDay | null
  /** Days from the first recorded play to the end of the window, inclusive. */
  windowDays: number
  /** Days in that window with at least one recorded play. */
  activeDays: number
}

const MS_PER_DAY = 86_400_000

/**
 * A `Date` as the `YYYY-MM-DD` its own timezone calls it.
 *
 * Built from the local getters rather than through a locale or `toISOString`: the first would
 * depend on what the user's locale spells a date like, and the second would answer in UTC,
 * which is a different day for a third of the world for a third of the time. The day strings
 * this produces are the ones `playInsights` groups by, which is the point.
 */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * `YYYY-MM-DD` to a UTC timestamp, and back.
 *
 * Day arithmetic runs in UTC deliberately, on dates that are local. Adding 24 hours to a local
 * date crosses a daylight-saving boundary twice a year and lands on the same day or skips one;
 * UTC has no such boundary, so counting days this way is exact. The values never leave this
 * module as timestamps, so nothing downstream can mistake them for instants.
 */
function toUtc(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Days from `from` to `to` inclusive. 1 when they are the same day. */
function spanDays(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY) + 1
}

/**
 * How long one block should be, so the chart stays readable at any length of history.
 *
 * A day, a week or four weeks while one of those fits; past that the length is whatever divides
 * the window into MAX_BLOCKS, because a decade of history at four weeks a bar is 130 bars.
 */
function blockLength(windowDays: number): number {
  for (const step of BLOCK_STEPS) {
    if (Math.ceil(windowDays / step) <= MAX_BLOCKS) return step
  }
  return Math.ceil(windowDays / MAX_BLOCKS)
}

/**
 * The recorded history as blocks, or null when there is no history to draw.
 *
 * `today` is passed in rather than read off the clock so this stays pure and so a test can say
 * what day it is. It is a local `YYYY-MM-DD`, from `localDay(new Date())`.
 *
 * A play dated after today (a clock that was wrong, a timezone Clone Hero wrote from) extends
 * the window rather than being dropped: it is still a play the user made, and a chart that
 * silently omitted rows would be worse than one whose last block runs a day long.
 */
export function activity(days: PlayDay[], today: string): Activity | null {
  if (days.length === 0) return null
  // The rows arrive ordered by the query, but the ends are taken by comparison rather than by
  // position: these strings sort chronologically, and trusting the caller's order here would
  // make a reordered query a silently wrong chart.
  const first = days.reduce((min, row) => (row.day < min ? row.day : min), days[0].day)
  const lastPlay = days.reduce((max, row) => (row.day > max ? row.day : max), days[0].day)
  const last = today > lastPlay ? today : lastPlay

  const windowDays = spanDays(first, last)
  const blockDays = blockLength(windowDays)
  const startMs = toUtc(first)
  const lastMs = toUtc(last)

  const blocks: ActivityBlock[] = []
  for (let ms = startMs; ms <= lastMs; ms += blockDays * MS_PER_DAY) {
    const endMs = ms + (blockDays - 1) * MS_PER_DAY
    blocks.push({
      start: fromUtc(ms),
      end: fromUtc(Math.min(endMs, lastMs)),
      plays: 0,
      partial: endMs > lastMs
    })
  }

  let busiest: PlayDay | null = null
  for (const row of days) {
    const index = Math.floor((toUtc(row.day) - startMs) / MS_PER_DAY / blockDays)
    // Guarded rather than assumed: a row outside the window would mean `first`/`last` and this
    // index disagree, and writing past the end of the array would fail somewhere else entirely.
    if (index >= 0 && index < blocks.length) blocks[index].plays += row.plays
    if (busiest === null || row.plays > busiest.plays) busiest = row
  }

  return {
    blocks,
    blockDays,
    peak: blocks.reduce((max, block) => (block.plays > max ? block.plays : max), 0),
    busiest,
    windowDays,
    activeDays: days.length
  }
}
