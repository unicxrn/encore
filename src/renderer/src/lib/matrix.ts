import { partState, type PartState } from '../../../shared/format'

export type DiffKey = 'E' | 'M' | 'H' | 'X'

/** One instrument+difficulty note total, as both the Encore API and the catalog store it. */
export interface NoteCountEntry {
  instrument: string
  difficulty: string
  count: number
}

export interface MatrixRow {
  instrument: string
  label: string
  diffs: Record<DiffKey, boolean>
}

// Canonical instrument order and labels as required by the M4 spec.
const INSTRUMENT_ORDER: readonly { key: string; label: string }[] = [
  { key: 'guitar', label: 'Guitar' },
  { key: 'bass', label: 'Bass' },
  { key: 'drums', label: 'Drums' },
  { key: 'keys', label: 'Keys' },
  { key: 'rhythm', label: 'Rhythm' },
  { key: 'guitarcoop', label: 'Guitar co-op' },
  { key: 'guitarghl', label: 'Guitar (GHL)' },
  { key: 'bassghl', label: 'Bass (GHL)' },
  { key: 'rhythmghl', label: 'Rhythm (GHL)' },
  { key: 'guitarcoopghl', label: 'Co-op (GHL)' }
]

/**
 * The part each instrument key plays, which is the thing its colour names.
 *
 * Ten keys, six parts. Guitar co-op is guitar; the four GHL entries are guitar, bass, rhythm
 * and guitar co-op on a six-fret controller. A controller is not a part, so it is not a hue:
 * see the instruments block in tokens.css for why colour is spent on the axis a player scans
 * for and not on the one that is already spelled out in the label beside it.
 *
 * Vocals is here without being in INSTRUMENT_ORDER, which is correct and not an oversight: it
 * is metadata rather than a playable track (PreviewPane says so), so it never appears as a
 * matrix row, but the catalog stores a vocals difficulty and anything that colours one needs
 * the same answer this gives everything else.
 */
const INSTRUMENT_PART: Record<string, string> = {
  guitar: 'guitar',
  guitarcoop: 'guitar',
  guitarghl: 'guitar',
  guitarcoopghl: 'guitar',
  bass: 'bass',
  bassghl: 'bass',
  rhythm: 'rhythm',
  rhythmghl: 'rhythm',
  drums: 'drums',
  keys: 'keys',
  vocals: 'vocals'
}

/**
 * The custom property holding an instrument's colour, or null for a key with no part.
 *
 * A name rather than a value, so the colour itself stays in tokens.css and this file holds only
 * the mapping. Null rather than a fallback colour: a caller that meets an instrument key this
 * app has never heard of should draw it uncoloured, not draw it as guitar.
 */
export function instrumentColorVar(instrument: string): string | null {
  const part = INSTRUMENT_PART[instrument]
  return part === undefined ? null : `--inst-${part}`
}

// API difficulty names → matrix column keys (user requirement: easy→E, medium→M, hard→H, expert→X).
const DIFF_MAP: Record<string, DiffKey> = {
  easy: 'E',
  medium: 'M',
  hard: 'H',
  expert: 'X'
}

/**
 * Convert the notesData.noteCounts array from the Encore API into a matrix of
 * instrument rows with E/M/H/X presence flags.
 *
 * - Only instruments present in INSTRUMENT_ORDER are included (unknown instruments ignored).
 * - Only count > 0 entries mark a difficulty as present.
 * - Unknown difficulty strings are ignored gracefully.
 * - null/undefined input returns [].
 * - Output is sorted by INSTRUMENT_ORDER (instruments with no qualifying counts omitted).
 */
export function diffMatrix(noteCounts: NoteCountEntry[] | null | undefined): MatrixRow[] {
  if (!noteCounts || noteCounts.length === 0) return []

  // Build a map: instrument → set of present DiffKeys (count > 0 only).
  const presenceMap = new Map<string, Set<DiffKey>>()

  for (const entry of noteCounts) {
    const diffKey = DIFF_MAP[entry.difficulty]
    if (!diffKey) continue // unknown difficulty, ignore
    if (entry.count <= 0) continue // a zero count does not mark presence

    let set = presenceMap.get(entry.instrument)
    if (!set) {
      set = new Set<DiffKey>()
      presenceMap.set(entry.instrument, set)
    }
    set.add(diffKey)
  }

  const rows: MatrixRow[] = []

  for (const { key, label } of INSTRUMENT_ORDER) {
    const present = presenceMap.get(key)
    if (!present || present.size === 0) continue // instrument not present or all zero

    rows.push({
      instrument: key,
      label,
      diffs: {
        E: present.has('E'),
        M: present.has('M'),
        H: present.has('H'),
        X: present.has('X')
      }
    })
  }

  return rows
}

/**
 * How many instruments carry notes, or null when the chart's notes were never read.
 *
 * The null is the whole point. An absent or empty noteCounts is not the answer "this chart
 * has no instruments"; it is what every catalog row carries until a scan fills it in (the
 * column is added with a DEFAULT of '[]' and the watcher ignores the initial pass, so nothing
 * re-parses until the user asks), and what the API returns for a chart it has not processed.
 * Callers must render null as a dash: "we have not looked" is a different claim from "there is
 * nothing there", and only one of them is true of a chart that plainly has four instruments.
 *
 * A noteCounts that IS populated but yields no rows returns 0, not null, because that zero was
 * measured.
 */
export function countInstruments(noteCounts: NoteCountEntry[] | null | undefined): number | null {
  if (!noteCounts || noteCounts.length === 0) return null
  return diffMatrix(noteCounts).length
}

/** One instrument+difficulty peak, as both sources store it. The API's `time` is ignored here. */
export interface MaxNpsEntry {
  instrument: string
  difficulty: string
  nps: number
}

/**
 * One instrument+difficulty square of the chart page's grid.
 *
 * Three kinds rather than a number, for the same reason `PartState` has three: "nobody has
 * counted" and "counted, and there is nothing here" are different claims, and a single number
 * cannot hold both. `unread` is what every square of a chart reads before a scan.
 */
export type DiffCell =
  | { kind: 'charted'; count: number; nps: number | null }
  | { kind: 'uncharted' }
  | { kind: 'unread' }

export interface PartRow {
  instrument: string
  label: string
  /** What song.ini claims about this part, judged against what the notes say. See `partState`. */
  state: PartState
  /** The raw song.ini rating, or null when the charter left it unset. Carries no ceiling. */
  rating: number | null
  cells: Record<DiffKey, DiffCell>
}

export interface PartMatrixInput {
  noteCounts?: NoteCountEntry[] | null
  maxNps?: readonly MaxNpsEntry[] | null
  /** song.ini's ratings by instrument key. Undefined, null and negative are all "unset". */
  ratings?: Readonly<Record<string, number | null | undefined>> | null
}

const COLUMN_KEYS: readonly DiffKey[] = ['E', 'M', 'H', 'X']

/**
 * The whole of what a chart says about its playable parts, which is what the chart page draws.
 *
 * Deliberately a second function rather than a wider `diffMatrix`. That one answers "which
 * tracks can be previewed", and the rail and the preview pane build their instrument selects
 * from it; a row for a part with no notes would offer the user a track the player cannot open.
 * This one answers "what does this chart say about each part", where a rating with no notes
 * behind it is exactly the thing worth showing.
 *
 * Two sources of rows, and a row appears when either has something to say: an instrument that
 * carries notes, or one song.ini rates. Where they disagree the notes win, which is `partState`'s
 * rule and not a new one: a rating is a line of text a converter copied, and six charts in a
 * hundred carry one for a part their notes do not contain.
 *
 * An empty `noteCounts` is "nobody has read this chart", not "this chart is empty", so every
 * square reads `unread` rather than `uncharted` and the ratings are still drawn. That is the one
 * case where this says more than the old grid could: a catalog row written before note counts
 * existed used to render as nothing at all.
 */
export function partMatrix(input: PartMatrixInput): PartRow[] {
  const counts = input.noteCounts ?? []
  const read = counts.length > 0

  const present = new Set<string>()
  for (const entry of counts) if (entry.count > 0) present.add(entry.instrument)
  const presentList = [...present]

  const peaks = new Map<string, number>()
  for (const entry of input.maxNps ?? []) {
    peaks.set(`${entry.instrument} ${entry.difficulty}`, entry.nps)
  }

  const rows: PartRow[] = []
  for (const { key, label } of INSTRUMENT_ORDER) {
    const raw = input.ratings?.[key]
    const rating = raw == null || raw < 0 ? null : raw
    if (!present.has(key) && rating === null) continue

    const cells = {} as Record<DiffKey, DiffCell>
    for (const col of COLUMN_KEYS) cells[col] = { kind: read ? 'uncharted' : 'unread' }
    for (const entry of counts) {
      if (entry.instrument !== key || entry.count <= 0) continue
      const col = DIFF_MAP[entry.difficulty]
      if (!col) continue
      cells[col] = {
        kind: 'charted',
        count: entry.count,
        nps: peaks.get(`${key} ${entry.difficulty}`) ?? null
      }
    }

    rows.push({ instrument: key, label, state: partState(presentList, key, rating), rating, cells })
  }
  return rows
}
