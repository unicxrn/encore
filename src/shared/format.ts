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
