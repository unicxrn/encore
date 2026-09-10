import type { ChartRecord } from '../../shared/schemas'
import type { ChartVerdict, UpdateCheckSummary } from '../../shared/updates'
import { checkForUpdates, createThrottle, type CheckDeps } from './check'
import { searchCharts } from './client'
import type { LocalChartIdentity } from './match'

/**
 * The measured ceiling is 50 requests per minute. Request 51 returns 429. Pacing at 1.4 s leaves
 * roughly 43 per minute, enough headroom that a sweep running alongside an Explore search the user
 * is typing does not push the pair over the line and fail both.
 */
const REQUEST_INTERVAL_MS = 1400

/** A catalog row carries everything the matcher needs; this is the narrowing, not a conversion. */
function toIdentity(row: ChartRecord): LocalChartIdentity {
  return {
    path: row.path,
    name: row.name,
    artist: row.artist,
    charter: row.charter,
    chartHash: row.chartHash,
    tempoMapHash: row.tempoMapHash
  }
}

export interface UpdateServiceDeps {
  /** Rows to check. Called per sweep so a rescan since the last one is picked up. */
  listCharts: (paths: string[]) => ChartRecord[]
  onProgress: (done: number, total: number) => void
  /** Injected for the suite; production passes global fetch. */
  fetchFn?: typeof fetch
  /** Injected for the suite so it never sleeps through a real 1.4 s interval. */
  throttle?: () => Promise<void>
}

/**
 * Owns the one running sweep and the results it produced.
 *
 * Results are held for the session rather than persisted. They are a claim about a remote index
 * that changes underneath us, and a stale "different version available" badge restored from disk
 * days later would point at an offer that may no longer exist. `issuesLast` keeps its report the
 * same way.
 */
export class UpdateService {
  private last: ChartVerdict[] = []
  private controller: AbortController | null = null

  constructor(private deps: UpdateServiceDeps) {}

  lastResults(): ChartVerdict[] {
    return this.last
  }

  running(): boolean {
    return this.controller !== null
  }

  cancel(): void {
    this.controller?.abort()
  }

  async check(paths: string[]): Promise<UpdateCheckSummary> {
    if (this.controller) throw new Error('An update check is already running')
    const charts = this.deps.listCharts(paths).map(toIdentity)
    const controller = new AbortController()
    this.controller = controller
    const fetchFn = this.deps.fetchFn ?? fetch
    const checkDeps: CheckDeps = {
      search: (query, signal) => searchCharts(query, fetchFn, { signal }),
      throttle: this.deps.throttle ?? createThrottle(REQUEST_INTERVAL_MS),
      onProgress: this.deps.onProgress
    }
    try {
      const summary = await checkForUpdates(charts, checkDeps, controller.signal)
      // Merge rather than replace: a single-chart check from the Detail page must not throw away
      // the sweep's other 218 answers, which is what the Library badges are reading.
      const byPath = new Map(this.last.map((v) => [v.local.path, v]))
      for (const verdict of summary.verdicts) byPath.set(verdict.local.path, verdict)
      this.last = [...byPath.values()]
      return summary
    } finally {
      this.controller = null
    }
  }
}
