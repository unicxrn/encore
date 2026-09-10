import { writable, type Writable } from 'svelte/store'
import type { ChartVerdict } from '../../../../shared/updates'
import { encore } from './bridge'

/**
 * The session's Chorus version verdicts, keyed by chart path.
 *
 * Main owns the results: `UpdateService` merges every check the user has run this session, whether
 * a library sweep or a single chart from Detail, and `updatesLast` hands the merged list back from
 * memory. Nothing here ever calls `updatesCheck`: one check is one request against a
 * 50-per-minute budget, and a list scrolling past 219 rows is not the user asking to spend it.
 *
 * A chart with no entry has not been checked, and is drawn as such: absence means "not asked",
 * never "current". The map is replaced wholesale on each replay rather than merged, because main's
 * list is already the merge and a renderer-side copy that outlived it would be the stale one.
 *
 * Detail reads this same map for its CHORUS VERSION card, and writes a check it ran back into it
 * through `recordVerdicts`, so a verdict has one home in the renderer rather than a local copy
 * per view that could disagree with the badge.
 */
export const verdicts: Writable<ReadonlyMap<string, ChartVerdict>> = writable(new Map())

/**
 * Fold the result of a check the user just ran into the map.
 *
 * Main has already merged these into its own list (`UpdateService.check` sets by path and keeps
 * the rest), so this is the same merge applied locally: it leaves the map equal to what
 * `updatesLast` would replay, minus the IPC round trip. Set by path rather than replace, for the
 * same reason main does. A single-chart check from Detail must not blank the sweep's other
 * answers, which the Installed badges are reading.
 */
export function recordVerdicts(list: readonly ChartVerdict[]): void {
  verdicts.update((prev) => {
    const next = new Map(prev)
    for (const v of list) next.set(v.local.path, v)
    return next
  })
}

/**
 * Re-read main's verdicts. One IPC round trip, zero network.
 *
 * Failures are swallowed on purpose: the badge this feeds is an enhancement over a list that is
 * complete without it, and the one way this can fail in practice (an older bridge without the
 * method, or main mid-restart) is not something the Installed view can act on. The previous map
 * is kept, since it is still the last thing main said.
 */
export async function refreshVerdicts(): Promise<void> {
  try {
    const list = await encore().updatesLast()
    verdicts.set(new Map(list.map((v) => [v.local.path, v])))
  } catch {
    /* see above */
  }
}
