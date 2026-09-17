import { chartKey, chartKeyId, namesAChart, type ChartKey } from './chart-key'

/**
 * What a setlist is, and the one thing it is not.
 *
 * **Clone Hero has no setlist Encore could write to.** That was checked rather than assumed, and
 * the check is worth recording because a user who builds a setlist here and then cannot find it in
 * the game will reasonably call it broken:
 *
 * - scan-chart reads the whole `[Song]` section of `song.ini`, and the only key in it that touches
 *   grouping is `playlist_track`. That is an ORDINAL and nothing else: it says a chart is fourth in
 *   its setlist and never says which setlist, so it cannot name one and cannot create one. Encore
 *   stores it (`charts.playlistTrack`) and the chart page prints it.
 * - There is no setlist file in the format. The one `setlist.ini` in this repository is an
 *   arbitrary extra file in a `.sng` packing fixture, there to prove unrelated bytes survive a
 *   repack.
 * - Nothing in Clone Hero's own data folder holds one either. Encore reads `scoredata.bin`,
 *   `scoresext.bin`, `scorestats.json`, `settings.ini` and `songcache.bin`, and none of the five
 *   is a playlist.
 * - `packName` is a Chorus Encore API field, not a chart's. It was null across a 100-chart sample
 *   (see `badgesFor` in Browse.svelte), so it names nothing on the user's disk.
 *
 * What the game actually groups by is the folder tree, and the only way to make it see a setlist
 * would be to move or copy chart files into a folder per setlist. Encore will not: the catalog is
 * keyed on `charts.path`, so moving files rewrites every row that names one, and copying duplicates
 * gigabytes to say something a list of names already says. So a setlist is Encore's own thing, and
 * `SETLISTS_ARE_ENCORES` below is the app saying so, once, on the screen that holds them.
 */
export const SETLISTS_ARE_ENCORES =
  'Setlists live in Encore. Clone Hero groups charts by the folders they sit in and has no ' +
  'setlist of its own to write to, so nothing here moves a file, renames a folder or reaches ' +
  'the game. What a setlist is for is reading: the order you meant to play in, and how long it runs.'

/**
 * Which chart a setlist entry names: the song, the artist and the charter, as a reader sees them.
 *
 * `ChartKey`, under the name this caller knows it by. `shared/chart-key.ts` argues the choice of
 * the readable text over the raw, and `shared/favourites.ts` argues the three fields against the
 * path, `cloneHeroChecksum` and `getChartHash`; every word of both holds here. A setlist has to
 * survive a folder reorganisation, a re-download of a newer version, and a catalog rebuilt from
 * nothing, and it has to be storable for a chart on Chorus that has not been downloaded yet.
 *
 * Calling the same functions is the part that matters. If a setlist folded case one way and a
 * heart another, one chart could be in a setlist and not in it depending on which screen asked, and
 * `catalog:exists-by-meta` would be a third answer again. It was a third answer once, over the raw
 * `song.ini` text rather than the readable form these store; `shared/chart-key.ts` is the reconcile.
 * There is one rule and these are aliases onto it, named for the caller rather than restated for it.
 */
export type SetlistEntryKey = ChartKey
export const setlistEntryKey = chartKey
export const setlistEntryId = chartKeyId

/**
 * Whether this key names a chart a setlist can hold.
 *
 * Refused for exactly the case the heart refuses: a chart whose `song.ini` sets no name is drawn
 * from its folder name, which is a display fallback and not an identity. Two unnamed charts in two
 * folders would be one entry between them and renaming a folder would move it. The metadata editor
 * is the way out, and it is the same way out the heart points at.
 */
export const canJoinASetlist = namesAChart

/** A chart in a setlist: which chart, and when it went in. Position is the array's own order. */
export interface SetlistEntry extends SetlistEntryKey {
  /** ISO 8601. Kept so an entry can say how long it has been on the list; never the sort key. */
  addedAt: string
}

/**
 * One setlist, entries included.
 *
 * Entries travel with the setlist rather than being asked for per setlist, because the whole table
 * is a few short strings per chart on a list a person is meant to read: a setlist long enough for
 * that to cost anything is one nobody could play. The renderer holds the lot and answers "is this
 * chart in that setlist" without a round trip, exactly as the favourites store does.
 *
 * `id` is opaque and generated in main. It is deliberately NOT the name: renaming a setlist must
 * not detach its entries, and two setlists are two setlists even while one is still called
 * "Untitled".
 */
export interface Setlist {
  id: string
  name: string
  /** ISO 8601. The list's own order, oldest first, so a new setlist appears at the bottom. */
  createdAt: string
  /** In the order the user put them in. `position` is not exposed: the array IS the position. */
  entries: SetlistEntry[]
}

/** The longest name a setlist may carry. Past this the sidebar's column and the view's rows lie. */
export const SETLIST_NAME_MAX = 60

/**
 * A name as it will be stored: outer whitespace gone, inner runs collapsed to one space.
 *
 * Collapsing rather than only trimming, because the name is compared for uniqueness and
 * "Friday  night" and "Friday night" read as the same words on screen. A name that is nothing but
 * whitespace collapses to '' and is refused below rather than stored as a setlist with no name.
 */
export function setlistName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** Whether a normalised name can be stored. Length is checked after collapsing, not before. */
export function isValidSetlistName(name: string): boolean {
  return name.length > 0 && name.length <= SETLIST_NAME_MAX
}

/**
 * The ids of the setlists holding this chart.
 *
 * Built per chart rather than per setlist because that is the question both callers ask: the rail
 * asks it about the one chart in front of it, and the panel it opens draws a tick per setlist from
 * the answer. A setlist's own entry list is already in hand for the other direction.
 */
export function setlistsHolding(setlists: Setlist[], key: SetlistEntryKey): Set<string> {
  const wanted = setlistEntryId(key)
  const ids = new Set<string>()
  for (const list of setlists) {
    if (list.entries.some((entry) => setlistEntryId(entry) === wanted)) ids.add(list.id)
  }
  return ids
}
