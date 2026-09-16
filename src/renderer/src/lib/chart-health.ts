import type { ChartData } from './api/enchor'
import type { ChartRecord } from '../../../shared/schemas'

/**
 * What the rail says about a chart, beyond its name.
 *
 * Three states and not two. "Missing" is a claim, and the rail is only entitled to make it
 * about a chart somebody has actually looked inside: a scanned folder in the user's library.
 * For a chart on Chorus the API answers for the video and the cover and says nothing at all
 * about a background or a lyrics track, and the honest word for that is "unknown", not
 * "missing". The Asset Studio acts on the first of those and must never be sent after the
 * second.
 *
 * Deliberately derived from fields the caller is already holding. Nothing here asks main
 * anything, so the rail costs no IPC on a chart the user merely clicked past.
 */
export type HealthState = 'present' | 'missing' | 'unknown'

export interface HealthItem {
  /** Matches the asset kind the Asset Studio uses, where there is one. */
  key: 'albumArt' | 'background' | 'video' | 'lyrics' | 'notes'
  label: string
  state: HealthState
}

/** A local chart whose scan predates note counts stores an empty array, which is "not read". */
function notesState(counts: { count: number }[] | null | undefined): HealthState {
  if (!counts || counts.length === 0) return 'unknown'
  return counts.some((entry) => entry.count > 0) ? 'present' : 'missing'
}

function flag(value: boolean): HealthState {
  return value ? 'present' : 'missing'
}

export function localHealth(record: ChartRecord): HealthItem[] {
  return [
    { key: 'albumArt', label: 'Album art', state: flag(record.hasAlbumArt) },
    { key: 'background', label: 'Background', state: flag(record.hasBackground) },
    { key: 'video', label: 'Video', state: flag(record.hasVideo) },
    { key: 'lyrics', label: 'Lyrics', state: flag(record.hasLyrics) },
    { key: 'notes', label: 'Note counts', state: notesState(record.noteCounts) }
  ]
}

export function remoteHealth(chart: ChartData): HealthItem[] {
  return [
    { key: 'albumArt', label: 'Album art', state: flag(chart.albumArtMd5 !== null) },
    // Chorus reports whether a chart ships a video background. A still background and a lyrics
    // track are not in the response at all, so neither is knowable before a download.
    { key: 'background', label: 'Background', state: 'unknown' },
    { key: 'video', label: 'Video', state: flag(chart.hasVideoBackground) },
    { key: 'lyrics', label: 'Lyrics', state: 'unknown' },
    { key: 'notes', label: 'Note counts', state: notesState(chart.notesData?.noteCounts) }
  ]
}

/**
 * One line summarising the list, or null when nothing in it is known either way.
 *
 * Counts only what was measured: an unknown is neither a pass nor a fail, so a remote chart
 * reads "2 of 3" rather than "2 of 5 missing three things we never looked for".
 */
export function healthSummary(items: HealthItem[]): { present: number; known: number } | null {
  const known = items.filter((item) => item.state !== 'unknown')
  if (known.length === 0) return null
  return { present: known.filter((item) => item.state === 'present').length, known: known.length }
}

/**
 * The number in the middle of the rail's health ring.
 *
 * It is a percentage of `known`, the checks somebody actually looked at, and never of the five
 * items. Counting an unknown as a failure would mark every chart on Chorus down for a lyrics
 * track and a background that cannot be seen before a download, which is the same rule
 * `healthSummary` already applies, written as a number so an arc can be drawn from it.
 *
 * The scale is percent and its resolution is one check, so the values it can take are fixed by
 * the denominator: five known checks give 0, 20, 40, 60, 80 and 100, and three give 0, 33, 67
 * and 100. Nothing here can produce a 95. A ring reporting one would be claiming a precision
 * that five booleans do not have, and the card prints "4 of 5 checks" beside it so the reader
 * is told what the percentage is a percentage of.
 *
 * Null when nothing is known either way, which is the one case where there is no ring to draw.
 */
export function healthScore(items: HealthItem[]): number | null {
  const counted = healthSummary(items)
  if (counted === null) return null
  return Math.round((counted.present / counted.known) * 100)
}

/**
 * One health item as a claim rather than a noun, which is what lets the tick beside it be
 * decoration instead of the only signal.
 *
 * Built from the label rather than stored per state: three strings per item is three places for
 * the vocabulary to drift, and the shape "Album art" / "No album art" / "Album art unknown"
 * holds for every label the two builders above produce.
 */
export function healthPhrase(item: HealthItem): string {
  if (item.state === 'present') return item.label
  if (item.state === 'unknown') return `${item.label} unknown`
  return `No ${item.label.charAt(0).toLowerCase()}${item.label.slice(1)}`
}
