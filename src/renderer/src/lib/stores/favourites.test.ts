import { get, writable } from 'svelte/store'
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

/**
 * An answer that is not a list of favourites.
 *
 * `favouriteIds` reads three fields off every entry, inside a store notification the rail holds
 * while it is mounted. svelte/store's notification queue is module-global, so an exception
 * escaping one leaves it non-empty and every `set` in the renderer afterwards notifies nobody:
 * the app keeps running and stops redrawing. The canary at the end is the whole point.
 */
describe('a favourites call answered with something that is not a list', () => {
  const badAnswers: [string, unknown][] = [
    ['nothing at all', undefined],
    ['null', null],
    ['an object', { 0: 'x' }],
    ['a row that is not a favourite', [null]]
  ]
  for (const [what, answer] of badAnswers) {
    it(`refuses ${what} and leaves the list alone`, async () => {
      favourites.set([EVERLONG])
      // The rail holds this while it is mounted, which is what makes the ids run inside the
      // notification rather than on the next read.
      const stop = favouriteIds.subscribe(() => {})
      vi.stubGlobal('window', { encore: { favouritesSet: () => Promise.resolve(answer) } })

      await expect(toggleFavourite({ name: 'Aerials' }, true)).rejects.toThrow('invalid answer')
      expect(get(favourites)).toEqual([EVERLONG])
      stop()

      // One throw inside a notification stops every store in the renderer, this one included.
      const canary = writable(0)
      let heard = 0
      const stopCanary = canary.subscribe((v) => (heard = v))
      canary.set(7)
      stopCanary()
      expect(heard).toBe(7)
    })
  }
})
