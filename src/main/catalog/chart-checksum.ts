import { createHash } from 'node:crypto'

/**
 * Clone Hero's own identity for a chart: an MD5 over the bytes of the chart file alone.
 *
 * This is the `checksum` field Clone Hero writes into `scorestats.json` after every play, and it
 * is the only thing that joins a recorded play back to a chart in our catalog. Nothing else in
 * that file identifies the chart unambiguously: song/artist/charter are free text a charter can
 * repeat, and the same three strings routinely name several different charts in one library.
 *
 * Verified against the owner's install on 2026-09-11. Clone Hero v1.1.0.6142-final recorded
 * `E54E9A0521444E81BD1FED4F3F3A3201` for "The Smile - Skrting On The Surface (Mech)", and the
 * MD5 of the `notes.chart` entry inside that `.sng` is `e54e9a0521444e81bd1fed4f3f3a3201`. Note
 * both halves of that: the digest covers the chart file's bytes and nothing else, and for a
 * `.sng` those are the DECODED bytes of the archive entry, not the archive file on disk.
 *
 * Two hashes already on ChartRecord are deliberately NOT this one, and neither can substitute:
 *
 * - `chartHash` is scan-chart's `getChartHash`, which appends seven song.ini gameplay keys to the
 *   chart file's bytes and returns base64url BLAKE3. Different algorithm, different input,
 *   different encoding. It is the wider of the two — those keys are covered by it and not by
 *   this — and `issues/fix.ts` asserts both for that reason.
 * - scan-chart's whole-folder `getChartMD5` hashes every file's NAME and DATA, so album art or
 *   audio moves it. That is the value `includeMd5: true` would produce, and it is not this.
 *
 * Case is normalised to lower hex here because Clone Hero writes upper hex and `createHash`
 * produces lower. Every comparison in this codebase therefore happens on the stored,
 * already-lowercased form; see `normalizeChecksum` for the read side of that.
 */

/**
 * The chart file's name, lowercased, in the order this hashes them.
 *
 * A chart carrying both is rare enough that scan-chart reports it as the `multipleChart` folder
 * issue rather than treating it as normal. When it happens, something has to choose, and the
 * order here is scan-chart's own: it sorts its candidates `mid` first and parses `chartFiles[0]`
 * (scan-chart/dist/index.js:2245). Matching it means this digest and the `chartHash` stored
 * beside it always describe the same file.
 *
 * What is NOT established is that Clone Hero agrees. The verification below was done on a chart
 * with one chart file, which says nothing about the tie-break, and no source for the game's own
 * preference was found. On a both-files chart this may therefore hash the file Clone Hero did
 * not, and the failure is silent: a well-formed digest that no play ever matches. It costs that
 * chart its play data and nothing else.
 */
const CHART_FILE_NAMES = ['notes.mid', 'notes.chart'] as const

/** A chart-file entry as both scan paths already produce it. */
export interface ChartFileEntry {
  fileName: string
  data: Uint8Array
}

/**
 * Clone Hero's checksum for a chart, or null when the entries carry no chart file's bytes.
 *
 * Null rather than a throw: both callers are mid-scan, a chart with no `notes.*` is already a
 * chart the scan reports problems for, and losing the catalog row over a missing play-data join
 * would be a poor trade. A null column simply never matches a play.
 *
 * Entries whose `data` is empty are treated as absent. Both scan paths hand back every file
 * NAMED with bytes only for the ones scan-chart parses, and a zero-length read would otherwise
 * hash to d41d8cd9..., the MD5 of nothing, on every chart alike — a value that would collide
 * every such chart onto one play.
 */
export function cloneHeroChecksum(entries: readonly ChartFileEntry[]): string | null {
  for (const wanted of CHART_FILE_NAMES) {
    const entry = entries.find((e) => e.fileName.toLowerCase() === wanted)
    if (entry && entry.data.length > 0) {
      return createHash('md5').update(entry.data).digest('hex')
    }
  }
  return null
}

/**
 * A checksum from Clone Hero's own file, reduced to the form the catalog stores, or null when it
 * is not a 32-character hex digest at all.
 *
 * Clone Hero writes upper hex; the catalog stores lower. Anything else is a malformed record
 * rather than a chart we have not scanned, and returning null keeps the two indistinguishable
 * at the call site on purpose: both mean "no play to attach", and neither is worth an error.
 */
export function normalizeChecksum(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^[0-9a-fA-F]{32}$/.test(trimmed)) return null
  return trimmed.toLowerCase()
}
