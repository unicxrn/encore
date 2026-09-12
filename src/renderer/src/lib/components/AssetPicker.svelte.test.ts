import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChartRecordSchema, type ChartRecord, type JobProgress } from '../../../../shared/schemas'
import { assetJobs } from '../stores/assets'
import { TAGGED_CHARTER, TAGGED_CHARTER_TEXT } from '../../../../../test/helpers/marked-up-names'
import AssetPicker from './AssetPicker.svelte'

const CHART_PATH = '/library/Rush - YYZ'

/**
 * Goes through the real schema so the fields the picker reads are the ones the catalog would
 * hand it, rather than a hand-written literal that can drift from the row shape.
 */
const chart = (overrides: Partial<ChartRecord> = {}): ChartRecord =>
  ChartRecordSchema.parse({
    path: CHART_PATH,
    chartType: 'folder',
    folderHash: CHART_PATH,
    modifiedTime: 0,
    name: 'YYZ',
    artist: 'Rush',
    ...overrides
  })

/**
 * The picker learns a download is running from the asset-job store, which main feeds over
 * `ev:asset-progress`. Writing the store directly is the same input without the IPC hop.
 */
function setVideoJob(job: Partial<JobProgress> | null): void {
  assetJobs.set(
    job === null
      ? new Map()
      : new Map([
          [
            `video:${CHART_PATH}`,
            {
              jobId: `video:${CHART_PATH}`,
              kind: 'asset',
              phase: 'download',
              percent: 42,
              message: null,
              status: 'running',
              ...job
            } as JobProgress
          ]
        ])
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  assetJobs.set(new Map())
})

describe('AssetPicker video cancel', () => {
  it('offers no cancel until a download is running', () => {
    vi.stubGlobal('encore', { videoCancel: vi.fn() })
    setVideoJob(null)
    render(AssetPicker, { mode: 'video', chart: chart(), onAction: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Cancel download' })).toBeNull()
  })

  it('cancels the running download for its own chart', async () => {
    const videoCancel = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('encore', { videoCancel })
    setVideoJob({})
    render(AssetPicker, { mode: 'video', chart: chart(), onAction: vi.fn() })

    const button = await screen.findByRole('button', { name: 'Cancel download' })
    await fireEvent.click(button)
    expect(videoCancel).toHaveBeenCalledWith(CHART_PATH)
  })

  it('reports a cancelled download as cancelled rather than as an error', async () => {
    // main rejects the download invoke on cancel, exactly as it does for a real failure. The
    // picker has to tell the two apart or it shows the user's own click back to them as ERROR.
    const videoCancel = vi.fn().mockResolvedValue(undefined)
    const hit = {
      id: 'dQw4w9WgXcQ',
      title: 'YYZ',
      channel: 'Rush',
      durationSeconds: 273,
      thumbnailUrl: null
    }
    // Held open so the cancel click lands while the download is still in flight, which is the
    // only ordering that tells the two rejection causes apart.
    let rejectDownload: (err: Error) => void = () => {}
    vi.stubGlobal('encore', {
      videoCancel,
      videoSearch: vi.fn().mockResolvedValue([hit]),
      videoDownload: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectDownload = reject
          })
      )
    })
    render(AssetPicker, { mode: 'video', chart: chart(), onAction: vi.fn() })

    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    // "Download YYZ", not "Download": every result row carries one of these, and the
    // accessible name has to say which row it belongs to.
    await fireEvent.click(await screen.findByRole('button', { name: `Download ${hit.title}` }))
    setVideoJob({})
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel download' }))
    rejectDownload(new Error('Video download aborted'))

    await waitFor(() => expect(screen.getByText('DOWNLOAD CANCELED')).toBeTruthy())
    expect(screen.queryByText(/^ERROR:/)).toBeNull()
  })
})

/**
 * The seeds are the one place in this task where stripping helps the search as well as the
 * screen: iTunes, YouTube and LRCLIB have never heard of a TextMeshPro tag, so a seed carrying
 * one returns nothing at all. The box the user reads and the request Encore sends are the same
 * string, which is what these pin.
 */
describe('AssetPicker seeds a search from a name written in Clone Hero markup', () => {
  const marked = (): ChartRecord =>
    chart({ name: '<b>YYZ</b>', artist: TAGGED_CHARTER, album: '<i>Moving Pictures</i>' })

  it('seeds the album search with the artist and album as text', () => {
    vi.stubGlobal('encore', {})
    render(AssetPicker, { mode: 'art', chart: marked(), onAction: vi.fn() })
    const box = screen.getByPlaceholderText('Search albums…') as HTMLInputElement
    expect(box.value).toBe(`${TAGGED_CHARTER_TEXT} Moving Pictures`)
  })

  it('seeds the video search with the artist and title as text', () => {
    vi.stubGlobal('encore', {})
    render(AssetPicker, { mode: 'video', chart: marked(), onAction: vi.fn() })
    const box = screen.getByPlaceholderText('Search YouTube…') as HTMLInputElement
    expect(box.value).toBe(`${TAGGED_CHARTER_TEXT} YYZ`)
  })

  it('seeds the two lyrics boxes as text', () => {
    vi.stubGlobal('encore', {})
    render(AssetPicker, { mode: 'lyrics', chart: marked(), onAction: vi.fn() })
    expect((screen.getByPlaceholderText('Artist') as HTMLInputElement).value).toBe(
      TAGGED_CHARTER_TEXT
    )
    expect((screen.getByPlaceholderText('Track') as HTMLInputElement).value).toBe('YYZ')
  })
})
