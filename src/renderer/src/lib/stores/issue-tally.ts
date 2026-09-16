import { writable } from 'svelte/store'

/**
 * How much of the library the issue report found broken, or null when nothing has scanned.
 *
 * Written by the Issues view and read by the sidebar, which is the only arrangement this number
 * can honestly have. Main caches the report in module state and answers `issuesLast()` with null
 * until a scan has completed in THIS launch, so there is nothing for the sidebar to ask on the
 * launches where nobody opens Issues; and where there IS something, asking would copy the whole
 * report across the boundary to count its rows. On a real library that is 24,151 rows for one
 * integer. So the number is taken where it is already in memory and handed here.
 *
 * Null therefore means "nobody has looked this launch", and it is drawn as nothing at all rather
 * than as a zero. A sidebar reading 0 beside Issues on a library full of broken charts, every
 * launch until the user happens to open the view, is the one thing this must not do.
 *
 * `brokenCharts` and not a count of findings: a report is roughly a hundred charting-craft notes
 * for every actual fault, and a badge reading 24,151 would be alarming and wrong. It is the same
 * number the view's own Broken card carries, so the two cannot disagree.
 */
export interface IssueTally {
  brokenCharts: number
}

export const issueTally = writable<IssueTally | null>(null)
