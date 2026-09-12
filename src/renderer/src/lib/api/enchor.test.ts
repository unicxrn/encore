import { describe, expect, it, vi } from 'vitest'
import { searchCharts } from './enchor'
import { emptyAdvanced } from './advanced'

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

/**
 * Which endpoint answers, and what it is sent.
 *
 * One function decides, so paging, retry, backoff and abort are the same code either way. The
 * decision is the advanced fields themselves rather than a flag beside them, because a flag can
 * disagree with the body it is passed and these cannot.
 */
describe('searchCharts and the advanced endpoint', () => {
  const ok = (body: unknown): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  const empty = { found: 0, out_of: 0, page: 1, data: [] }

  it('stays on /search when the advanced form is untouched', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(empty))
    await searchCharts({ search: 'everlong', advanced: emptyAdvanced() }, fetchFn)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.enchor.us/search')
    // Byte for byte the body a search without the advanced parameter sends: an untouched form is
    // not a different request.
    expect(JSON.parse(String(init.body))).toEqual({
      search: 'everlong',
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

  it('moves to /search/advanced as soon as one field is filled in', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(empty))
    const advanced = emptyAdvanced()
    advanced.flags.modchart = true
    await searchCharts({ search: 'everlong', advanced }, fetchFn)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.enchor.us/search/advanced')
    expect(JSON.parse(String(init.body))).toMatchObject({ modchart: true })
  })

  it('sends the wildcard in place of a search term the advanced endpoint ignores', async () => {
    // Measured against the live service: a term sent to /search/advanced answers with the whole
    // catalog. Passing it on anyway would put a question in the body that the answer does not
    // honour, and Explore's own note about the disabled box would be describing something else.
    const fetchFn = vi.fn().mockImplementation(() => ok(empty))
    const advanced = emptyAdvanced()
    advanced.text.name.value = 'bloom'
    await searchCharts({ search: 'everlong', advanced }, fetchFn)
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).search).toBe('*')
  })

  it('keeps paging and the instrument filters on the advanced endpoint', async () => {
    const fetchFn = vi.fn().mockImplementation(() => ok(empty))
    const advanced = emptyAdvanced()
    advanced.numbers.minLength = '10'
    await searchCharts(
      { search: '*', page: 3, instrument: 'drums', difficulty: 'expert', advanced },
      fetchFn
    )
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.enchor.us/search/advanced')
    expect(JSON.parse(String(init.body))).toMatchObject({
      page: 3,
      per_page: 25,
      instrument: 'drums',
      difficulty: 'expert',
      // Typed in minutes, sent in seconds.
      minLength: 600
    })
  })

  it('retries an advanced request the same way, and against the same URL', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockImplementationOnce(() => ok({ ...empty, found: 1 }))
    const advanced = emptyAdvanced()
    advanced.flags.hasLyrics = true
    const result = await searchCharts({ search: '*', advanced }, fetchFn, { retryDelayMs: 1 })
    expect(result.found).toBe(1)
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      'https://api.enchor.us/search/advanced',
      'https://api.enchor.us/search/advanced'
    ])
  })
})
