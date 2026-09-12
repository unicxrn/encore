import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { browseSearch } from '../stores/search'
import { settings } from '../stores/settings'
import { defaultSettings } from '../../../../shared/settings-defaults'
import type { ChartData, SearchResult } from '../api/enchor'
import type { AdvancedQuery } from '../api/advanced'

// Browse drives the module-scoped `browseSearch`, which was constructed with the
// real `fetch` at import time, so stubbing the global afterwards would be too late.
// Mocking the API module is the seam that still works, and it is the one
// `latest-charts.test.ts` already uses. Partial, because Browse also reads
// INSTRUMENTS and DIFFICULTIES from here.
const searchCharts = vi.fn()
vi.mock('../api/enchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/enchor')>()),
  searchCharts: (...args: unknown[]) => searchCharts(...args) as Promise<SearchResult>
}))

import Browse from './Browse.svelte'

function chart(
  chartId: number,
  songId: number | null,
  charter: string,
  albumArtMd5: string | null = null
): ChartData {
  return {
    chartId,
    songId,
    // One md5 per chart, not one shared constant: the download queue keys on
    // md5, so a fixture where two versions hash alike would hide a bulk
    // download that enqueued the same chart twice.
    md5: String(chartId).padStart(32, 'a'),
    albumArtMd5,
    hasVideoBackground: false,
    name: 'Everlong',
    artist: 'Foo Fighters',
    album: '',
    genre: '',
    year: '1997',
    charter,
    song_length: 250_000,
    diff_guitar: 4,
    diff_bass: null,
    diff_drums: null,
    diff_keys: null,
    diff_vocals: null
  }
}

// Cover art for the primary. The alternate's md5 differs so a failure recorded
// for one cannot be mistaken for the other's.
const ART_MD5 = 'b'.repeat(32)

// Two charts sharing a songId, so the primary row carries a "+1" version chip.
//
// Every test in this file sees these same rows: `browseSearch` is module-scoped
// and ignores a query it has already answered, so only the first test to run
// actually fetches, and each later mount re-reads what that one loaded. Charts
// specific to one test would therefore never reach the screen.
const TWO_VERSIONS: ChartData[] = [
  chart(1, 42, 'CharterA', ART_MD5),
  chart(2, 42, 'CharterB', 'c'.repeat(32))
]

/** The one key field that tells TWO_VERSIONS apart, as `existsByMeta` sees it. */
type MetaKey = { charter: string }

const downloadAdd = vi.fn<(r: unknown) => Promise<void>>()

/**
 * The observers Browse has opened, newest last.
 *
 * jsdom ships no IntersectionObserver and computes no layout, so there is nothing to observe and
 * nothing that could ever intersect. The stub below records what Browse asked to watch and hands
 * back a way to say it came into view, which is the only part of this a test can drive.
 */
const observers: { fire: (visible: boolean) => void }[] = []

class StubIntersectionObserver {
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe(): void {
    observers.push({ fire: (visible) => this.callback([{ isIntersecting: visible }]) })
  }
  unobserve(): void {
    // Nothing to forget: `observers` is emptied by renderBrowse before each mount.
  }
  disconnect(): void {
    // As above.
  }
  takeRecords(): never[] {
    return []
  }
}

/** Say the button at the end of the list has come into view (or gone out of it). */
function sentinelInView(visible = true): void {
  for (const observer of observers) observer.fire(visible)
}

function renderBrowse(
  onOpenChart: (target: unknown) => void = () => {},
  {
    inLibrary = false,
    // Explore is reachable with nothing configured (the welcome's "Explore
    // charts instead" leads straight here), so the library folder is a real
    // variable of these tests, not a constant. A folder by default, because
    // that is the state most of them are about.
    libraryFolders = [{ path: '/music', isDefault: true }]
  }: {
    inLibrary?: boolean | ((key: MetaKey) => boolean)
    libraryFolders?: { path: string; isDefault: boolean }[]
  } = {}
): ReturnType<typeof render> {
  settings.set({ ...defaultSettings(), libraryFolders })
  observers.length = 0
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
  vi.stubGlobal('encore', {
    existsByMeta: (keys: MetaKey[]): Promise<boolean[]> =>
      Promise.resolve(
        keys.map((k) => (typeof inLibrary === 'function' ? inLibrary(k) : inLibrary))
      ),
    downloadAdd
  })
  return render(Browse, { onOpenChart })
}

afterEach(async () => {
  downloadAdd.mockReset()
  // `settings` is another module-level writable this file writes to; left set,
  // a library folder from one test is what the next one's first paint reads.
  settings.set(defaultSettings())
  // Same singleton problem as `expanded` below: the mode one test sets is still set on the
  // next test's first paint. Pinned to list rather than to the store's default, which is grid:
  // most of this file asserts on list rows, and `Browse grid view` switches for itself.
  browseSearch.setMode('list')
  browseSearch.clearSelected()
  // Same singleton again. An advanced query one test applies disables the next test's search box
  // and routes its request to a different endpoint, and an open panel puts thirty more controls
  // on screen for every getByRole after it.
  browseSearch.clearAdvanced()
  browseSearch.setAdvancedOpen(false)
  browseSearch.saveScroll(0)
  // `browseSearch` is module-scoped and outlives every render in this file, so a
  // group one test expands is still expanded on the next test's first paint,
  // which would put two rows for the same song on screen and make `getByRole`
  // ambiguous. Collapse whatever is open, the way a fresh store would be.
  for (const songId of get(browseSearch.expanded)) browseSearch.toggleExpanded(songId)
  // Unstubbed last, and only once the run `clearAdvanced` may have started has settled. Browse is
  // still mounted while this hook runs (the library's cleanup is registered before it, so it runs
  // after), and its in-library effect reaches for the bridge every time the rows change. Pulling
  // the bridge out from under it first surfaces as an unhandled TypeError attributed to whichever
  // test happened to be last.
  await new Promise((r) => setTimeout(r, 0))
  vi.unstubAllGlobals()
})

describe('Browse expanded version groups', () => {
  it('keeps a group expanded across the unmount an opened chart causes', async () => {
    // App renders Detail *instead of* Browse, so visiting a chart destroys this
    // component. Before the expansion state moved into the shared store, every
    // expanded group collapsed on the way back.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })

    const first = renderBrowse()
    // The store debounces 300ms before its first request, so the first paint is empty.
    const chip = await screen.findByLabelText('2 versions')
    // CharterB is the alternate version; it only has rows while the group is open.
    expect(screen.queryAllByText('CharterB')).toHaveLength(0)

    await fireEvent.click(chip)
    expect(screen.queryAllByText('CharterB').length).toBeGreaterThan(0)

    first.unmount()
    renderBrowse()

    // Same store, same rows, so the alternate row is back without another fetch.
    expect((await screen.findAllByText('CharterB')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('2 versions').getAttribute('aria-expanded')).toBe('true')
  })
})

// The charter is what tells the two rows of TWO_VERSIONS apart (same song, same
// artist, same length), so these match the control that opens a chart by charter
// rather than by title.
const OPENS_PRIMARY = /CharterA/
const OPENS_ALTERNATE = /CharterB/
// The checkboxes carry the same charter, prefixed, and are matched separately so
// a query for one control can never pick up the other.
const SELECTS_PRIMARY = /^Select .*CharterA/
const SELECTS_ALTERNATE = /^Select .*CharterB/

describe('Browse rows', () => {
  async function showAlternates(): Promise<void> {
    await fireEvent.click(await screen.findByLabelText('2 versions'))
  }

  it('opens a chart when its row is clicked', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    const onOpenChart = vi.fn()
    renderBrowse(onOpenChart)

    await fireEvent.click(await screen.findByRole('button', { name: OPENS_PRIMARY }))

    // Once, not twice: a row that both handles its own click and lets an inner
    // control's click bubble up to it would navigate twice per click.
    expect(onOpenChart).toHaveBeenCalledTimes(1)
    expect(onOpenChart.mock.calls[0][0]).toMatchObject({ kind: 'remote', chart: { chartId: 1 } })
  })

  it('opens an alternate version when its row is clicked', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    const onOpenChart = vi.fn()
    renderBrowse(onOpenChart)
    await showAlternates()

    await fireEvent.click(screen.getByRole('button', { name: OPENS_ALTERNATE }))

    expect(onOpenChart).toHaveBeenCalledTimes(1)
    expect(onOpenChart.mock.calls[0][0]).toMatchObject({ kind: 'remote', chart: { chartId: 2 } })
  })

  it('does not open a chart when the version toggle is used', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    const onOpenChart = vi.fn()
    renderBrowse(onOpenChart)

    await showAlternates()

    // The toggle sits inside the row's clickable area, so expanding a group must
    // not also navigate away from the list it was expanded in.
    expect(onOpenChart).not.toHaveBeenCalled()
    expect(screen.getByLabelText('2 versions').getAttribute('aria-expanded')).toBe('true')
  })

  it('opens charts from a real button, which is what carries Enter and Space', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    await showAlternates()

    // Keyboard activation cannot be exercised here: measured under this config,
    // a keydown of Enter or Space on a focused <button> fires no click in jsdom,
    // and @testing-library/user-event is not installed. What is checkable is the
    // thing the platform derives it from: an actual <button>. A <span
    // role="button"> passes getByRole and loses Space unless someone remembers
    // to handle it, which is the trap this pins shut.
    for (const name of [OPENS_PRIMARY, OPENS_ALTERNATE]) {
      const open = screen.getByRole('button', { name })
      expect(open.tagName).toBe('BUTTON')
      expect((open as HTMLButtonElement).disabled).toBe(false)
    }
  })

  it('names the control that opens a chart after the chart it opens', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    await showAlternates()

    // Two rows here are the same song by the same artist. A name that stopped at
    // the title would announce both identically, so a screen-reader user picking
    // a version would be choosing blind.
    await screen.findByRole('button', { name: 'Everlong by Foo Fighters, charted by CharterA' })
    screen.getByRole('button', { name: 'Everlong by Foo Fighters, charted by CharterB' })
  })

  it('numbers rows in list view', async () => {
    // The grid tests below read the absence of this number as "not the list",
    // so pin that it is the list's and only the list's.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()

    expect(await screen.findByText('01')).toBeTruthy()
  })

  it('keeps the version toggle outside the control that opens the chart', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()

    // The spec forbids interactive content inside a button, which leaves what a
    // browser does with the inner control undefined. The version toggle is the
    // one such control the row has today; the checkbox and per-row download
    // button that follow depend on the same rule holding.
    const open = await screen.findByRole('button', { name: OPENS_PRIMARY })
    expect(open.contains(screen.getByLabelText('2 versions'))).toBe(false)
  })
})

describe('Browse grid view', () => {
  it('opens in the grid, without anyone asking for it', async () => {
    // The one test in this file that does NOT take the beforeEach's list pin: it undoes it, so
    // it sees what a user sees on a cold start. The default lives in `createSearch`; this is
    // what makes a change to it visible here rather than only in the store's own test.
    browseSearch.setMode('grid')
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    // Cards are not numbered; the row number is the list's alone.
    expect((await screen.findByRole('button', { name: 'Grid' })).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.queryByText('01')).toBeNull()
  })

  async function showGrid(): Promise<void> {
    await fireEvent.click(screen.getByRole('button', { name: 'Grid' }))
    // A card and a row show much of the same text, so most of what these tests
    // assert would also hold if the click did nothing and the list stayed up.
    // The row numbering is the list's alone: gone means the mode really changed.
    expect(screen.queryByText('01')).toBeNull()
  }

  it('switches between the list and the grid, and says which is on', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    // The row number is the list's; cards are not numbered. It is the cheapest
    // observable difference between the two modes that is content, not styling.
    expect(await screen.findByText('01')).toBeTruthy()

    await showGrid()
    expect(screen.queryByText('01')).toBeNull()
    expect(screen.getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('false')

    await fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByText('01')).toBeTruthy()
  })

  it('keeps the chosen mode across the unmount an opened chart causes', async () => {
    // App renders Detail *instead of* Browse, so visiting a chart destroys this
    // component. A per-instance mode would drop the user back into the list.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    const first = renderBrowse()
    await screen.findByText('01')
    await showGrid()

    first.unmount()
    renderBrowse()

    expect((await screen.findByRole('button', { name: 'Grid' })).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.queryByText('01')).toBeNull()
  })

  it('names the chart, its artist and its charter on a card', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    await screen.findByText('01')
    await showGrid()

    // Same accessible name as the list's row button: the charter is what tells
    // two versions of one song apart.
    expect(
      screen.getByRole('button', { name: 'Everlong by Foo Fighters, charted by CharterA' })
    ).toBeTruthy()
    expect(screen.getByText('Foo Fighters')).toBeTruthy()
    expect(screen.getByText('CharterA')).toBeTruthy()
  })

  it('marks a chart already in the library, as the list does', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse(() => {}, { inLibrary: true })
    await screen.findByText('01')
    await showGrid()

    expect((await screen.findAllByText('IN LIBRARY')).length).toBeGreaterThan(0)
  })

  it('says a song has other versions, and shows them without leaving the grid', async () => {
    // A card cannot expand in place the way a row does, but dropping the
    // alternates would leave someone downloading one of three charts believing
    // it was the only one.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    const onOpenChart = vi.fn()
    renderBrowse(onOpenChart)
    await screen.findByText('01')
    await showGrid()

    const chip = screen.getByLabelText('2 versions')
    expect(screen.queryAllByText('CharterB')).toHaveLength(0)

    await fireEvent.click(chip)

    expect(screen.queryAllByText('CharterB').length).toBeGreaterThan(0)
    // The chip sits inside the card's clickable area, and the card opens a
    // chart: revealing versions must not navigate away from them.
    expect(onOpenChart).not.toHaveBeenCalled()
    expect(screen.getByLabelText('2 versions').getAttribute('aria-expanded')).toBe('true')
  })

  it('opens the alternate a revealed card stands for', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    const onOpenChart = vi.fn()
    renderBrowse(onOpenChart)
    await screen.findByText('01')
    await showGrid()
    await fireEvent.click(screen.getByLabelText('2 versions'))

    await fireEvent.click(screen.getByRole('button', { name: OPENS_ALTERNATE }))

    expect(onOpenChart).toHaveBeenCalledTimes(1)
    expect(onOpenChart.mock.calls[0][0]).toMatchObject({ kind: 'remote', chart: { chartId: 2 } })
  })

  it('selects a chart from a card, as a row does', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    await screen.findByText('01')
    await showGrid()

    await fireEvent.click(screen.getByRole('checkbox', { name: SELECTS_PRIMARY }))

    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('drops album art that fails to load and does not ask for it again', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    const { container } = renderBrowse()
    await screen.findByText('01')
    await showGrid()

    // Art is decorative (alt=""), so it has no accessible name to query by; its
    // presence is still content rather than styling, which is why this reaches
    // for the element directly.
    const img = container.querySelector(`img[src*="${ART_MD5}"]`)
    expect(img).toBeTruthy()

    await fireEvent.error(img as HTMLImageElement)

    // Gone, not merely hidden: a URL that 404'd is re-requested by every
    // remount otherwise, and the card shows a broken image while it waits.
    expect(container.querySelector(`img[src*="${ART_MD5}"]`)).toBeNull()
  })
})

describe('Browse multi-select', () => {
  it('shows the selection bar only once something is selected', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    const box = await screen.findByRole('checkbox', { name: SELECTS_PRIMARY })

    // A toolbar for a state that is empty almost all the time is a permanent
    // tax on the list for an occasional action.
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull()

    await fireEvent.click(box)
    expect(screen.getByText('1 selected')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByText('1 selected')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull()
  })

  it('unticks a chart that is ticked again', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    const box = await screen.findByRole('checkbox', { name: SELECTS_PRIMARY })

    await fireEvent.click(box)
    await fireEvent.click(screen.getByRole('checkbox', { name: SELECTS_PRIMARY }))

    expect(screen.queryByText('1 selected')).toBeNull()
  })

  it('does not open a chart when its checkbox is ticked', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    const onOpenChart = vi.fn()
    renderBrowse(onOpenChart)

    // The checkbox sits inside the row's clickable area. The row stands aside
    // for clicks from `button, input, a, select`, and this is what proves an
    // `<input type="checkbox">` is covered by that rule rather than assuming it.
    await fireEvent.click(await screen.findByRole('checkbox', { name: SELECTS_PRIMARY }))

    expect(onOpenChart).not.toHaveBeenCalled()
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('selects only the primary of a group, never its hidden alternates', async () => {
    // Three charts queued when the user picked one is how a bulk download
    // becomes untrustworthy. A tick means one chart, always.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()

    await fireEvent.click(await screen.findByRole('checkbox', { name: SELECTS_PRIMARY }))
    expect(screen.getByText('1 selected')).toBeTruthy()

    // Reveal the alternate: it must have arrived unticked.
    await fireEvent.click(screen.getByLabelText('2 versions'))
    const alt = screen.getByRole('checkbox', { name: SELECTS_ALTERNATE })
    expect((alt as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('forgets an alternate when the group that showed it is collapsed', async () => {
    // Collapsing takes the alternate's checkbox off the screen; leaving it
    // selected would leave a count nobody can account for.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()

    await fireEvent.click(await screen.findByLabelText('2 versions'))
    await fireEvent.click(screen.getByRole('checkbox', { name: SELECTS_PRIMARY }))
    await fireEvent.click(screen.getByRole('checkbox', { name: SELECTS_ALTERNATE }))
    expect(screen.getByText('2 selected')).toBeTruthy()

    await fireEvent.click(screen.getByLabelText('2 versions'))

    // The primary is still on screen, so it keeps its tick.
    expect(screen.getByText('1 selected')).toBeTruthy()
  })
})

describe('Browse bulk download', () => {
  /** Ticks both versions of the group, which needs the group open first. */
  async function selectBoth(): Promise<void> {
    await fireEvent.click(await screen.findByLabelText('2 versions'))
    await fireEvent.click(screen.getByRole('checkbox', { name: SELECTS_PRIMARY }))
    await fireEvent.click(screen.getByRole('checkbox', { name: SELECTS_ALTERNATE }))
  }

  it('queues one download per selected chart', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    await selectBoth()

    await fireEvent.click(screen.getByRole('button', { name: 'Download 2' }))

    // Distinct md5s, so this cannot pass by enqueuing one chart twice.
    expect(downloadAdd.mock.calls.map((c) => (c[0] as { md5: string }).md5)).toEqual([
      TWO_VERSIONS[0].md5,
      TWO_VERSIONS[1].md5
    ])
  })

  it('clears the selection once the charts are queued', async () => {
    // The batch has been handed over, and the queue panel is where it lives
    // now. Leaving the ticks up invites a second click that the queue's own
    // md5 dedupe would silently swallow, which reads as a broken button.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()
    await selectBoth()

    await fireEvent.click(screen.getByRole('button', { name: 'Download 2' }))

    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull())
  })

  it('says once, not once per chart, that there is nowhere to put them', async () => {
    // downloadAdd resolves happily with no library folder configured (the
    // rejection is in the download runner), so enqueuing anyway would put two
    // separate failures in the queue saying the same thing.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse(() => {}, { libraryFolders: [] })
    await selectBoth()

    await fireEvent.click(screen.getByRole('button', { name: 'Download 2' }))

    expect(await screen.findByText(/no library folder/i)).toBeTruthy()
    expect(downloadAdd).not.toHaveBeenCalled()
    // The selection survives, so fixing the setting does not mean picking again.
    expect(screen.getByText('2 selected')).toBeTruthy()
  })

  it('leaves out charts already in the library, and says how many', async () => {
    // Silently re-fetching a chart the user owns wastes their bandwidth;
    // silently dropping it from a batch they picked is worse. Say the number.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse(() => {}, { inLibrary: (k) => k.charter === 'CharterA' })
    await selectBoth()

    const button = await screen.findByRole('button', { name: 'Download 1' })
    expect(screen.getByText(/1 already in your library/)).toBeTruthy()

    await fireEvent.click(button)

    expect(downloadAdd.mock.calls.map((c) => (c[0] as { md5: string }).md5)).toEqual([
      TWO_VERSIONS[1].md5
    ])
  })

  it('offers nothing to download when every selected chart is already owned', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse(() => {}, { inLibrary: true })
    await selectBoth()

    const button = await screen.findByRole('button', { name: 'Nothing to download' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/2 already in your library/)).toBeTruthy()
  })

  it('reports one failure for a batch that could not be queued, and keeps the selection', async () => {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    downloadAdd.mockRejectedValue(new Error('bridge is down'))
    renderBrowse()
    await selectBoth()

    await fireEvent.click(screen.getByRole('button', { name: 'Download 2' }))

    // Named down to the sentence: "2 of 2" alone also matches the list's own "2 of 2 charts
    // loaded" status line, and a matcher that finds either one is not checking this.
    expect(await screen.findByText(/could not queue 2 of 2/)).toBeTruthy()
    expect(screen.getByText('2 selected')).toBeTruthy()
  })
})

/**
 * Loading as the user reaches the end of the list.
 *
 * Nothing here sees a scroll: jsdom applies no CSS and computes no layout, so the list has no
 * height, no overflow and no scrolling box, and `scrollTop` on it is 0 whatever is assigned to it.
 * What these pin is the wiring either side of the measurement. That the sentinel really lands at
 * the end of the list, and that a real IntersectionObserver reports it where this one is told to,
 * needs QA in the desktop app.
 */
describe('Browse loading as the list is scrolled', () => {
  /** The store left with rows on screen and more pages behind them, and Browse rendered over it. */
  async function renderWithMorePages(): Promise<HTMLElement> {
    // `found` well past the rows in hand, so there is always another page to ask for. retry() is
    // the one path that re-runs a query the module-scoped store has already answered.
    searchCharts.mockResolvedValue({ found: 50, out_of: 50, page: 1, data: TWO_VERSIONS })
    browseSearch.retry()
    await new Promise((r) => setTimeout(r, 350))
    const { container } = renderBrowse()
    await screen.findByRole('button', { name: 'Load more' })
    return container.querySelector('.table') as HTMLElement
  }

  /**
   * jsdom's `scrollTop` setter does nothing without a scrolling box, so the offset a scroll event
   * reports has to be defined onto the element directly.
   */
  function scrollTo(table: HTMLElement, top: number): Promise<boolean> {
    Object.defineProperty(table, 'scrollTop', { value: top, writable: true, configurable: true })
    return fireEvent.scroll(table)
  }

  it('fetches exactly one more page when the end of the list comes into view', async () => {
    const table = await renderWithMorePages()
    expect(searchCharts).toHaveBeenCalledTimes(1)

    await scrollTo(table, 120)
    sentinelInView()
    await waitFor(() => expect(searchCharts).toHaveBeenCalledTimes(2))

    // One page, not several. The decision is taken once per arrival at the bottom: left standing,
    // it would fire again the instant the request finished, before the observer could say the
    // sentinel had moved, and a fast scroll would spend the API's 50 a minute on the way down.
    const params = searchCharts.mock.calls[1][0] as { page: number }
    expect(params.page).toBe(2)
    await new Promise((r) => setTimeout(r, 50))
    expect(searchCharts).toHaveBeenCalledTimes(2)
  })

  it('does not fetch until the user has moved the list themselves', async () => {
    // Explore is destroyed by every navigation and the mount puts the list back where it was. On
    // a list left at the bottom, an observer armed from the first paint would spend a request on
    // every trip back from a chart Detail, for a page nobody asked for.
    const table = await renderWithMorePages()
    expect(searchCharts).toHaveBeenCalledTimes(1)

    sentinelInView()
    await new Promise((r) => setTimeout(r, 50))
    expect(searchCharts).toHaveBeenCalledTimes(1)

    await scrollTo(table, 120)
    await waitFor(() => expect(searchCharts).toHaveBeenCalledTimes(2))
  })

  it('does not treat the restored scroll offset as the user reaching the bottom', async () => {
    // The restore writes scrollTop, and the browser answers with a scroll event of its own. That
    // one is not a gesture and must not arm anything.
    searchCharts.mockResolvedValue({ found: 50, out_of: 50, page: 1, data: TWO_VERSIONS })
    browseSearch.retry()
    await new Promise((r) => setTimeout(r, 350))
    browseSearch.saveScroll(420)

    const { container } = renderBrowse()
    await screen.findByRole('button', { name: 'Load more' })
    const table = container.querySelector('.table') as HTMLElement
    expect(searchCharts).toHaveBeenCalledTimes(1)

    await scrollTo(table, 420)
    sentinelInView()
    await new Promise((r) => setTimeout(r, 50))
    expect(searchCharts).toHaveBeenCalledTimes(1)

    // A scroll to anywhere else is the user's, and the page they have reached is then fetched.
    await scrollTo(table, 560)
    await waitFor(() => expect(searchCharts).toHaveBeenCalledTimes(2))
  })

  it('leaves a button at the end of the list, so reaching more needs no scroll gesture', async () => {
    // The whole point of keeping a real button rather than an empty sentinel div: a keyboard or
    // screen-reader user never fires an intersection, and tabbing to this and pressing it is how
    // they reach the same rows.
    const table = await renderWithMorePages()
    const button = screen.getByRole('button', { name: 'Load more' })
    expect(button.tagName).toBe('BUTTON')

    await fireEvent.click(button)

    await waitFor(() => expect(searchCharts).toHaveBeenCalledTimes(2))
    // Never disabled: disabling the control that has focus throws focus back to the document and
    // loses a keyboard user their place in the list every time a page lands.
    expect(
      (screen.getByRole('button', { name: /Load more|Loading more/ }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(table).toBeTruthy()
  })

  it('says how much of the answer is loaded, where a screen reader will hear it', async () => {
    await renderWithMorePages()
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/2 of 50 charts loaded/)
  })

  it('asks for nothing more once a failed page has left the error card up', async () => {
    // Re-asking on every re-evaluation is how a rate-limited client stays rate-limited. Retry is
    // the deliberate way back, and it is already on the error card.
    const table = await renderWithMorePages()
    searchCharts.mockRejectedValueOnce(new Error('Search failed: 429'))

    await scrollTo(table, 120)
    sentinelInView()
    await screen.findByRole('alert')
    const spent = searchCharts.mock.calls.length

    sentinelInView(false)
    sentinelInView(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(searchCharts).toHaveBeenCalledTimes(spent)
  })
})

describe('Browse advanced search', () => {
  let mounted: ReturnType<typeof render> | null = null

  /** Opens the panel from the button that carries the filter count. */
  async function openPanel(): Promise<void> {
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    mounted = renderBrowse()
    await fireEvent.click(await screen.findByRole('button', { name: 'Advanced search' }))
  }

  /** What opening a chart Detail does to this view: destroys it, then builds it again. */
  function remount(): void {
    mounted?.unmount()
    mounted = renderBrowse()
  }

  it('keeps the panel shut until it is asked for', async () => {
    // Thirty controls is not what most people came for. The plain box is.
    searchCharts.mockResolvedValue({ found: 2, out_of: 2, page: 1, data: TWO_VERSIONS })
    renderBrowse()

    const toggle = await screen.findByRole('button', { name: 'Advanced search' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  it('opens on the toggle and offers a field per thing the endpoint takes', async () => {
    await openPanel()

    expect(
      screen.getByRole('button', { name: 'Advanced search' }).getAttribute('aria-expanded')
    ).toBe('true')
    for (const label of ['Name', 'Artist', 'Album', 'Genre', 'Year', 'Charter']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    expect(screen.getByLabelText('Match Name exactly')).toBeTruthy()
    expect(screen.getByLabelText('Exclude charts matching Name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Modchart' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
  })

  it('names the unit on the length range, which the API counts in seconds', async () => {
    await openPanel()
    expect(screen.getByLabelText('Lowest length, in min')).toBeTruthy()
    expect(screen.getByLabelText('Highest length, in min')).toBeTruthy()
  })

  it('changes nothing until Search is pressed', async () => {
    // Thirty controls searching on change is thirty requests against 50 a minute, and a
    // half-filled form is rarely a question anyone means.
    await openPanel()
    const spent = searchCharts.mock.calls.length

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'bloom' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Modchart' }))

    expect(searchCharts).toHaveBeenCalledTimes(spent)
    expect(screen.getByRole('button', { name: 'Advanced search' })).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(searchCharts).toHaveBeenCalledTimes(spent + 1))
    const params = searchCharts.mock.calls.at(-1)?.[0] as { advanced: AdvancedQuery }
    expect(params.advanced.flags.modchart).toBe(true)
    expect(params.advanced.text.name.value).toBe('bloom')
  })

  it('says on the closed panel how many filters are on, and offers the way out beside it', async () => {
    // The panel is shut most of the time, and a list narrowed by filters nobody can see is a list
    // that looks wrong.
    await openPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Modchart' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    const toggle = await screen.findByRole('button', { name: 'Advanced search, 1 filter applied' })
    await fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Still named after the count with the panel shut, and Clear is in reach of it.
    expect(screen.getByRole('button', { name: 'Advanced search, 1 filter applied' })).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    await screen.findByRole('button', { name: 'Advanced search' })
  })

  it('turns the search box off and says why, because the endpoint takes no term', async () => {
    // Measured against the live service: a term sent to /search/advanced answers with the whole
    // catalog. A box that still took typing would look broken rather than being off.
    await openPanel()
    const box = screen.getByLabelText('Search charts') as HTMLInputElement
    expect(box.disabled).toBe(false)

    await fireEvent.click(screen.getByRole('button', { name: 'Modchart' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() =>
      expect((screen.getByLabelText('Search charts') as HTMLInputElement).disabled).toBe(true)
    )
    expect(screen.getByText(/does not take a search term/)).toBeTruthy()
  })

  it('keeps a form that was filled in but never searched across the unmount a chart opens', async () => {
    // App renders Detail instead of Browse, so visiting a chart destroys this component and the
    // panel with it. Ten fields typed and lost is worse than a search nobody ran.
    await openPanel()
    await fireEvent.input(screen.getByLabelText('Charter'), { target: { value: 'half typed' } })

    remount()

    // The panel is still open, because that is state too, and the boxes still hold what was typed.
    expect(
      (await screen.findByRole('button', { name: 'Advanced search' })).getAttribute('aria-expanded')
    ).toBe('true')
    expect((screen.getByLabelText('Charter') as HTMLInputElement).value).toBe('half typed')
  })

  it('keeps the applied filters across the same unmount', async () => {
    await openPanel()
    await fireEvent.click(screen.getByRole('button', { name: 'Modchart' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await screen.findByRole('button', { name: 'Advanced search, 1 filter applied' })
    const spent = searchCharts.mock.calls.length

    remount()

    // The rows on screen were fetched with these, so the count has to still say so, and the
    // remount must not spend a request re-asking a question the store has already answered.
    expect(
      await screen.findByRole('button', { name: 'Advanced search, 1 filter applied' })
    ).toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(searchCharts).toHaveBeenCalledTimes(spent)
  })
})
