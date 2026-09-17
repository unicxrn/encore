import { derived, writable, type Readable, type Writable } from 'svelte/store'
import { favouriteId, favouriteKey, type Favourite } from '../../../../shared/favourites'
import { encore } from './bridge'

/**
 * Every chart the user hearted, as main has it.
 *
 * Module-scoped and loaded once, for the reason the Installed view's filter bar is: App destroys
 * and recreates its views on every navigation, and the rail asks this about a different chart on
 * each one. A component-owned copy would be a `favourites:list` per navigation, and the rail's
 * heart would flicker empty on the way back to a chart the user hearted a second ago.
 *
 * Never written except from an answer main gave. Both channels reply with the whole list, so the
 * renderer never has to reconstruct what main decided to store, and a toggle that fails leaves the
 * list exactly as the last successful call left it rather than half-applied.
 */
export const favourites: Writable<Favourite[]> = writable([])

/**
 * The same list as a set of ids, so "is this chart favourited" is a lookup rather than a scan.
 *
 * Derived rather than maintained: the rail asks this for one chart, but Installed rows and
 * Explore's results are the callers waiting to happen, and a per-chart `.some()` over the list is
 * what turns into a page-sized scan when they arrive.
 */
export const favouriteIds: Readable<Set<string>> = derived(favourites, (list) => {
  const ids = new Set<string>()
  for (const fav of list) ids.add(favouriteId(fav))
  return ids
})

/** Whether the chart these three fields name is one of them. Fields as the chart carries them. */
export function isFavourited(
  ids: Set<string>,
  chart: { name?: string | null; artist?: string | null; charter?: string | null }
): boolean {
  return ids.has(favouriteId(favouriteKey(chart)))
}

/**
 * The list main answered with, or a throw.
 *
 * `favouriteIds` reads three fields off every entry, and it reads them inside a store
 * notification: the rail and the metadata editor hold that subscription while they are mounted.
 * svelte/store's notification queue is module-global and an exception escaping one leaves it
 * non-empty, so every `set` in the renderer afterwards updates its value and tells nobody: the
 * app keeps running, stops redrawing, and reports nothing while `get` goes on answering
 * correctly. Measured in a real engine against the same shape on another store: the window is
 * frozen from that moment with nothing on screen saying so.
 *
 * All four calls below go through this. A toggle already rejects with main's own sentence when
 * main refuses, and an answer that is not a list of favourites is the same kind of failure.
 */
function accept(list: unknown): Favourite[] {
  if (!Array.isArray(list) || list.some((fav) => typeof fav !== 'object' || fav === null))
    throw new Error('Favourites: invalid answer')
  return list as Favourite[]
}

let loaded = false

/**
 * Read the list once per launch.
 *
 * Failures are swallowed on purpose, and this is the one place in the feature where that is the
 * right answer: the list is drawn as an empty heart, which is what an unfavourited chart looks
 * like anyway, and there is no screen a message could go on that the user asked to see. A toggle
 * made afterwards still reports its own failure, where the user is looking at the thing they
 * pressed.
 */
export async function loadFavourites(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    favourites.set(accept(await encore().favouritesList()))
  } catch {
    loaded = false
  }
}

/**
 * Re-read the list, for a screen that has just made main change it behind the store's back.
 *
 * The metadata editor is that screen: a save that renames a chart moves the favourite onto the new
 * details (main/catalog/rekey.ts), and nothing in this store was told. Without this the heart on
 * the rail would keep drawing the chart's old title as the favourited one until the next launch.
 * `reloadSetlists` is the same call for the same reason.
 */
export async function reloadFavourites(): Promise<void> {
  favourites.set(accept(await encore().favouritesList()))
  loaded = true
}

/**
 * Heart a chart, or un-heart it, and keep the store in step with what main stored.
 *
 * Deliberately not optimistic. The write is a single SQLite statement against a file that is
 * already open, so there is nothing to hide behind a guess, and a heart that filled in and then
 * emptied again would be worse than one that waits a frame.
 */
export async function toggleFavourite(
  chart: { name?: string | null; artist?: string | null; charter?: string | null },
  favourite: boolean
): Promise<void> {
  const list = await encore().favouritesSet({
    name: chart.name ?? null,
    artist: chart.artist ?? null,
    charter: chart.charter ?? null,
    favourite
  })
  favourites.set(accept(list))
}
