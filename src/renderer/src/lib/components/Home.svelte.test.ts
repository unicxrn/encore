import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { readable } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartRecord, JobProgress } from '../../../../shared/schemas'
import { ChartRecordSchema } from '../../../../shared/schemas'
import { scanProgress } from '../stores/scan'

// The latest-charts row talks to the Enchor API over the network. Stubbed at the store, not at
// fetch, because nothing below is about that row; this file only covers Home's scan controls.
vi.mock('../stores/latest-charts', () => ({
  latestCharts: readable({ charts: [], loading: false, error: null, total: null }),
  loadLatestCharts: (): Promise<void> => Promise.resolve()
}))

const { default: Home } = await import('./Home.svelte')

const chart = (path: string, name: string): ChartRecord =>
  ChartRecordSchema.parse({
    path,
    name,
    chartType: 'folder',
    folderHash: path,
    modifiedTime: 0
  })

const progress = (status: JobProgress['status'], percent: number): JobProgress => ({
  jobId: 'scan',
  kind: 'scan',
  phase: status === 'running' ? 'scanning' : status,
  percent,
  message: null,
  status
})

function renderHome(
  api: Record<string, unknown> = { catalogQuery: () => Promise.resolve([]) }
): void {
  vi.stubGlobal('encore', api)
  render(Home, { onNavigate: () => {}, onOpenChart: () => {} })
}

afterEach(() => {
  vi.unstubAllGlobals()
  scanProgress.set(null)
})

/**
 * Home is where the first-run user lands: Welcome saves the folder, starts the scan and closes
 * itself immediately (catalog:scan resolves once the scan has STARTED, not once it is finished),
 * so this view is the one on screen for the whole scan. A cancel that only existed on the
 * Installed tab would be a control the user who most needs it has to go looking for.
 */
describe('Home: cancelling a scan', () => {
  it('offers no cancel until a scan is actually running', async () => {
    renderHome()
    await screen.findByText('Scan library')
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('asks main to stop the scan when the cancel is pressed', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    renderHome({ catalogQuery: () => Promise.resolve([]), catalogScanCancel: cancel })
    scanProgress.set(progress('running', 40))

    await fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('refreshes the library row after a cancel, because the rows it wrote were kept', async () => {
    let rows: ChartRecord[] = []
    const query = vi.fn(() => Promise.resolve(rows))
    renderHome({ catalogQuery: query })
    await waitFor(() => expect(query).toHaveBeenCalled())

    rows = [chart('/library/Rush - YYZ', 'YYZ')]
    scanProgress.set(progress('canceled', 42))

    expect(await screen.findByText('YYZ')).toBeTruthy()
  })
})
