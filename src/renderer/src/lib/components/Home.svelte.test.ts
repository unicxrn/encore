import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { readable } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartRecord, JobProgress } from '../../../../shared/schemas'
import { ChartRecordSchema } from '../../../../shared/schemas'
import { scanProgress } from '../stores/scan'
import {
  EIGHT_TAG_CHARTER,
  EIGHT_TAG_CHARTER_TEXT
} from '../../../../../test/helpers/marked-up-names'

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

/**
 * The play data moved to its own tab. What is left to check here is that Home does not reach
 * for it any more: the panel owned a bridge subscription and three calls, and a Home that still
 * made one of them would be spending a read on a block it no longer draws.
 */
describe('Home: no longer the place the play data lives', () => {
  it('draws no play panel, and asks the bridge for nothing about plays', async () => {
    const playStatus = vi.fn()
    const playStats = vi.fn()
    const onPlayRecorded = vi.fn()
    renderHome({
      catalogQuery: () => Promise.resolve([chart('/library/YYZ', 'YYZ')]),
      playStatus,
      playStats,
      onPlayRecorded
    })

    expect(await screen.findByText('YYZ')).toBeTruthy()
    expect(screen.queryByText('YOUR PLAYS')).toBeNull()
    expect(playStatus).not.toHaveBeenCalled()
    expect(playStats).not.toHaveBeenCalled()
    expect(onPlayRecorded).not.toHaveBeenCalled()
  })

  it('opens with the chart rows, which are now the first thing under the hero', async () => {
    renderHome({ catalogQuery: () => Promise.resolve([]) })

    const latest = await screen.findByText('LATEST CHARTS')
    const library = await screen.findByText('IN YOUR LIBRARY')
    expect(latest.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('Home: a name written in Clone Hero markup', () => {
  it('reads the recently added row as text, and falls back when the name is only tags', async () => {
    // Home is the one view the strip pass could not reach, because the Stats move held this file.
    // Both rows here are real shapes: a charter styles their name and song.ini carries it whole.
    renderHome({
      catalogQuery: () =>
        Promise.resolve([chart('/l/a', EIGHT_TAG_CHARTER), chart('/l/Only Tags', '<b></b>')])
    })
    expect(await screen.findByText(EIGHT_TAG_CHARTER_TEXT)).toBeTruthy()
    // A name that strips to nothing used to render an empty span. The path is what is left to
    // identify the chart by, and it is what every other view falls back to.
    expect(screen.getByText('Only Tags')).toBeTruthy()
    expect(screen.queryByText(/color=#/)).toBeNull()
  })
})
