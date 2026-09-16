import type { ChartData } from './api/enchor'
import { issueSummary } from './issue-summary'

/**
 * The decisions behind "5 charts you don't own", kept apart from the store that makes the
 * requests so each one can be tested on its own.
 *
 * Nothing here talks to anything. The store hands it a page of search results and a source of
 * randomness, and it answers which charts are worth offering and which five to offer.
 */

/** How many charts a surprise offers. The approved design's number. */
export const SURPRISE_COUNT = 5

/**
 * How many charts one request asks for.
 *
 * 100 rather than Explore's 25, and it is the same 100 `main/updates/client.ts` records as the
 * largest the endpoint honours. A surprise is one request that has to survive being filtered
 * twice, by playability and by ownership, and still leave five charts standing; a page of 25
 * would have run out of candidates and spent a second request to say so.
 */
export const SURPRISE_PAGE_SIZE = 100

/**
 * How many pages the last attempt draws from.
 *
 * Nothing in this repo has measured how deep `page` may go. The deepest offset anyone has is
 * 525, written down in `SearchStore.hasMore`: `/search "metallica"` was paged to 21 pages of
 * 25 and answered. 500 charts is that measurement rounded down, so the final attempt asks a
 * question the service is known to answer. It is a smaller pool and therefore a worse surprise,
 * which is why it is the last attempt and not the first.
 */
export const SHALLOW_POOL = 500

/** A number in [0, 1). `Math.random` in the app, something fixed under test. */
export type Random = () => number

/**
 * How many pages of `size` a catalog of `total` charts has, never fewer than one.
 *
 * A total of 0 is what an unanswered catalog-size request leaves behind, and one page is the
 * honest thing to ask for then: page 1 exists whatever the size is.
 */
export function pageCount(total: number, size: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  return Math.max(1, Math.ceil(total / size))
}

/**
 * A page number in [1, pages], never `avoid`.
 *
 * `avoid` is the page the previous roll drew. Two presses in a row landing on the same page
 * would offer five charts out of the same hundred, which is the failure mode "surprise" is
 * named after. Stepping on by one rather than re-rolling keeps this a pure function of one
 * draw: a re-roll loop fed by a fixed `random` under test would never terminate.
 */
export function randomPage(
  total: number,
  size: number,
  random: Random,
  avoid: number | null = null
): number {
  const pages = pageCount(total, size)
  const draw = Math.min(pages - 1, Math.max(0, Math.floor(random() * pages)))
  const page = draw + 1
  if (page !== avoid || pages === 1) return page
  return (page % pages) + 1
}

/**
 * Whether a chart is worth putting in front of someone who did not ask for it by name.
 *
 * Three exclusions, each one a thing the response itself says, and each one a chart the user
 * could not use if it arrived:
 *
 * - No `md5`. That is the whole of the download address (`chartDownloadUrl`), so there is
 *   nothing to fetch. `main/updates/client.ts` records that the API really does send such rows:
 *   a chart it has not finished processing comes back with the hash fields empty.
 * - No notes. `notesData` is null on those same unprocessed rows, and a chart whose note counts
 *   are all zero is a chart with nothing to play. `remoteHealth` already reads this field to
 *   decide the same thing for the rail.
 * - A blocking issue. Chorus Encore runs scan-chart over everything it ingests and sends the
 *   findings with every result, and `explainIssue` already splits those into "Clone Hero cannot
 *   play this, or will show it wrong" and "somebody would rather it were tidier". The first kind
 *   is exactly the bad surprise. The second kind stays: the chart plays, and a charting note is
 *   not a reason to refuse to offer somebody a song.
 *
 * Quality issues are deliberately kept, and so is everything else about a chart. Taste is not
 * measurable from this response: there is no download count, no rating and no file size in any
 * of the 66 fields a result carries (see `ChartData`), so a filter for "good" charts would be
 * a filter for something else wearing that name.
 */
export function usableChart(chart: ChartData, platform: string): boolean {
  if (!chart.md5) return false
  const counts = chart.notesData?.noteCounts
  if (!counts || !counts.some((entry) => entry.count > 0)) return false
  return issueSummary(chart, platform).blocking === 0
}

/**
 * `count` of `charts`, drawn without replacement.
 *
 * A partial Fisher-Yates over a copy: every subset of the input is equally likely, each draw
 * costs exactly one call to `random`, and the number of calls depends only on how many charts
 * are wanted. That last part is what makes the result predictable under test from a fixed
 * sequence of numbers rather than from a loop nobody can count.
 */
export function sampleCharts(
  charts: readonly ChartData[],
  count: number,
  random: Random
): ChartData[] {
  const pool = [...charts]
  const take = Math.min(count, pool.length)
  for (let i = 0; i < take; i++) {
    const j =
      i + Math.min(pool.length - i - 1, Math.max(0, Math.floor(random() * (pool.length - i))))
    const held = pool[i]
    pool[i] = pool[j]
    pool[j] = held
  }
  return pool.slice(0, take)
}

/** Charts not already in `seen`, by chartId. Two attempts can draw the same page's neighbours. */
export function withoutSeen(charts: readonly ChartData[], seen: ReadonlySet<number>): ChartData[] {
  return charts.filter((chart) => !seen.has(chart.chartId))
}
