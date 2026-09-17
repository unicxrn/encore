import { describe, expect, it } from 'vitest'
import {
  chartKey,
  chartKeyId,
  chartListsPhrase,
  describeChartListMove,
  namesAChart,
  sameChart,
  type ChartListMove
} from './chart-key'
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

const MOVE: ChartListMove = {
  from: { name: 'YYZ', artist: 'Rush', charter: 'Harmonix' },
  to: { name: 'YYZ', artist: 'RUSH (Canada)', charter: 'Harmonix' },
  favourite: false,
  setlists: [],
  oldKeyKept: false,
  stranded: false,
  merged: false
}

describe('describeChartListMove', () => {
  it('says nothing when nothing moved', () => {
    expect(describeChartListMove(null)).toBeNull()
    expect(describeChartListMove(undefined)).toBeNull()
    // The key moved but the chart was on no list, which is the same non-event to a reader.
    expect(describeChartListMove(MOVE)).toBeNull()
  })

  it('names the favourite and the setlists it moved', () => {
    expect(describeChartListMove({ ...MOVE, favourite: true })).toBe(
      'Encore moved this chart in your favourites to match.'
    )
    expect(describeChartListMove({ ...MOVE, setlists: ['Friday night'] })).toBe(
      'Encore moved this chart in the setlist "Friday night" to match.'
    )
    expect(
      describeChartListMove({ ...MOVE, favourite: true, setlists: ['Friday night', 'Warm up'] })
    ).toBe('Encore moved this chart in your favourites and 2 setlists to match.')
  })

  it('says a second copy kept the old details, so the old rows are still there', () => {
    const line = describeChartListMove({ ...MOVE, favourite: true, oldKeyKept: true })
    expect(line).toContain('added the new details to your favourites')
    expect(line).toContain('still says "YYZ"')
  })

  it('says the two became one when the new details already carried a favourite', () => {
    expect(describeChartListMove({ ...MOVE, favourite: true, merged: true })).toContain(
      'the two are now one'
    )
  })

  it('says where the rows stayed when the title was cleared, and how to get them back', () => {
    const line = describeChartListMove({
      ...MOVE,
      to: { name: '', artist: 'Rush', charter: 'Harmonix' },
      favourite: true,
      stranded: true
    })
    expect(line).toContain('no title now')
    expect(line).toContain('"YYZ"')
    expect(line).toContain('Typing the title back')
  })

  it('agrees its verb with the subject, which is not the same as with the count', () => {
    // "your favourites" is one row and a plural subject; one setlist is the other way round.
    expect(describeChartListMove({ ...MOVE, favourite: true, stranded: true })).toContain(
      'your favourites still name'
    )
    expect(
      describeChartListMove({ ...MOVE, setlists: ['Friday night'], stranded: true })
    ).toContain('the setlist "Friday night" still names')
  })
})

describe('chartListsPhrase', () => {
  it('is null for a chart on no list', () => {
    expect(chartListsPhrase(false, [])).toBeNull()
  })

  it('is what the editor says before a save and what the move says after one', () => {
    expect(chartListsPhrase(true, ['Friday night', 'Warm up'])).toBe(
      'your favourites and 2 setlists'
    )
    expect(
      describeChartListMove({ ...MOVE, favourite: true, setlists: ['Friday night', 'Warm up'] })
    ).toContain('your favourites and 2 setlists')
  })
})
