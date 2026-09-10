import { describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus } from '../shared/app-update'
import { IPC } from '../shared/ipc-contract'
import type { ChartIssueRow } from './catalog/issues'
import { registerIpc, IpcDeps } from './ipc'

function fakeIpc(): {
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    },
    invoke: async (channel: string, ...args: unknown[]): Promise<unknown> =>
      handlers.get(channel)!({ sender: { id: 1 } }, ...args)
  }
}

const APP_UPDATE_STATUS: AppUpdateStatus = {
  currentVersion: '0.1.0',
  target: 'appimage',
  canApply: true,
  note: 'Encore downloads the new AppImage and replaces this one when you restart.',
  state: { kind: 'idle' }
}

const deps = (): IpcDeps => ({
  getSettings: vi.fn().mockReturnValue({ downloadFormat: 'sng' }),
  setSettings: vi.fn(),
  queryCharts: vi.fn().mockReturnValue([]),
  countCharts: vi.fn().mockReturnValue(0),
  chartsExistByMeta: vi.fn().mockReturnValue([true]),
  checkUpdates: vi.fn().mockResolvedValue({ verdicts: [], failed: 0, requests: 0 }),
  lastUpdates: vi.fn().mockReturnValue([]),
  cancelUpdateCheck: vi.fn(),
  startScan: vi.fn(),
  cancelScan: vi.fn(),
  rescanCharts: vi.fn().mockResolvedValue([]),
  addDownload: vi.fn(),
  cancelDownload: vi.fn(),
  retryDownload: vi.fn(),
  listDownloads: vi.fn().mockReturnValue([]),
  clearFinishedDownloads: vi.fn(),
  windowControl: vi.fn(),
  pickFolder: vi.fn().mockResolvedValue('/picked'),
  readChartFiles: vi.fn().mockResolvedValue([{ fileName: 'song.ini', data: new Uint8Array([1]) }]),
  readLyricLines: vi.fn().mockResolvedValue({ lines: [{ ms: 1000, endMs: 2000, text: 'Hello' }] }),
  sidecarStatus: vi.fn().mockResolvedValue({ installed: false, version: null, path: '/s/yt-dlp' }),
  sidecarInstall: vi.fn().mockResolvedValue(undefined),
  sidecarUpdate: vi.fn().mockResolvedValue(undefined),
  searchVideos: vi.fn().mockResolvedValue([
    {
      id: 'dQw4w9WgXcQ',
      title: 'T',
      channel: 'C',
      durationSeconds: 213,
      thumbnailUrl: null
    }
  ]),
  downloadVideo: vi.fn().mockResolvedValue(undefined),
  cancelVideoDownload: vi.fn(),
  searchAlbumArt: vi.fn().mockResolvedValue([
    {
      artist: 'Tool',
      album: 'Lateralus',
      thumbUrl: 'https://a1.mzstatic.com/100x100bb.jpg',
      fullUrl: 'https://a1.mzstatic.com/600x600bb.jpg'
    }
  ]),
  downloadArt: vi.fn().mockResolvedValue('/lib/chart/album.png'),
  searchLyrics: vi.fn().mockResolvedValue([
    {
      id: 1,
      trackName: 'Lateralus',
      artistName: 'Tool',
      synced: true,
      syncedLyrics: '[00:01.00] hi',
      plainLyrics: 'hi'
    }
  ]),
  injectLyrics: vi.fn().mockResolvedValue(undefined),
  writeBackground: vi.fn().mockResolvedValue(undefined),
  assetCompleteCharts: vi.fn(),
  assetBatchCancel: vi.fn(),
  scanIssues: vi.fn().mockResolvedValue([
    {
      chartPath: '/lib/chart',
      kind: 'folder' as const,
      code: 'noAudio',
      description: "This chart doesn't have an audio file."
    } satisfies ChartIssueRow
  ]),
  cancelIssueScan: vi.fn(),
  lastIssues: vi.fn().mockReturnValue(null),
  fixIssue: vi.fn().mockResolvedValue([]),
  fixableIssueCodes: vi
    .fn()
    .mockResolvedValue([{ code: 'badVideo', available: true, reason: null }]),
  cancelIssueFix: vi.fn(),
  listFixBackups: vi.fn().mockReturnValue({ backups: [], totalBytes: 0 }),
  restoreFixBackup: vi.fn().mockResolvedValue({ chartPath: '/lib/chart', rows: [] }),
  clearFixBackups: vi.fn(),
  detectLibraries: vi
    .fn()
    .mockReturnValue([
      { path: '/home/user/.clonehero/Songs', chartCount: 207, countCapped: false }
    ]),
  saveTextFile: vi.fn().mockResolvedValue('/home/user/encore-issues.csv'),
  appUpdateStatus: vi.fn().mockReturnValue(APP_UPDATE_STATUS),
  appUpdateCheck: vi.fn().mockResolvedValue(APP_UPDATE_STATUS),
  appUpdateDownload: vi.fn().mockResolvedValue(APP_UPDATE_STATUS),
  appUpdateInstall: vi.fn().mockReturnValue(false)
})

describe('registerIpc', () => {
  it('routes settings:get to deps', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    expect(await ipc.invoke(IPC.settingsGet)).toEqual({ downloadFormat: 'sng' })
  })

  it('rejects invalid settings payloads at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.settingsSet, { downloadConcurrency: 'lots' })).rejects.toThrow()
    expect(d.setSettings).not.toHaveBeenCalled()
  })

  it('validates catalog filters and applies defaults', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.catalogQuery, { search: 'foo' })
    expect(d.queryCharts).toHaveBeenCalledWith({ search: 'foo', offset: 0, limit: 100 })
  })

  it('validates download requests', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.downloadAdd, { nope: true })).rejects.toThrow()
    await ipc.invoke(IPC.downloadAdd, {
      md5: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      meta: { name: 'S', artist: 'A', charter: 'C' }
    })
    expect(d.addDownload).toHaveBeenCalledTimes(1)
  })

  it('routes dialog:pick-folder to deps', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    expect(await ipc.invoke(IPC.dialogPickFolder)).toBe('/picked')
    expect(d.pickFolder).toHaveBeenCalledWith(expect.anything())
  })
  it('passes the sender to windowControl', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.windowControl, 'minimize')
    expect(d.windowControl).toHaveBeenCalledWith('minimize', expect.anything())
  })
  it('routes download:clear-finished to deps.clearFinishedDownloads', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.downloadClearFinished)
    expect(d.clearFinishedDownloads).toHaveBeenCalledTimes(1)
  })
  it('routes chart:read-files with a valid payload', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.chartReadFiles, { path: '/lib/song', chartType: 'folder' })
    expect(d.readChartFiles).toHaveBeenCalledWith('/lib/song', 'folder')
    expect(result).toEqual([{ fileName: 'song.ini', data: new Uint8Array([1]) }])
  })
  it('rejects invalid chart:read-files payloads at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(
      ipc.invoke(IPC.chartReadFiles, { path: 123, chartType: 'folder' })
    ).rejects.toThrow()
    expect(d.readChartFiles).not.toHaveBeenCalled()
  })
  it('routes chart:lyric-lines with a valid payload', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.chartLyricLines, {
      path: '/lib/song.sng',
      chartType: 'sng'
    })
    expect(d.readLyricLines).toHaveBeenCalledWith('/lib/song.sng', 'sng')
    expect(result).toEqual({ lines: [{ ms: 1000, endMs: 2000, text: 'Hello' }] })
  })
  it('rejects invalid chart:lyric-lines payloads at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(
      ipc.invoke(IPC.chartLyricLines, { path: '/lib/song', chartType: 'zip' })
    ).rejects.toThrow()
    expect(d.readLyricLines).not.toHaveBeenCalled()
  })
  it('routes updates:check with an explicit path list', async () => {
    const d = deps()
    const ipc = fakeIpc()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.updatesCheck, { paths: ['/lib/a.sng'] })
    expect(d.checkUpdates).toHaveBeenCalledWith(['/lib/a.sng'])
  })

  // The renderer's "check my whole library" call sends no list, and the whole-library sweep is
  // the expensive one, so it must not be reachable by a malformed payload silently becoming [].
  it('treats an omitted updates:check payload as the whole library', async () => {
    const d = deps()
    const ipc = fakeIpc()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.updatesCheck, undefined)
    expect(d.checkUpdates).toHaveBeenCalledWith([])
  })

  it('rejects a non-string path list at the boundary', async () => {
    const d = deps()
    const ipc = fakeIpc()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.updatesCheck, { paths: [17] })).rejects.toThrow()
    expect(d.checkUpdates).not.toHaveBeenCalled()
  })

  it('routes updates:last and updates:cancel to deps', async () => {
    const d = deps()
    const ipc = fakeIpc()
    registerIpc(ipc as never, d)
    expect(await ipc.invoke(IPC.updatesLast)).toEqual([])
    await ipc.invoke(IPC.updatesCancel)
    expect(d.cancelUpdateCheck).toHaveBeenCalled()
  })

  it('routes catalog:exists-by-meta to deps.chartsExistByMeta', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const keys = [{ name: 'Everlong', artist: 'Foo Fighters', charter: 'GuitarHero' }]
    expect(await ipc.invoke(IPC.catalogExistsByMeta, keys)).toEqual([true])
    expect(d.chartsExistByMeta).toHaveBeenCalledWith(keys)
  })
  it('rejects an oversized catalog:exists-by-meta array at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const oversized = Array.from({ length: 251 }, (_, i) => ({
      name: `Song ${i}`,
      artist: 'Artist',
      charter: 'Charter'
    }))
    await expect(ipc.invoke(IPC.catalogExistsByMeta, oversized)).rejects.toThrow()
    expect(d.chartsExistByMeta).not.toHaveBeenCalled()
  })
  it('rejects malformed catalog:exists-by-meta keys at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(
      ipc.invoke(IPC.catalogExistsByMeta, [{ name: 'Song', artist: 'Artist' }])
    ).rejects.toThrow()
    expect(d.chartsExistByMeta).not.toHaveBeenCalled()
  })

  it('routes catalog:rescan-charts to deps and returns the refreshed rows', async () => {
    const ipc = fakeIpc()
    const d = deps()
    const row = { path: '/lib/a.sng', hasAlbumArt: true }
    d.rescanCharts = vi.fn().mockResolvedValue([row])
    registerIpc(ipc as never, d)
    expect(await ipc.invoke(IPC.catalogRescanCharts, ['/lib/a.sng'])).toEqual([row])
    expect(d.rescanCharts).toHaveBeenCalledWith(['/lib/a.sng'])
  })
  it('rejects an empty or oversized catalog:rescan-charts list at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.catalogRescanCharts, [])).rejects.toThrow()
    await expect(
      ipc.invoke(
        IPC.catalogRescanCharts,
        Array.from({ length: 101 }, (_, i) => `/lib/${i}`)
      )
    ).rejects.toThrow()
    expect(d.rescanCharts).not.toHaveBeenCalled()
  })

  it('routes sidecar:status for ytdlp to deps.sidecarStatus', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.sidecarStatus, 'ytdlp')
    expect(d.sidecarStatus).toHaveBeenCalledWith('ytdlp')
    expect(result).toEqual({ installed: false, version: null, path: '/s/yt-dlp' })
  })

  it('routes sidecar:status for ffmpeg to deps.sidecarStatus', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.sidecarStatus, 'ffmpeg')
    expect(d.sidecarStatus).toHaveBeenCalledWith('ffmpeg')
  })

  it('routes sidecar:install for ytdlp to deps.sidecarInstall', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.sidecarInstall, 'ytdlp')
    expect(d.sidecarInstall).toHaveBeenCalledWith('ytdlp')
  })

  // ffmpeg install used to be refused here, because nothing could extract its archive. It is
  // routed now; the boundary still exists, and the unknown-name cases below are what prove it.
  it('routes sidecar:install for ffmpeg to deps.sidecarInstall', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.sidecarInstall, 'ffmpeg')
    expect(d.sidecarInstall).toHaveBeenCalledWith('ffmpeg')
  })

  it('rejects sidecar:install with an unknown sidecar name', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.sidecarInstall, 'rm -rf')).rejects.toThrow()
    expect(d.sidecarInstall).not.toHaveBeenCalled()
  })

  it('routes sidecar:update for ytdlp to deps.sidecarUpdate', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.sidecarUpdate, 'ytdlp')
    expect(d.sidecarUpdate).toHaveBeenCalledWith('ytdlp')
  })

  it('routes sidecar:update for ffmpeg to deps.sidecarUpdate', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.sidecarUpdate, 'ffmpeg')
    expect(d.sidecarUpdate).toHaveBeenCalledWith('ffmpeg')
  })

  it('rejects sidecar:update with an unknown sidecar name', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.sidecarUpdate, 'ffmpeg.exe')).rejects.toThrow()
    expect(d.sidecarUpdate).not.toHaveBeenCalled()
  })

  it('routes video:search to deps.searchVideos', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.videoSearch, 'artist song')
    expect(d.searchVideos).toHaveBeenCalledWith('artist song')
    expect(result).toEqual([
      { id: 'dQw4w9WgXcQ', title: 'T', channel: 'C', durationSeconds: 213, thumbnailUrl: null }
    ])
  })

  it('rejects empty and oversized video:search queries at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.videoSearch, '')).rejects.toThrow()
    await expect(ipc.invoke(IPC.videoSearch, 'x'.repeat(201))).rejects.toThrow()
    expect(d.searchVideos).not.toHaveBeenCalled()
  })

  it('routes video:download to deps.downloadVideo', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.videoDownload, {
      chartPath: '/lib/chart.sng',
      chartType: 'sng',
      videoId: 'dQw4w9WgXcQ'
    })
    expect(d.downloadVideo).toHaveBeenCalledWith({
      chartPath: '/lib/chart.sng',
      chartType: 'sng',
      videoId: 'dQw4w9WgXcQ'
    })
  })

  it('rejects video:download with a malformed videoId at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(
      ipc.invoke(IPC.videoDownload, {
        chartPath: '/lib/chart',
        chartType: 'folder',
        videoId: '"; rm -rf /'
      })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.videoDownload, {
        chartPath: '/lib/chart',
        chartType: 'folder',
        videoId: 'abc'
      })
    ).rejects.toThrow()
    expect(d.downloadVideo).not.toHaveBeenCalled()
  })

  it('routes video:cancel to deps.cancelVideoDownload', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.videoCancel, '/lib/chart.sng')
    expect(d.cancelVideoDownload).toHaveBeenCalledWith('/lib/chart.sng')
  })

  it('rejects a video:cancel with no chart path at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.videoCancel, '')).rejects.toThrow()
    await expect(ipc.invoke(IPC.videoCancel, undefined)).rejects.toThrow()
    expect(d.cancelVideoDownload).not.toHaveBeenCalled()
  })

  it('routes art:search to deps.searchAlbumArt', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.artSearch, 'tool lateralus')
    expect(d.searchAlbumArt).toHaveBeenCalledWith('tool lateralus')
    expect(result).toEqual([
      {
        artist: 'Tool',
        album: 'Lateralus',
        thumbUrl: 'https://a1.mzstatic.com/100x100bb.jpg',
        fullUrl: 'https://a1.mzstatic.com/600x600bb.jpg'
      }
    ])
  })

  it('rejects empty and oversized art:search terms at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.artSearch, '')).rejects.toThrow()
    await expect(ipc.invoke(IPC.artSearch, 'x'.repeat(201))).rejects.toThrow()
    expect(d.searchAlbumArt).not.toHaveBeenCalled()
  })

  it('routes art:download to deps.downloadArt', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.artDownload, {
      chartPath: '/lib/chart',
      chartType: 'sng',
      url: 'https://a1.mzstatic.com/600x600bb.jpg'
    })
    expect(d.downloadArt).toHaveBeenCalledWith({
      chartPath: '/lib/chart',
      chartType: 'sng',
      url: 'https://a1.mzstatic.com/600x600bb.jpg'
    })
    expect(result).toBe('/lib/chart/album.png')
  })

  it('rejects art:download with a non-url at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(
      ipc.invoke(IPC.artDownload, {
        chartPath: '/lib/chart',
        chartType: 'folder',
        url: 'not-a-url'
      })
    ).rejects.toThrow()
    expect(d.downloadArt).not.toHaveBeenCalled()
    expect(d.downloadVideo).not.toHaveBeenCalled()
  })

  // chartType picks the writer in main, so an unrecognised value must not reach it, because
  // the dispatcher treats anything that is not 'sng' as a folder chart.
  it('rejects a missing or unknown chartType on the asset write channels', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const url = 'https://a1.mzstatic.com/600x600bb.jpg'
    await expect(ipc.invoke(IPC.artDownload, { chartPath: '/lib/chart', url })).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.videoDownload, { chartPath: '/lib/chart', videoId: 'dQw4w9WgXcQ' })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.videoDownload, {
        chartPath: '/lib/chart',
        chartType: 'zip',
        videoId: 'dQw4w9WgXcQ'
      })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.artDownload, { chartPath: '/lib/chart', chartType: 'zip', url })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.assetWriteBackground, { chartPath: '/lib/chart', data: new Uint8Array([1]) })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.assetWriteBackground, {
        chartPath: '/lib/chart',
        chartType: 'zip',
        data: new Uint8Array([1])
      })
    ).rejects.toThrow()
    const syncedLyrics = '[00:01.00] hi'
    await expect(
      ipc.invoke(IPC.lyricsInject, { chartPath: '/lib/chart', syncedLyrics })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.lyricsInject, { chartPath: '/lib/chart', chartType: 'zip', syncedLyrics })
    ).rejects.toThrow()
    expect(d.downloadArt).not.toHaveBeenCalled()
    expect(d.downloadVideo).not.toHaveBeenCalled()
    expect(d.writeBackground).not.toHaveBeenCalled()
    expect(d.injectLyrics).not.toHaveBeenCalled()
  })

  it('routes lyrics:search to deps.searchLyrics', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.lyricsSearch, { artist: 'Tool', track: 'Lateralus' })
    expect(d.searchLyrics).toHaveBeenCalledWith({ artist: 'Tool', track: 'Lateralus' })
    expect(result).toEqual([
      {
        id: 1,
        trackName: 'Lateralus',
        artistName: 'Tool',
        synced: true,
        syncedLyrics: '[00:01.00] hi',
        plainLyrics: 'hi'
      }
    ])
  })

  it('rejects lyrics:search with an empty track or oversized fields', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.lyricsSearch, { artist: 'Tool', track: '' })).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.lyricsSearch, { artist: 'x'.repeat(201), track: 'T' })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.lyricsSearch, { artist: 'Tool', track: 'x'.repeat(201) })
    ).rejects.toThrow()
    expect(d.searchLyrics).not.toHaveBeenCalled()
  })

  it('routes lyrics:inject to deps.injectLyrics', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.lyricsInject, {
      chartPath: '/lib/chart/notes.chart',
      chartType: 'folder',
      syncedLyrics: '[00:01.00] hi'
    })
    expect(d.injectLyrics).toHaveBeenCalledWith({
      chartPath: '/lib/chart/notes.chart',
      chartType: 'folder',
      syncedLyrics: '[00:01.00] hi'
    })
  })

  it('routes a .sng lyrics:inject with its chartType intact', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.lyricsInject, {
      chartPath: '/lib/Artist - Song.sng',
      chartType: 'sng',
      syncedLyrics: '[00:01.00] hi'
    })
    expect(d.injectLyrics).toHaveBeenCalledWith({
      chartPath: '/lib/Artist - Song.sng',
      chartType: 'sng',
      syncedLyrics: '[00:01.00] hi'
    })
  })

  it('rejects lyrics:inject with empty or oversized lyrics at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(
      ipc.invoke(IPC.lyricsInject, {
        chartPath: '/lib/chart/notes.chart',
        chartType: 'folder',
        syncedLyrics: ''
      })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.lyricsInject, {
        chartPath: '/lib/chart/notes.chart',
        chartType: 'folder',
        syncedLyrics: 'x'.repeat(100_001)
      })
    ).rejects.toThrow()
    expect(d.injectLyrics).not.toHaveBeenCalled()
  })

  it('routes asset:write-background to deps.writeBackground', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const data = new Uint8Array([1, 2, 3, 4])
    await ipc.invoke(IPC.assetWriteBackground, {
      chartPath: '/lib/chart',
      chartType: 'sng',
      data
    })
    expect(d.writeBackground).toHaveBeenCalledWith({
      chartPath: '/lib/chart',
      chartType: 'sng',
      data
    })
  })

  it('rejects asset:write-background when data is not a Uint8Array', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(
      ipc.invoke(IPC.assetWriteBackground, {
        chartPath: '/lib/chart',
        chartType: 'folder',
        data: 'not-bytes'
      })
    ).rejects.toThrow(/Uint8Array/)
    await expect(
      ipc.invoke(IPC.assetWriteBackground, {
        chartPath: '/lib/chart',
        chartType: 'folder',
        data: 42
      })
    ).rejects.toThrow()
    expect(d.writeBackground).not.toHaveBeenCalled()
  })

  it('rejects asset:write-background when data exceeds 20 MB', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1)
    await expect(
      ipc.invoke(IPC.assetWriteBackground, {
        chartPath: '/lib/chart',
        chartType: 'folder',
        data: oversized
      })
    ).rejects.toThrow(/20 MB/)
    expect(d.writeBackground).not.toHaveBeenCalled()
  })

  it('routes asset:complete to deps.assetCompleteCharts', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.assetCompleteCharts, ['/lib/a', '/lib/b'])
    expect(d.assetCompleteCharts).toHaveBeenCalledWith(['/lib/a', '/lib/b'])
  })

  it('rejects empty and oversized asset:complete path arrays at the boundary', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.assetCompleteCharts, [])).rejects.toThrow()
    await expect(
      ipc.invoke(
        IPC.assetCompleteCharts,
        Array.from({ length: 101 }, (_, i) => `/lib/${i}`)
      )
    ).rejects.toThrow()
    await expect(ipc.invoke(IPC.assetCompleteCharts, [42])).rejects.toThrow()
    expect(d.assetCompleteCharts).not.toHaveBeenCalled()
  })

  it('routes asset:cancel to deps.assetBatchCancel', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.assetBatchCancel)
    expect(d.assetBatchCancel).toHaveBeenCalledTimes(1)
  })

  it('routes issues:scan to deps.scanIssues and returns the rows', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.issuesScan)
    expect(d.scanIssues).toHaveBeenCalledTimes(1)
    expect(result).toEqual([
      {
        chartPath: '/lib/chart',
        kind: 'folder',
        code: 'noAudio',
        description: "This chart doesn't have an audio file."
      }
    ])
  })

  it('routes catalog:scan-cancel to deps.cancelScan, with no payload to identify', async () => {
    // One library scan exists at a time (ScanRunner serialises them), so there is nothing to
    // name here and therefore no argument to validate.
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.catalogScanCancel)
    expect(d.cancelScan).toHaveBeenCalledTimes(1)
  })

  it('routes issues:scan-cancel to deps.cancelIssueScan, with no payload to identify', async () => {
    // There is only ever one library-wide scan, so unlike issues:fix-cancel there is nothing to
    // name, and therefore no argument to validate.
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await ipc.invoke(IPC.issuesScanCancel)
    expect(d.cancelIssueScan).toHaveBeenCalledTimes(1)
  })

  it('routes issues:last to deps.lastIssues', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.issuesLast)
    expect(d.lastIssues).toHaveBeenCalledTimes(1)
    expect(result).toBeNull()
  })

  it('routes issues:fix to deps.fixIssue with the validated row', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const row = {
      chartPath: '/lib/chart',
      kind: 'folder',
      code: 'badVideo',
      description: '"video.mp4" will not work on Linux and should be converted to .webm.'
    }

    await ipc.invoke(IPC.issuesFix, row)

    expect(d.fixIssue).toHaveBeenCalledWith(row)
  })

  it('rejects an issue row that is not one', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)

    // `kind` outside scan-chart's three issue arrays: an action that switched on it would
    // otherwise be handed a value it has no branch for.
    await expect(
      ipc.invoke(IPC.issuesFix, {
        chartPath: '/lib/chart',
        kind: 'whatever',
        code: 'badVideo',
        description: 'x'
      })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.issuesFix, {
        chartPath: '',
        kind: 'folder',
        code: 'badVideo',
        description: ''
      })
    ).rejects.toThrow()
    expect(d.fixIssue).not.toHaveBeenCalled()
  })

  it('routes issues:fixable to deps.fixableIssueCodes', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)

    expect(await ipc.invoke(IPC.issuesFixable)).toEqual([
      { code: 'badVideo', available: true, reason: null }
    ])
  })

  it('routes issues:fix-cancel to deps.cancelIssueFix and refuses an empty path', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)

    await ipc.invoke(IPC.issuesFixCancel, '/lib/chart')
    expect(d.cancelIssueFix).toHaveBeenCalledWith('/lib/chart')

    await expect(ipc.invoke(IPC.issuesFixCancel, '')).rejects.toThrow()
    expect(d.cancelIssueFix).toHaveBeenCalledTimes(1)
  })

  it('accepts asset:write-background data exactly at the 20 MB limit', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const atLimit = new Uint8Array(20 * 1024 * 1024)
    await ipc.invoke(IPC.assetWriteBackground, {
      chartPath: '/lib/chart',
      chartType: 'folder',
      data: atLimit
    })
    expect(d.writeBackground).toHaveBeenCalledTimes(1)
  })

  it('routes dialog:save-text to deps.saveTextFile and returns the path', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const result = await ipc.invoke(IPC.saveTextFile, {
      defaultName: 'encore-issues.csv',
      content: 'chartPath,kind,code,description\r\n'
    })
    expect(d.saveTextFile).toHaveBeenCalledWith(
      { defaultName: 'encore-issues.csv', content: 'chartPath,kind,code,description\r\n' },
      expect.anything()
    )
    expect(result).toBe('/home/user/encore-issues.csv')
  })

  it('rejects dialog:save-text when defaultName contains a path separator', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(
      ipc.invoke(IPC.saveTextFile, { defaultName: '../evil.csv', content: '' })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.saveTextFile, { defaultName: 'sub/evil.csv', content: '' })
    ).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.saveTextFile, { defaultName: 'sub\\evil.csv', content: '' })
    ).rejects.toThrow()
    expect(d.saveTextFile).not.toHaveBeenCalled()
  })

  it('rejects dialog:save-text when defaultName is empty or too long', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    await expect(ipc.invoke(IPC.saveTextFile, { defaultName: '', content: '' })).rejects.toThrow()
    await expect(
      ipc.invoke(IPC.saveTextFile, { defaultName: 'x'.repeat(121), content: '' })
    ).rejects.toThrow()
    expect(d.saveTextFile).not.toHaveBeenCalled()
  })

  it('routes library:detect to deps', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    expect(await ipc.invoke(IPC.libraryDetect)).toEqual([
      { path: '/home/user/.clonehero/Songs', chartCount: 207, countCapped: false }
    ])
    expect(d.detectLibraries).toHaveBeenCalledTimes(1)
  })

  it('rejects dialog:save-text when content exceeds 10 MB', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerIpc(ipc as never, d)
    const oversized = 'x'.repeat(10_000_001)
    await expect(
      ipc.invoke(IPC.saveTextFile, { defaultName: 'test.csv', content: oversized })
    ).rejects.toThrow()
    expect(d.saveTextFile).not.toHaveBeenCalled()
  })
})
