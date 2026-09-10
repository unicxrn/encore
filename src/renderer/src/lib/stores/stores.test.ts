import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobProgress, QueuedDownload } from '../../../../shared/schemas'
import { defaultSettings } from '../../../../shared/schemas'

type Listener<T> = (data: T) => void

function stubEncore(): Record<string, unknown> & {
  fireDownload: Listener<QueuedDownload[]>
  fireScan: Listener<JobProgress>
} {
  let onDl: Listener<QueuedDownload[]> = () => {}
  let onScan: Listener<JobProgress> = () => {}
  const api = {
    settingsGet: vi.fn().mockResolvedValue(defaultSettings()),
    settingsSet: vi.fn().mockResolvedValue(undefined),
    downloadList: vi.fn().mockResolvedValue([]),
    onDownloadUpdate: vi.fn((cb: Listener<QueuedDownload[]>) => {
      onDl = cb
      return () => {}
    }),
    onScanProgress: vi.fn((cb: Listener<JobProgress>) => {
      onScan = cb
      return () => {}
    }),
    catalogScan: vi.fn().mockResolvedValue(undefined),
    catalogScanCancel: vi.fn().mockResolvedValue(undefined),
    fireDownload: (d: QueuedDownload[]) => onDl(d),
    fireScan: (p: JobProgress) => onScan(p)
  }
  ;(globalThis as Record<string, unknown>).window = { encore: api }
  return api as never
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.resetModules()
})

describe('settings store', () => {
  it('loads settings and patches them', async () => {
    const api = stubEncore()
    const { settings, initSettings, patchSettings } = await import('./settings')
    await initSettings()
    expect(get(settings).downloadConcurrency).toBe(3)
    await patchSettings({ downloadConcurrency: 5 })
    expect(get(settings).downloadConcurrency).toBe(5)
    const { settingsSet } = api as unknown as { settingsSet: ReturnType<typeof vi.fn> }
    expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ downloadConcurrency: 5 }))
  })

  it('opens the welcome gate only after settings have loaded with no library folder', async () => {
    stubEncore()
    const { settings, settingsLoaded, needsWelcome, initSettings } = await import('./settings')
    // The pre-load store value is defaultSettings(), whose libraryFolders is [], identical to a
    // genuine first run. Reading it before the load resolves would flash the welcome on every
    // cold start, including for users who have had a library configured for months.
    expect(get(settingsLoaded)).toBe(false)
    expect(get(needsWelcome)).toBe(false)

    await initSettings()
    expect(get(settingsLoaded)).toBe(true)
    expect(get(needsWelcome)).toBe(true)

    // Configured, so the welcome is done, including when the folder turns out to hold no
    // charts, which is a library the user chose, not a user who has not chosen one.
    settings.set({ ...get(settings), libraryFolders: [{ path: '/songs', isDefault: true }] })
    expect(get(needsWelcome)).toBe(false)
  })

  it('reports a library folder only after settings have loaded with one', async () => {
    stubEncore()
    const { settings, hasLibrary, initSettings } = await import('./settings')
    // The same pre-load trap as needsWelcome, seen from the other side: the defaults have no
    // folder, so a reader that trusted them before the load would treat every configured library
    // as absent for a frame.
    expect(get(hasLibrary)).toBe(false)
    await initSettings()
    expect(get(hasLibrary)).toBe(false)
    settings.set({ ...get(settings), libraryFolders: [{ path: '/songs', isDefault: true }] })
    expect(get(hasLibrary)).toBe(true)
  })

  it('keeps the welcome closed for the session once "Explore instead" dismissed it', async () => {
    stubEncore()
    const { needsWelcome, welcomeDismissed, initSettings } = await import('./settings')
    await initSettings()
    expect(get(needsWelcome)).toBe(true)

    // Without this the user is thrown back into onboarding by every click on Home, because
    // nothing about choosing Explore changes the library folders the gate reads.
    welcomeDismissed.set(true)
    expect(get(needsWelcome)).toBe(false)
  })

  it('does not persist the dismissal, so the next launch still opens on the welcome', async () => {
    const api = stubEncore()
    const { welcomeDismissed, initSettings } = await import('./settings')
    await initSettings()
    welcomeDismissed.set(true)
    // A settings write here would carry the dismissal into the next launch of an app that still
    // has no library, where onboarding is the most useful thing to open on.
    const { settingsSet } = api as unknown as { settingsSet: ReturnType<typeof vi.fn> }
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('releases the welcome gate even when loading settings fails', async () => {
    const api = stubEncore()
    const { settingsGet } = api as unknown as { settingsGet: ReturnType<typeof vi.fn> }
    settingsGet.mockRejectedValue(new Error('settings.json is a directory'))
    const { settingsLoaded, initSettings } = await import('./settings')
    await expect(initSettings()).rejects.toThrow('settings.json is a directory')
    // Otherwise the gate never opens and the view it guards stays blank forever. Landing on the
    // welcome is recoverable, since the user can still point at a folder.
    expect(get(settingsLoaded)).toBe(true)
  })
})

describe('downloads store', () => {
  it('seeds from downloadList and follows update events', async () => {
    const api = stubEncore()
    const { downloads, initDownloads } = await import('./downloads')
    initDownloads()
    await Promise.resolve()
    expect(get(downloads)).toEqual([])
    const item: QueuedDownload = {
      md5: 'a',
      url: 'u',
      folderName: 'n',
      status: 'running',
      percent: 40,
      message: null,
      finalPath: null
    }
    api.fireDownload([item])
    expect(get(downloads)).toEqual([item])
  })

  it('does not clobber a live update event with a stale seed list', async () => {
    const api = stubEncore()
    let resolveList: (items: QueuedDownload[]) => void = () => {}
    const { downloadList } = api as unknown as { downloadList: ReturnType<typeof vi.fn> }
    downloadList.mockReturnValue(
      new Promise<QueuedDownload[]>((resolve) => {
        resolveList = resolve
      })
    )
    const { downloads, initDownloads } = await import('./downloads')
    initDownloads()
    const item: QueuedDownload = {
      md5: 'b',
      url: 'u',
      folderName: 'n',
      status: 'running',
      percent: 10,
      message: null,
      finalPath: null
    }
    api.fireDownload([item])
    expect(get(downloads)).toEqual([item])
    resolveList([])
    await Promise.resolve()
    expect(get(downloads)).toEqual([item])
  })
})

describe('scan store', () => {
  it('tracks progress events and clears on done', async () => {
    const api = stubEncore()
    const { scanProgress, initScan, startScan } = await import('./scan')
    initScan()
    await startScan()
    const { catalogScan } = api as unknown as { catalogScan: ReturnType<typeof vi.fn> }
    expect(catalogScan).toHaveBeenCalled()
    api.fireScan({
      jobId: 'scan',
      kind: 'scan',
      phase: 'scanning',
      percent: 50,
      message: null,
      status: 'running'
    })
    expect(get(scanProgress)?.percent).toBe(50)
    api.fireScan({
      jobId: 'scan',
      kind: 'scan',
      phase: 'complete',
      percent: 100,
      message: null,
      status: 'done'
    })
    expect(get(scanProgress)?.status).toBe('done')
  })

  it('asks main to stop the scan and leaves the progress store to the canceled event', async () => {
    // Deliberately does NOT clear or overwrite scanProgress: the terminal state is main's to
    // report, and writing a guess here would either erase the percent the scan reached or claim
    // it had stopped while charts were still finishing.
    const api = stubEncore()
    const { scanProgress, initScan, cancelScan } = await import('./scan')
    initScan()
    api.fireScan({
      jobId: 'scan',
      kind: 'scan',
      phase: 'scanning',
      percent: 40,
      message: null,
      status: 'running'
    })
    await cancelScan()
    const { catalogScanCancel } = api as unknown as {
      catalogScanCancel: ReturnType<typeof vi.fn>
    }
    expect(catalogScanCancel).toHaveBeenCalled()
    expect(get(scanProgress)?.status).toBe('running')

    api.fireScan({
      jobId: 'scan',
      kind: 'scan',
      phase: 'canceled',
      percent: 42,
      message: null,
      status: 'canceled'
    })
    expect(get(scanProgress)?.status).toBe('canceled')
    expect(get(scanProgress)?.percent).toBe(42)
  })
})
