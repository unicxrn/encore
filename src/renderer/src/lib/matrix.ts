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
