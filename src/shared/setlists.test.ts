import { describe, expect, it } from 'vitest'
import { favouriteId, favouriteKey } from './favourites'
import {
  SETLISTS_ARE_ENCORES,
  SETLIST_NAME_MAX,
  canJoinASetlist,
  isValidSetlistName,
  setlistEntryId,
  setlistEntryKey,
  setlistName,
  setlistsHolding,
  type Setlist
} from './setlists'

const entry = (name: string, artist = '', charter = ''): ReturnType<typeof setlistEntryKey> => ({
  ...setlistEntryKey({ name, artist, charter })
})

const list = (
  id: string,
  entries: { name: string; artist?: string; charter?: string }[]
): Setlist => ({
  id,
  name: id,
  createdAt: '2026-09-16T00:00:00.000Z',
  entries: entries.map((e) => ({ ...setlistEntryKey(e), addedAt: '2026-09-16T00:00:00.000Z' }))
})

describe('the key a setlist entry names a chart by', () => {
  // The whole point of the aliases. Two rules would let one chart be in a setlist on one screen
  // and out of it on another, which is the failure the shared key exists to make impossible.
  it('is the same function a favourite is keyed by, not a second copy of its rules', () => {
    expect(setlistEntryKey).toBe(favouriteKey)
    expect(setlistEntryId).toBe(favouriteId)
  })
  it('strips the markup, so an entry names the chart as it reads on screen', () => {
    expect(setlistEntryKey({ name: '<color=#ff0000>Red</color>' }).name).toBe('Red')
  })
  it('reads two spellings of one chart as one entry', () => {
    expect(setlistEntryId(entry('EVERLONG', 'FOO FIGHTERS'))).toBe(
      setlistEntryId(entry('everlong', 'foo fighters'))
    )
  })
  it('tells the same song by two charters apart, which is what a setlist needs', () => {
    expect(setlistEntryId(entry('Everlong', 'Foo Fighters', 'CCC'))).not.toBe(
      setlistEntryId(entry('Everlong', 'Foo Fighters', 'Neversoft'))
    )
  })
  it('refuses a chart with no name of its own, exactly as the heart does', () => {
    expect(canJoinASetlist(setlistEntryKey({ name: 'Everlong' }))).toBe(true)
    expect(canJoinASetlist(setlistEntryKey({ artist: 'Foo Fighters' }))).toBe(false)
  })
})

describe('a setlist name', () => {
  it('loses its outer whitespace', () => {
    expect(setlistName('  Friday night  ')).toBe('Friday night')
  })
  it('collapses inner runs, so two spellings of the same words are one name', () => {
    expect(setlistName('Friday\t\tnight')).toBe('Friday night')
    expect(setlistName('Friday  night')).toBe(setlistName('Friday night'))
  })
  it('is refused when it collapses to nothing', () => {
    expect(isValidSetlistName(setlistName('   '))).toBe(false)
  })
  it('is measured after collapsing, not before', () => {
    const wide = `${'a'.repeat(SETLIST_NAME_MAX)}${'  '.repeat(20)}`
    expect(isValidSetlistName(setlistName(wide))).toBe(true)
    expect(isValidSetlistName(setlistName('a'.repeat(SETLIST_NAME_MAX + 1)))).toBe(false)
  })
})

describe('setlistsHolding', () => {
  it('names every setlist a chart is in, which is more than one', () => {
    const lists = [list('a', [{ name: 'Everlong' }]), list('b', [{ name: 'Everlong' }])]
    expect([...setlistsHolding(lists, entry('Everlong'))]).toEqual(['a', 'b'])
  })
  it('is empty for a chart no setlist holds', () => {
    expect(setlistsHolding([list('a', [{ name: 'Everlong' }])], entry('Painkiller')).size).toBe(0)
  })
  it('matches by the chart rather than by its capitals', () => {
    expect(setlistsHolding([list('a', [{ name: 'Everlong' }])], entry('EVERLONG')).size).toBe(1)
  })
  it('tells two charters of one song apart inside a single setlist', () => {
    const lists = [
      list('a', [
        { name: 'Everlong', charter: 'CCC' },
        { name: 'Everlong', charter: 'Neversoft' }
      ])
    ]
    expect(setlistsHolding(lists, entry('Everlong', '', 'CCC')).size).toBe(1)
    expect(setlistsHolding(lists, entry('Everlong', '', 'Harmonix')).size).toBe(0)
  })
})

describe('what the app says a setlist is', () => {
  // The claim is checked in the module comment against scan-chart, the .sng fixture and the score
  // folder. This pins that the app still SAYS it: a sentence that quietly loses the part about the
  // game is the defect the whole check exists to prevent.
  it('says the game will not see it, and that nothing on disk moves', () => {
    expect(SETLISTS_ARE_ENCORES).toMatch(/Clone Hero/)
    expect(SETLISTS_ARE_ENCORES).toMatch(/folders/)
    expect(SETLISTS_ARE_ENCORES).toMatch(/nothing here moves a file/)
  })
  it('carries none of the punctuation this codebase strips', () => {
    expect(SETLISTS_ARE_ENCORES).not.toMatch(/[—–“”‘’]/)
  })
})
