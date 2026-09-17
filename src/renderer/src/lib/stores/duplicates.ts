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

/**
 * Enough of the shape for `spareCopies` to count it without throwing.
 *
 * Only the three lists and the copies inside the identical ones, because those are what is read
 * inside a store notification. The rest of the report is read by the view, from runes, where a
 * throw is one component failing rather than the whole renderer.
 */
function isReport(value: unknown): value is DuplicateReport {
  if (typeof value !== 'object' || value === null) return false
  const report = value as Partial<DuplicateReport>
  return (
    Array.isArray(report.identical) &&
    Array.isArray(report.versions) &&
    Array.isArray(report.alternates) &&
    report.identical.every((group) => Array.isArray(group?.copies))
  )
}

export async function loadDuplicates(): Promise<void> {
  try {
    const report = await encore().catalogDuplicates()
    // The rule stores/search.ts states about a search body, for the same reason and earlier in
    // the launch. This answer is handed straight to `spareCopies`, which reads three fields off
    // it, and that read runs inside a store notification. svelte/store's notification queue is
    // module-global and an exception escaping one leaves it non-empty, so every `set` in the
    // renderer afterwards updates its value and tells nobody: the app keeps running, stops
    // redrawing, and reports nothing, while `get` goes on answering correctly. This one is read
    // once at launch before the user has touched anything, so a bad answer here freezes the whole
    // window from its first paint, and the catch below would swallow the only sign of it.
    //
    // Measured in a real engine: with this read answering undefined, pressing the player bar's
    // Repeat leaves `aria-pressed` false, Installed's Favourites filter does not light, Explore's
    // advanced panel does not open and its grid stays empty holding 25 rows. With it answering a
    // report, all four work in the same window.
    if (!isReport(report)) throw new Error('Duplicate report: invalid answer')
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
