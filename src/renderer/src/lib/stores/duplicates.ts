import { derived, get, writable } from 'svelte/store'
import type { DuplicateReport } from '../../../../shared/duplicates'
import { encore } from './bridge'
import { scanProgress } from './scan'

/**
 * What the library holds more than one copy of, read once per launch.
 *
 * It lives in a store rather than inside the view for two reasons, and the second is the one that
 * decided it. App recreates a view component on every navigation back to it, so a
 * component-owned fetch asked main for the whole report each time the user looked; one load per
 * launch is strictly less work than that. And the sidebar draws a count off this report, which it
 * cannot do from a view that is not mounted.
 *
 * What one load costs: two grouped SQL statements over the catalog, plus a size walk over the
 * byte-identical copies alone (`withCopySizes` in main, which is bounded by the number of copies
 * the report has just called spare, and is nothing at all on a library with none). No chart is
 * parsed, no library folder is walked, and nothing here talks to the network.
 */
export const duplicates = writable<DuplicateReport | null>(null)

/** Why the last read failed, and null when it did not. A failure leaves the report alone. */
export const duplicatesError = writable<string | null>(null)

/**
 * Copies that could be removed without losing a chart: every copy past the first in each
 * byte-identical group, and null until a report has arrived.
 *
 * The only number in this report that means "there is something to do". The other two tiers are
 * deliberately not added to it: a chart installed at two versions is two different charts, and a
 * song charted by two people is not a fault at all, so counting either of them here would put a
 * number on the sidebar that the view itself refuses to call spare.
 */
export const spareCopies = derived(duplicates, (report) =>
  report === null
    ? null
    : report.identical.reduce((total, group) => total + group.copies.length - 1, 0)
)

export async function loadDuplicates(): Promise<void> {
  try {
    const report = await encore().catalogDuplicates()
    duplicates.set(report)
    duplicatesError.set(null)
  } catch (err) {
    duplicatesError.set(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Subscribe for the life of the launch: one read now, and another whenever a library scan stops.
 *
 * 'canceled' counts along with 'done' for the reason the scan store gives: a cancelled scan keeps
 * every row it wrote, so the catalog really has moved and a report taken before it is stale.
 */
export function initDuplicates(): () => void {
  void loadDuplicates()
  let last: string | null = null
  return scanProgress.subscribe((progress) => {
    const status = progress?.status ?? null
    const settled = status === 'done' || status === 'canceled'
    if (settled && status !== last) void loadDuplicates()
    last = status
  })
}

/**
 * Drop one copy from the report in place, once it is really gone.
 *
 * Local rather than a second read, and not because of the cost. The library watcher has just seen
 * the folder disappear and will run a scan of its own; re-asking for the whole report puts this in
 * a race with that scan for no gain, when the one thing that changed is a copy the user just
 * removed. A group left holding a single copy is no longer a duplicate of anything, so it goes
 * with it.
 */
export function dropDuplicateCopy(path: string): void {
  const report = get(duplicates)
  if (report === null) return
  duplicates.set({
    ...report,
    identical: report.identical
      .map((group) => ({ ...group, copies: group.copies.filter((c) => c.path !== path) }))
      .filter((group) => group.copies.length > 1),
    // The same chart can be listed under tiers 2 and 3 as well, and a path that is gone must not
    // stay on screen under a heading that offers to open it in a file manager.
    versions: report.versions
      .map((group) => ({ ...group, copies: group.copies.filter((c) => c.path !== path) }))
      .filter((group) => group.copies.length > 1),
    alternates: report.alternates
      .map((group) => ({
        ...group,
        charters: group.charters
          .map((charter) => ({
            ...charter,
            copies: charter.copies.filter((c) => c.path !== path)
          }))
          .filter((charter) => charter.copies.length > 0)
      }))
      .filter((group) => group.charters.length > 1),
    totalCharts: Math.max(0, report.totalCharts - 1)
  })
}
