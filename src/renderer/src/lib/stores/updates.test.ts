import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartVerdict } from '../../../../shared/updates'

const local = (path: string): ChartVerdict['local'] => ({
  path,
  name: null,
  artist: null,
  charter: null,
  chartHash: null,
  tempoMapHash: null
})

/**
 * The bridge as the store sees it: `updatesLast` only. `updatesCheck` is stubbed to a spy that
 * every test expects to stay silent, because the whole point of this store is that reading a
 * verdict costs no Chorus request.
 */
function stubEncore(last: () => Promise<ChartVerdict[]>): {
  updatesLast: ReturnType<typeof vi.fn>
  updatesCheck: ReturnType<typeof vi.fn>
} {
  const api = { updatesLast: vi.fn(last), updatesCheck: vi.fn() }
  ;(globalThis as Record<string, unknown>).window = { encore: api }
  return api
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.resetModules()
})

describe('updates store', () => {
  it('replays the session verdicts from main, keyed by chart path', async () => {
    const api = stubEncore(() =>
      Promise.resolve([
        { kind: 'alternate', local: local('/songs/a'), alternates: [] },
        { kind: 'current', local: local('/songs/b') }
      ])
    )
    const { verdicts, refreshVerdicts } = await import('./updates')

    await refreshVerdicts()

    expect(get(verdicts).get('/songs/a')?.kind).toBe('alternate')
    expect(get(verdicts).get('/songs/b')?.kind).toBe('current')
    expect(get(verdicts).has('/songs/c')).toBe(false)
    expect(api.updatesLast).toHaveBeenCalledTimes(1)
    expect(api.updatesCheck).not.toHaveBeenCalled()
  })

  it('keeps the last good map when the replay fails, and does not throw', async () => {
    const api = stubEncore(() =>
      Promise.resolve([{ kind: 'alternate', local: local('/songs/a'), alternates: [] }])
    )
    const { verdicts, refreshVerdicts } = await import('./updates')
    await refreshVerdicts()

    api.updatesLast.mockRejectedValueOnce(new Error('ipc gone'))
    await expect(refreshVerdicts()).resolves.toBeUndefined()

    expect(get(verdicts).get('/songs/a')?.kind).toBe('alternate')
  })

  it('survives a bridge without updatesLast, since the badge is only an enhancement', async () => {
    ;(globalThis as Record<string, unknown>).window = { encore: {} }
    const { verdicts, refreshVerdicts } = await import('./updates')

    await expect(refreshVerdicts()).resolves.toBeUndefined()
    expect(get(verdicts).size).toBe(0)
  })

  /**
   * A check the user ran from Detail is already merged into main's list, so the honest local
   * move is the same merge: set by path, keep everything else. Anything less and Installed would
   * need a replay to show what the user just watched happen.
   */
  it('records a check result by path, keeping the other verdicts', async () => {
    const api = stubEncore(() =>
      Promise.resolve([
        { kind: 'alternate', local: local('/songs/a'), alternates: [] },
        { kind: 'unknown', local: local('/songs/b') }
      ])
    )
    const { verdicts, refreshVerdicts, recordVerdicts } = await import('./updates')
    await refreshVerdicts()

    recordVerdicts([
      { kind: 'current', local: local('/songs/b') },
      { kind: 'alternate', local: local('/songs/c'), alternates: [] }
    ])

    expect(get(verdicts).get('/songs/a')?.kind).toBe('alternate')
    expect(get(verdicts).get('/songs/b')?.kind).toBe('current')
    expect(get(verdicts).get('/songs/c')?.kind).toBe('alternate')
    expect(get(verdicts).size).toBe(3)
    expect(api.updatesLast).toHaveBeenCalledTimes(1)
    expect(api.updatesCheck).not.toHaveBeenCalled()
  })

  it('records into an empty map before any replay has happened', async () => {
    stubEncore(() => Promise.resolve([]))
    const { verdicts, recordVerdicts } = await import('./updates')

    recordVerdicts([{ kind: 'current', local: local('/songs/a') }])

    expect(get(verdicts).get('/songs/a')?.kind).toBe('current')
  })
})
