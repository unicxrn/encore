import type { ChartVerdict, LocalChartIdentity, RemoteChart } from '../../shared/updates'

export type { ChartVerdict, LocalChartIdentity, RemoteChart }

/**
 * Deciding whether Chorus holds a different version of a chart the user already has.
 *
 * There is no cross-revision identity in the api.enchor.us response, and this module exists
 * because of that absence rather than in spite of it. What was checked against the live API on
 * 2026-09-09, before any of this was written:
 *
 *   - `versionGroupId` reads like a revision group and is not one. Every group that held more
 *     than one row held rows with an IDENTICAL `md5` and an identical `chartHash`: the same
 *     bytes reached through several Google Drive packs. It groups mirrors, not revisions.
 *   - `chartId` is per-upload, not per-chart. One charter's unchanged chart was present under
 *     three ids at once (JRabes, "Meet Me in the Graveyard": 334437, 444518, 747184, one
 *     `chartHash` between them), so a stored id cannot be re-found after a re-upload.
 *   - Superseded uploads are NOT withdrawn; old and new sit in the index together.
 *   - There is no version-history endpoint (`/chart/:id`, `/chart/:id/versions`, `/versions/:id`,
 *     `/song/:id`, `/charts/:id` all 404).
 *   - `chartHash` cannot serve either: it hashes the notes, so a revision necessarily differs.
 *
 * What is left is a conjunction of weak signals: same charter, same artist, same song title,
 * corroborated by an unchanged tempo map. On 6019 live charts that conjunction put two different
 * `chartHash`es in one bucket 0.97% of the time, and on the owner's 219-chart library it flagged
 * exactly one chart, which was confirmed a genuine revision by downloading it: same charter, same
 * title, same tempo map, 12377 notes trimmed to 12374.
 *
 * Two limits follow, and both are deliberate rather than oversights:
 *
 *   1. This reports that a DIFFERENT version exists, never that it is a NEWER one. Neither field
 *      that could order two uploads survives scrutiny: `modifiedTime` is the mtime of one Drive
 *      copy (mirrors of identical bytes carry different ones) and `chartId` disagrees with it in
 *      both directions across sampled revision pairs. The user is shown the evidence and decides.
 *   2. When the user's exact notes are still in the index this returns `current`, which misses a
 *      revision whose predecessor was left listed. That trade is measured, not assumed: on the
 *      real library, treating those buckets as updatable would have produced four wrong prompts
 *      (each "alternate" was an older, smaller cut) against zero extra true findings.
 */

/** Titles and names vary by case and stray spacing between song.ini and the index. */
function norm(value: string | null): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Whether `remote` is the same chart as `local`, ignoring which revision each is.
 *
 * The tempo-map clause only ever subtracts: a mismatch rejects, but an absence on either side
 * does not, because a chart with no parsed tempo map would otherwise be unmatchable forever.
 */
function isSameChart(local: LocalChartIdentity, remote: RemoteChart): boolean {
  if (norm(local.charter) !== norm(remote.charter)) return false
  if (norm(local.artist) !== norm(remote.artist)) return false
  if (norm(local.name) !== norm(remote.name)) return false
  if (
    local.tempoMapHash !== null &&
    remote.tempoMapHash !== null &&
    local.tempoMapHash !== remote.tempoMapHash
  ) {
    return false
  }
  return true
}

/**
 * Classify one local chart against every remote row gathered for it.
 *
 * `pool` is not required to be pre-filtered. The caller pools results from whatever searches it
 * ran, and this picks its own bucket out of them.
 */
export function classifyChart(local: LocalChartIdentity, pool: RemoteChart[]): ChartVerdict {
  // An unhashable chart, or one with no charter/title, has no identity to match on. Saying
  // "unknown" is the only answer that cannot put a replace prompt on a chart we cannot name.
  if (local.chartHash === null || norm(local.charter) === '' || norm(local.name) === '') {
    return { kind: 'unknown', local }
  }

  const bucket = pool.filter((r) => isSameChart(local, r))
  if (bucket.length === 0) return { kind: 'unknown', local }
  if (bucket.some((r) => r.chartHash === local.chartHash)) return { kind: 'current', local }

  // One entry per distinct set of notes: mirrors of the same upload are the same offer.
  const byHash = new Map<string, RemoteChart>()
  for (const r of bucket) if (!byHash.has(r.chartHash)) byHash.set(r.chartHash, r)
  const alternates = [...byHash.values()].sort((a, b) => b.noteCount - a.noteCount)
  return { kind: 'alternate', local, alternates }
}
