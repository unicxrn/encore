import { describe, expect, it } from 'vitest'
import { chartKey, chartKeyId, namesAChart, sameChart } from './chart-key'
import { favouriteId, favouriteKey, isFavouritable } from './favourites'
import { canJoinASetlist, setlistEntryId, setlistEntryKey } from './setlists'

/**
 * The one definition of what makes two charts the same chart.
 *
 * Three features asked this question in one release and two of them spelled it differently, so
 * what these pin down first is that there is now one function and the other names are aliases onto
 * it, not copies of it. The SQL half is in main/catalog/queries.test.ts, where the same markup case
 * is put through Hide owned, the badge, a favourite and a setlist.
 */
describe('chartKey', () => {
  it('strips the markup Clone Hero renders and nobody can see', () => {
    expect(
      chartKey({
        name: '<color=#8200f3>Everlong</color>',
        artist: 'Foo Fighters',
        charter: '<b>SirMonkfish</b>'
      })
    ).toEqual({ name: 'Everlong', artist: 'Foo Fighters', charter: 'SirMonkfish' })
  })

  it('is idempotent, which is what lets main normalise at the door of every lookup', () => {
    const once = chartKey({ name: '<i>YYZ</i>', artist: null, charter: 'Harmonix' })
    expect(chartKey(once)).toEqual(once)
  })

  it('reads a missing field as the empty string, never as null', () => {
    expect(chartKey({ name: 'YYZ' })).toEqual({ name: 'YYZ', artist: '', charter: '' })
  })

  it('leaves an angle bracket that is not a tag Clone Hero renders', () => {
    // stripRichText's allowlist, deliberately stricter than the lyric path's catch-all: a name is
    // an identifier and a wrong drop silently renames someone's chart.
    expect(chartKey({ name: 'Rock <3 Roll' }).name).toBe('Rock <3 Roll')
  })
})

describe('namesAChart', () => {
  it('refuses a key with no name, because the only name it could take is a folder name', () => {
    expect(namesAChart(chartKey({ name: '', artist: 'Rush' }))).toBe(false)
    expect(namesAChart(chartKey({ name: '<color=red></color>', artist: 'Rush' }))).toBe(false)
  })

  it('accepts a chart that credits nobody', () => {
    expect(namesAChart(chartKey({ name: 'YYZ' }))).toBe(true)
  })
})

describe('chartKeyId', () => {
  it('folds A-Z and nothing else, matching SQLite NOCASE', () => {
    expect(chartKeyId(chartKey({ name: 'YYZ' }))).toBe(chartKeyId(chartKey({ name: 'yyz' })))
    // toLowerCase() folds these two and NOCASE does not, so a title carrying either would read as
    // favourited on one side of the IPC boundary and not on the other.
    expect(chartKeyId(chartKey({ name: 'İ' }))).not.toBe(chartKeyId(chartKey({ name: 'i̇' })))
    expect(chartKeyId(chartKey({ name: 'ẞ' }))).not.toBe(chartKeyId(chartKey({ name: 'ß' })))
  })

  it('cannot let one combination of the three spell the id of another', () => {
    expect(chartKeyId({ name: 'a', artist: 'b', charter: '' })).not.toBe(
      chartKeyId({ name: 'a', artist: '', charter: 'b' })
    )
  })
})

describe('sameChart', () => {
  it('ignores case and markup, which is what every comparison of these rows ignores', () => {
    expect(
      sameChart(
        chartKey({ name: '<b>YYZ</b>', artist: 'Rush' }),
        chartKey({ name: 'yyz', artist: 'RUSH' })
      )
    ).toBe(true)
  })

  it('separates the same song charted by two people', () => {
    expect(
      sameChart(chartKey({ name: 'YYZ', charter: 'A' }), chartKey({ name: 'YYZ', charter: 'B' }))
    ).toBe(false)
  })
})

/**
 * The aliases, held to being the same function rather than the same behaviour.
 *
 * Identity rather than equivalence on purpose: two functions that agree today are two functions
 * that can stop agreeing, and the defect this module exists to close was exactly that.
 */
describe('the favourite and setlist names for it', () => {
  it('are these functions, not second copies of their rules', () => {
    expect(favouriteKey).toBe(chartKey)
    expect(favouriteId).toBe(chartKeyId)
    expect(isFavouritable).toBe(namesAChart)
    expect(setlistEntryKey).toBe(chartKey)
    expect(setlistEntryId).toBe(chartKeyId)
    expect(canJoinASetlist).toBe(namesAChart)
  })
})
