import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChartRecord } from '../../../../shared/schemas'
import type { Setlist, SetlistEntry } from '../../../../shared/setlists'
import { get } from 'svelte/store'
import { setlists } from '../stores/setlists'
import Setlists from './Setlists.svelte'

/**
 * The Setlists view.
 *
 * jsdom applies no CSS and computes no layout, so nothing here says anything about how wide the
 * picker strip is, whether a name is clipped or how the rows line up; that is the offscreen
 * measurement in scripts/measure-setlists.mjs. What these pin down is what would be a defect
 * rather than an eyesore:
 *
 *   - the screen says, once, that Clone Hero will not see a setlist,
 *   - an entry whose chart the library does not hold is still drawn, and says which it is,
 *   - the running time counts only what it can actually time, and says so,
 *   - the order on screen is the setlist's order, and the ends of it cannot be moved past,
 *   - a refusal from main is shown where the user pressed.
 */

const entry = (
  name: string,
  over: Partial<{ artist: string; charter: string }> = {}
): SetlistEntry => ({
  name,
  artist: over.artist ?? 'Foo Fighters',
  charter: over.charter ?? 'Neversoft',
  addedAt: '2026-09-16T00:00:00.000Z'
})

const list = (id: string, name: string, names: string[] = []): Setlist => ({
  id,
  name,
  createdAt: '2026-09-16T00:00:00.000Z',
  entries: names.map((n) => entry(n))
})

const record = (path: string, songLength: number | null): ChartRecord =>
  ({ path, chartType: 'folder', songLength }) as unknown as ChartRecord

function stubBridge(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    // The view re-reads on mount, so main's answer has to be what the store already holds or the
    // read would wipe the fixture out from under the assertions.
    setlistsList: vi.fn().mockImplementation(async () => get(setlists)),
    setlistsCharts: vi.fn().mockResolvedValue([]),
    ...over
  }
  // `encore` and not `window`: replacing the whole of `window` takes `document` with it, and
  // testing-library has nothing left to query.
  vi.stubGlobal('encore', api)
  return api as Record<string, ReturnType<typeof vi.fn>>
}

beforeEach(() => setlists.set([]))
afterEach(() => {
  vi.unstubAllGlobals()
  setlists.set([])
})

describe('Setlists: what the screen says a setlist is', () => {
  it('says Clone Hero will not see it, and that nothing on disk moves', async () => {
    stubBridge()
    render(Setlists)
    const note = await screen.findByText(/Clone Hero groups charts by the folders/)
    expect(note.textContent).toContain('nothing here moves a file')
  })

  it('says it once, not on every row', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong', 'Painkiller'])])
    stubBridge()
    render(Setlists)
    await waitFor(() => expect(screen.getAllByText(/Clone Hero groups charts/)).toHaveLength(1))
  })

  it('points a user with no setlists at where charts are added from', async () => {
    stubBridge()
    render(Setlists)
    expect(await screen.findByText(/You have no setlists yet/)).toBeTruthy()
  })
})

describe('Setlists: the open setlist', () => {
  it('opens the first one and draws its charts in its own order', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong', 'Painkiller']), list('b', 'Encores')])
    stubBridge()
    render(Setlists)
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll('.s-list .s-name')]
      expect(found).toHaveLength(2)
      return found
    })
    expect(rows.map((r) => r.textContent)).toEqual(['Everlong', 'Painkiller'])
  })

  it('counts the charts on each setlist in the picker, and draws none for an empty one', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong']), list('b', 'Encores')])
    stubBridge()
    render(Setlists)
    const tabs = await waitFor(() => {
      const found = [...document.querySelectorAll('.s-picker .s-tab')]
      expect(found).toHaveLength(2)
      return found
    })
    expect(tabs[0].querySelector('.s-tab-count')?.textContent).toBe('1')
    expect(tabs[1].querySelector('.s-tab-count')).toBeNull()
  })

  it('switches to the setlist that was picked', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong']), list('b', 'Encores', ['Painkiller'])])
    stubBridge()
    render(Setlists)
    await fireEvent.click(await screen.findByRole('button', { name: /Encores/ }))
    await waitFor(() =>
      expect([...document.querySelectorAll('.s-name')].map((r) => r.textContent)).toEqual([
        'Painkiller'
      ])
    )
  })
})

describe('Setlists: a chart the library does not hold', () => {
  it('still draws the entry, and says which one is missing', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong', 'Painkiller'])])
    stubBridge({
      setlistsCharts: vi.fn().mockResolvedValue([record('/lib/Everlong', 200_000), null])
    })
    render(Setlists)
    await waitFor(() => expect(screen.getAllByText('Not in your library')).toHaveLength(1))
    expect([...document.querySelectorAll('.s-name')].map((r) => r.textContent)).toEqual([
      'Everlong',
      'Painkiller'
    ])
  })

  it('says how many are missing and times only the ones it can', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong', 'Painkiller'])])
    stubBridge({
      setlistsCharts: vi.fn().mockResolvedValue([record('/lib/Everlong', 250_000), null])
    })
    render(Setlists)
    const summary = await waitFor(() => {
      const el = document.querySelector('.s-summary')
      expect(el?.textContent).toContain('not in your library')
      return el
    })
    expect(summary?.textContent).toContain('2 charts')
    expect(summary?.textContent).toContain('1 not in your library')
    expect(summary?.textContent).toContain('that are timed')
  })

  // A chart the scanner never recorded a length for. A total that quietly counted it as zero
  // would be a running time that is wrong rather than one that is partial.
  it('draws a dash rather than a zero for a chart with no length', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong'])])
    stubBridge({ setlistsCharts: vi.fn().mockResolvedValue([record('/lib/Everlong', null)]) })
    render(Setlists)
    await waitFor(() => expect(document.querySelector('.s-len')?.textContent).toBe('—'))
  })

  it('offers no preview for an entry with no chart behind it', async () => {
    setlists.set([list('a', 'Friday night', ['Painkiller'])])
    stubBridge({ setlistsCharts: vi.fn().mockResolvedValue([null]) })
    render(Setlists)
    await screen.findByText('Not in your library')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  })

  it('hands a chart the library holds to the rail', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong'])])
    stubBridge({ setlistsCharts: vi.fn().mockResolvedValue([record('/lib/Everlong', 200_000)]) })
    const onSelectChart = vi.fn()
    render(Setlists, { props: { onSelectChart } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    expect(onSelectChart).toHaveBeenCalledWith({
      kind: 'local',
      record: record('/lib/Everlong', 200_000)
    })
  })
})

describe('Setlists: editing', () => {
  it('cannot move the first entry up or the last one down', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong', 'Painkiller'])])
    stubBridge()
    render(Setlists)
    const up = await screen.findByRole('button', { name: 'Move Everlong up' })
    expect((up as HTMLButtonElement).disabled).toBe(true)
    const down = screen.getByRole('button', { name: 'Move Painkiller down' })
    expect((down as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Move Everlong down' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('asks main to move one place in the direction pressed', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong', 'Painkiller'])])
    const api = stubBridge({ setlistsMoveEntry: vi.fn().mockResolvedValue([]) })
    render(Setlists)
    await fireEvent.click(await screen.findByRole('button', { name: 'Move Painkiller up' }))
    expect(api.setlistsMoveEntry).toHaveBeenCalledWith({
      id: 'a',
      name: 'Painkiller',
      artist: 'Foo Fighters',
      charter: 'Neversoft',
      delta: -1
    })
  })

  it('takes a chart out of the setlist without touching the chart', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong'])])
    const api = stubBridge({ setlistsSetEntry: vi.fn().mockResolvedValue([]) })
    render(Setlists)
    const out = await screen.findByRole('button', { name: 'Take Everlong out of Friday night' })
    await fireEvent.click(out)
    expect(api.setlistsSetEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', name: 'Everlong', member: false })
    )
  })

  it('creates a setlist by the name that was typed', async () => {
    const api = stubBridge({ setlistsCreate: vi.fn().mockResolvedValue([]) })
    render(Setlists)
    const box = await screen.findByLabelText('New setlist')
    await fireEvent.input(box, { target: { value: 'Friday night' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(api.setlistsCreate).toHaveBeenCalledWith({ name: 'Friday night' })
  })

  it('will not create one with no name', async () => {
    stubBridge()
    render(Setlists)
    await screen.findByLabelText('New setlist')
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
      true
    )
  })

  // A delete asks twice and says what it is and is not taking, because the button under it is the
  // only thing between a typed name plus an ordered list and nothing.
  it('asks before deleting, and says the charts stay', async () => {
    setlists.set([list('a', 'Friday night', ['Everlong'])])
    const api = stubBridge({ setlistsDelete: vi.fn().mockResolvedValue([]) })
    render(Setlists)
    await fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(api.setlistsDelete).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: /Delete Friday night, charts stay/ })
    await fireEvent.click(confirm)
    expect(api.setlistsDelete).toHaveBeenCalledWith({ id: 'a' })
  })

  it('renames the open setlist', async () => {
    setlists.set([list('a', 'Friday night')])
    const api = stubBridge({ setlistsRename: vi.fn().mockResolvedValue([]) })
    render(Setlists)
    await fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))
    const box = screen.getByLabelText('Rename')
    await fireEvent.input(box, { target: { value: 'Saturday night' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.setlistsRename).toHaveBeenCalledWith({ id: 'a', name: 'Saturday night' })
  })

  it("shows main's refusal where the user pressed, rather than swallowing it", async () => {
    stubBridge({
      setlistsCreate: vi.fn().mockRejectedValue(new Error('You already have a setlist called F.'))
    })
    render(Setlists)
    const box = await screen.findByLabelText('New setlist')
    await fireEvent.input(box, { target: { value: 'F' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You already have a setlist called F.'
    )
  })

  it('says so when the list itself could not be read, rather than claiming there are none', async () => {
    stubBridge({ setlistsList: vi.fn().mockRejectedValue(new Error('The catalog is closed')) })
    render(Setlists)
    expect((await screen.findByRole('alert')).textContent).toContain('The catalog is closed')
  })
})
