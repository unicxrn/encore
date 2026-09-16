import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Setlist } from '../../../../shared/setlists'
import {
  createSetlist,
  moveSetlistEntry,
  setlistCount,
  setlists,
  setlistsWith,
  setSetlistEntry
} from './setlists'

const EVERLONG = { name: 'Everlong', artist: 'Foo Fighters', charter: 'Neversoft' }

/** Entries as MAIN stores them: normalised already, which is what the store is handed. */
const list = (
  id: string,
  entries: { name: string; artist?: string; charter?: string }[] = []
): Setlist => ({
  id,
  name: id,
  createdAt: '2026-09-16T00:00:00.000Z',
  entries: entries.map((e) => ({
    name: e.name,
    artist: e.artist ?? '',
    charter: e.charter ?? '',
    addedAt: '2026-09-16T00:00:00.000Z'
  }))
})

beforeEach(() => setlists.set([]))
afterEach(() => vi.unstubAllGlobals())

describe('the setlists store', () => {
  it('counts setlists rather than the charts in them', () => {
    setlists.set([list('a', [{ name: 'A' }, { name: 'B' }]), list('b')])
    expect(get(setlistCount)).toBe(2)
  })
  it('counts nothing before anything is read, which is what the sidebar draws no figure for', () => {
    expect(get(setlistCount)).toBe(0)
  })
  it('names every setlist holding a chart, by what the chart calls itself', () => {
    setlists.set([list('a', [{ ...EVERLONG }]), list('b')])
    expect([...setlistsWith(get(setlists), EVERLONG)]).toEqual(['a'])
  })
  it('reads a chart whose charter carries markup by the text on screen', () => {
    setlists.set([list('a', [{ ...EVERLONG, charter: 'SirMonkfish' }])])
    const marked = { ...EVERLONG, charter: '<color=#8200f3>SirMonkfish</color>' }
    expect(setlistsWith(get(setlists), marked).size).toBe(1)
  })
  it('reads a chart that credits nobody, where the fields arrive as null', () => {
    setlists.set([list('a', [{ name: 'Untitled' }])])
    const nameless = { name: 'Untitled', artist: null, charter: null }
    expect(setlistsWith(get(setlists), nameless).size).toBe(1)
  })
  it('takes the list main answers with rather than applying its own guess', async () => {
    const setlistsCreate = vi.fn().mockResolvedValue([list('a')])
    vi.stubGlobal('window', { encore: { setlistsCreate } })
    await createSetlist('Friday night')
    expect(get(setlists)).toEqual([list('a')])
    expect(setlistsCreate).toHaveBeenCalledWith({ name: 'Friday night' })
  })
  it('hands main the three fields raw, so main decides what gets stored', async () => {
    const setlistsSetEntry = vi.fn().mockResolvedValue([])
    vi.stubGlobal('window', { encore: { setlistsSetEntry } })
    await setSetlistEntry('a', { name: 'Everlong', artist: null }, true)
    expect(setlistsSetEntry).toHaveBeenCalledWith({
      id: 'a',
      name: 'Everlong',
      artist: null,
      charter: null,
      member: true
    })
  })
  it('asks for a move of one place, in the direction it was given', async () => {
    const setlistsMoveEntry = vi.fn().mockResolvedValue([])
    vi.stubGlobal('window', { encore: { setlistsMoveEntry } })
    await moveSetlistEntry('a', { name: 'Everlong', artist: '', charter: '' }, -1)
    expect(setlistsMoveEntry).toHaveBeenCalledWith({
      id: 'a',
      name: 'Everlong',
      artist: '',
      charter: '',
      delta: -1
    })
  })
  it('leaves the list alone when a write fails, rather than half-applying it', async () => {
    setlists.set([list('a')])
    vi.stubGlobal('window', {
      encore: { setlistsSetEntry: vi.fn().mockRejectedValue(new Error('The catalog is closed')) }
    })
    await expect(setSetlistEntry('a', EVERLONG, true)).rejects.toThrow('The catalog is closed')
    expect(get(setlists)).toEqual([list('a')])
  })
})
