import { writable, type Writable } from 'svelte/store'
import type { CatalogFilter, CatalogSortField, SortDirection } from '../../../../shared/schemas'

/**
 * What the Installed view's filter bar is set to.
 *
 * The controls' own values, as strings, rather than a half-built `CatalogFilter`. Two reasons:
 * a `<select>` reset to its "any" option posts `''` and a number input mid-edit holds `'19'`, and
 * neither is a number the catalog should be asked about yet; and keeping the record in control
 * terms means restoring the bar after a remount is an assignment rather than a reconstruction.
 *
 * `toCatalogFilter` below is the single place these become a query.
 */
export interface LibraryFilterState {
  /** The free-text box, which is the FTS search over name, artist, album and charter. */
  search: string
  /** Exact values, picked from what the catalog holds. Empty string means "any". */
  artist: string
  genre: string
  charter: string
  /** A substring, typed. See CatalogFilterSchema on why album is the one text field here. */
  album: string
  /** Years, as the picker posts them: '' or a four-digit string. */
  yearMin: string
  yearMax: string
  /** Song length bounds in whole MINUTES, as typed. Milliseconds are a query detail. */
  lengthMinMin: string
  lengthMaxMin: string
  /** Charts with no play recorded while Encore has been watching. See shared/play.ts. */
  neverPlayed: boolean
  /** Empty means the view's existing default order, which is not one order: see CatalogFilter. */
  sort: CatalogSortField | ''
  direction: SortDirection
}

export const EMPTY_LIBRARY_FILTER: LibraryFilterState = {
  search: '',
  artist: '',
  genre: '',
  charter: '',
  album: '',
  yearMin: '',
  yearMax: '',
  lengthMinMin: '',
  lengthMaxMin: '',
  neverPlayed: false,
  sort: '',
  direction: 'asc'
}

/** One minute, in the milliseconds the catalog stores song lengths in. */
const MS_PER_MINUTE = 60_000

/**
 * A typed number, or undefined when the box is empty or holds something that is not one.
 *
 * Undefined rather than 0 for the unparseable case: a half-typed '-' or a stray letter means the
 * user has not said anything yet, and reading it as zero would apply a bound they did not ask
 * for. Negatives are dropped for the same reason lengths and years cannot be negative.
 */
function toNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * The catalog query one page of this filter bar asks for.
 *
 * Minutes become milliseconds here, inclusive at both ends: "up to 4" means up to 4:00 exactly,
 * so a 3:59 chart is in and a 4:01 chart is out, which is how anyone reads "under four minutes".
 *
 * Fields the user has not set are left off entirely rather than sent as empty strings, so the
 * filter that crosses IPC says only what was actually asked for.
 */
export function toCatalogFilter(
  state: LibraryFilterState,
  page: { offset: number; limit: number }
): Partial<CatalogFilter> {
  const lengthMin = toNumber(state.lengthMinMin)
  const lengthMax = toNumber(state.lengthMaxMin)
  return {
    search: state.search,
    offset: page.offset,
    limit: page.limit,
    ...(state.artist ? { artist: state.artist } : {}),
    ...(state.genre ? { genre: state.genre } : {}),
    ...(state.charter ? { charter: state.charter } : {}),
    ...(state.album.trim() ? { album: state.album.trim() } : {}),
    ...(toNumber(state.yearMin) !== undefined ? { yearMin: toNumber(state.yearMin) } : {}),
    ...(toNumber(state.yearMax) !== undefined ? { yearMax: toNumber(state.yearMax) } : {}),
    ...(lengthMin !== undefined ? { lengthMinMs: Math.round(lengthMin * MS_PER_MINUTE) } : {}),
    ...(lengthMax !== undefined ? { lengthMaxMs: Math.round(lengthMax * MS_PER_MINUTE) } : {}),
    ...(state.neverPlayed ? { neverPlayed: true } : {}),
    ...(state.sort ? { sort: state.sort, direction: state.direction } : {})
  }
}

/**
 * How many narrowing controls are set, so the bar can say whether there is anything to clear.
 *
 * The sort is not counted and Clear does not reset it: a sort takes no charts away, so offering
 * to clear it alongside the filters would promise the user more rows than it delivers. The
 * search box is counted, because it is a filter like the rest of them.
 */
export function activeFilterCount(state: LibraryFilterState): number {
  const set = [
    state.search.trim(),
    state.artist,
    state.genre,
    state.charter,
    state.album.trim(),
    state.yearMin,
    state.yearMax,
    state.lengthMinMin.trim(),
    state.lengthMaxMin.trim()
  ].filter((value) => value !== '').length
  return set + (state.neverPlayed ? 1 : 0)
}

/** Clear every narrowing control, keeping the sort. See activeFilterCount. */
export function clearedFilters(state: LibraryFilterState): LibraryFilterState {
  return { ...EMPTY_LIBRARY_FILTER, sort: state.sort, direction: state.direction }
}

/**
 * The Installed view's filter bar, module-scoped.
 *
 * Same reason Explore's search store is (see stores/search.ts): App destroys this view on every
 * sidebar navigation and whenever a chart Detail opens, so state owned by the component resets
 * on the way back. Losing a typed query on Explore costs an API request; losing a filter here
 * costs the user the set of charts they had narrowed to, with nothing on screen saying why.
 *
 * Like Explore's `mode`, it does NOT survive a restart. Persisting it would mean a `Settings`
 * field, its zod default and the IPC round trip that writes it.
 *
 * The list's scroll position is deliberately not kept here. Explore can restore its offset
 * because its rows live in its store and are already in the DOM on remount; this view refetches
 * from the catalog on mount, so there is nothing to scroll to at the moment the offset would be
 * applied. Restoring it would mean caching the rows too, and then deciding when a scan has made
 * them stale.
 */
export const libraryFilter: Writable<LibraryFilterState> = writable({ ...EMPTY_LIBRARY_FILTER })
