import { describe, expect, it } from 'vitest'
import { countBySeverity, unrepairableNote, type GradedRow } from './issue-cards'

const row = (chartPath: string, severity: GradedRow['severity']): GradedRow => ({
  chartPath,
  severity
})

describe('the counts behind the health cards', () => {
  it('answers zero for every severity when the report is empty', () => {
    const counts = countBySeverity([])

    expect(counts.blocking).toEqual({ charts: 0, findings: 0 })
    expect(counts.quality).toEqual({ charts: 0, findings: 0 })
    expect(counts.portability).toEqual({ charts: 0, findings: 0 })
  })

  it('counts a chart once however many findings of one severity it carries', () => {
    const counts = countBySeverity([
      row('/library/a', 'quality'),
      row('/library/a', 'quality'),
      row('/library/a', 'quality')
    ])

    expect(counts.quality).toEqual({ charts: 1, findings: 3 })
  })

  /**
   * The overlap, stated as a test because the card sentences promise it.
   *
   * One chart, broken and full of charting notes, is counted by both cards. Filing it under the
   * worst thing in it instead would make the three counts sum to the report and then disagree
   * with the list each card opens, which lists every row of that severity whatever else its
   * chart carries.
   */
  it('counts one chart under every severity it carries, not under the worst one', () => {
    const counts = countBySeverity([
      row('/library/a', 'blocking'),
      row('/library/a', 'quality'),
      row('/library/b', 'quality')
    ])

    expect(counts.blocking.charts).toBe(1)
    expect(counts.quality.charts).toBe(2)
    // Two charts in the report, three charts across the cards.
    expect(counts.blocking.charts + counts.quality.charts).toBe(3)
  })

  it('keeps the platform severity apart from the two that are about the chart', () => {
    const counts = countBySeverity([
      row('/library/a', 'portability'),
      row('/library/b', 'blocking')
    ])

    expect(counts.portability).toEqual({ charts: 1, findings: 1 })
    expect(counts.blocking).toEqual({ charts: 1, findings: 1 })
    expect(counts.quality.charts).toBe(0)
  })
})

describe('the two findings Encore refuses to repair', () => {
  it('refuses to delete a chart file, in terms of what deleting one would cost', () => {
    const note = unrepairableNote('multipleChart', 'This chart has more than one chart file.')

    expect(note).not.toBeNull()
    expect(note).toContain('will not delete a chart file')
    // The reason has to be the identity, because that is the reason. A refusal with no cost
    // attached reads as Encore not having got round to it.
    expect(note).toContain('multiplayer')
  })

  /**
   * `missingValue` carries two unrelated flavours separated only by their text, and only the
   * difficulty-rating one was refused. The other really is a metadata gap.
   */
  it('answers only for the difficulty-rating flavour of a missing value', () => {
    expect(
      unrepairableNote('missingValue', 'Metadata is missing a "diff_guitar" value.')
    ).toContain('same upload')
    expect(
      unrepairableNote('missingValue', 'Metadata is missing the "artist" property.')
    ).toBeNull()
  })

  it('says nothing at all about a row nobody decided anything about', () => {
    expect(unrepairableNote('badSustainGap', 'A note is too close to the last sustain.')).toBeNull()
    expect(unrepairableNote('albumArtSize', 'The album art is 1024x1024.')).toBeNull()
  })
})
