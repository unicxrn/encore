import { canonicalize } from '../assets/library-guard'
import { withChartLock } from '../assets/write'
import { chartTypeAt, scanChartIssues, type ChartIssueRow } from '../catalog/issues'
import { beginBackup, type BackupPlan } from './backup-store'
import { albumArtSizeAction } from './actions/album-art-size'
import { badVideoAction } from './actions/bad-video'
import { extraValueAction } from './actions/extra-value'
import { strayIniAction } from './actions/stray-ini'

/**
 * Turning the Issues tab from a report into a repair shop, under one rule.
 *
 * **A fix may never change what Clone Hero matches charts by.** `getChartHash`
 * (node_modules/scan-chart/dist/index.js:2572) hashes exactly two things: the chart file's bytes,
 * and seven gameplay ini keys (`hopo_frequency`, `eighthnote_hopo`, `multiplier_note`,
 * `sustain_cutoff_threshold`, `chord_snap_threshold`, `five_lane_drums`, `pro_drums`), and those
 * only when they differ from their defaults. Nothing else contributes: not video, not album art,
 * not `album`/`year`/`genre`/`charter`, not file names, not archive layout.
 *
 * A fix that changed that hash would make the user's chart un-playable with anyone who has the
 * original, a failure they would discover socially, weeks later, with no way to trace it back to
 * us. So the rule is not a convention this module hopes actions follow: `applyFix` re-scans the
 * chart it has just written and refuses to report success unless the hash is byte-identical.
 * Every action is subject to it, including ones written after this comment.
 *
 * The whole-folder `md5` (`getChartMD5`) WILL change, because it hashes every file name and every
 * byte. That is Chorus's dedupe identity, not Clone Hero's gameplay identity, and changing it is
 * expected and harmless for multiplayer.
 *
 * Since M17 a SECOND identity is asserted beside it, and this is the one Clone Hero writes down
 * itself. After every play the game appends the chart's `checksum` to `~/.clonehero/scorestats.json`,
 * and that value is an MD5 over the chart file's bytes (the DECODED archive entry, for a `.sng`).
 * `cloneHeroChecksum` reproduces it, and a repair must leave it alone as well.
 *
 * What each of the two is for, because they are not symmetric:
 *
 * - `chartHash` covers the seven `song.ini` gameplay keys that the chart-file MD5 does not. The
 *   `strayIni` repair can change which `.ini` scan-chart reads, and so those keys, without going
 *   near the chart file. Only `chartHash` sees that, and it is why it stays.
 * - `cloneHeroChecksum` covers nothing `chartHash` does not: `getChartHash` hashes the chart
 *   file's bytes verbatim, so a chart file that moved moves both. What it adds is that it is
 *   derived by this codebase rather than read out of scan-chart, so the two cannot fail the same
 *   way, and — the point — that it is a number the game has been observed to record. The claim
 *   "a repair cannot break multiplayer" no longer rests only on scan-chart's model of Clone
 *   Hero's identity; it rests on a value Clone Hero wrote.
 *
 * The honest limit, restated rather than removed: what has been verified is that the digest
 * Clone Hero recorded for a played chart equals the one `cloneHeroChecksum` computes for it
 * (catalog/chart-checksum.test.ts, against the owner's install). That is one chart, because
 * `scorestats.json` holds one play. It establishes the derivation; it does not establish that
 * Clone Hero's multiplayer matching uses this digest and nothing else, and no repair asserted
 * here has been played online against an unrepaired copy.
 */

/** Where a fix has got to, for the renderer's progress row. `percent` is null when unknown. */
export interface FixProgress {
  phase: string
  percent: number | null
}

/**
 * A video conversion, as the fix framework needs it.
 *
 * Deliberately not ffmpeg. This module has never heard of ffmpeg, an encoder or a codec. Main
 * wires this to `locateFfmpeg` + `convertToWebm` (see src/main/index.ts), and the tests wire it
 * to something that copies a fixture in a millisecond. Keeping the seam here is what lets the
 * invariant above be tested without a 35-second encode in CI.
 */
export interface VideoConverter {
  /**
   * Why a conversion cannot be run right now, or null when one can.
   *
   * Asked before a button is offered rather than after it is pressed: a conversion takes 35-70
   * seconds, and "ffmpeg is not installed" is something the UI can act on by offering the
   * install, but only if it learns it up front.
   */
  unavailableReason(): Promise<string | null>
  convert(job: {
    input: string
    output: string
    signal?: AbortSignal
    /** 0..1, from ffmpeg's own `-progress` output rather than a spinner pretending to know. */
    onProgress?: (fraction: number) => void
  }): Promise<void>
}

/**
 * Re-encode a cover to exactly 512x512, in the container named by `format`.
 *
 * Injected for the same reason `VideoConverter` is, though for a different missing runtime: the
 * real implementation is `encodeSquareAlbumArt` (src/main/art-encode.ts), which is built on
 * Electron's `nativeImage`. Under vitest the `electron` import resolves to a CJS stub whose
 * `nativeImage` is `undefined`, so a module that called it directly could not be tested at all.
 * That is the same constraint that made the scanner take its art encoder as a parameter
 * (catalog/scanner.ts). Main wires this to the real encoder; the tests wire it to something that
 * returns a 512x512 fixture.
 */
export type AlbumArtSquarer = (data: Uint8Array, format: 'png' | 'jpeg') => Uint8Array

/** Everything an action is given beyond the row itself. */
export interface FixContext {
  /** The write guard's allow-list; every write goes through `assertUnderLibrary` with it. */
  libraryFolders: { path: string }[]
  signal?: AbortSignal
  onProgress?: (progress: FixProgress) => void
  /** Present when video conversion is wired up; an action that needs it and lacks it fails. */
  video?: VideoConverter
  /** Present when image encoding is wired up; the album-art fix needs it and reports why if absent. */
  image?: AlbumArtSquarer
  /**
   * Where the originals a repair replaces are kept, so it can be undone. `null` means no undo.
   *
   * Required rather than optional, and that is the point. Every one of these actions rewrites a
   * file in the user's library and none of them can be taken back without this; a field that could
   * simply be left out would make "irreversible" the accident of a forgotten call site rather than
   * a decision anyone made. Spelling `null` is allowed, and the framework's own unit tests do it
   * where the subject is the framework and not the store, but it has to be spelled.
   *
   * Main passes `<userData>/fix-backups`. See issues/backup-store.ts for what goes in it.
   */
  backupDir: string | null
}

export interface FixAction {
  /** The `ChartIssueRow.code` this action repairs. */
  code: string
  appliesTo(row: ChartIssueRow): boolean
  /**
   * The exact user-facing sentence, naming the file that will be written or removed.
   *
   * Destructive actions must name the file. "Clean up duplicates" is not an acceptable
   * confirmation for something that deletes from a user's library.
   */
  describe(row: ChartIssueRow): string
  /**
   * What this repair is about to replace, read before it runs.
   *
   * Required, not optional, and that is deliberate: an action without one would be an action whose
   * damage cannot be undone, and the compiler is a better guard against that than a convention. It
   * returns a description of the content (the file to copy, the archive entry to extract, the
   * header key and its current value) and `applyFix` is what turns that into bytes on disk, so an
   * action never has to know where backups live or in what shape.
   *
   * Called inside the chart's write lock, immediately before `apply`, so what it reads is what
   * `apply` is about to overwrite. It reads the chart a second time in doing so, because `badVideo`
   * extracts its `video.mp4` here and again to hand to ffmpeg. That is a second pass over as much
   * as 159 MB against a conversion that takes 35-70 seconds. Sharing the extraction would mean
   * `apply` taking its input from wherever the store happened to put it, and coupling the two that
   * way is worth more than the second the copy costs.
   */
  backup(row: ChartIssueRow, ctx: FixContext): Promise<BackupPlan>
  apply(row: ChartIssueRow, ctx: FixContext): Promise<void>
  /**
   * Whether this action can run right now. Absent means always, which is the common case; the
   * video action is the one that depends on a tool that may not be installed.
   */
  availability?(ctx: FixContext): Promise<FixAvailability>
}

export interface FixAvailability {
  available: boolean
  /** Why not, in words the UI can show. Null when available. */
  reason: string | null
}

/**
 * Every fix Encore knows how to perform. Order is irrelevant; no two actions claim a row.
 *
 * **There is deliberately no `missingValue` action, and this is where to read why before adding
 * one.** The approved design called for filling `album`, `year`, `genre` and `charter` from
 * Chorus, matched by an exact `chartHash` so the metadata would come from provably the same chart
 * rather than a guess. The lookup works: searching by text and filtering to an exact hash found
 * an entry for 39 of the affected charts. What it returns is the problem. Measured against every
 * one of the library's 78 rows, not a sample:
 *
 * (The library has 41 distinct charts with a `missingValue` row, not the 47 this comment and the
 * design used to say: 39 charts carry the `diff_*` flavour and 8 the metadata flavour, and 6 carry
 * both. Re-measured at the close of M14. It changes nothing below, which was counted per row.)
 *
 * - all 60 `diff_*` rows: the matched Chorus entry carries `-1`, the same sentinel that raised
 *   the issue. 50 key readings across 35 matched charts, every one of them `-1`.
 * - all 18 `album`/`genre`/`year`/`charter` rows: 4 of their 8 charts matched, and all 4 came back
 *   `"Unknown Album"`, `"Unknown Year"`, `"Unknown Charter"`, which are scan-chart's defaults and
 *   so the same thing as missing.
 *
 * That is not bad luck, it is what an exact hash match means. Chorus ingested these charts from
 * the same uploads the user has, so an entry with this chart's hash is usually built from this
 * chart's `song.ini` and cannot know anything it does not. Zero of 78 rows are fixable, so a fix
 * would be a network client, an IPC round trip and a button that never appears. Worse, it could
 * be one that writes `"Unknown Album"` into `song.ini` and calls it repaired.
 *
 * (The design also recorded that `year` and `genre` come back null. They do not: the API's
 * `chartYear` and `chartGenre` fields are always null, but its plain `year` and `genre` fields
 * carry values. That correction does not change the conclusion, since for an exact hash match
 * those fields hold the same defaults our copy has, but it is the reason the fields were thought
 * unavailable, and someone re-opening this should not repeat the query that suggested it.)
 *
 * Re-open it on a measurement: a library where an exact-hash Chorus entry carries metadata the
 * local chart lacks. Until then those rows correctly offer nothing.
 */
export const FIX_ACTIONS: readonly FixAction[] = [
  badVideoAction,
  extraValueAction,
  albumArtSizeAction,
  strayIniAction
]

/** The action that handles this row, or null when nothing does. */
export function resolveFixAction(
  row: ChartIssueRow,
  actions: readonly FixAction[] = FIX_ACTIONS
): FixAction | null {
  return actions.find((action) => action.appliesTo(row)) ?? null
}

/** The confirmation sentence for a row, or null when Encore cannot fix it. */
export function describeFix(
  row: ChartIssueRow,
  actions: readonly FixAction[] = FIX_ACTIONS
): string | null {
  return resolveFixAction(row, actions)?.describe(row) ?? null
}

export interface FixableCode extends FixAvailability {
  code: string
}

/**
 * Which codes have an action, and whether each can run right now.
 *
 * Per code rather than per row because that is the question the UI asks once, before it renders
 * 24,151 rows, and because availability is a property of the tool a code needs rather than of any
 * one chart. A code whose tool is missing is reported as unavailable WITH the reason, so the
 * Issues tab can offer the install instead of a button that fails 70 seconds later.
 */
export async function fixableCodes(
  ctx: FixContext,
  actions: readonly FixAction[] = FIX_ACTIONS
): Promise<FixableCode[]> {
  return Promise.all(
    actions.map(async (action) => {
      const availability = (await action.availability?.(ctx)) ?? { available: true, reason: null }
      return { code: action.code, ...availability }
    })
  )
}

/**
 * Apply the fix for one issue row, then prove it did not break multiplayer.
 *
 * The order is the whole design:
 *
 * 1. Take the chart's write lock. Everything below reads and writes one chart, and a batch asset
 *    write landing in the middle would make the before/after comparison meaningless.
 * 2. Read the chart hash INSIDE the lock. Reading it outside would compare against a chart some
 *    other writer had already changed, and blame this fix for their edit.
 * 3. Copy aside whatever the action is about to replace, BEFORE it replaces it. A backup that
 *    cannot be written (a full disk, a read-only `userData`) fails the fix here, with the chart
 *    untouched. That is the whole reason it goes first: the alternative is a repair that has
 *    already happened and no way back from it.
 * 4. Apply.
 * 5. Re-scan that one chart, not the library. The per-chart scan is what the UI needs anyway,
 *    and re-running the 3.4 s library report after each of six conversions is 20 s spent learning
 *    what this scan already said.
 * 6. Refuse unless BOTH identities are identical: the checksum Clone Hero records for the chart,
 *    and scan-chart's `chartHash`.
 *
 * **There is still no rollback, deliberately, and an undo is not one.** A rollback would be code
 * that only ever runs in the situation we have already established we do not understand, namely
 * the action doing something we did not predict, and it has no test that could exercise it
 * honestly.
 * Failing loudly with both hashes leaves the user one damaged chart and a message that says which;
 * a bad rollback could leave them a chart that is damaged differently and a message that says
 * everything is fine. What changed at M15 is that the failure is no longer terminal: the backup is
 * committed between steps 4 and 5, BEFORE the hash is checked, so the one case where the user most
 * needs the original back is the one case that now has it. Undoing is a separate, deliberate act
 * with its own checks (issues/restore.ts), not something this function does on their behalf.
 *
 * Returns the chart's fresh issue rows, so the caller can update that chart's section of the
 * report without a full re-scan.
 */
export async function applyFix(
  row: ChartIssueRow,
  ctx: FixContext,
  actions: readonly FixAction[] = FIX_ACTIONS
): Promise<ChartIssueRow[]> {
  const action = resolveFixAction(row, actions)
  if (!action) {
    throw new Error(`Encore has no fix for ${row.code} (${row.chartPath})`)
  }
  const availability = (await action.availability?.(ctx)) ?? { available: true, reason: null }
  if (!availability.available) {
    throw new Error(`Cannot fix ${row.code}: ${availability.reason ?? 'no reason given'}`)
  }

  const chartType = chartTypeAt(row.chartPath)
  return withChartLock(row.chartPath, async () => {
    const before = await scanChartIssues(row.chartPath, chartType)

    const pending =
      ctx.backupDir === null
        ? null
        : await beginBackup(
            ctx.backupDir,
            {
              chartPath: row.chartPath,
              chartType,
              chartHash: before.chartHash,
              cloneHeroChecksum: before.cloneHeroChecksum
            },
            await action.backup(row, ctx)
          )

    try {
      await action.apply(row, ctx)
    } catch (err) {
      // Nothing was replaced, so there is nothing to undo, and a backup nobody can act on is
      // still 159 MB of the user's disk. Discarding is best-effort inside the rethrow so a
      // failure to clean up cannot replace the reason the fix failed.
      try {
        pending?.discard()
      } catch (cleanup) {
        console.warn(`Could not discard the unused backup for ${row.chartPath}:`, cleanup)
      }
      throw err
    }

    // Before the hash check, not after. The chart has been rewritten either way, and if the check
    // below is about to fail this is the only copy of what it replaced.
    try {
      await pending?.commit()
    } catch (err) {
      // The repair really happened and cannot now be undone, and the caller has to be told both
      // halves: reporting only the filesystem error would leave a user re-running a fix that has
      // already been applied, and reporting success would offer an undo that does not exist.
      throw new Error(
        `${row.chartPath} was fixed, but Encore could not save what the fix replaced, so ` +
          `this cannot be undone: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const after = await scanChartIssues(row.chartPath, chartType)
    // Clone Hero's own number first, scan-chart's model second. Not arbitrary: the checksum is
    // the chart file's bytes, the hash is the chart file's bytes PLUS seven ini keys, so between
    // them they partition the failures. A repair that touched the chart file is reported in the
    // game's own terms; one that only moved an ini key falls through to the hash, which is the
    // only one of the two that can see it. Each assertion therefore has a failure only it
    // catches, and a mutation test that fails if it is deleted.
    assertCloneHeroChecksumUnchanged(
      row.chartPath,
      before.cloneHeroChecksum,
      after.cloneHeroChecksum
    )
    assertChartHashUnchanged(row.chartPath, before.chartHash, after.chartHash)
    return after.rows
  })
}

/**
 * One entry per chart with a fix in flight; the value is that fix's abort handle.
 *
 * The same shape, for the same reason, as `perChartDownloads` in sidecars/ytdlp.ts: a conversion
 * runs for 35-70 seconds and the only thing the renderer and the running job share is the chart
 * path. Keyed on the canonicalized path so two spellings of one chart cannot register twice.
 */
const runningFixes = new Map<string, AbortController>()

/**
 * `applyFix` with an abort handle filed under the chart path, so `cancelFix` can stop it.
 *
 * The controller is created here rather than by the caller because the caller is an IPC handler
 * with no way to hold state between two invocations. A `signal` already on the context is
 * respected as well, so either one can stop the fix.
 */
export function runFix(
  row: ChartIssueRow,
  ctx: FixContext,
  actions: readonly FixAction[] = FIX_ACTIONS
): Promise<ChartIssueRow[]> {
  const key = canonicalize(row.chartPath)
  const controller = new AbortController()
  if (ctx.signal) {
    // Chained, not replaced: a caller that brought its own signal keeps it.
    if (ctx.signal.aborted) controller.abort()
    else ctx.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  runningFixes.set(key, controller)
  return applyFix(row, { ...ctx, signal: controller.signal }, actions).finally(() => {
    // Only ever clear our own entry. A second fix started on this chart has already replaced it,
    // and dropping that one would leave the newer fix uncancellable.
    if (runningFixes.get(key) === controller) runningFixes.delete(key)
  })
}

/**
 * Stop the fix running on `chartPath`.
 *
 * A no-op when there is none, which is the normal outcome of a cancel that lost the race to the
 * conversion's own end: the click and the last frame crossed, and the user gets the WebM.
 */
export function cancelFix(chartPath: string): void {
  runningFixes.get(canonicalize(chartPath))?.abort()
}

/** Test seam: how many charts have a cancellable fix in flight. Production code never asks. */
export function pendingFixCount(): number {
  return runningFixes.size
}

/**
 * The invariant, as an assertion.
 *
 * Exported so it can be tested directly as well as through a fix, and so a future caller that
 * writes to a chart outside this module has an obvious thing to call.
 *
 * A hash of null on both sides passes: a chart with no readable chart file has no gameplay
 * identity to preserve, and it already carries an issue row saying so. Null on ONE side does not
 * pass: a fix that made the chart file unreadable is exactly the failure this exists to catch.
 */
export function assertChartHashUnchanged(
  chartPath: string,
  before: string | null,
  after: string | null
): void {
  if (before === after) return
  throw new Error(
    `Fix aborted: it changed the chart hash of ${chartPath}, which would break multiplayer ` +
      `with anyone who has the original (was ${before ?? 'none'}, now ${after ?? 'none'}). ` +
      `The chart has NOT been restored. This is a bug in the fix, not something you did.`
  )
}

/**
 * The same invariant, against the number Clone Hero writes down rather than scan-chart's.
 *
 * ## Why "unknown" is not a case here
 *
 * The value compared is computed fresh, on both sides, from the bytes the re-scan just read
 * (`scanChartIssues`). The catalog's `cloneHeroChecksum` column is never consulted, and that is
 * the deliberate choice: a chart the user has never scanned, or one scanned before the column
 * existed, has a null or absent row, and a guard that read the row would skip itself on exactly
 * the charts nobody has looked at. Reading the disk instead means the check always runs, and
 * costs nothing, because the repair's re-scan has already decoded the chart file.
 *
 * So the only way this is null is that the chart carries no parseable `notes.mid`/`notes.chart`
 * at all. That is tolerated on BOTH sides and refused on one, exactly as `assertChartHashUnchanged`
 * treats its own null:
 *
 * - null before and after: a chart with no chart file has no identity to preserve. It already
 *   carries a `noChart` issue row saying so, and blocking its repairs would mean refusing to
 *   delete a stray `.ini` from a chart whose problem is that it has no notes.
 * - null on one side only: the repair either destroyed the chart file or produced one. Both are
 *   the failure this exists to catch, and both fail.
 *
 * ## What this catches that `assertChartHashUnchanged` would not have
 *
 * Nothing, in content: `getChartHash` hashes the chart file's bytes verbatim, so every edit this
 * sees moves that too. What it changes is which number the user is told about and where it came
 * from. It runs first (see `applyFix`) so that an edit to the chart file is refused in the
 * game's own terms rather than scan-chart's, and it is computed by this codebase from the
 * entries rather than read out of scan-chart, so a defect in one derivation cannot pass both.
 */
export function assertCloneHeroChecksumUnchanged(
  chartPath: string,
  before: string | null,
  after: string | null
): void {
  if (before === after) return
  throw new Error(
    `Fix aborted: it changed the checksum Clone Hero records for ${chartPath}, which would ` +
      `break multiplayer with anyone who has the original (was ${before ?? 'none'}, now ` +
      `${after ?? 'none'}). The chart has NOT been restored. This is a bug in the fix, not ` +
      `something you did.`
  )
}
