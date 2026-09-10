import { describe, expect, it, vi } from 'vitest'
import type { JobProgress } from '../shared-types'
import { AssetJobQueue, type AssetBatchDeps, type BatchChartInfo } from './batch'

const chartInfo = (over: Partial<BatchChartInfo> = {}): BatchChartInfo => ({
  name: 'Song',
  artist: 'Artist',
  album: 'Album',
  charter: 'Charter',
  chartType: 'folder',
  hasVideo: false,
  hasAlbumArt: false,
  hasLyrics: false,
  ...over
})

const makeDeps = (overrides: Partial<AssetBatchDeps> = {}): AssetBatchDeps => ({
  getChart: vi.fn().mockImplementation(() => chartInfo()),
  searchVideos: vi.fn().mockResolvedValue([{ id: 'vid00000001' }]),
  downloadVideo: vi.fn().mockResolvedValue(undefined),
  searchArt: vi.fn().mockResolvedValue([{ fullUrl: 'https://a1.mzstatic.com/600x600bb.jpg' }]),
  downloadArt: vi.fn().mockResolvedValue('/lib/chart/album.jpg'),
  searchLyrics: vi.fn().mockResolvedValue([{ synced: true, syncedLyrics: '[00:01.00] hi' }]),
  injectLyrics: vi.fn().mockResolvedValue(undefined),
  ytdlpInstalled: vi.fn().mockResolvedValue(true),
  ...overrides
})

async function runBatch(
  deps: AssetBatchDeps,
  paths: string[]
): Promise<{ queue: AssetJobQueue; events: JobProgress[] }> {
  const events: JobProgress[] = []
  const queue = new AssetJobQueue(deps, (p) => events.push(p))
  queue.start(paths)
  await queue.idle()
  return { queue, events }
}

describe('AssetJobQueue', () => {
  it('runs a mixed batch: had/done/failed per asset without aborting the batch', async () => {
    const deps = makeDeps({
      getChart: vi.fn().mockImplementation((path: string) => {
        if (path === '/lib/full') {
          return chartInfo({ name: 'Full', hasVideo: true, hasAlbumArt: true, hasLyrics: true })
        }
        if (path === '/lib/none') return chartInfo({ name: 'None' })
        return chartInfo({ name: 'VFail' })
      }),
      downloadVideo: vi.fn().mockImplementation((chartDir: string) => {
        if (chartDir === '/lib/vfail') return Promise.reject(new Error('yt-dlp boom'))
        return Promise.resolve()
      })
    })
    const { queue, events } = await runBatch(deps, ['/lib/full', '/lib/none', '/lib/vfail'])

    expect(queue.results).toEqual([
      { path: '/lib/full', video: 'had', art: 'had', lyrics: 'had', errors: [] },
      { path: '/lib/none', video: 'done', art: 'done', lyrics: 'done', errors: [] },
      {
        path: '/lib/vfail',
        video: 'failed',
        art: 'done',
        lyrics: 'done',
        errors: [expect.stringContaining('yt-dlp boom')]
      }
    ])
    expect(queue.running).toBe(false)

    // Chart with all assets present triggers no searches or downloads.
    expect(deps.searchVideos).toHaveBeenCalledTimes(2)
    expect(deps.downloadVideo).toHaveBeenCalledTimes(2)
    // chartType is forwarded, not assumed: the downloader needs it to pick between writing
    // into a folder and staging + repacking an archive.
    expect(deps.downloadVideo).toHaveBeenCalledWith(
      '/lib/none',
      'folder',
      expect.any(String),
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(deps.injectLyrics).toHaveBeenCalledTimes(2)

    // Progress: per-chart running events plus a terminal done with summary.
    const running = events.filter((e) => e.status === 'running')
    expect(running[0]).toMatchObject({
      jobId: 'asset-batch',
      kind: 'asset',
      phase: '1/3 Full',
      percent: 0
    })
    expect(running[1]?.phase).toBe('2/3 None')
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({ jobId: 'asset-batch', status: 'done', percent: 100 })
    expect(terminal?.message).toBe('3 charts: 1 videos, 2 art, 2 lyrics, 1 failures')
  })

  it('records failed with a message when a search returns no hits', async () => {
    const deps = makeDeps({
      searchVideos: vi.fn().mockResolvedValue([]),
      searchArt: vi.fn().mockResolvedValue([]),
      searchLyrics: vi.fn().mockResolvedValue([{ synced: false, syncedLyrics: null }])
    })
    const { queue } = await runBatch(deps, ['/lib/chart'])

    const [result] = queue.results
    expect(result.video).toBe('failed')
    expect(result.art).toBe('failed')
    expect(result.lyrics).toBe('failed')
    expect(result.errors).toEqual([
      expect.stringMatching(/video: no /i),
      expect.stringMatching(/art: no /i),
      expect.stringMatching(/lyrics: no synced/i)
    ])
    expect(deps.downloadVideo).not.toHaveBeenCalled()
    expect(deps.downloadArt).not.toHaveBeenCalled()
    expect(deps.injectLyrics).not.toHaveBeenCalled()
  })

  it('cancel mid-run aborts the current video download and stops with partial results', async () => {
    let started!: () => void
    const startedPromise = new Promise<void>((r) => (started = r))
    const deps = makeDeps({
      downloadVideo: vi.fn().mockImplementation(
        (_path: string, _type: string, _id: string, _onProgress: unknown, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            started()
            signal.addEventListener('abort', () => reject(new Error('Video download aborted')), {
              once: true
            })
          })
      )
    })
    const events: JobProgress[] = []
    const queue = new AssetJobQueue(deps, (p) => events.push(p))
    queue.start(['/lib/a', '/lib/b'])
    await startedPromise
    expect(queue.running).toBe(true)
    queue.cancel()
    await queue.idle()

    // Only the first chart was processed; its aborted/remaining assets are
    // 'skipped' (a cancel is not a failure), the second chart never started.
    expect(queue.results).toEqual([
      { path: '/lib/a', video: 'skipped', art: 'skipped', lyrics: 'skipped', errors: [] }
    ])
    expect(queue.running).toBe(false)
    expect(deps.searchVideos).toHaveBeenCalledTimes(1)
    expect(deps.searchArt).not.toHaveBeenCalled()
    expect(events.at(-1)?.status).toBe('canceled')
  })

  it('rejects a second start while running', async () => {
    let started!: () => void
    const startedPromise = new Promise<void>((r) => (started = r))
    const deps = makeDeps({
      downloadVideo: vi.fn().mockImplementation(
        (_path: string, _type: string, _id: string, _onProgress: unknown, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            started()
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
      )
    })
    const queue = new AssetJobQueue(deps, () => {})
    queue.start(['/lib/a'])
    await startedPromise
    expect(() => queue.start(['/lib/b'])).toThrow(/already running/i)
    queue.cancel()
    await queue.idle()
  })

  // The path here deliberately lacks a .sng suffix: the batch must take the chart's shape from
  // the catalog row the scanner wrote, not from a second guess at the filename. Each writer
  // repacks the archive itself, so what the batch owes them is the type, unaltered.
  it('fills .sng charts too, passing the catalog row type to every writer', async () => {
    const deps = makeDeps({
      getChart: vi.fn().mockImplementation(() => chartInfo({ chartType: 'sng' }))
    })
    const { queue } = await runBatch(deps, ['/lib/song-archive'])

    expect(queue.results).toEqual([
      { path: '/lib/song-archive', video: 'done', art: 'done', lyrics: 'done', errors: [] }
    ])
    expect(deps.downloadVideo).toHaveBeenCalledWith(
      '/lib/song-archive',
      'sng',
      expect.any(String),
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(deps.downloadArt).toHaveBeenCalledWith(expect.any(String), '/lib/song-archive', 'sng')
    expect(deps.injectLyrics).toHaveBeenCalledWith('/lib/song-archive', 'sng', expect.any(String))
  })

  it('hands the art and lyrics writers the chart type from the catalog row', async () => {
    const deps = makeDeps()
    await runBatch(deps, ['/lib/a'])
    expect(deps.downloadArt).toHaveBeenCalledWith(
      'https://a1.mzstatic.com/600x600bb.jpg',
      '/lib/a',
      'folder'
    )
    expect(deps.injectLyrics).toHaveBeenCalledWith('/lib/a', 'folder', expect.any(String))
  })

  it('skips all videos when yt-dlp is not installed but still fills art and lyrics', async () => {
    const deps = makeDeps({ ytdlpInstalled: vi.fn().mockResolvedValue(false) })
    const { queue, events } = await runBatch(deps, ['/lib/a', '/lib/b'])

    expect(queue.results.map((r) => r.video)).toEqual(['skipped', 'skipped'])
    expect(queue.results.map((r) => r.art)).toEqual(['done', 'done'])
    expect(queue.results.map((r) => r.lyrics)).toEqual(['done', 'done'])
    expect(deps.searchVideos).not.toHaveBeenCalled()
    expect(events.at(-1)?.message).toBe('2 charts: 0 videos, 2 art, 2 lyrics, 0 failures')
  })

  it('marks a chart missing from the catalog as failed on every asset', async () => {
    const deps = makeDeps({ getChart: vi.fn().mockReturnValue(null) })
    const { queue } = await runBatch(deps, ['/lib/gone'])

    expect(queue.results).toEqual([
      {
        path: '/lib/gone',
        video: 'failed',
        art: 'failed',
        lyrics: 'failed',
        errors: [expect.stringContaining('not found')]
      }
    ])
    expect(deps.searchVideos).not.toHaveBeenCalled()
  })
})
