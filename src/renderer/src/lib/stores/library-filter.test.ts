import { describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
  EMPTY_LIBRARY_FILTER,
  activeFilterCount,
  clearedFilters,
  libraryFilter,
  toCatalogFilter,
  type LibraryFilterState
} from './library-filter'

const state = (overrides: Partial<LibraryFilterState> = {}): LibraryFilterState => ({
  ...EMPTY_LIBRARY_FILTER,
  ...overrides
})

const PAGE = { offset: 0, limit: 100 }

describe('toCatalogFilter', () => {
  it('sends only the search and the page when nothing is set', () => {
    expect(toCatalogFilter(state(), PAGE)).toEqual({ search: '', offset: 0, limit: 100 })
  })

  it('leaves a picker reset to "any" out of the query rather than sending an empty string', () => {
    expect(toCatalogFilter(state({ artist: '', genre: '', charter: '' }), PAGE)).not.toHaveProperty(
      'artist'
    )
  })

  it('passes the picked values through', () => {
    const filter = toCatalogFilter(
      state({ artist: 'Rush', genre: 'Rock', charter: 'Skyline', album: 'Moving' }),
      PAGE
    )
    expect(filter).toMatchObject({
      artist: 'Rush',
      genre: 'Rock',
      charter: 'Skyline',
      album: 'Moving'
    })
  })

  it('trims an album before sending it, and drops one that was only spaces', () => {
    expect(toCatalogFilter(state({ album: '  Powerslave ' }), PAGE).album).toBe('Powerslave')
    expect(toCatalogFilter(state({ album: '   ' }), PAGE)).not.toHaveProperty('album')
  })

  it('converts length bounds from minutes to milliseconds, inclusive at both ends', () => {
    // "up to 4" means up to 4:00 exactly, so a 3:59 chart is in and a 4:01 chart is out.
    const filter = toCatalogFilter(state({ lengthMinMin: '2', lengthMaxMin: '4' }), PAGE)
    expect(filter.lengthMinMs).toBe(120_000)
    expect(filter.lengthMaxMs).toBe(240_000)
  })

  it('accepts one end of a range without the other', () => {
    expect(toCatalogFilter(state({ lengthMinMin: '5' }), PAGE)).not.toHaveProperty('lengthMaxMs')
    expect(toCatalogFilter(state({ yearMax: '1989' }), PAGE)).toMatchObject({ yearMax: 1989 })
  })

  it('ignores a half-typed or negative bound instead of reading it as zero', () => {
    // Mid-edit an input can hold '-' or 'nineteen'. Treating either as 0 applies a bound the
    // user never asked for.
    for (const value of ['-', 'nineteen', '-3']) {
      expect(toCatalogFilter(state({ lengthMinMin: value }), PAGE)).not.toHaveProperty(
        'lengthMinMs'
      )
    }
  })

  it('sends a direction only alongside a sort', () => {
    expect(toCatalogFilter(state({ direction: 'desc' }), PAGE)).not.toHaveProperty('direction')
    expect(toCatalogFilter(state({ sort: 'length', direction: 'desc' }), PAGE)).toMatchObject({
      sort: 'length',
      direction: 'desc'
    })
  })

  it('sends neverPlayed only when it is on', () => {
    expect(toCatalogFilter(state(), PAGE)).not.toHaveProperty('neverPlayed')
    expect(toCatalogFilter(state({ neverPlayed: true }), PAGE).neverPlayed).toBe(true)
  })

  it('carries the page through, which is what makes the sort a whole-library sort', () => {
    expect(toCatalogFilter(state({ sort: 'year' }), { offset: 200, limit: 100 })).toMatchObject({
      offset: 200,
      limit: 100,
      sort: 'year'
    })
  })
})

describe('activeFilterCount', () => {
  it('is zero for an untouched bar', () => {
    expect(activeFilterCount(state())).toBe(0)
  })

  it('counts the search box as a filter', () => {
    expect(activeFilterCount(state({ search: 'rush' }))).toBe(1)
    expect(activeFilterCount(state({ search: '   ' }))).toBe(0)
  })

  it('counts each set control once, including the never-played toggle', () => {
    expect(activeFilterCount(state({ artist: 'Rush', yearMin: '1980', neverPlayed: true }))).toBe(3)
  })

  // A sort takes no charts away, so counting it would offer to clear something that is not
  // hiding anything.
  it('does not count the sort', () => {
    expect(activeFilterCount(state({ sort: 'length', direction: 'desc' }))).toBe(0)
  })
})

describe('clearedFilters', () => {
  it('clears every narrowing control', () => {
    const messy = state({
      search: 'rush',
      artist: 'Rush',
      genre: 'Rock',
      charter: 'Skyline',
      album: 'Moving',
      yearMin: '1980',
      yearMax: '1989',
      lengthMinMin: '2',
      lengthMaxMin: '6',
      neverPlayed: true
    })
    expect(activeFilterCount(clearedFilters(messy))).toBe(0)
  })

  it('keeps the sort, which was not hiding anything', () => {
    const sorted = state({ search: 'rush', sort: 'year', direction: 'desc' })
    expect(clearedFilters(sorted)).toMatchObject({ sort: 'year', direction: 'desc', search: '' })
  })
})

describe('the shared store', () => {
  // Module-scoped for the same reason Explore's search store is: App destroys the Installed
  // view on every navigation and whenever a chart Detail opens.
  it('starts empty and holds what is written to it', () => {
    const before = get(libraryFilter)
    try {
      expect(activeFilterCount(before)).toBe(0)
      libraryFilter.set(state({ artist: 'Rush' }))
      expect(get(libraryFilter).artist).toBe('Rush')
    } finally {
      libraryFilter.set({ ...EMPTY_LIBRARY_FILTER })
    }
  })
})
