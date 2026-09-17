import type { IssueSeverity } from '../../../shared/issue-labels'

/**
 * The state of a library, read off an issue report, in the two or three counts a person can hold
 * in their head at once.
 *
 * The report itself is 24,151 rows on the reference library's 219 charts. Nobody reads that, and
 * the old view asked them to start trying immediately: chips, a totals line, then rows. The cards
 * these counts feed are what goes above the rows instead, so the first thing on screen is how much
 * of the library is actually in trouble.
 *
 * **What is deliberately not here: a count of healthy charts.** The prototype had one and the
 * scanner cannot fill it. `issuesScan` resolves with findings, not with charts, so a report of 182
 * affected charts says nothing about how many clean ones it walked past. The two denominators
 * within reach, the catalog's row count and the duplicate report's `totalCharts`, are a different
 * reading taken at a different time by a different mechanism: a library with 50 charts added since
 * the last catalog scan would have them counted as findings and not counted in the total, and
 * "1,204 healthy of 1,190" is the kind of number that costs a view its credibility. Adding the
 * walked count to the scan's payload would make it sayable; until something does, it is not.
 */

/** A graded row, in the fields the counts read. `ExplainedRow` in Tools.svelte satisfies it. */
export interface GradedRow {
  chartPath: string
  severity: IssueSeverity
}

export interface SeverityCount {
  /** Distinct charts carrying at least one finding of this severity. */
  charts: number
  /** Findings of this severity, which on a real library is the much larger number. */
  findings: number
}

export type SeverityCounts = Record<IssueSeverity, SeverityCount>

/**
 * Charts and findings per severity.
 *
 * **Charts are counted once per severity they carry, not once in total.** A chart with no audio
 * and a hundred short sustains is counted by the broken card and by the charting-notes card, so
 * the three counts overlap and do not sum to the size of the report. That is the deliberate half
 * of this: the alternative, filing each chart under the worst thing in it, would make the counts
 * a clean partition and then disagree with the list underneath them, which shows every row of the
 * chosen severity whatever else its chart carries. A card whose number does not match the list it
 * opens is worse than one that overlaps its neighbour and says so, which the card's own sentence
 * does.
 */
export function countBySeverity(rows: GradedRow[]): SeverityCounts {
  const counts: SeverityCounts = {
    blocking: { charts: 0, findings: 0 },
    quality: { charts: 0, findings: 0 },
    portability: { charts: 0, findings: 0 }
  }
  const seen: Record<IssueSeverity, Set<string>> = {
    blocking: new Set(),
    quality: new Set(),
    portability: new Set()
  }
  for (const row of rows) {
    counts[row.severity].findings += 1
    seen[row.severity].add(row.chartPath)
  }
  for (const severity of Object.keys(counts) as IssueSeverity[]) {
    counts[severity].charts = seen[severity].size
  }
  return counts
}

/**
 * Why a row Encore could repair in principle carries no button, in the two cases where the answer
 * is a decision rather than a gap.
 *
 * Every other row without a Fix button is one nothing could fix from a button: a chord shape a
 * charter chose, a note two milliseconds from the last sustain. Those need no sentence, and the
 * view deliberately draws them bare rather than implying Encore could help if only it were asked.
 * These two are different. Both look repairable, both were looked at, and both were refused, so
 * the row says which and why rather than leaving a user to read the absence of a button as an
 * oversight and go looking for the setting that turns it on.
 *
 * The wording is ours, not scan-chart's, and it is kept beside the counts rather than in
 * `shared/issue-labels.ts` because only this view draws it; the labels file is the part both
 * processes read.
 */
const MULTIPLE_CHART_DECISION =
  'Encore will not delete a chart file. The chart file is what Clone Hero matches charts by, so ' +
  "removing the wrong one changes this chart's identity and costs it multiplayer and its " +
  'play history. Moving one of them out yourself is the way to settle it.'

/**
 * The second half of what the row already says, and the half that is a measurement.
 *
 * The meaning `explainIssue` returns for this flavour already says only the charter can set a
 * difficulty rating. What it does not say is that the obvious workaround was tried: the M14 fix
 * work looked all 78 of the reference library's `missingValue` rows up on Chorus by exact chart
 * hash, and every matched entry carried the same `-1` that raises the issue. An exact hash match
 * means Chorus ingested this same upload, so its copy of song.ini holds this same blank.
 */
const MISSING_RATING_DECISION =
  'Chorus cannot fill it either: a chart it matches by hash is this same upload, carrying the ' +
  'same blank.'

/** Same test `explainIssue` uses to tell the two `missingValue` flavours apart. */
const MISSING_DIFFICULTY_RATING = /missing a "diff_/

export function unrepairableNote(code: string, description: string): string | null {
  if (code === 'multipleChart') return MULTIPLE_CHART_DECISION
  if (code === 'missingValue' && MISSING_DIFFICULTY_RATING.test(description)) {
    return MISSING_RATING_DECISION
  }
  return null
}
