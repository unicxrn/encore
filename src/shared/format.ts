export function msToTime(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * A byte count as a person would say it.
 *
 * Binary steps under decimal names, which is what the file managers on this app's platforms show
 * and therefore what a user comparing Encore's number against their own will see. Precision drops
 * as the unit grows: "9.7 MB" is worth the digit and "512.3 MB" is not.
 *
 * Exists because the undo store's size is shown in two places (beside the button that clears it
 * in Settings, and per entry in the Issues tab), and two rounding rules would let the two
 * disagree about one store.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function diffDisplay(diff: number | null | undefined): string {
  // Negative is song.ini's "no rating" sentinel. The scanner already normalizes it away, but
  // rows written by an older build still carry it, so never render one as a number.
  return diff == null || diff < 0 ? '–' : String(diff)
}

/**
 * Render one instrument's difficulty cell for the library list.
 *
 * Three distinct states the old single-number column could not tell apart: rated, charted but
 * unrated, and not charted. An empty string means "this chart has no such track". Showing a
 * dash there would claim the instrument exists with no rating.
 *
 * An empty `instruments` means "we have not looked", not "there is nothing": rows scanned
 * before the note data was stored carry an empty list until the next rescan, so they fall back
 * to the song.ini rating rather than rendering an entirely blank column.
 */
export function instrumentDiff(
  instruments: readonly string[],
  instrument: string,
  diff: number | null | undefined
): string {
  if (instruments.length > 0 && !instruments.includes(instrument)) return ''
  return diffDisplay(diff)
}

/**
 * A readable stand-in for a chart with no parsed title.
 *
 * The full path is technically accurate and useless to read: a library list of forty
 * `/home/user/.clonehero/Songs/…` lines tells you nothing at a glance. Chart folders and
 * .sng files are conventionally named "Artist - Title (Charter)", so the last path segment
 * is nearly always the information the user wanted. Both separators are split on: paths are
 * native, and Windows-style ones reach here via settings and test data. That does mean a
 * literal backslash in a Linux file name splits too. The misread is rare, and purely cosmetic.
 */
export function fallbackChartName(path: string): string {
  // filter(Boolean) drops the empty segments a trailing separator leaves behind; returning
  // the raw path when nothing survives keeps an odd input ugly rather than invisible, which
  // is the one outcome worse than the full path this replaces.
  const base = path.split(/[/\\]/).filter(Boolean).pop()
  const stripped = base?.replace(/\.sng$/i, '') ?? ''
  return stripped === '' ? path : stripped
}

/**
 * A Clone Hero play timestamp as a date, in whatever the user's locale calls one.
 *
 * Clone Hero writes ISO 8601 with seven fractional digits and a Z, which Date parses, but the
 * app never re-serialises it and nothing guarantees the next Clone Hero writes the same shape.
 * An unparsable value renders as the empty-cell placeholder, because the unguarded form of this
 * puts the literal words "Invalid Date" on screen.
 *
 * Date only, no clock time: every caller is labelling a span of history, and the minute a song
 * finished is not what any of them is about.
 */
export function playedOn(value: string | null | undefined): string {
  if (value == null) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

/**
 * Every TextMeshPro tag Clone Hero renders, so a name written in them reads as text here.
 *
 * Charters style their own names in the game (`<color=#7B0000>W</color>...`), and song.ini and
 * Chorus both carry that styling verbatim. Encore is a table, not the game: the colours were
 * chosen against Clone Hero's background, several of them are near black, and a list of names in
 * nine colours is noise where a name is an identifier to scan down.
 */
const RICH_TEXT_TAGS = [
  'align',
  'allcaps',
  'alpha',
  'b',
  'br',
  'color',
  'cspace',
  'font',
  'font-weight',
  'gradient',
  'i',
  'indent',
  'line-height',
  'line-indent',
  'link',
  'lowercase',
  'margin',
  'mark',
  'material',
  'mspace',
  'nobr',
  'noparse',
  'page',
  'pos',
  'quad',
  'rotate',
  's',
  'size',
  'smallcaps',
  'space',
  'sprite',
  'strikethrough',
  'style',
  'sub',
  'sup',
  'u',
  'underline',
  'uppercase',
  'voffset',
  'width'
].join('|')

/**
 * A named tag, opening or closing, with or without a value.
 *
 * Deliberately stricter than the `<[^>]*>` in `main/catalog/lyric-lines.ts`, which is right for
 * lyrics and wrong here. That one drops anything between angle brackets, so a title like
 * `Rock <3 Roll >` loses its middle. A lyric is prose, where a stray `<` is vanishingly rare and a
 * wrong drop costs one word on screen; a name is an identifier, where a wrong drop silently
 * renames someone's chart and nobody can tell it happened. So this only drops tags the game
 * actually renders, and leaves every other angle bracket alone.
 */
const RICH_TEXT = new RegExp(`</?(?:${RICH_TEXT_TAGS})(?:[=\\s][^>]*)?>`, 'gi')

/**
 * Clone Hero's own markup out of a name.
 *
 * Nothing a chart says is edited: the catalogue stores the raw string exactly as the chart wrote
 * it and keeps the output of this beside it, because search and sort run over stored data and a
 * name nobody can see is a name nobody can find. See STRIPPED_COLUMN in main/catalog/db.ts.
 * A name made entirely of tags comes back empty, which the callers' own empty handling covers.
 *
 * Changing the rules here restyles every name on screen and dates every stripped column already
 * in a user's catalog. That is a migration (null the four columns and let the backfill recompute
 * them), not an edit on its own.
 */
export function stripRichText(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(RICH_TEXT, '').replace(/\s+/g, ' ').trim()
}
