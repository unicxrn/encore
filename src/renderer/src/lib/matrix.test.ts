import { describe, expect, it } from 'vitest'
import { countInstruments, diffMatrix, instrumentColorVar, partMatrix } from './matrix'
import type { MatrixRow } from './matrix'

describe('diffMatrix', () => {
  it('returns [] for null input', () => {
    expect(diffMatrix(null)).toEqual([])
  })

  it('returns [] for undefined input', () => {
    expect(diffMatrix(undefined)).toEqual([])
  })

  it('returns [] for empty array', () => {
    expect(diffMatrix([])).toEqual([])
  })

  it('maps easy/medium/hard/expert to E/M/H/X', () => {
    const input = [
      { instrument: 'guitar', difficulty: 'easy', count: 10 },
      { instrument: 'guitar', difficulty: 'medium', count: 20 },
      { instrument: 'guitar', difficulty: 'hard', count: 30 },
      { instrument: 'guitar', difficulty: 'expert', count: 40 }
    ]
    const result = diffMatrix(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      instrument: 'guitar',
      label: 'Guitar',
      diffs: { E: true, M: true, H: true, X: true }
    })
  })

  it('excludes instruments with all zero counts', () => {
    const input = [
      { instrument: 'guitar', difficulty: 'expert', count: 0 },
      { instrument: 'bass', difficulty: 'expert', count: 5 }
    ]
    const result = diffMatrix(input)
    expect(result).toHaveLength(1)
    expect(result[0].instrument).toBe('bass')
  })

  it('marks only present difficulties as true', () => {
    const input = [{ instrument: 'guitar', difficulty: 'expert', count: 100 }]
    const result = diffMatrix(input)
    expect(result[0].diffs).toEqual({ E: false, M: false, H: false, X: true })
  })

  it('preserves instrument order: guitar, bass, drums, keys, rhythm, guitarcoop, guitarghl, bassghl, rhythmghl, guitarcoopghl', () => {
    const input = [
      { instrument: 'drums', difficulty: 'expert', count: 1 },
      { instrument: 'bass', difficulty: 'expert', count: 1 },
      { instrument: 'guitar', difficulty: 'expert', count: 1 },
      { instrument: 'guitarcoopghl', difficulty: 'expert', count: 1 },
      { instrument: 'bassghl', difficulty: 'expert', count: 1 }
    ]
    const result = diffMatrix(input)
    expect(result.map((r) => r.instrument)).toEqual([
      'guitar',
      'bass',
      'drums',
      'bassghl',
      'guitarcoopghl'
    ])
  })

  it('uses correct labels for all known instruments', () => {
    const instruments = [
      { instrument: 'guitar', difficulty: 'expert', count: 1 },
      { instrument: 'bass', difficulty: 'expert', count: 1 },
      { instrument: 'drums', difficulty: 'expert', count: 1 },
      { instrument: 'keys', difficulty: 'expert', count: 1 },
      { instrument: 'rhythm', difficulty: 'expert', count: 1 },
      { instrument: 'guitarcoop', difficulty: 'expert', count: 1 },
      { instrument: 'guitarghl', difficulty: 'expert', count: 1 },
      { instrument: 'bassghl', difficulty: 'expert', count: 1 },
      { instrument: 'rhythmghl', difficulty: 'expert', count: 1 },
      { instrument: 'guitarcoopghl', difficulty: 'expert', count: 1 }
    ]
    const result = diffMatrix(instruments)
    const labelMap = Object.fromEntries(result.map((r) => [r.instrument, r.label]))
    expect(labelMap).toMatchObject({
      guitar: 'Guitar',
      bass: 'Bass',
      drums: 'Drums',
      keys: 'Keys',
      rhythm: 'Rhythm',
      guitarcoop: 'Guitar co-op',
      guitarghl: 'Guitar (GHL)',
      bassghl: 'Bass (GHL)',
      rhythmghl: 'Rhythm (GHL)',
      guitarcoopghl: 'Co-op (GHL)'
    })
  })

  it('includes GHL instruments when present', () => {
    const input = [
      { instrument: 'guitarghl', difficulty: 'expert', count: 50 },
      { instrument: 'bassghl', difficulty: 'hard', count: 30 }
    ]
    const result = diffMatrix(input)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      instrument: 'guitarghl',
      label: 'Guitar (GHL)',
      diffs: { X: true, H: false }
    })
    expect(result[1]).toMatchObject({
      instrument: 'bassghl',
      label: 'Bass (GHL)',
      diffs: { H: true, X: false }
    })
  })

  it('ignores unknown instruments gracefully', () => {
    const input = [
      { instrument: 'unknownInstrument', difficulty: 'expert', count: 100 },
      { instrument: 'guitar', difficulty: 'expert', count: 5 }
    ]
    const result = diffMatrix(input)
    expect(result).toHaveLength(1)
    expect(result[0].instrument).toBe('guitar')
  })

  it('ignores unknown difficulties gracefully', () => {
    const input = [
      { instrument: 'guitar', difficulty: 'unknown_diff', count: 100 },
      { instrument: 'guitar', difficulty: 'expert', count: 5 }
    ]
    const result = diffMatrix(input)
    expect(result).toHaveLength(1)
    expect(result[0].diffs).toEqual({ E: false, M: false, H: false, X: true })
  })

  it('mixed instruments and difficulties produce correct rows', () => {
    const input = [
      { instrument: 'guitar', difficulty: 'expert', count: 500 },
      { instrument: 'guitar', difficulty: 'hard', count: 300 },
      { instrument: 'bass', difficulty: 'expert', count: 200 },
      { instrument: 'drums', difficulty: 'easy', count: 100 },
      { instrument: 'drums', difficulty: 'medium', count: 0 },
      { instrument: 'keys', difficulty: 'hard', count: 50 }
    ]
    const result = diffMatrix(input)
    expect(result).toHaveLength(4)
    const [guitar, bass, drums, keys] = result
    expect(guitar).toMatchObject({
      instrument: 'guitar',
      diffs: { E: false, M: false, H: true, X: true }
    })
    expect(bass).toMatchObject({
      instrument: 'bass',
      diffs: { E: false, M: false, H: false, X: true }
    })
    // drums medium has count 0 → excluded
    expect(drums).toMatchObject({
      instrument: 'drums',
      diffs: { E: true, M: false, H: false, X: false }
    })
    expect(keys).toMatchObject({
      instrument: 'keys',
      diffs: { E: false, M: false, H: true, X: false }
    })
  })

  it('accepts the note counts the scanner stores for local charts', () => {
    // Same field names scan-chart emits, so a local chart needs no conversion layer.
    const rows = diffMatrix([
      { instrument: 'guitar', difficulty: 'expert', count: 900 },
      { instrument: 'guitar', difficulty: 'hard', count: 700 },
      { instrument: 'drums', difficulty: 'expert', count: 1200 }
    ])
    expect(rows.map((r) => r.instrument)).toEqual(['guitar', 'drums'])
    expect(rows[0].diffs).toEqual({ E: false, M: false, H: true, X: true })
    expect(rows[1].diffs.X).toBe(true)
  })

  it('returns typed MatrixRow objects', () => {
    const input = [{ instrument: 'guitar', difficulty: 'expert', count: 1 }]
    const result: MatrixRow[] = diffMatrix(input)
    expect(result[0]).toHaveProperty('instrument')
    expect(result[0]).toHaveProperty('label')
    expect(result[0]).toHaveProperty('diffs')
  })
})

describe('countInstruments', () => {
  it('returns null for null input', () => {
    expect(countInstruments(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(countInstruments(undefined)).toBeNull()
  })

  it('returns null rather than 0 for a catalog row scanned before note counts were stored', () => {
    // The M5 migration adds `noteCounts` with a DEFAULT of '[]', and the watcher runs with
    // ignoreInitial, so every pre-existing chart carries this until the user runs a scan.
    // Counting it as 0 asserts "this chart has no instruments" about a chart nobody looked at.
    expect(countInstruments([])).toBeNull()
  })

  it('counts the instruments that carry notes', () => {
    const counts = countInstruments([
      { instrument: 'guitar', difficulty: 'expert', count: 900 },
      { instrument: 'guitar', difficulty: 'hard', count: 700 },
      { instrument: 'drums', difficulty: 'expert', count: 1200 }
    ])
    // Two instruments across three tracks; tracks are not the unit.
    expect(counts).toBe(2)
  })

  it('returns 0 when the chart was parsed and nothing is charted', () => {
    // Distinct from the empty case: an all-zero noteCounts is an answer, not a gap.
    expect(countInstruments([{ instrument: 'guitar', difficulty: 'expert', count: 0 }])).toBe(0)
  })

  it('excludes instruments the matrix does not recognise', () => {
    const counts = countInstruments([
      { instrument: 'unknownInstrument', difficulty: 'expert', count: 100 },
      { instrument: 'guitar', difficulty: 'expert', count: 5 }
    ])
    expect(counts).toBe(1)
  })
})

/**
 * Colour is per PART, not per controller.
 *
 * The rule tokens.css states: six parts get six hues, and the four entries that are the same
 * part on a six-fret controller take their part's hue rather than one of their own. These pin
 * that mapping, because the alternative reading (ten keys, ten colours) is the one somebody
 * will reach for the first time a GHL row looks like a guitar row.
 */
describe('instrumentColorVar', () => {
  it('gives every instrument the matrix can list a colour', () => {
    const listed = diffMatrix(
      [
        'guitar',
        'bass',
        'drums',
        'keys',
        'rhythm',
        'guitarcoop',
        'guitarghl',
        'bassghl',
        'rhythmghl',
        'guitarcoopghl'
      ].map((instrument) => ({ instrument, difficulty: 'expert', count: 1 }))
    )
    expect(listed).toHaveLength(10)
    for (const row of listed) expect(instrumentColorVar(row.instrument)).not.toBeNull()
  })

  it('colours a GHL or co-op track as the part it plays', () => {
    expect(instrumentColorVar('guitarcoop')).toBe('--inst-guitar')
    expect(instrumentColorVar('guitarghl')).toBe('--inst-guitar')
    expect(instrumentColorVar('guitarcoopghl')).toBe('--inst-guitar')
    expect(instrumentColorVar('bassghl')).toBe('--inst-bass')
    expect(instrumentColorVar('rhythmghl')).toBe('--inst-rhythm')
  })

  it('gives the six parts six different colours', () => {
    const vars = ['guitar', 'rhythm', 'bass', 'drums', 'keys', 'vocals'].map(instrumentColorVar)
    expect(new Set(vars).size).toBe(6)
  })

  // Vocals is not a matrix row (it is metadata, never playable) but the catalog stores a
  // difficulty for it, so anything colouring that needs the same answer.
  it('answers for vocals, which is not in the matrix order', () => {
    expect(instrumentColorVar('vocals')).toBe('--inst-vocals')
  })

  // A fallback here would paint an unknown track as guitar, which is worse than painting it
  // as nothing: the colour would be a claim about which instrument it is.
  it('refuses to guess for a key it has never heard of', () => {
    expect(instrumentColorVar('theremin')).toBeNull()
  })
})

describe('partMatrix', () => {
  const counts = [
    { instrument: 'guitar', difficulty: 'hard', count: 902 },
    { instrument: 'guitar', difficulty: 'expert', count: 1408 },
    { instrument: 'bass', difficulty: 'expert', count: 800 }
  ]

  it('gives an instrument a row when it carries notes, rated or not', () => {
    const rows = partMatrix({ noteCounts: counts })
    expect(rows.map((row) => row.instrument)).toEqual(['guitar', 'bass'])
    expect(rows[0].state).toEqual({ kind: 'unrated' })
    expect(rows[0].rating).toBeNull()
  })

  it('carries the note count and the peak of every charted square', () => {
    const rows = partMatrix({
      noteCounts: counts,
      maxNps: [{ instrument: 'guitar', difficulty: 'expert', nps: 9.4 }]
    })
    expect(rows[0].cells.X).toEqual({ kind: 'charted', count: 1408, nps: 9.4 })
    // Charted, and nobody measured a peak for it. Null rather than 0: a chart with 902 notes
    // does not have a peak of zero notes a second.
    expect(rows[0].cells.H).toEqual({ kind: 'charted', count: 902, nps: null })
    expect(rows[0].cells.E).toEqual({ kind: 'uncharted' })
  })

  it('keeps the rating whole, however far past the scale it runs', () => {
    const rows = partMatrix({ noteCounts: counts, ratings: { guitar: 73 } })
    expect(rows[0].state).toEqual({ kind: 'rated', tier: 73 })
    expect(rows[0].rating).toBe(73)
  })

  // song.ini's "unset" sentinel reaches the renderer raw from the Encore API and normalized to
  // null by the scanner. Both are the same answer and neither is a tier.
  it('reads -1 and null as no rating at all', () => {
    expect(partMatrix({ noteCounts: counts, ratings: { guitar: -1 } })[0].state).toEqual({
      kind: 'unrated'
    })
    expect(partMatrix({ noteCounts: counts, ratings: { guitar: null } })[0].state).toEqual({
      kind: 'unrated'
    })
  })

  /**
   * The notes win, and the row still appears. This is scan-chart's `extraValue`: measured
   * against api.enchor.us, six charts in a hundred rate a part their notes do not contain.
   * `diffMatrix` has no row for it at all, which is right for a list of previewable tracks and
   * wrong for a page reporting what a chart claims.
   */
  it('reports a rated part with no notes as absent rather than dropping it', () => {
    const rows = partMatrix({ noteCounts: counts, ratings: { keys: 3 } })
    const keys = rows.find((row) => row.instrument === 'keys')
    expect(keys?.state).toEqual({ kind: 'absent' })
    expect(keys?.rating).toBe(3)
    expect(keys?.cells.X).toEqual({ kind: 'uncharted' })
    expect(diffMatrix(counts).some((row) => row.instrument === 'keys')).toBe(false)
  })

  /**
   * An empty noteCounts is "nobody has read this chart", not "this chart is empty". Every
   * catalog row carries one until a scan fills it in, and the ratings beside it are all that is
   * known; drawing them as `uncharted` would turn "not counted" into "counted and empty".
   */
  it('falls back to the ratings when nothing has counted the notes', () => {
    const rows = partMatrix({ noteCounts: [], ratings: { guitar: 4, drums: 5 } })
    expect(rows.map((row) => row.instrument)).toEqual(['guitar', 'drums'])
    expect(rows[0].state).toEqual({ kind: 'rated', tier: 4 })
    expect(rows[0].cells.X).toEqual({ kind: 'unread' })
    expect(rows[0].cells.E).toEqual({ kind: 'unread' })
  })

  it('has nothing to say about a chart with neither notes nor ratings', () => {
    expect(partMatrix({})).toEqual([])
    expect(partMatrix({ noteCounts: null, ratings: null })).toEqual([])
  })

  // A zero count is a measurement, and it marks nothing present: same rule diffMatrix keeps.
  it('leaves out an instrument whose only counts are zero and which nobody rated', () => {
    const rows = partMatrix({
      noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 0 }]
    })
    expect(rows).toEqual([])
  })

  it('keeps the canonical instrument order rather than the order the counts arrived in', () => {
    const rows = partMatrix({
      noteCounts: [
        { instrument: 'bassghl', difficulty: 'expert', count: 1 },
        { instrument: 'drums', difficulty: 'expert', count: 1 },
        { instrument: 'guitar', difficulty: 'expert', count: 1 }
      ]
    })
    expect(rows.map((row) => row.instrument)).toEqual(['guitar', 'drums', 'bassghl'])
  })

  it('ignores an instrument key and a difficulty name it has never heard of', () => {
    const rows = partMatrix({
      noteCounts: [
        { instrument: 'theremin', difficulty: 'expert', count: 50 },
        { instrument: 'guitar', difficulty: 'impossible', count: 50 },
        { instrument: 'guitar', difficulty: 'expert', count: 10 }
      ]
    })
    expect(rows.map((row) => row.instrument)).toEqual(['guitar'])
    expect(rows[0].cells.X).toEqual({ kind: 'charted', count: 10, nps: null })
  })
})
