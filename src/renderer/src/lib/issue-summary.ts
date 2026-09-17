import { explainIssue, type IssueSeverity } from '../../../shared/issue-labels'
import type { ChartData } from './api/enchor'

/**
 * What a search result already says about its own problems, reduced to one glance.
 *
 * Chorus Encore runs scan-chart over every chart it ingests and hands the three issue arrays
 * back on every search result, so Encore can say whether a chart is broken before anything is
 * downloaded. Nothing else in the row needs a request to make this claim.
 *
 * `explainIssue` is the same severity model the Issues view sorts by, read rather than copied:
 * one list of what counts as breakage, and a scan-chart upgrade that adds a code changes both
 * views at once.
 */
export interface IssueSummary {
  /** Issues Clone Hero will trip over: the chart will not play, or will display wrong. */
  blocking: number
  /** Charting craft and cosmetics. The chart plays; somebody would rather it were tidier. */
  quality: number
  /** The worst thing present, or null when the chart is clean. */
  worst: Extract<IssueSeverity, 'blocking' | 'quality'> | null
  /** Up to three labels for the problems found, worst first, for the row's tooltip. */
  labels: string[]
}

/** One issue, reduced to the two fields the severity model reads. */
export interface Counted {
  code: string
  description: string
}

/**
 * Fold a chart's issues into the pair a row draws.
 *
 * Takes the flattened list rather than a result object, because the two views that draw this
 * mark hold their issues in different shapes: Explore has Chorus Encore's three arrays on the
 * search result, and Installed has the rows Encore's own issue scan wrote. One severity fold
 * for both, so the same problem cannot read as breakage in one list and a note in the other.
 *
 * `portability` is folded into `quality` rather than given a third state. It exists because
 * `badVideo` means different things on different machines, which is a judgement the Issues view
 * makes room for and a dot in a list row has no way to express. Counting it as breakage would
 * mark charts that play here as broken, so it lands on the quieter side.
 */
export function summarizeIssues(found: readonly Counted[], platform: string): IssueSummary {
  let blocking = 0
  let quality = 0
  const blockingLabels: string[] = []
  const qualityLabels: string[] = []

  for (const issue of found) {
    const { label, severity } = explainIssue(issue.code, issue.description, platform)
    if (severity === 'blocking') {
      blocking++
      if (!blockingLabels.includes(label)) blockingLabels.push(label)
    } else {
      quality++
      if (!qualityLabels.includes(label)) qualityLabels.push(label)
    }
  }

  return {
    blocking,
    quality,
    worst: blocking > 0 ? 'blocking' : quality > 0 ? 'quality' : null,
    // Distinct labels rather than one per issue: a chart with 200 `babySustain` rows would
    // otherwise hand the tooltip the same sentence 200 times.
    labels: [...blockingLabels, ...qualityLabels].slice(0, 3)
  }
}

/**
 * The same fold over a Chorus Encore search result, whose issues arrive as three arrays under
 * three different key names.
 */
export function issueSummary(chart: ChartData, platform: string): IssueSummary {
  return summarizeIssues(
    [
      ...(chart.folderIssues ?? []).map((i) => ({
        code: i.folderIssue,
        description: i.description
      })),
      ...(chart.metadataIssues ?? []).map((i) => ({
        code: i.metadataIssue,
        description: i.description
      })),
      ...(chart.notesData?.chartIssues ?? []).map((i) => ({
        code: i.noteIssue,
        description: i.description
      }))
    ],
    platform
  )
}

/**
 * The sentence the indicator carries, or null for a clean chart.
 *
 * Null rather than "no problems found" because the row draws nothing at all when a chart is
 * clean. Measured against api.enchor.us on 2026-09-15: 60 charts in a hundred have no issue
 * of any kind, and a mark on those 60 would be a mark the eye has to skip past on most rows
 * to find the ones that mean something.
 *
 * `finder` opens the sentence, and it is a parameter rather than the word "Chorus" spelled into
 * it because the two lists that draw this mark learned it from different places. Explore is
 * repeating what Chorus Encore sent with the search result; Installed is repeating what Encore's
 * own issue scan found on this disk. A hover that named the wrong one would be telling the user
 * a remote service had looked at their local files.
 */
export function issueTitle(summary: IssueSummary, finder: string): string | null {
  if (summary.worst === null) return null
  const counts: string[] = []
  if (summary.blocking > 0) {
    counts.push(`${summary.blocking} ${summary.blocking === 1 ? 'problem' : 'problems'}`)
  }
  if (summary.quality > 0) {
    counts.push(`${summary.quality} charting ${summary.quality === 1 ? 'note' : 'notes'}`)
  }
  const head =
    summary.worst === 'blocking'
      ? `${finder} found ${counts.join(' and ')} in this chart.`
      : `${finder} found ${counts.join(' and ')}. The chart plays.`
  return `${head} ${summary.labels.join(', ')}.`
}
