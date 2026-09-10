import { describe, expect, it, vi } from 'vitest'
import { searchCharts } from './client'

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  chartId: 1,
  name: 'Song',
  artist: 'Band',
  charter: 'Charter',
  chartHash: 'HASH',
  md5: 'a'.repeat(32),
  modifiedTime: '2026-05-16T18:34:48.885Z',
  hasVideoBackground: false,
  notesData: { tempoMapHash: 'TEMPO', noteCounts: [{ count: 10 }, { count: 5 }] },
  ...over
})

describe('searchCharts', () => {
  it('maps a row, summing note counts across tracks', async () => {
    const fetchFn = vi.fn(async () => ok({ found: 1, data: [row()] }))
    const [chart] = await searchCharts('Band Song', fetchFn as unknown as typeof fetch)
    expect(chart).toMatchObject({
      chartId: 1,
      charter: 'Charter',
      chartHash: 'HASH',
      tempoMapHash: 'TEMPO',
      noteCount: 15
    })
  })

  it('posts the query with the 100-row page size', async () => {
    const fetchFn = vi.fn(async () => ok({ found: 1, data: [row()] }))
    await searchCharts('Band Song', fetchFn as unknown as typeof fetch)
    const init = (fetchFn.mock.calls as unknown as [string, RequestInit][])[0][1]
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ search: 'Band Song', per_page: 100, page: 1 })
  })

  /** notesData is null on charts the API has not finished processing; those rows carry no hash. */
  it('drops rows that cannot be compared or downloaded', async () => {
    const fetchFn = vi.fn(async () =>
      ok({ found: 3, data: [row(), row({ chartHash: null }), row({ md5: null })] })
    )
    expect(await searchCharts('q', fetchFn as unknown as typeof fetch)).toHaveLength(1)
  })

  it('tolerates a row whose notesData is null', async () => {
    const fetchFn = vi.fn(async () => ok({ found: 1, data: [row({ notesData: null })] }))
    const [chart] = await searchCharts('q', fetchFn as unknown as typeof fetch)
    expect(chart).toMatchObject({ noteCount: 0, tempoMapHash: null })
  })

  it('pages until it has as many rows as the response claims exist', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok({ found: 2, data: [row({ chartId: 1 })] }))
      .mockResolvedValueOnce(ok({ found: 2, data: [row({ chartId: 2 })] }))
    const charts = await searchCharts('q', fetchFn as unknown as typeof fetch)
    expect(charts.map((c) => c.chartId)).toEqual([1, 2])
  })

  it('stops at maxPages rather than walking a huge artist forever', async () => {
    const fetchFn = vi.fn(async () => ok({ found: 999, data: [row()] }))
    await searchCharts('q', fetchFn as unknown as typeof fetch, { maxPages: 3 })
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('stops when a page comes back empty even if found overstates the total', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(ok({ found: 99, data: [row()] }))
      .mockResolvedValueOnce(ok({ found: 99, data: [] }))
    await searchCharts('q', fetchFn as unknown as typeof fetch, { maxPages: 5 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('names rate limiting specifically, because the fix is to wait', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 429 }))
    await expect(searchCharts('q', fetchFn as unknown as typeof fetch)).rejects.toThrow(
      /rate-limiting/
    )
  })

  it('does not retry a rate-limited request', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 429 }))
    await expect(searchCharts('q', fetchFn as unknown as typeof fetch)).rejects.toThrow()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('surfaces other failures with their status', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 500 }))
    await expect(searchCharts('q', fetchFn as unknown as typeof fetch)).rejects.toThrow(
      /Update check failed: 500/
    )
  })
})
