import { describe, expect, it } from 'vitest'
import { favouriteId, favouriteKey, isFavouritable } from './favourites'
import { EIGHT_TAG_CHARTER, EIGHT_TAG_CHARTER_TEXT } from '../../test/helpers/marked-up-names'

describe('favouriteKey', () => {
  it('keeps the three fields a chart names itself by', () => {
    expect(
      favouriteKey({ name: 'Everlong', artist: 'Foo Fighters', charter: 'Neversoft' })
    ).toEqual({ name: 'Everlong', artist: 'Foo Fighters', charter: 'Neversoft' })
  })
  it('strips the markup, so the key is the chart as it reads on screen', () => {
    expect(favouriteKey({ charter: EIGHT_TAG_CHARTER }).charter).toBe(EIGHT_TAG_CHARTER_TEXT)
  })
  it('reads an absent field as nobody rather than as null', () => {
    // '' and not null: this is half of the rule the SQL join keeps on the other side, where a
    // NULL column compares equal to nothing at all, its own value included.
    expect(favouriteKey({ name: 'Everlong' })).toEqual({
      name: 'Everlong',
      artist: '',
      charter: ''
    })
    expect(favouriteKey({ name: 'Everlong', artist: null, charter: undefined }).artist).toBe('')
  })
})

describe('isFavouritable', () => {
  it('accepts a chart that names itself, with or without an artist and a charter', () => {
    expect(isFavouritable(favouriteKey({ name: 'Everlong' }))).toBe(true)
  })
  it('refuses a chart with no name of its own', () => {
    expect(isFavouritable(favouriteKey({ artist: 'Foo Fighters', charter: 'Neversoft' }))).toBe(
      false
    )
  })
  it('refuses a name that is nothing but markup, which is the same case once stripped', () => {
    expect(isFavouritable(favouriteKey({ name: '<color=#ff0000></color>' }))).toBe(false)
  })
})

describe('favouriteId', () => {
  it('reads two spellings of one chart as one favourite', () => {
    expect(favouriteId(favouriteKey({ name: 'EVERLONG', charter: 'Neversoft' }))).toBe(
      favouriteId(favouriteKey({ name: 'everlong', charter: 'neversoft' }))
    )
  })
  it('folds A-Z and nothing else, which is what SQLite NOCASE does', () => {
    // The case this pins is the one that would drift: `toLowerCase()` folds these two and NOCASE
    // does not, so an id built with it would call a chart favourited that the catalog's own
    // PRIMARY KEY considers a different row.
    expect(favouriteId(favouriteKey({ name: 'İ' }))).not.toBe(
      favouriteId(favouriteKey({ name: 'i' }))
    )
    expect(favouriteId(favouriteKey({ name: 'ẞ' }))).not.toBe(
      favouriteId(favouriteKey({ name: 'ß' }))
    )
  })
  it('tells the same song by two charters apart', () => {
    expect(favouriteId(favouriteKey({ name: 'Everlong', charter: 'A' }))).not.toBe(
      favouriteId(favouriteKey({ name: 'Everlong', charter: 'B' }))
    )
  })
  it('cannot be spelled by another chart moving text between the fields', () => {
    // The separator is the whole of this: joined on nothing, "Ever" by "long" and "Everlong" by
    // nobody would be one id.
    expect(favouriteId(favouriteKey({ name: 'Ever', artist: 'long' }))).not.toBe(
      favouriteId(favouriteKey({ name: 'Everlong' }))
    )
  })
})
