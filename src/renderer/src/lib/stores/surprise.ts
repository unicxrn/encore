import { get } from 'svelte/store'
import { searchCharts, type ChartData } from '../api/enchor'
import { latestCharts, loadLatestCharts } from './latest-charts'
import { browseSearch, type SearchStore } from './search'
import { encore } from './bridge'
import {
  SHALLOW_POOL,
  SURPRISE_COUNT,
  SURPRISE_PAGE_SIZE,
  randomPage,
  sampleCharts,
  usableChart,
  withoutSeen,
  type Random
} from '../surprise-pick'

/**
 * The sidebar's Surprise me: five charts from Chorus Encore that the user does not have.
 *
 * WHAT THE SERVICE OFFERS, having looked. `POST /search` takes `page` and `per_page` and answers
 * with `found` and `out_of`, so the catalog can be counted and then indexed into. What it does
 * not have is any notion of randomness: `sort.type` is an eight-value enum (`SORT_FIELDS`, which
 * was measured by sending a ninth and reading the 400 back) and none of the eight is random, and
 * there is no seed, no sample and no shuffle parameter anywhere in the request. So the randomness
 * has to be built out of the offset, which is what this does: draw a page uniformly from the whole
 * catalog, then draw five charts uniformly from that page.
 *
 * WHY THAT IS NOT ALWAYS THE SAME FIVE. There are around 950 pages of 100, and the five are drawn
 * without replacement out of whichever one came back, so two presses agreeing is a coincidence
 * with roughly one chance in ten million. The one way it could have been the same twice is the
 * same page twice, and `randomPage` refuses to draw the page the previous roll drew.
 *
 * WHY IT IS NOT SLOW. One request answers it. The catalog size comes from the count Home's latest
 * charts row already holds, so it usually costs nothing; the page is one request; ownership is one
 * IPC call over the whole page rather than one per chart. Only a page that cannot fill five costs
 * a second, and the whole thing stops at three pages whatever happens, which is the difference
 * between a surprise and a progress bar.
 */

/** Pages one roll will ask for before it answers with whatever it has. */
export const PAGE_ATTEMPTS = 3

export interface SurpriseConfig {
  /** Where the five land. `browseSearch` in the app; a fresh store under test. */
  list?: SearchStore
  /** [0, 1). `Math.random` in the app, a fixed sequence under test. */
  random?: Random
  fetchFn?: typeof fetch
  retryDelayMs?: number
}

export interface SurpriseStore {
  /** Draw five charts and put them in front of the user. Ignores a press while one is running. */
  roll: () => Promise<void>
}

/** The note while the requests are out. */
export const LOOKING = 'Looking for five charts you do not have on Chorus Encore…'

interface Outcome {
  /** The charts that made it, up to `SURPRISE_COUNT`. */
  picked: number
  /** Playable charts the roll looked at, owned ones included. */
  examined: number
  /** Charts in the whole remote catalog, or null when that count could not be had. */
  total: number | null
  /** False when the library could not be consulted, so "you do not have these" is unproven. */
  checked: boolean
}

/**
 * What the band over the list says, in the words of what actually happened.
 *
 * Every branch here is a real outcome with a real cause, and each one says what to do next. The
 * one thing none of them does is claim the five are unowned when the library could not be read:
 * "you do not have these" is the whole promise of this feature, and a promise made on a check
 * that did not happen is the kind of surprise that ends in a duplicate download.
 */
export function surpriseNote(outcome: Outcome): string {
  const { picked, examined, total, checked } = outcome
  if (picked === 0) {
    return examined === 0
      ? 'Chorus Encore had no playable charts to offer this time. Shuffle to draw again.'
      : `Encore drew ${examined} playable ${examined === 1 ? 'chart' : 'charts'} and you already have every one. Shuffle to draw again.`
  }
  const size = total === null ? 'Chorus Encore' : `the ${total.toLocaleString()} on Chorus Encore`
  const count =
    picked === SURPRISE_COUNT ? 'Five charts' : `${picked} ${picked === 1 ? 'chart' : 'charts'}`
  const head = checked
    ? `${count} you do not have, drawn at random from ${size}.`
    : `${count} drawn at random from ${size}. Encore could not read your library this time, so some of these may already be installed.`
  const short =
    picked < SURPRISE_COUNT ? ' It ran out of candidates before five. Shuffle to draw again.' : ''
  // The header is still showing whatever instrument, order and advanced fields were last set,
  // and none of them narrowed this draw. Said once here rather than by clearing them, which
  // would either put an unasked-for request in the way or leave a mounted Explore showing
  // selects that disagree with the store.
  return `${head}${short} The filters and order above had no part in it.`
}

/** What a roll that could not reach the service says. */
export function failureNote(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err)
  return `Encore could not draw a surprise. ${reason} Shuffle to try again.`
}

export function createSurprise(config: SurpriseConfig = {}): SurpriseStore {
  const { list = browseSearch, random = Math.random, fetchFn = fetch, retryDelayMs } = config
  let inFlight: Promise<void> | null = null
  /**
   * The page the last roll drew, so the next one cannot draw it again.
   *
   * Module-scoped for the life of the store rather than per roll, which is the point: within one
   * roll the pages differ because `randomPage` avoids the previous draw, and across rolls it is
   * what stops two presses in a row offering five charts out of the same hundred.
   */
  let lastPage: number | null = null

  /**
   * How many charts Chorus Encore has, which is what the page is drawn out of.
   *
   * Read off the row Home already loads. That store holds `out_of` from the wildcard search, caps
   * itself at one request per five minutes and exists precisely because this number is worth
   * asking for once; a second count of the same thing would be a second request against the 50 a
   * minute the API allows. A total that cannot be had is not fatal: `randomPage` answers 1, which
   * is a page that exists whatever the size is.
   */
  async function catalogTotal(): Promise<number | null> {
    const held = get(latestCharts).total
    if (held !== null && held > 0) return held
    await loadLatestCharts()
    const loaded = get(latestCharts).total
    return loaded !== null && loaded > 0 ? loaded : null
  }

  /**
   * The charts of `charts` that are not already in the library, and whether that could be checked.
   *
   * `existsByMeta` is the one ownership test this app has: Explore's Hide owned reads it, the
   * chart page's IN LIBRARY button reads it, and it answers "this song by this charter is in your
   * library" over the catalog's own index. A page is at most 100 keys, well under the 250 the IPC
   * boundary caps a batch at, so a whole page costs one call.
   *
   * A failure is not fatal here, it is unproven: an unscanned or missing catalog answers every key
   * false, which is the truth for an empty library, but a catalog that throws has said nothing at
   * all. Five charts under a line admitting the check did not happen is worth more than no
   * surprise, and `surpriseNote` is what admits it.
   */
  async function unowned(charts: ChartData[]): Promise<{ free: ChartData[]; checked: boolean }> {
    if (charts.length === 0) return { free: [], checked: true }
    try {
      const flags = await encore().existsByMeta(
        charts.map((c) => ({ name: c.name, artist: c.artist, charter: c.charter }))
      )
      return { free: charts.filter((_, i) => flags[i] !== true), checked: true }
    } catch {
      return { free: charts, checked: false }
    }
  }

  async function draw(): Promise<void> {
    list.present(LOOKING, null)
    try {
      // Only decides whether `badVideo` counts as breakage. `explainIssue` treats a value it does
      // not know as a platform nobody has checked, which is the honest answer for one.
      const platform = encore().platform
      const total = await catalogTotal()
      const seen = new Set<number>()
      const drawn = new Set<number>()
      const pool: ChartData[] = []
      let examined = 0
      let checked = true
      for (let attempt = 1; attempt <= PAGE_ATTEMPTS && pool.length < SURPRISE_COUNT; attempt++) {
        // The last attempt draws from the shallow end. Nothing here has measured how deep the
        // service will page, so a catalog-wide draw that keeps answering with nothing is the one
        // shape a deep-paging limit would take, and this is the question it is known to answer.
        const reach =
          attempt === PAGE_ATTEMPTS ? Math.min(total ?? SHALLOW_POOL, SHALLOW_POOL) : (total ?? 0)
        const page = randomPage(reach, SURPRISE_PAGE_SIZE, random, lastPage)
        // A catalog too small to have a second page, or a size that could not be read at all,
        // leaves one page to draw from. Asking for it twice would spend a request to be told the
        // same hundred charts, every one of which this roll has already rejected.
        if (drawn.has(page)) break
        drawn.add(page)
        lastPage = page
        const response = await searchCharts(
          { search: '*', page, perPage: SURPRISE_PAGE_SIZE },
          fetchFn,
          { retryDelayMs }
        )
        const fresh = withoutSeen(response.data, seen)
        for (const chart of fresh) seen.add(chart.chartId)
        const usable = fresh.filter((chart) => usableChart(chart, platform))
        examined += usable.length
        const answer = await unowned(usable)
        if (!answer.checked) checked = false
        pool.push(...answer.free)
      }
      const picked = sampleCharts(pool, SURPRISE_COUNT, random)
      const note = surpriseNote({ picked: picked.length, examined, total, checked })
      // Nothing to show is still an answer, and it is one the list has to carry: the note says
      // what happened, and rows left over from the last search underneath it would be five
      // strangers the sentence does not describe.
      list.present(note, picked)
    } catch (err) {
      // The rows stay. A surprise that could not be drawn is no reason to take away whatever the
      // user was looking at, and the note is what says the press was heard.
      list.present(failureNote(err), null)
    }
  }

  function roll(): Promise<void> {
    // A second press while one is running would spend a second page on a question already asked,
    // and both answers would land on the same list.
    if (inFlight) return inFlight
    inFlight = draw().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return { roll }
}

/**
 * The app's one surprise.
 *
 * Module-scoped like `browseSearch`, and for a reason of its own as well as that one: the page it
 * last drew lives here, and a store rebuilt per press could not avoid drawing it again.
 * Constructing it is inert; nothing is requested until `roll` runs.
 */
export const surprise = createSurprise()
