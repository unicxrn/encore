import { get, writable, type Writable } from 'svelte/store'
import { searchCharts, type ChartData } from '../api/enchor'

export interface LatestCharts {
  charts: ChartData[]
  /** Total charts the API reports for the wildcard query; null when unknown. */
  total: number | null
  loading: boolean
  error: string | null
}

const COUNT = 10
/** How long a loaded row stays fresh. The Enchor catalog moves slowly and the
 *  API allows only 50 requests per minute, so re-asking on every visit to Home
 *  costs more than it is worth. */
const TTL_MS = 5 * 60 * 1000

export const latestCharts: Writable<LatestCharts> = writable({
  charts: [],
  total: null,
  loading: true,
  error: null
})

let loadedAt = 0
let inFlight: Promise<void> | null = null

/**
 * Loads the Home "latest charts" row, at most once per TTL per session.
 *
 * Module-scoped rather than component state: App destroys and recreates Home on
 * every navigation away and back, so component state meant one API request per
 * visit: 12 visits measured 12 requests, against a 50/minute budget.
 */
export function loadLatestCharts(): Promise<void> {
  if (inFlight) return inFlight
  const state = get(latestCharts)
  if (state.charts.length > 0 && Date.now() - loadedAt < TTL_MS) return Promise.resolve()

  latestCharts.update((s) => ({ ...s, loading: true, error: null }))
  inFlight = searchCharts({
    search: '*',
    page: 1,
    sort: { type: 'modifiedTime', direction: 'desc' }
  })
    .then((result) => {
      loadedAt = Date.now()
      latestCharts.set({
        charts: result.data.slice(0, COUNT),
        total: typeof result.out_of === 'number' ? result.out_of : null,
        loading: false,
        error: null
      })
    })
    .catch((err: unknown) => {
      latestCharts.update((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      }))
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
