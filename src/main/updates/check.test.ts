import { describe, expect, it, vi } from 'vitest'
import { checkForUpdates, createThrottle } from './check'
import type { LocalChartIdentity, RemoteChart } from './match'

const local = (over: Partial<LocalChartIdentity> = {}): LocalChartIdentity => ({
  path: '/lib/a.sng',
  name: 'Song',
  artist: 'Band',
  charter: 'Charter',
  chartHash: 'LOCAL',
  tempoMapHash: 'TEMPO',
  ...over
})

const remote = (over: Partial<RemoteChart> = {}): RemoteChart => ({
  chartId: 1,
  name: 'Song',
  artist: 'Band',
  charter: 'Charter',
  chartHash: 'LOCAL',
  md5: 'a'.repeat(32),
  modifiedTime: null,
  tempoMapHash: 'TEMPO',
  noteCount: 100,
  hasVideoBackground: false,
  ...over
})

describe('checkForUpdates', () => {
  it('classifies each chart and reports how many searches it spent', async () => {
    const search = vi.fn(async () => [remote()])
    const result = await checkForUpdates([local()], { search })
    expect(result.verdicts.map((v) => v.kind)).toEqual(['current'])
    expect(result.requests).toBe(1)
  })

  it('flags a chart whose notes no upload carries', async () => {
    const search = vi.fn(async () => [remote({ chartHash: 'REMOTE', noteCount: 90 })])
    const result = await checkForUpdates([local()], { search })
    expect(result.verdicts[0].kind).toBe('alternate')
  })

  /** The whole point of the pool: a second chart by the same artist costs no request. */
  it("answers a later chart from an earlier chart's results without searching again", async () => {
    const search = vi.fn(async () => [
      remote({ chartId: 1, name: 'Song', chartHash: 'LOCAL' }),
      remote({ chartId: 2, name: 'Other', chartHash: 'OTHER' })
    ])
    const result = await checkForUpdates(
      [local(), local({ path: '/lib/b.sng', name: 'Other', chartHash: 'OTHER' })],
      { search }
    )
    expect(result.verdicts.map((v) => v.kind)).toEqual(['current', 'current'])
    expect(search).toHaveBeenCalledTimes(1)
    expect(result.requests).toBe(1)
  })

  /**
   * Absence from a partial pool is not absence from the index, so only `current`, which rests on
   * a hash that is present, is allowed to skip the request.
   */
  it('still searches for a chart the pool cannot yet account for', async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce([remote({ chartId: 1, chartHash: 'LOCAL' })])
      .mockResolvedValueOnce([remote({ chartId: 2, name: 'Other', chartHash: 'OTHER' })])
    const result = await checkForUpdates(
      [local(), local({ path: '/lib/b.sng', name: 'Other', chartHash: 'OTHER' })],
      { search }
    )
    expect(search).toHaveBeenCalledTimes(2)
    expect(result.verdicts.map((v) => v.kind)).toEqual(['current', 'current'])
  })

  it('searches for the song and its artist together', async () => {
    const search = vi.fn(async () => [])
    await checkForUpdates([local()], { search })
    expect(search).toHaveBeenCalledWith('Band Song', undefined)
  })

  it('reports a chart with nothing to search on as unknown, without searching', async () => {
    const search = vi.fn(async () => [])
    const result = await checkForUpdates([local({ artist: null, name: null })], { search })
    expect(result.verdicts[0].kind).toBe('unknown')
    expect(search).not.toHaveBeenCalled()
  })

  it('keeps going when one search fails, and counts the failure', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([remote({ name: 'Other', chartHash: 'OTHER' })])
    const result = await checkForUpdates(
      [local(), local({ path: '/lib/b.sng', name: 'Other', chartHash: 'OTHER' })],
      { search }
    )
    expect(result.failed).toBe(1)
    expect(result.verdicts.map((v) => v.kind)).toEqual(['unknown', 'current'])
  })

  /** A failed lookup must never read as "you are up to date". */
  it('reports a failed lookup as unknown rather than current', async () => {
    const search = vi.fn(async () => {
      throw new Error('offline')
    })
    const result = await checkForUpdates([local()], { search })
    expect(result.verdicts[0].kind).toBe('unknown')
  })

  it('throttles before each search', async () => {
    const order: string[] = []
    const throttle = vi.fn(async () => {
      order.push('throttle')
    })
    const search = vi.fn(async () => {
      order.push('search')
      return []
    })
    await checkForUpdates([local(), local({ path: '/b', name: 'B' })], { search, throttle })
    expect(order).toEqual(['throttle', 'search', 'throttle', 'search'])
  })

  it('reports progress per chart', async () => {
    const onProgress = vi.fn()
    await checkForUpdates([local(), local({ path: '/b', name: 'B' })], {
      search: async () => [],
      onProgress
    })
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2]
    ])
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      checkForUpdates([local()], { search: async () => [] }, controller.signal)
    ).rejects.toThrow(/Aborted/)
  })

  it('propagates an abort raised by the search itself', async () => {
    const search = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError')
    })
    await expect(checkForUpdates([local()], { search })).rejects.toThrow(/Aborted/)
  })
})

describe('createThrottle', () => {
  it('spaces successive calls by the interval', async () => {
    vi.useFakeTimers()
    try {
      const throttle = createThrottle(1000)
      await throttle()
      const second = throttle()
      let done = false
      void second.then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(600)
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
