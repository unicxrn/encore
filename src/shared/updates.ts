import { z } from 'zod'

/** The fields of a catalog row the update matcher needs; a `ChartRecord` satisfies it. */
export interface LocalChartIdentity {
  path: string
  name: string | null
  artist: string | null
  charter: string | null
  chartHash: string | null
  tempoMapHash: string | null
}

/** One upload as api.enchor.us describes it, narrowed to the fields the matcher and UI use. */
export interface RemoteChart {
  chartId: number
  name: string
  artist: string
  charter: string
  chartHash: string
  md5: string
  modifiedTime: string | null
  tempoMapHash: string | null
  noteCount: number
  hasVideoBackground: boolean
}

/**
 * What the check concluded about one chart.
 *
 * Deliberately not called "outdated"/"up to date". Chorus exposes nothing that orders two
 * uploads of the same chart (see main/updates/match.ts), so the strongest honest claim is that a
 * DIFFERENT version exists, never that it is a newer one.
 */
export type ChartVerdict =
  /** Chorus still serves these exact notes. */
  | { kind: 'current'; local: LocalChartIdentity }
  /** No upload carries these notes, but the same charter's same song is there under other notes. */
  | { kind: 'alternate'; local: LocalChartIdentity; alternates: RemoteChart[] }
  /** Not found on Chorus, renamed beyond recognition, or unhashable. */
  | { kind: 'unknown'; local: LocalChartIdentity }

export interface UpdateCheckSummary {
  verdicts: ChartVerdict[]
  /** Charts whose lookup failed. Reported `unknown`, never silently `current`. */
  failed: number
  /** Searches actually issued, against `verdicts.length` charts considered. */
  requests: number
}

/**
 * Which charts to check. An empty/omitted list means the whole library.
 *
 * Capped because each path can cost a request against a 50-per-minute budget; the cap is the
 * ceiling on one sweep, not on the library.
 */
export const UpdateCheckRequestSchema = z.object({
  paths: z.array(z.string()).max(5000).default([])
})
export type UpdateCheckRequest = z.infer<typeof UpdateCheckRequestSchema>
