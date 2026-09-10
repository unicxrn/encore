import type { UpdateCheckSummary } from '../../shared/updates'
import {
  classifyChart,
  type ChartVerdict,
  type LocalChartIdentity,
  type RemoteChart
} from './match'

/**
 * Sweeping a library against api.enchor.us without spending one request per chart.
 *
 * The endpoint allows 50 requests per minute (measured: request 51 returns 429), so a naive
 * per-chart sweep of the owner's 219-chart library costs 4.5 minutes of solid requests, and ten
 * times that library is unusable. Two things bring it down:
 *
 *   - One search returns up to 100 rows, and a query for "Artist Song" pulls in most of that
 *     artist's catalogue alongside the one chart asked for. Every row is kept in a shared pool.
 *   - Before spending a request on a chart, the pool it already has is consulted. A chart that is
 *     already provably `current` needs no request at all. On the real library 210 of 219 charts
 *     were `current`, so the great majority resolve off a neighbour's response.
 *
 * Only a `current` verdict may short-circuit, and that asymmetry is the point. `current` rests on
 * an exact `chartHash` present in the pool, which no later response can contradict. `alternate`
 * and `unknown` are statements about absence, and absence from a partial pool is not absence from
 * the index, so those still spend their request.
 *
 * Grouping by artist instead was measured and rejected: the search is fuzzy, and querying an
 * artist string does not reliably return that artist's own charts. "Avenged Tablefold" missed a
 * chart of its own that a query for "Avenged Sevenfold" had returned.
 */

export interface CheckDeps {
  /** Injected so the suite never reaches the network. */
  search: (query: string, signal?: AbortSignal) => Promise<RemoteChart[]>
  /**
   * Awaited before each search. This is where the rate limit is enforced; the default spaces
   * requests, and tests pass a no-op to run instantly.
   */
  throttle?: () => Promise<void>
  onProgress?: (done: number, total: number) => void
}

/** api.enchor.us matches on free text; the song and its artist is the narrowest useful query. */
function queryFor(chart: LocalChartIdentity): string {
  return [chart.artist, chart.name]
    .filter((p) => (p ?? '').trim() !== '')
    .join(' ')
    .trim()
}

/** Spaces calls at least `intervalMs` apart, so a sweep cannot outrun the API's window. */
export function createThrottle(intervalMs: number): () => Promise<void> {
  let previous = Promise.resolve()
  let last = 0
  return () => {
    previous = previous.then(async () => {
      const wait = last + intervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      last = Date.now()
    })
    return previous
  }
}

export async function checkForUpdates(
  charts: LocalChartIdentity[],
  deps: CheckDeps,
  signal?: AbortSignal
): Promise<UpdateCheckSummary> {
  const pool: RemoteChart[] = []
  const verdicts: ChartVerdict[] = []
  let failed = 0
  let requests = 0

  for (const [index, chart] of charts.entries()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    // Free answer if a neighbour's search already proved this chart is on Chorus as-is.
    if (classifyChart(chart, pool).kind === 'current') {
      verdicts.push({ kind: 'current', local: chart })
      deps.onProgress?.(index + 1, charts.length)
      continue
    }

    const query = queryFor(chart)
    if (query === '') {
      // Nothing to search on. classifyChart would refuse this chart anyway.
      verdicts.push({ kind: 'unknown', local: chart })
      deps.onProgress?.(index + 1, charts.length)
      continue
    }

    try {
      await deps.throttle?.()
      requests++
      pool.push(...(await deps.search(query, signal)))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      // One artist failing must not lose the other 218 answers. The chart is reported `unknown`
      // rather than `current`, so a failed lookup never reads as "you are up to date".
      failed++
      verdicts.push({ kind: 'unknown', local: chart })
      deps.onProgress?.(index + 1, charts.length)
      continue
    }
    verdicts.push(classifyChart(chart, pool))
    deps.onProgress?.(index + 1, charts.length)
  }

  return { verdicts, failed, requests }
}
