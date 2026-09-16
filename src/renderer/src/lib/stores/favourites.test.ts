import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { favouriteIds, favourites, isFavourited, toggleFavourite } from './favourites'

const EVERLONG = {
  name: 'Everlong',
  artist: 'Foo Fighters',
  charter: 'Neversoft',
  addedAt: '2026-09-16T00:00:00.000Z'
}

beforeEach(() => favourites.set([]))
afterEach(() => vi.unstubAllGlobals())

describe('the favourites store', () => {
  it('answers whether a chart is one of them, by what the chart calls itself', () => {
    favourites.set([EVERLONG])
    expect(isFavourited(get(favouriteIds), EVERLONG)).toBe(true)
    expect(isFavourited(get(favouriteIds), { ...EVERLONG, charter: 'CCC' })).toBe(false)
  })

  it('reads a chart whose name carries markup by the text on screen', () => {
    favourites.set([{ ...EVERLONG, charter: 'SirMonkfish' }])
    expect(
      isFavourited(get(favouriteIds), {
        ...EVERLONG,
        charter: '<color=#8200f3>SirMonkfish</color>'
      })
    ).toBe(true)
  })

  it('reads a chart that credits nobody, where the fields arrive as null', () => {
    favourites.set([{ name: 'Untitled', artist: '', charter: '', addedAt: 'now' }])
    expect(isFavourited(get(favouriteIds), { name: 'Untitled', artist: null, charter: null })).toBe(
      true
    )
  })

  it('takes the list main answers with rather than applying its own guess', async () => {
    const favouritesSet = vi.fn().mockResolvedValue([EVERLONG])
    // `window`, not `encore`: this file runs in the node project, where the renderer's bridge is
    // the only thing standing in for a preload.
    vi.stubGlobal('window', { encore: { favouritesSet } })
    await toggleFavourite({ name: 'Everlong', artist: 'Foo Fighters', charter: 'Neversoft' }, true)
    expect(get(favourites)).toEqual([EVERLONG])
    expect(favouritesSet).toHaveBeenCalledWith({
      name: 'Everlong',
      artist: 'Foo Fighters',
      charter: 'Neversoft',
      favourite: true
    })
  })

  it('leaves the list alone when the write fails, rather than half-applying it', async () => {
    favourites.set([EVERLONG])
    vi.stubGlobal('window', {
      encore: { favouritesSet: vi.fn().mockRejectedValue(new Error('The catalog is closed')) }
    })
    await expect(toggleFavourite(EVERLONG, false)).rejects.toThrow('The catalog is closed')
    expect(get(favourites)).toEqual([EVERLONG])
  })
})
