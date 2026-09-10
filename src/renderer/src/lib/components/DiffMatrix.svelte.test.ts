import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import DiffMatrix from './DiffMatrix.svelte'
import type { MatrixRow } from '../matrix'

const guitar: MatrixRow = {
  instrument: 'guitar',
  label: 'Guitar',
  diffs: { E: false, M: false, H: true, X: true }
}

describe('DiffMatrix', () => {
  it('lists an instrument that has charted difficulties', () => {
    render(DiffMatrix, { rows: [guitar] })
    expect(screen.getByText('Guitar')).toBeTruthy()
  })

  // The check mark and the dash are an SVG and an empty <span>; the cell's aria-label is the
  // only rendering of charted-vs-not that survives into the accessibility tree, and so the only
  // one a test can read. jsdom draws nothing, so this asserts the label, not the glyph.
  it('labels each difficulty cell as charted or not charted', () => {
    render(DiffMatrix, { rows: [guitar] })
    expect(screen.getByLabelText('Hard: charted')).toBeTruthy()
    expect(screen.getByLabelText('Easy: not charted')).toBeTruthy()
  })

  it('shows its empty state when a chart has no note data', () => {
    // countInstruments() returns null and diffMatrix() returns [] for a catalog row whose
    // noteCounts a scan has not filled in yet, so this branch is what an unscanned chart shows.
    render(DiffMatrix, { rows: [] })
    expect(screen.getByText(/NO CHART DATA/i)).toBeTruthy()
  })
})
