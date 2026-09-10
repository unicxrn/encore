import { describe, expect, it } from 'vitest'
import { countInstruments, diffMatrix } from './matrix'
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
