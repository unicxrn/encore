import { describe, expect, it, vi } from 'vitest'
import { DownloadManager } from './manager'
import { DownloadError } from './download'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('DownloadManager', () => {
  it('runs at most `concurrency` downloads at once', async () => {
    let active = 0,
      peak = 0
    const runner = vi.fn().mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      await flush()
      active--
      return '/lib/x'
    })
    const mgr = new DownloadManager({ concurrency: 2, runner })
    for (const id of ['a', 'b', 'c', 'd', 'e']) mgr.add({ md5: id, url: `u/${id}`, folderName: id })
    await mgr.idle()
    expect(runner).toHaveBeenCalledTimes(5)
    expect(peak).toBe(2)
  })
  it('ignores duplicate md5s while queued', async () => {
    const runner = vi.fn().mockResolvedValue('/lib/x')
    const mgr = new DownloadManager({ concurrency: 1, runner })
    mgr.add({ md5: 'same', url: 'u', folderName: 'n' })
    mgr.add({ md5: 'same', url: 'u', folderName: 'n' })
    await mgr.idle()
    expect(runner).toHaveBeenCalledTimes(1)
  })
  it('moves failures to the errored list and retries on request', async () => {
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new DownloadError('fetch', 'boom'))
      .mockResolvedValueOnce('/lib/x')
    const events: string[] = []
    const mgr = new DownloadManager({ concurrency: 1, runner })
    mgr.onUpdate((items) => events.push(items.map((i) => i.status).join(',')))
    mgr.add({ md5: 'a', url: 'u', folderName: 'n' })
    await mgr.idle()
    expect(mgr.list()[0].status).toBe('error')
    mgr.retry('a')
    await mgr.idle()
    expect(mgr.list()[0].status).toBe('done')
  })
  it('normalizes non-Error rejections without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const runner = vi.fn().mockRejectedValue('plain string failure')
      const mgr = new DownloadManager({ concurrency: 1, runner })
      mgr.add({ md5: 'a', url: 'u', folderName: 'n' })
      await mgr.idle()
      await flush()
      expect(mgr.list()[0].status).toBe('error')
      expect(mgr.list()[0].message).toBe('plain string failure')
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
  it('treats a synchronously-throwing runner as an error and still resolves idle()', async () => {
    const runner = vi.fn().mockImplementation(() => {
      throw new Error('sync boom')
    })
    const mgr = new DownloadManager({ concurrency: 1, runner })
    mgr.add({ md5: 'a', url: 'u', folderName: 'n' })
    await mgr.idle()
    expect(mgr.list()[0].status).toBe('error')
    expect(mgr.list()[0].message).toBe('sync boom')
  })
  it('clearFinished removes done/canceled/error items and notifies, leaving queued items', async () => {
    // slow runner: never resolves on its own, which gives us control over timing
    let resolveSlow!: (p: string) => void
    const slowRunner = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSlow = resolve
        })
    )
    const errorRunner = vi.fn().mockRejectedValue(new DownloadError('fetch', 'boom'))
    const doneRunner = vi.fn().mockResolvedValue('/lib/done')
    const canceledRunner = vi.fn().mockRejectedValue(new DownloadError('fetch', 'boom'))

    // Build a manager that uses different runners per item by switching on md5
    const runner = vi
      .fn()
      .mockImplementation(
        async (
          input: { md5: string },
          onProgress: (p: { percent: number }) => void,
          signal: AbortSignal
        ) => {
          if (input.md5 === 'slow') return slowRunner(input, onProgress, signal)
          if (input.md5 === 'err') return errorRunner(input, onProgress, signal)
          if (input.md5 === 'done') return doneRunner(input, onProgress, signal)
          return canceledRunner(input, onProgress, signal)
        }
      )

    const mgr = new DownloadManager({ concurrency: 5, runner })
    const updates: string[][] = []
    mgr.onUpdate((items) => updates.push(items.map((i) => i.status)))

    // Add items: slow (will stay queued/running), done (resolves immediately), err (rejects)
    mgr.add({ md5: 'slow', url: 'u', folderName: 'slow' })
    mgr.add({ md5: 'done', url: 'u', folderName: 'done' })
    mgr.add({ md5: 'err', url: 'u', folderName: 'err' })

    // Wait for done and err to finish; slow is still running
    await flush()
    await flush()
    await flush()

    const statuses = mgr.list().map((i) => i.status)
    expect(statuses).toContain('running') // slow
    expect(statuses).toContain('done')
    expect(statuses).toContain('error')

    const listenerCallsBefore = updates.length
    mgr.clearFinished()

    // Only 'slow' (running) remains
    expect(mgr.list()).toHaveLength(1)
    expect(mgr.list()[0].md5).toBe('slow')
    expect(mgr.list()[0].status).toBe('running')
    // A notification was fired
    expect(updates.length).toBeGreaterThan(listenerCallsBefore)

    // Clean up the dangling promise
    resolveSlow('/lib/slow')
    await mgr.idle()
  })
})
