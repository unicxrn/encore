import { get, writable } from 'svelte/store'
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

/**
 * An answer that is not a list of setlists.
 *
 * `setlistCount` reads `.length` off whatever this store holds, and the sidebar holds that
 * subscription for the life of the launch, so the read runs inside a store notification.
 * svelte/store's notification queue is module-global, so an exception escaping one leaves it
 * non-empty and every `set` in the renderer afterwards notifies nobody: the app keeps running and
 * stops redrawing. The canary at the end is the whole point.
 */
describe('a setlists call answered with something that is not a list', () => {
  const badAnswers: [string, unknown][] = [
    ['nothing at all', undefined],
    ['null', null],
    ['an object', { 0: 'x' }]
  ]
  for (const [what, answer] of badAnswers) {
    it(`refuses ${what} and leaves the list alone`, async () => {
      setlists.set([list('a'), list('b')])
      // The sidebar holds this for the life of the launch, which is what makes the count run
      // inside the notification rather than on the next read.
      const stop = setlistCount.subscribe(() => {})
      vi.stubGlobal('window', { encore: { setlistsCreate: () => Promise.resolve(answer) } })

      await expect(createSetlist('c')).rejects.toThrow('invalid answer')
      expect(get(setlistCount)).toBe(2)
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
