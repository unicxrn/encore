import type { RemoteChart } from './match'

export const ENCHOR_API = 'https://api.enchor.us'

/**
 * The largest `per_page` the API honours. 25 is what the Explore client asks for; the search
 * endpoint accepts 100 and returns it (verified live: "Asking Alexandria" returned 58 rows in one
 * response), which is the difference between one request per artist and four.
 */
const PER_PAGE = 100

/** Shape of the fields this reads off a search response. The endpoint returns far more. */
interface RawChart {
  chartId: number
  name: string | null
  artist: string | null
  charter: string | null
  chartHash: string | null
  md5: string | null
  modifiedTime?: string | null
  hasVideoBackground?: boolean
  notesData?: {
    tempoMapHash?: string | null
    noteCounts?: { count: number }[]
  } | null
}

/**
 * Map one search row, or null if it is unusable.
 *
 * A row without `chartHash` or `md5` cannot be compared or downloaded, and the API does return
 * such rows: `notesData` is null on charts it has not finished processing.
 */
function toRemoteChart(raw: RawChart): RemoteChart | null {
  if (!raw.chartHash || !raw.md5) return null
  return {
    chartId: raw.chartId,
    name: raw.name ?? '',
    artist: raw.artist ?? '',
    charter: raw.charter ?? '',
    chartHash: raw.chartHash,
    md5: raw.md5,
    modifiedTime: raw.modifiedTime ?? null,
    tempoMapHash: raw.notesData?.tempoMapHash ?? null,
    noteCount: (raw.notesData?.noteCounts ?? []).reduce((sum, n) => sum + n.count, 0),
    hasVideoBackground: raw.hasVideoBackground ?? false
  }
}

export interface SearchOpts {
  signal?: AbortSignal
  /** Pages to pull per query. Charts beyond this are simply not considered. */
  maxPages?: number
}

/**
 * Search api.enchor.us and return the rows in the shape the matcher wants.
 *
 * `fetchFn` is injected so the suite never touches the network.
 *
 * A 4xx is terminal and throws, because retrying a 429 is what turns a rate-limited sweep into
 * a stuck one, the same reasoning the renderer's Explore client documents. This deliberately
 * does NOT retry 5xx either: the caller sweeps hundreds of charts and owns the pacing, so a
 * retry here would multiply requests underneath a budget it cannot see.
 */
export async function searchCharts(
  query: string,
  fetchFn: typeof fetch,
  opts: SearchOpts = {}
): Promise<RemoteChart[]> {
  const out: RemoteChart[] = []
  const maxPages = opts.maxPages ?? 2
  // Counts rows the server sent, not rows that survived mapping. Comparing the mapped total
  // against `found` would never catch up on a query whose results include unprocessed charts,
  // and the loop would ask for every page up to maxPages every time.
  let seen = 0
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetchFn(`${ENCHOR_API}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search: query,
        per_page: PER_PAGE,
        page,
        instrument: null,
        difficulty: null,
        drumType: null,
        drumsReviewed: true,
        sort: null,
        source: 'api'
      }),
      signal: opts.signal
    })
    if (!response.ok) {
      throw new Error(
        response.status === 429
          ? 'Chorus Encore is rate-limiting the update check. Wait a minute and try again.'
          : `Update check failed: ${response.status}`
      )
    }
    const body = (await response.json()) as { found?: number; data?: RawChart[] }
    const rows = body.data ?? []
    seen += rows.length
    for (const raw of rows) {
      const mapped = toRemoteChart(raw)
      if (mapped) out.push(mapped)
    }
    if (rows.length === 0 || seen >= (body.found ?? 0)) break
  }
  return out
}
