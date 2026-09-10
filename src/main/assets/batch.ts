import type { JobProgress } from '../shared-types'

/**
 * Batch "Complete missing" pipeline: fill missing assets for a list of charts
 * sequentially (one chart at a time) using first-result auto-pick.
 *
 * SCOPE (documented): the batch covers video + album art + lyrics only.
 * Background generation lives in the RENDERER (OffscreenCanvas blur/darken of
 * album art), so the main-process batch cannot generate backgrounds.
 * Background stays a per-chart UI action. Chaining generation after a batch
 * from the UI is backlog, not built here.
 *
 * `.sng` charts go through the same three steps as folder charts. Each of the three writers
 * repacks the archive itself (assets/write.ts dispatches on chartType, which every dep here
 * takes), so the batch needs no archive-specific branch. But it does pay archive-specific
 * time. A repack reads, rebuilds, verifies and swaps the whole chart, so a chart with all three
 * assets missing is rebuilt three times over.
 *
 * That used to block the main process outright: the rebuild was one synchronous buildSng and one
 * synchronous write, so progress events queued during it were not delivered until it finished and
 * a cancel arriving mid-rebuild was not seen until the same moment. M10 replaced both halves with
 * `await`ed positional reads and writes a chunk at a time (downloads/sng-repack.ts), so the event
 * loop turns throughout: events are delivered as they are queued and a cancel is seen when it
 * arrives. It still does not interrupt the rebuild in progress: it stops the batch after the
 * current chart, as it always has, and a rebuild abandoned half-written would be the one thing
 * verify-before-swap exists to prevent. What is left is elapsed time, measured at 0.71-0.88 s for
 * the largest chart in the reference library, down from 4.98 s.
 *
 * One path still blocks: lyrics injection into a `.sng` reads the whole archive synchronously to
 * get at its chart text before any of this runs. See the note on `injectLyrics`.
 */

export interface BatchChartInfo {
  name: string | null
  artist: string | null
  album: string | null
  charter: string | null
  chartType: 'folder' | 'sng'
  hasVideo: boolean
  hasAlbumArt: boolean
  hasLyrics: boolean
}

export interface AssetBatchDeps {
  getChart: (path: string) => BatchChartInfo | null
  searchVideos: (query: string) => Promise<{ id: string }[]>
  downloadVideo: (
    chartPath: string,
    chartType: 'folder' | 'sng',
    videoId: string,
    onProgress: (p: JobProgress) => void,
    signal: AbortSignal
  ) => Promise<void>
  searchArt: (term: string) => Promise<{ fullUrl: string }[]>
  downloadArt: (url: string, chartPath: string, chartType: 'folder' | 'sng') => Promise<string>
  searchLyrics: (
    artist: string,
    track: string
  ) => Promise<{ synced: boolean; syncedLyrics: string | null }[]>
  injectLyrics: (chartPath: string, chartType: 'folder' | 'sng', lrc: string) => Promise<void>
  ytdlpInstalled: () => Promise<boolean>
}

export type AssetOutcome = 'done' | 'skipped' | 'failed' | 'had'

export interface ChartBatchResult {
  path: string
  video: AssetOutcome
  art: AssetOutcome
  lyrics: AssetOutcome
  errors: string[]
}

export const ASSET_BATCH_JOB_ID = 'asset-batch'

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const joinMeta = (...parts: (string | null)[]): string => parts.filter(Boolean).join(' ').trim()

export class AssetJobQueue {
  private _running = false
  private cancelled = false
  private _results: ChartBatchResult[] = []
  private controller: AbortController | null = null
  private donePromise: Promise<void> = Promise.resolve()

  constructor(
    private deps: AssetBatchDeps,
    private onProgress: (p: JobProgress) => void
  ) {}

  get running(): boolean {
    return this._running
  }

  /** Snapshot copy of the results of the current (or last finished) batch. */
  get results(): ChartBatchResult[] {
    return this._results.map((r) => ({ ...r, errors: [...r.errors] }))
  }

  /** Kicks off a batch. Throws synchronously if a batch is already running. */
  start(paths: string[]): void {
    if (this._running) throw new Error('Asset batch is already running')
    this._running = true
    this.cancelled = false
    this._results = []
    this.donePromise = this.run([...paths]).finally(() => {
      this._running = false
    })
  }

  /** Aborts the in-flight video download and stops after the current chart. */
  cancel(): void {
    if (!this._running) return
    this.cancelled = true
    this.controller?.abort()
  }

  /** Resolves when the current batch finishes (test + shutdown helper). */
  idle(): Promise<void> {
    return this.donePromise
  }

  private report(
    phase: string,
    percent: number,
    message: string,
    status: JobProgress['status']
  ): void {
    this.onProgress({ jobId: ASSET_BATCH_JOB_ID, kind: 'asset', phase, percent, message, status })
  }

  private summary(): string {
    let videos = 0
    let art = 0
    let lyrics = 0
    let failures = 0
    for (const r of this._results) {
      if (r.video === 'done') videos++
      if (r.art === 'done') art++
      if (r.lyrics === 'done') lyrics++
      for (const outcome of [r.video, r.art, r.lyrics]) if (outcome === 'failed') failures++
    }
    return `${this._results.length} charts: ${videos} videos, ${art} art, ${lyrics} lyrics, ${failures} failures`
  }

  private async run(paths: string[]): Promise<void> {
    const total = paths.length
    // Checked once per batch: an install landing mid-batch is a corner case
    // not worth a per-chart subprocess status probe.
    const ytdlp = await this.deps.ytdlpInstalled().catch(() => false)

    for (let i = 0; i < total; i++) {
      if (this.cancelled) break
      const path = paths[i]
      const chart = this.deps.getChart(path)
      this.report(
        `${i + 1}/${total} ${chart?.name ?? path}`,
        Math.round((i / total) * 100),
        this.summary(),
        'running'
      )
      this._results.push(await this.processChart(path, chart, ytdlp))
    }

    const status = this.cancelled ? 'canceled' : 'done'
    const percent = total === 0 ? 100 : Math.round((this._results.length / total) * 100)
    this.report(status, this.cancelled ? percent : 100, this.summary(), status)
  }

  private async processChart(
    path: string,
    chart: BatchChartInfo | null,
    ytdlp: boolean
  ): Promise<ChartBatchResult> {
    const result: ChartBatchResult = {
      path,
      video: 'skipped',
      art: 'skipped',
      lyrics: 'skipped',
      errors: []
    }
    if (!chart) {
      result.video = result.art = result.lyrics = 'failed'
      result.errors.push('chart not found in catalog')
      return result
    }
    result.video = await this.fillVideo(path, chart, ytdlp, result.errors)
    result.art = await this.fillArt(path, chart, result.errors)
    result.lyrics = await this.fillLyrics(path, chart, result.errors)
    return result
  }

  private async fillVideo(
    path: string,
    chart: BatchChartInfo,
    ytdlp: boolean,
    errors: string[]
  ): Promise<AssetOutcome> {
    if (chart.hasVideo) return 'had'
    if (!ytdlp || this.cancelled) return 'skipped'
    try {
      const query = joinMeta(chart.artist, chart.name)
      if (!query) {
        errors.push('video: no artist/name metadata to search with')
        return 'failed'
      }
      const hits = await this.deps.searchVideos(query)
      if (hits.length === 0) {
        errors.push(`video: no results for "${query}"`)
        return 'failed'
      }
      this.controller = new AbortController()
      try {
        await this.deps.downloadVideo(
          path,
          chart.chartType,
          hits[0].id,
          this.onProgress,
          this.controller.signal
        )
      } finally {
        this.controller = null
      }
      return 'done'
    } catch (err) {
      // A cancel-triggered abort is not a failure.
      if (this.cancelled) return 'skipped'
      errors.push(`video: ${errMessage(err)}`)
      return 'failed'
    }
  }

  private async fillArt(
    path: string,
    chart: BatchChartInfo,
    errors: string[]
  ): Promise<AssetOutcome> {
    if (chart.hasAlbumArt) return 'had'
    if (this.cancelled) return 'skipped'
    try {
      const term = joinMeta(chart.artist, chart.album ?? chart.name)
      if (!term) {
        errors.push('art: no artist/album metadata to search with')
        return 'failed'
      }
      const hits = await this.deps.searchArt(term)
      if (hits.length === 0) {
        errors.push(`art: no results for "${term}"`)
        return 'failed'
      }
      await this.deps.downloadArt(hits[0].fullUrl, path, chart.chartType)
      return 'done'
    } catch (err) {
      if (this.cancelled) return 'skipped'
      errors.push(`art: ${errMessage(err)}`)
      return 'failed'
    }
  }

  private async fillLyrics(
    path: string,
    chart: BatchChartInfo,
    errors: string[]
  ): Promise<AssetOutcome> {
    if (chart.hasLyrics) return 'had'
    if (this.cancelled) return 'skipped'
    try {
      if (!chart.name) {
        errors.push('lyrics: chart has no name metadata to search with')
        return 'failed'
      }
      const hits = await this.deps.searchLyrics(chart.artist ?? '', chart.name)
      const synced = hits.find((h) => h.synced && h.syncedLyrics)
      if (!synced?.syncedLyrics) {
        errors.push('lyrics: no synced lyrics found')
        return 'failed'
      }
      await this.deps.injectLyrics(path, chart.chartType, synced.syncedLyrics)
      return 'done'
    } catch (err) {
      if (this.cancelled) return 'skipped'
      errors.push(`lyrics: ${errMessage(err)}`)
      return 'failed'
    }
  }
}
