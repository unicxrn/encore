import { derived, writable, type Readable, type Writable } from 'svelte/store'
import {
  setlistEntryKey,
  setlistsHolding,
  type Setlist,
  type SetlistEntryKey
} from '../../../../shared/setlists'
import { encore } from './bridge'

/** The three fields a chart names itself by, as whatever screen is asking carries them. */
export type ChartNames = { name?: string | null; artist?: string | null; charter?: string | null }

/**
 * Every setlist the user built, entries included, as main has it.
 *
 * Module-scoped and loaded once, for the reasons the favourites store is: App destroys and
 * recreates its views on every navigation, the rail asks which setlists hold a different chart on
 * each one, and the sidebar draws how many there are the whole time. A component-owned copy would
 * be a `setlists:list` per navigation and a count that blinked out between views.
 *
 * Never written except from an answer main gave. Every channel replies with the whole list, so a
 * write that fails leaves this exactly as the last successful one left it rather than half-applied.
 */
export const setlists: Writable<Setlist[]> = writable([])

/**
 * How many setlists there are, which is what the sidebar row draws.
 *
 * Costs one property read per render and no IPC at all: the list is already in memory for the rail
 * and this is a second reader of it, the same arrangement the Downloads count has with the queue.
 * It is a count of SETLISTS and not of the charts in them, because the row names the destination
 * rather than its contents, and because a user with four setlists holding 300 charts between them
 * is told something useless by "300".
 */
export const setlistCount: Readable<number> = derived(setlists, (list) => list.length)

/** The ids of the setlists holding this chart. Fields as the chart carries them. */
export function setlistsWith(list: Setlist[], chart: ChartNames): Set<string> {
  return setlistsHolding(list, setlistEntryKey(chart))
}

let loaded = false

/**
 * Read the list once per launch.
 *
 * Unlike the favourites store, a failure here is NOT swallowed silently by the caller that shows
 * it: the sidebar's count simply stays absent, which is what it draws for zero anyway, but the
 * Setlists view asks again on mount and reports what went wrong, because an empty list there would
 * claim the user has no setlists rather than that Encore could not read them.
 */
export async function loadSetlists(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    setlists.set(await encore().setlistsList())
  } catch (err) {
    loaded = false
    throw err
  }
}

/** Re-read the list, for a screen that wants to know it is looking at what main has. */
export async function reloadSetlists(): Promise<void> {
  setlists.set(await encore().setlistsList())
  loaded = true
}

/**
 * The five writes.
 *
 * Deliberately not optimistic, for the reason the heart is not: each is a handful of statements
 * against a file that is already open, so there is nothing to hide behind a guess, and a row that
 * appeared and then vanished again would be worse than one that waits a frame. Each rejects with
 * main's own sentence when main refuses, and the caller puts that sentence where the press was.
 */
export async function createSetlist(name: string): Promise<void> {
  setlists.set(await encore().setlistsCreate({ name }))
}

export async function renameSetlist(id: string, name: string): Promise<void> {
  setlists.set(await encore().setlistsRename({ id, name }))
}

export async function deleteSetlist(id: string): Promise<void> {
  setlists.set(await encore().setlistsDelete({ id }))
}

export async function setSetlistEntry(
  id: string,
  chart: ChartNames,
  member: boolean
): Promise<void> {
  setlists.set(
    await encore().setlistsSetEntry({
      id,
      name: chart.name ?? null,
      artist: chart.artist ?? null,
      charter: chart.charter ?? null,
      member
    })
  )
}

export async function moveSetlistEntry(
  id: string,
  chart: SetlistEntryKey,
  delta: -1 | 1
): Promise<void> {
  setlists.set(
    await encore().setlistsMoveEntry({
      id,
      name: chart.name,
      artist: chart.artist,
      charter: chart.charter,
      delta
    })
  )
}
