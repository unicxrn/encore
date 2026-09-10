import { describe, expect, it, vi } from 'vitest'
import { ChartRecordSchema, type ChartRecord } from '../../shared/schemas'
import { UpdateService } from './service'

const record = (over: Partial<ChartRecord> = {}): ChartRecord =>
  ChartRecordSchema.parse({
    path: '/lib/a.sng',
    chartType: 'sng',
    name: 'Song',
    artist: 'Band',
    charter: 'Charter',
    chartHash: 'LOCAL',
    tempoMapHash: 'TEMPO',
    folderHash: 'h',
    modifiedTime: 1,
    ...over
  })

const apiRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  chartId: 1,
  name: 'Song',
  artist: 'Band',
  charter: 'Charter',
  chartHash: 'LOCAL',
  md5: 'a'.repeat(32),
  modifiedTime: '2026-05-16T00:00:00.000Z',
  hasVideoBackground: false,
  notesData: { tempoMapHash: 'TEMPO', noteCounts: [{ count: 100 }] },
  ...over
})

const respond = (rows: Record<string, unknown>[]): Response =>
  new Response(JSON.stringify({ found: rows.length, data: rows }), { status: 200 })

const service = (
  rows: Record<string, unknown>[],
  charts: ChartRecord[] = [record()]
): { svc: UpdateService; progress: ReturnType<typeof vi.fn> } => {
  const progress = vi.fn()
  const svc = new UpdateService({
    listCharts: () => charts,
    onProgress: progress,
    throttle: async () => {},
    fetchFn: (async () => respond(rows)) as unknown as typeof fetch
  })
  return { svc, progress }
}

describe('UpdateService', () => {
  it('checks charts and remembers the verdicts', async () => {
    const { svc } = service([apiRow()])
    const summary = await svc.check([])
    expect(summary.verdicts[0].kind).toBe('current')
    expect(svc.lastResults()).toHaveLength(1)
  })

  it('reports progress', async () => {
    const { svc, progress } = service([apiRow()])
    await svc.check([])
    expect(progress).toHaveBeenCalledWith(1, 1)
  })

  it('refuses a second concurrent sweep', async () => {
    const { svc } = service([apiRow()])
    const first = svc.check([])
    await expect(svc.check([])).rejects.toThrow(/already running/)
    await first
  })

  it('clears the running flag so a later sweep can start', async () => {
    const { svc } = service([apiRow()])
    await svc.check([])
    expect(svc.running()).toBe(false)
    await expect(svc.check([])).resolves.toBeDefined()
  })

  it('clears the running flag even when the sweep throws', async () => {
    const svc = new UpdateService({
      listCharts: () => [record()],
      onProgress: () => {},
      throttle: async () => {},
      // A 500 is terminal in the client, so the sweep records a failure rather than throwing;
      // an abort is what actually unwinds check(), and the flag has to survive it.
      fetchFn: (async () => {
        throw new DOMException('Aborted', 'AbortError')
      }) as unknown as typeof fetch
    })
    await expect(svc.check([])).rejects.toThrow()
    expect(svc.running()).toBe(false)
  })

  /**
   * The Detail page checks one chart at a time. Replacing the stored results with that single
   * answer would blank every Library badge the sweep had just produced.
   */
  it('merges a single-chart result into earlier results instead of replacing them', async () => {
    const a = record({ path: '/lib/a.sng', name: 'Song' })
    const b = record({ path: '/lib/b.sng', name: 'Other', chartHash: 'B' })
    let charts = [a, b]
    const svc = new UpdateService({
      listCharts: () => charts,
      onProgress: () => {},
      throttle: async () => {},
      fetchFn: (async () =>
        respond([
          apiRow(),
          apiRow({ chartId: 2, name: 'Other', chartHash: 'B' })
        ])) as unknown as typeof fetch
    })
    await svc.check([])
    expect(svc.lastResults()).toHaveLength(2)

    charts = [b]
    await svc.check(['/lib/b.sng'])
    expect(
      svc
        .lastResults()
        .map((v) => v.local.path)
        .sort()
    ).toEqual(['/lib/a.sng', '/lib/b.sng'])
  })

  it('surfaces an alternate when no upload carries the local notes', async () => {
    const { svc } = service([
      apiRow({
        chartHash: 'DIFFERENT',
        notesData: { tempoMapHash: 'TEMPO', noteCounts: [{ count: 90 }] }
      })
    ])
    const summary = await svc.check([])
    expect(summary.verdicts[0].kind).toBe('alternate')
  })

  it('can be cancelled', async () => {
    const svc = new UpdateService({
      listCharts: () => [record(), record({ path: '/lib/b.sng', name: 'B', chartHash: 'B' })],
      onProgress: () => {},
      throttle: async () => {},
      fetchFn: (async () => respond([apiRow()])) as unknown as typeof fetch
    })
    const promise = svc.check([])
    svc.cancel()
    await expect(promise).rejects.toThrow(/Aborted/)
  })
})
