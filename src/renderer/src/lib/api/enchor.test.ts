import { describe, expect, it, vi } from 'vitest'
import { searchCharts } from './enchor'

const ok = (body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

describe('searchCharts', () => {
  it('POSTs the expected body to /search', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok({ found: 0, out_of: 0, page: 1, data: [] }))
    await searchCharts({ search: 'everlong', page: 2 }, fetchFn)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.enchor.us/search')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ search: 'everlong', page: 2, per_page: 25, source: 'api' })
  })
  it('retries on 503 and succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockImplementationOnce(() => ok({ found: 1, out_of: 1, page: 1, data: [] }))
    const result = await searchCharts({ search: 'x' }, fetchFn, { retryDelayMs: 1 })
    expect(result.found).toBe(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
  it('does not retry a 400', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('bad', { status: 400 }))
    await expect(searchCharts({ search: 'x' }, fetchFn, { retryDelayMs: 1 })).rejects.toThrow('400')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('does not retry a 429 and explains the rate limit', async () => {
    // api.enchor.us rate-limits at 50 requests per window (measured: request 51
    // returns 429). Retrying spends four requests per search instead of one,
    // which keeps a rate-limited client permanently over the limit. Every
    // Explore search then fails and the view looks broken.
    const fetchFn = vi.fn().mockResolvedValue(new Response('Too many requests', { status: 429 }))
    await expect(searchCharts({ search: 'x' }, fetchFn, { retryDelayMs: 1 })).rejects.toThrow(
      /too many searches/i
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('does not retry any other 4xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }))
    await expect(searchCharts({ search: 'x' }, fetchFn, { retryDelayMs: 1 })).rejects.toThrow('404')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('sends the full default body (sort: null when not provided)', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok({ found: 0, out_of: 0, page: 1, data: [] }))
    await searchCharts({ search: 'x' }, fetchFn)
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      search: 'x',
      per_page: 25,
      page: 1,
      instrument: null,
      difficulty: null,
      drumType: null,
      drumsReviewed: true,
      sort: null,
      source: 'api'
    })
  })
  it('includes sort object in body when sort is provided', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok({ found: 0, out_of: 0, page: 1, data: [] }))
    await searchCharts({ search: 'x', sort: { type: 'modifiedTime', direction: 'desc' } }, fetchFn)
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.sort).toEqual({ type: 'modifiedTime', direction: 'desc' })
  })
  it('sends sort: null when sort is absent', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok({ found: 0, out_of: 0, page: 1, data: [] }))
    await searchCharts({ search: 'x' }, fetchFn)
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.sort).toBeNull()
  })
  it('aborts without retrying', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () =>
            rej(new DOMException('Aborted', 'AbortError'))
          )
        })
    )
    const promise = searchCharts({ search: 'x' }, fetchFn, {
      retryDelayMs: 1,
      signal: controller.signal
    })
    controller.abort()
    await expect(promise).rejects.toThrow('Aborted')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('normalizes non-Error rejections', async () => {
    const fetchFn = vi.fn().mockRejectedValue('string failure')
    await expect(searchCharts({ search: 'x' }, fetchFn, { retryDelayMs: 1 })).rejects.toThrow(
      'string failure'
    )
  })
  it('wraps invalid JSON on a 200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    await expect(searchCharts({ search: 'x' }, fetchFn, { retryDelayMs: 1 })).rejects.toThrow(
      'invalid response'
    )
  })
})
