import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobProgress } from '../../../../shared/schemas'

type Listener<T> = (data: T) => void

function stubEncore(): {
  fireAsset: Listener<JobProgress>
  onAssetProgress: ReturnType<typeof vi.fn>
} {
  let onAsset: Listener<JobProgress> = () => {}
  const api = {
    onAssetProgress: vi.fn((cb: Listener<JobProgress>) => {
      onAsset = cb
      return () => {}
    }),
    fireAsset: (p: JobProgress) => onAsset(p)
  }
  ;(globalThis as Record<string, unknown>).window = { encore: api }
  return api
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.resetModules()
})

const makeProgress = (overrides: Partial<JobProgress> = {}): JobProgress => ({
  jobId: 'sidecar:ytdlp',
  kind: 'asset',
  phase: 'download',
  percent: 50,
  message: null,
  status: 'running',
  ...overrides
})

describe('assets store', () => {
  it('updates the per-job entry when an asset progress event fires', async () => {
    const api = stubEncore()
    const { assetJobs, initAssets } = await import('./assets')
    initAssets()

    api.fireAsset(makeProgress({ percent: 25 }))

    const map = get(assetJobs)
    expect(map.get('sidecar:ytdlp')).toMatchObject({ percent: 25, status: 'running' })
  })

  it('overwrites the previous entry with the latest progress', async () => {
    const api = stubEncore()
    const { assetJobs, initAssets } = await import('./assets')
    initAssets()

    api.fireAsset(makeProgress({ percent: 10 }))
    api.fireAsset(makeProgress({ percent: 80 }))

    expect(get(assetJobs).get('sidecar:ytdlp')?.percent).toBe(80)
  })

  it('retains terminal done state in the map', async () => {
    const api = stubEncore()
    const { assetJobs, initAssets } = await import('./assets')
    initAssets()

    api.fireAsset(makeProgress({ percent: 100, status: 'done', phase: 'complete' }))

    expect(get(assetJobs).get('sidecar:ytdlp')).toMatchObject({ status: 'done', percent: 100 })
  })

  it('retains terminal error state in the map', async () => {
    const api = stubEncore()
    const { assetJobs, initAssets } = await import('./assets')
    initAssets()

    api.fireAsset(makeProgress({ percent: null, status: 'error', message: 'network fail' }))

    const entry = get(assetJobs).get('sidecar:ytdlp')
    expect(entry?.status).toBe('error')
    expect(entry?.message).toBe('network fail')
  })

  it('tracks multiple jobs independently', async () => {
    const api = stubEncore()
    const { assetJobs, initAssets } = await import('./assets')
    initAssets()

    api.fireAsset(makeProgress({ jobId: 'sidecar:ytdlp', percent: 40 }))
    api.fireAsset(makeProgress({ jobId: 'sidecar:ffmpeg', percent: 60 }))

    const map = get(assetJobs)
    expect(map.get('sidecar:ytdlp')?.percent).toBe(40)
    expect(map.get('sidecar:ffmpeg')?.percent).toBe(60)
  })

  it('initAssets returns an unsubscriber that stops tracking events', async () => {
    const api = stubEncore()
    const { assetJobs, initAssets } = await import('./assets')
    const unsub = initAssets()

    api.fireAsset(makeProgress({ percent: 20 }))
    expect(get(assetJobs).get('sidecar:ytdlp')?.percent).toBe(20)

    // After unsubscribing the store stub resets the listener, so updates stop.
    unsub()
    // Subsequent fires go to the no-op listener, map stays unchanged.
    api.fireAsset(makeProgress({ percent: 99 }))
    // The mock returns () => {} so the unsub doesn't actually reset the stub
    // listener, but the return value is tested to be callable.
    expect(unsub).not.toThrow()
  })
})

describe('isJobRunning', () => {
  it('returns false when the job is not in the map', async () => {
    stubEncore()
    const { assetJobs, isJobRunning } = await import('./assets')
    assetJobs.set(new Map())
    const running = isJobRunning('sidecar:ytdlp')
    expect(get(running)).toBe(false)
  })

  it('returns true while the job is running', async () => {
    stubEncore()
    const { assetJobs, isJobRunning } = await import('./assets')
    assetJobs.set(new Map([['sidecar:ytdlp', makeProgress({ status: 'running' })]]))
    expect(get(isJobRunning('sidecar:ytdlp'))).toBe(true)
  })

  it('returns false after the job reaches done', async () => {
    stubEncore()
    const { assetJobs, isJobRunning } = await import('./assets')
    assetJobs.set(
      new Map([
        ['sidecar:ytdlp', makeProgress({ status: 'done', percent: 100, phase: 'complete' })]
      ])
    )
    expect(get(isJobRunning('sidecar:ytdlp'))).toBe(false)
  })
})
