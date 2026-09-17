import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { SearchResult } from '../api/enchor'
import { advancedBody, emptyAdvanced, type AdvancedQuery } from '../api/advanced'

// The store this panel edits calls the API module directly, so that module is the seam. Partial,
// because the panel also reads INSTRUMENTS from it to name the instrument the intensity band is
// a band of.
const searchCharts = vi.fn()
vi.mock('../api/enchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/enchor')>()),
  searchCharts: (...args: unknown[]) => searchCharts(...args) as Promise<SearchResult>
}))

import { createSearch, type SearchStore } from '../stores/search'
import AdvancedSearch from './AdvancedSearch.svelte'

/**
 * What this file can and cannot say.
 *
 * jsdom applies no stylesheet and computes no layout, so nothing here sees the panel. Every
 * claim in this change about where the panel sits, how many lines it wraps to and what it leaves
 * for the list underneath was measured in a real engine by `scripts/measure-advanced-panel.mjs`
 * and is written down there, not here.
 *
 * What IS pinnable is the behaviour the redesign had to carry across untouched: the fields, the
 * units, the request body, and the fact that nothing searches until Search is pressed. Plus the
 * two things the redesign changed on purpose, which are both states rather than appearances: the
 * intensity pair being off without an instrument, and the panel admitting when the boxes no
 * longer describe the rows.
 */

const EMPTY: SearchResult = { found: 0, out_of: 0, page: 1, data: [] }

/** The last query the store actually asked for, as the endpoint would be handed it. */
function lastBody(): Record<string, unknown> {
  const params = searchCharts.mock.calls.at(-1)?.[0] as { advanced: AdvancedQuery }
  return advancedBody(params.advanced)
}

let search: SearchStore

/**
 * A fresh store per test, unlike Explore's module-scoped one.
 *
 * The panel is the whole subject here, so nothing has to survive a remount, and a store shared
 * between tests would carry one test's draft into the next. `debounceMs: 0` because nothing in
 * this file types into the plain search box, which is the only thing the debounce is for.
 */
function mount(): void {
  render(AdvancedSearch, { search })
}

beforeEach(() => {
  searchCharts.mockReset()
  searchCharts.mockResolvedValue(EMPTY)
  search = createSearch({ debounceMs: 0 })
})

describe('the fields the endpoint takes', () => {
  it('offers every text field by name, with both modifiers on each', () => {
    mount()
    for (const label of ['Name', 'Artist', 'Album', 'Genre', 'Year', 'Charter']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
      expect(screen.getByLabelText(`Match ${label} exactly`)).toBeTruthy()
      expect(screen.getByLabelText(`Exclude charts matching ${label}`)).toBeTruthy()
    }
  })

  it('asks a text field for all three keys, which is what the endpoint validates', async () => {
    // A body trimmed to the keys that look interesting is not a smaller request, it is a 400
    // naming the missing path. See advancedBody.
    mount()
    await fireEvent.input(screen.getByLabelText('Artist'), { target: { value: 'Rush' } })
    await fireEvent.click(screen.getByLabelText('Match Artist exactly'))
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(searchCharts).toHaveBeenCalled())
    expect(lastBody()).toEqual({ artist: { value: 'Rush', exact: true, exclude: false } })
  })

  it('keeps every flag the endpoint knows, as a single pressed-pill idiom', () => {
    mount()
    for (const label of [
      'Solo sections',
      'Forced notes',
      'Open notes',
      'Tap notes',
      'Roll lanes',
      '2x kick',
      'Lyrics',
      'Vocals',
      'Video background',
      'Modchart',
      'Has issues'
    ]) {
      expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('leaves no checkbox behind, so one kind of question is asked one way', () => {
    // Exact and Exclude used to be checkboxes sitting among eleven pressed pills that meant the
    // same thing. Two idioms for one question is the defect this whole step is about, one level
    // down from the panel and the filter header asking it twice.
    mount()
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })

  it('still finds one exact chart by hash, and says what a hash does', async () => {
    mount()
    await fireEvent.input(screen.getByLabelText('Chart hash'), { target: { value: 'abc123' } })
    await fireEvent.input(screen.getByLabelText('Track hash'), { target: { value: 'def456' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(searchCharts).toHaveBeenCalled())
    expect(lastBody()).toEqual({ hash: 'abc123', trackHash: 'def456' })
  })

  it('keeps the date threshold, next to the numbers rather than beside the hashes', async () => {
    mount()
    await fireEvent.input(screen.getByLabelText('Updated after'), {
      target: { value: '2026-01-31' }
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(searchCharts).toHaveBeenCalled())
    expect(lastBody()).toEqual({ modifiedAfter: '2026-01-31' })
  })
})

describe('length, which the API counts in minutes', () => {
  /**
   * The unit this project got wrong once and paid four stale pins across three files to undo. A
   * brief said seconds, the implementer built a 60x conversion, and a search for 3 to 6 minute
   * charts answered with charts 3 to 5 hours long.
   */
  it('names the unit on both ends of the range', () => {
    mount()
    expect(screen.getByLabelText('Lowest length, in min')).toBeTruthy()
    expect(screen.getByLabelText('Highest length, in min')).toBeTruthy()
  })

  it('sends the number the box was given, unconverted', async () => {
    mount()
    await fireEvent.input(screen.getByLabelText('Lowest length, in min'), {
      target: { value: '3' }
    })
    await fireEvent.input(screen.getByLabelText('Highest length, in min'), {
      target: { value: '6' }
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(searchCharts).toHaveBeenCalled())
    // 3 and 6, not 180 and 360. `{minLength: 3, maxLength: 6}` answers with 63,408 charts that
    // all sit in that band; a lone maximum of 360 matched 95,284 of the 95,299 there are.
    expect(lastBody()).toEqual({ minLength: 3, maxLength: 6 })
  })
})

describe('the intensity pair, which the filter header also edits', () => {
  it('is off until an instrument is chosen, and says why', () => {
    // A `maxIntensity: 1` query with no instrument answers with 95,093 of 95,299 charts, because
    // the field is per instrument and an uncharted one carries -1. See ADVANCED_RANGES.
    mount()
    const low = screen.getByLabelText('Lowest intensity, off until an instrument is chosen')
    const high = screen.getByLabelText('Highest intensity, off until an instrument is chosen')
    expect((low as HTMLInputElement).disabled).toBe(true)
    expect((high as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('pick an instrument')).toBeTruthy()
  })

  it('comes on with an instrument, and names the one it is rated for', async () => {
    search.setFilters('drums', null)
    mount()

    const low = await screen.findByLabelText('Lowest intensity')
    expect((low as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('Highest intensity') as HTMLInputElement).disabled).toBe(false)
    expect(screen.getByText('rated for Drums')).toBeTruthy()
    expect(screen.queryByText('pick an instrument')).toBeNull()
  })

  it('is named plainly while it is live, so it cannot be confused with the header band', async () => {
    // The header's own two selects are called "Lowest intensity for Drums" whenever an
    // instrument is chosen. Two controls sharing one accessible name is one control a screen
    // reader cannot point at, so this pair takes the plain name and the header keeps the long one.
    search.setFilters('drums', null)
    mount()

    await screen.findByLabelText('Lowest intensity')
    expect(screen.queryByLabelText('Lowest intensity for Drums')).toBeNull()
  })

  it('shows what the header set, rather than holding a second copy of it', async () => {
    search.setFilters('guitar', null)
    search.setIntensity('3', '5')
    mount()

    const low = await screen.findByLabelText('Lowest intensity')
    expect((low as HTMLInputElement).value).toBe('3')
    expect((screen.getByLabelText('Highest intensity') as HTMLInputElement).value).toBe('5')
  })

  it('takes a tier the header does not offer, at either end', async () => {
    // The header runs 1 to 6 with an open 7+ floor and no ceiling above 6, which is the right
    // list for a chip. 0 is a real tier and ratings run to 20, and these two boxes are where
    // either of those is askable. A `max` attribute here would silently exclude real charts.
    search.setFilters('guitar', null)
    mount()

    const low = await screen.findByLabelText('Lowest intensity')
    const high = screen.getByLabelText('Highest intensity')
    expect(low.getAttribute('max')).toBeNull()
    expect(high.getAttribute('max')).toBeNull()

    await fireEvent.input(low, { target: { value: '8' } })
    await fireEvent.input(high, { target: { value: '20' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(lastBody()).toEqual({ minIntensity: 8, maxIntensity: 20 }))
  })

  it('keeps a whole-number step, because a fraction is a 500 from the endpoint', async () => {
    search.setFilters('keys', null)
    mount()
    const low = await screen.findByLabelText('Lowest intensity')
    expect(low.getAttribute('step')).toBe('1')
  })
})

describe('what the panel does and does not repeat', () => {
  it('leaves the applied count to the Advanced button, which is on screen either way', async () => {
    // The badge on that button says the same number whether the panel is open or shut. A second
    // copy of one number, six pixels below it, is a second place for it to be wrong.
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Modchart' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(searchCharts).toHaveBeenCalled())
    expect(screen.queryByText(/filters? applied/)).toBeNull()
  })

  it('says the boxes are ahead of the rows, which is the one thing the header cannot', async () => {
    // Thirty controls that do not search as they are edited need somewhere to admit it. Nothing
    // else on screen distinguishes a form that has been filled in from one that has been asked.
    mount()
    expect(screen.queryByText('Not searched yet')).toBeNull()

    await fireEvent.input(screen.getByLabelText('Genre'), { target: { value: 'Thrash' } })
    expect(screen.getByText('Not searched yet')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(screen.queryByText('Not searched yet')).toBeNull())
  })

  it('does not call a box that would not be sent an unsearched edit', async () => {
    // An Exact pressed beside an empty value changes no request, so it is not news. The
    // comparison is between request bodies rather than between forms, which is what makes that
    // true without a second rule about which edits count.
    mount()
    await fireEvent.click(screen.getByLabelText('Match Album exactly'))
    expect(screen.queryByText('Not searched yet')).toBeNull()
  })
})

describe('what the panel holds on to', () => {
  it('changes nothing until Search is pressed', async () => {
    // Thirty controls searching on change is thirty requests against the 50 a minute the API
    // allows, and a half-filled form is rarely a question anyone means.
    mount()
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'bloom' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Open notes' }))

    expect(searchCharts).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(searchCharts).toHaveBeenCalledTimes(1))
  })

  it('empties every box when the filters are cleared from outside it', async () => {
    // The Clear chip beside the Advanced button is on screen while this panel is open and goes
    // straight to the store, which cannot reach the copy the boxes are bound to. The boxes went
    // on showing filters nothing was filtering by, and the next keystroke wrote them all back.
    mount()
    await fireEvent.input(screen.getByLabelText('Artist'), { target: { value: 'Metallica' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    search.clearAdvanced()

    await waitFor(() =>
      expect((screen.getByLabelText('Artist') as HTMLInputElement).value).toBe('')
    )
    await fireEvent.input(screen.getByLabelText('Genre'), { target: { value: 'Thrash' } })
    expect(get(search.advancedDraft).text.artist.value).toBe('')
  })

  it('empties itself from its own Clear, with nothing left applied', async () => {
    mount()
    await fireEvent.input(screen.getByLabelText('Charter'), { target: { value: 'Harmonix' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(get(search.advancedCount)).toBe(1))

    await fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    expect((screen.getByLabelText('Charter') as HTMLInputElement).value).toBe('')
    expect(get(search.advancedCount)).toBe(0)
    expect(get(search.advancedDraftCount)).toBe(0)
  })
})

describe('a tag on a chart page, which prefills one field and opens this', () => {
  /**
   * The calling side's sequence, which is what a charter, year, album or genre tag in a chart's
   * metadata does: seed the draft, run it, open the panel. This file mounts the panel the way
   * that arrival mounts it, because Explore is destroyed while a chart page is open and the
   * panel is built fresh from the store on the way back.
   */
  function tagged(field: 'charter' | 'year' | 'album' | 'genre', value: string): void {
    const query = emptyAdvanced()
    query.text[field] = { value, exact: true, exclude: false }
    search.setAdvancedDraft(query)
    search.applyAdvanced()
    search.setAdvancedOpen(true)
  }

  it.each([
    ['charter', 'Charter', 'Harmonix'],
    ['year', 'Year', '1997'],
    ['album', 'Album', 'The Colour and the Shape'],
    ['genre', 'Genre', 'Rock']
  ] as const)('shows the %s tag in its own box, exactly', async (field, label, value) => {
    tagged(field, value)
    mount()

    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value)
    // Exact came with the tag: a tag is the value the chart carries, not a substring of it.
    expect(screen.getByLabelText(`Match ${label} exactly`).getAttribute('aria-pressed')).toBe(
      'true'
    )
    // And the panel opens agreeing with the rows, rather than claiming an unsearched edit.
    expect(screen.queryByText('Not searched yet')).toBeNull()
    await waitFor(() =>
      expect(lastBody()).toEqual({ [field]: { value, exact: true, exclude: false } })
    )
  })

  it('leaves a tag editable once it is on screen', async () => {
    tagged('charter', 'Harmonix')
    mount()

    await fireEvent.click(screen.getByLabelText('Match Charter exactly'))
    expect(screen.getByText('Not searched yet')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() =>
      expect(lastBody()).toEqual({
        charter: { value: 'Harmonix', exact: false, exclude: false }
      })
    )
  })
})
