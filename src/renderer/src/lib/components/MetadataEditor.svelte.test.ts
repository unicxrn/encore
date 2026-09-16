import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartMetadataRead } from '../../../../main/metadata/edit'
import type { ChartRecord } from '../../../../shared/schemas'
import MetadataEditor from './MetadataEditor.svelte'

/**
 * The metadata editor, which is the one view in Encore that writes what a user typed into a chart
 * they own and cannot get back.
 *
 * jsdom applies no CSS and computes no layout, so nothing here says anything about how the form
 * looks, where the rows sit or whether a label fits beside its box; that is the offscreen
 * measurement in scripts/measure-metadata-editor.mjs. What these pin down is the part that would
 * be a defect rather than an eyesore:
 *
 *   - the form offers the six fields and NOT the seven keys Clone Hero matches charts by,
 *   - a save carries only what the user changed,
 *   - the values on screen are the raw ones from the file, not scan-chart's reading of them,
 *   - a refusal or a failed save is shown in main's own words, with the typed values still there.
 */

const CHART: ChartRecord = {
  path: '/library/Rush - YYZ',
  chartType: 'folder',
  name: 'YYZ',
  artist: 'Rush',
  album: null,
  genre: 'Rock',
  year: null,
  charter: 'Harmonix'
} as unknown as ChartRecord

const SNG: ChartRecord = { ...CHART, path: '/library/rush.sng', chartType: 'sng' }

/** What the file says, including the two blanks that bring somebody to this view. */
const READ: ChartMetadataRead = {
  chartPath: CHART.path,
  chartType: 'folder',
  iniName: 'song.ini',
  synthetic: false,
  fields: { name: 'YYZ', artist: 'Rush', album: '', genre: 'Rock', year: '', charter: 'Harmonix' },
  gameplay: [
    { key: 'hopo_frequency', value: '3' },
    { key: 'pro_drums', value: 'True' }
  ],
  refusal: null
}

function stubEncore(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    chartReadMetadata: vi.fn().mockResolvedValue(READ),
    chartWriteMetadata: vi.fn().mockResolvedValue({
      chartPath: CHART.path,
      chartType: 'folder',
      changed: ['album'],
      chartHash: 'hash',
      cloneHeroChecksum: 'checksum',
      record: { ...CHART, album: 'Moving Pictures' }
    }),
    catalogQuery: vi.fn().mockResolvedValue([CHART]),
    ...over
  }
  vi.stubGlobal('encore', api)
  return api as unknown as Record<string, ReturnType<typeof vi.fn>>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** The box for one field, by the label the form gives it. */
const box = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement

async function openOnChart(chart: ChartRecord = CHART): Promise<void> {
  render(MetadataEditor, { chart })
  await waitFor(() => expect(box('Album')).toBeTruthy())
}

describe('MetadataEditor', () => {
  it('shows the raw values from the file, blanks included', async () => {
    stubEncore()

    await openOnChart()

    expect(box('Title').value).toBe('YYZ')
    expect(box('Artist').value).toBe('Rush')
    // Empty, not "Unknown Album". The catalog row stores scan-chart's reading, where an unset
    // album is that string, and a form seeded from the row would offer to write those words into
    // the user's song.ini.
    expect(box('Album').value).toBe('')
    expect(box('Year').value).toBe('')
  })

  it('offers a box for the six fields and for nothing else', async () => {
    stubEncore()

    await openOnChart()

    const editable = screen
      .getAllByRole('textbox')
      .map((el) => el.getAttribute('id'))
      .filter((id) => id?.startsWith('metaedit-'))
    expect(editable).toEqual([
      'metaedit-name',
      'metaedit-artist',
      'metaedit-album',
      'metaedit-genre',
      'metaedit-year',
      'metaedit-charter'
    ])
  })

  it('shows the gameplay keys it will not edit, with the reason, and no control', async () => {
    stubEncore()

    await openOnChart()

    // The keys are on screen: a form that silently lacked them would leave a user looking for the
    // setting that turns them on.
    expect(screen.getByText('pro_drums')).toBeTruthy()
    expect(screen.getByText('hopo_frequency')).toBeTruthy()
    expect(screen.getByText(/matches charts between players/)).toBeTruthy()
    // And they are text, not boxes. This is the assertion that would fail if someone ever added
    // the seven to METADATA_FIELDS.
    expect(screen.queryByLabelText('pro_drums')).toBeNull()
    expect(screen.queryByLabelText('hopo_frequency')).toBeNull()
  })

  it('says so when the chart leaves all seven at their defaults', async () => {
    stubEncore({ chartReadMetadata: vi.fn().mockResolvedValue({ ...READ, gameplay: [] }) })

    await openOnChart()

    expect(screen.getByText(/leaves all seven at their defaults/)).toBeTruthy()
  })

  it('cannot be saved until something is typed', async () => {
    stubEncore()

    await openOnChart()

    const save = screen.getByRole('button', { name: 'Save to the chart' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await fireEvent.input(box('Album'), { target: { value: 'Moving Pictures' } })
    expect(save.disabled).toBe(false)
  })

  it('sends only the fields that changed', async () => {
    const api = stubEncore()

    await openOnChart()
    await fireEvent.input(box('Album'), { target: { value: 'Moving Pictures' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save to the chart' }))

    // Not all six. A key absent from this payload is a line the ini editor never looks at, which
    // is what keeps a save from rewriting five lines the user did not touch.
    await waitFor(() =>
      expect(api.chartWriteMetadata).toHaveBeenCalledWith({
        path: CHART.path,
        chartType: 'folder',
        fields: { album: 'Moving Pictures' }
      })
    )
  })

  it('sends an empty string for a field cleared on purpose', async () => {
    const api = stubEncore()

    await openOnChart()
    await fireEvent.input(box('Genre'), { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save to the chart' }))

    await waitFor(() =>
      expect(api.chartWriteMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ fields: { genre: '' } })
      )
    )
  })

  it('shows the value it is about to replace, for as long as it is unsaved', async () => {
    stubEncore()

    await openOnChart()
    expect(screen.queryByText(/^Was/)).toBeNull()
    await fireEvent.input(box('Artist'), { target: { value: 'RUSH' } })

    // The editor's undo. There is no backup store behind a metadata edit, because the value being
    // replaced is one the user is looking at rather than one Encore chose for them.
    const was = screen.getByText(/^Was/)
    expect(was.textContent).toContain('Rush')
  })

  it('reverts to what the file says', async () => {
    stubEncore()

    await openOnChart()
    await fireEvent.input(box('Artist'), { target: { value: 'RUSH' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Revert' }))

    expect(box('Artist').value).toBe('Rush')
    expect(
      (screen.getByRole('button', { name: 'Save to the chart' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('refuses a year the catalog could not store, before anything is written', async () => {
    const api = stubEncore()

    await openOnChart()
    await fireEvent.input(box('Year'), { target: { value: 'late nineties' } })

    expect(screen.getByRole('alert').textContent).toMatch(/four digits/)
    expect(
      (screen.getByRole('button', { name: 'Save to the chart' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(api.chartWriteMetadata).not.toHaveBeenCalled()
  })

  it('names what it saved and hands the fresh row back', async () => {
    const saved: ChartRecord[] = []
    stubEncore()

    render(MetadataEditor, { chart: CHART, onSaved: (record: ChartRecord) => saved.push(record) })
    await waitFor(() => expect(box('Album')).toBeTruthy())
    await fireEvent.input(box('Album'), { target: { value: 'Moving Pictures' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save to the chart' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Saved\. Album is/))
    expect(saved).toHaveLength(1)
    expect(saved[0].album).toBe('Moving Pictures')
  })

  it('re-reads the chart after a save, so a second save diffs against the file', async () => {
    const api = stubEncore()

    await openOnChart()
    await fireEvent.input(box('Album'), { target: { value: 'Moving Pictures' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save to the chart' }))

    // Twice: once on mount, once after the write. Assuming the written value instead would let a
    // second save send a field the first one had already put on disk.
    await waitFor(() => expect(api.chartReadMetadata).toHaveBeenCalledTimes(2))
  })

  it("shows main's message when a save is refused, and keeps what was typed", async () => {
    stubEncore({
      chartWriteMetadata: vi
        .fn()
        .mockRejectedValue(
          new Error(
            '/library/Rush - YYZ is not there any more, so Encore has not changed anything.'
          )
        )
    })

    await openOnChart()
    await fireEvent.input(box('Album'), { target: { value: 'Moving Pictures' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save to the chart' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not there any more/))
    // Still in the box. A failed save that also cleared the form would cost the user the typing
    // as well as the edit.
    expect(box('Album').value).toBe('Moving Pictures')
  })

  it('replaces the form with the reason when a chart cannot be edited at all', async () => {
    stubEncore({
      chartReadMetadata: vi.fn().mockResolvedValue({
        ...READ,
        chartPath: SNG.path,
        chartType: 'sng',
        synthetic: false,
        refusal: '/library/rush.sng packs its own song.ini as well as header metadata.'
      })
    })

    render(MetadataEditor, { chart: SNG })

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/packs its own song\.ini/)
    )
    // No boxes at all, rather than boxes whose Save would fail.
    expect(screen.queryByLabelText('Album')).toBeNull()
  })

  it('says a .sng save rebuilds the archive rather than writing a file', async () => {
    stubEncore({
      chartReadMetadata: vi
        .fn()
        .mockResolvedValue({ ...READ, chartPath: SNG.path, chartType: 'sng', synthetic: true })
    })

    render(MetadataEditor, { chart: SNG })

    await waitFor(() => expect(screen.getByText(/rebuilds the archive/)).toBeTruthy())
  })

  it('opens on a finder when nothing handed it a chart', async () => {
    const api = stubEncore()
    vi.useFakeTimers()

    render(MetadataEditor)
    expect(screen.getByLabelText('Find a chart')).toBeTruthy()
    // No chart, so nothing was read.
    expect(api.chartReadMetadata).not.toHaveBeenCalled()

    await fireEvent.input(screen.getByLabelText('Find a chart'), { target: { value: 'yyz' } })
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()

    await waitFor(() => expect(screen.getByText('YYZ')).toBeTruthy())
    expect(api.catalogQuery).toHaveBeenCalledWith({ search: 'yyz', limit: 25 })
  })

  it('loads the chart the finder picked', async () => {
    const api = stubEncore()
    vi.useFakeTimers()
    render(MetadataEditor)
    await fireEvent.input(screen.getByLabelText('Find a chart'), { target: { value: 'yyz' } })
    await vi.advanceTimersByTimeAsync(250)
    vi.useRealTimers()
    await waitFor(() => expect(screen.getByText('YYZ')).toBeTruthy())

    await fireEvent.click(screen.getByText('YYZ'))

    await waitFor(() => expect(box('Album')).toBeTruthy())
    expect(api.chartReadMetadata).toHaveBeenCalledWith({
      path: CHART.path,
      chartType: 'folder'
    })
  })
})
