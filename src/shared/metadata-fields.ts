/**
 * The `song.ini` fields Encore's metadata editor offers, and nothing else.
 *
 * Shared because main and the renderer have to agree on the set exactly: main refuses a key that
 * is not in it, and the form draws one row per entry. Two lists would drift into a field the form
 * offers and the writer rejects, which the user would meet as a save that failed for no reason
 * they can see.
 *
 * ## Why these six
 *
 * They are the intersection of three questions, and every field outside it fails at least one.
 *
 * - **What does the Issues view refuse to repair?** scan-chart raises `missingValue` for exactly
 *   six `requiredProperties` (`name`, `artist`, `album`, `genre`, `year`, `charter`;
 *   scan-chart/dist/index.js:429), and `FIX_ACTIONS` deliberately carries no action for it,
 *   because an exact-hash Chorus match is built from this same upload and holds the same blank
 *   (issues/fix.ts). This view is the answer to that refusal, so it has to cover that set.
 * - **Does the scanner read it back?** A field the scanner ignores is a field the app forgets you
 *   edited: the ini would hold the new value and every list in Encore would go on showing the old
 *   one until something else re-read the file. All six are in `scannedFields`
 *   (catalog/scanner.ts) and on `ChartRecordSchema`.
 * - **Is the library organised by it?** `CatalogSortFieldSchema` sorts by title, artist, album,
 *   charter and year; `catalog:facets` builds its pickers from artist, genre, charter and year.
 *   The six between them are every column the Installed view sorts, filters or groups by, which
 *   is what makes a wrong value cost something more than a wrong line on one page.
 *
 * ## Why not the others
 *
 * `song.ini` holds around thirty keys and the scanner stores a dozen more of them
 * (`loading_phrase`, `icon`, `album_track`, `playlist_track`, `preview_start_time`, `modchart`
 * and the thirteen `diff_*` ratings). None of them is missing from a chart in a way any view
 * complains about, none is something the catalog is organised by, and the ratings are the
 * charter's own judgement, which `MISSING_DIFFICULTY_MEANING` in shared/issue-labels.ts already
 * says is not Encore's to fill in. Offering them would be offering edits nobody arrived wanting,
 * each with its own write to prove correct.
 *
 * And seven keys are excluded on a different ground entirely: `hopo_frequency`,
 * `eighthnote_hopo`, `multiplier_note`, `sustain_cutoff_threshold`, `chord_snap_threshold`,
 * `five_lane_drums` and `pro_drums` are mixed into `getChartHash`, which is what Clone Hero
 * matches charts between players by. See `HASHED_INI_KEYS` in main/issues/ini-edit.ts, which
 * refuses them at the writer, and `GAMEPLAY_KEYS_NOTE` below, which is what the form says instead
 * of drawing a text box.
 */

export const EDITABLE_INI_KEYS = ['name', 'artist', 'album', 'genre', 'year', 'charter'] as const

export type EditableIniKey = (typeof EDITABLE_INI_KEYS)[number]

/** Every editable field, as the editor reads and writes them. `''` means the chart sets nothing. */
export type ChartMetadataFields = Record<EditableIniKey, string>

export interface MetadataFieldSpec {
  key: EditableIniKey
  /** The word on the form. `name` is "Title" because that is what the rest of Encore calls it. */
  label: string
  /** One line under the control, saying what Clone Hero does with the value. */
  hint: string
}

/**
 * The form's rows, in the order they are drawn.
 *
 * Title and artist lead because they are what a chart is found by; charter is last because it is
 * a credit rather than a property of the song. Between them the order matches the About card in
 * Detail.svelte, so the two readings of one chart list its fields the same way.
 */
export const METADATA_FIELDS: readonly MetadataFieldSpec[] = [
  { key: 'name', label: 'Title', hint: 'The song name Clone Hero lists this chart under.' },
  { key: 'artist', label: 'Artist', hint: 'Spelled the way the rest of your library spells it.' },
  { key: 'album', label: 'Album', hint: 'The release this song is from.' },
  { key: 'genre', label: 'Genre', hint: 'Free text. Clone Hero sorts and filters by it.' },
  { key: 'year', label: 'Year', hint: 'A four-digit year, or empty.' },
  { key: 'charter', label: 'Charter', hint: 'Who charted it. Credit, not a property of the song.' }
]

/** What the read-only gameplay panel says above the seven values it lists. */
export const GAMEPLAY_KEYS_NOTE =
  'Clone Hero matches charts between players by these seven values, so Encore will not edit ' +
  'them. Changing one would leave you unable to play this chart with anyone who has the ' +
  'original, and no message would tell either of you why.'

/**
 * Whether `year` is something the catalog can hold, and what to say when it is not.
 *
 * `song.ini` stores the year as free text and Clone Hero prints whatever it finds, but Encore's
 * catalog column is an integer: the scanner runs `parseInt(scanned.year, 10) || null`
 * (catalog/scanner.ts), so `1997 remaster` is stored as 1997 and `late nineties` as nothing at
 * all. Accepting either would write a value into the user's file that every Encore view then
 * disagreed with, which is the same failure as editing a field the scanner ignores, only quieter.
 *
 * Shared so the form can refuse before the save and the handler can refuse again after it. The
 * range is deliberately wide rather than "not in the future": charts are made for songs recorded
 * long before Clone Hero and dated by people who know better than a validator.
 */
export function yearRefusal(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!/^\d{4}$/.test(trimmed)) {
    return 'Encore stores the year as a number, so this has to be four digits, or empty.'
  }
  return null
}
