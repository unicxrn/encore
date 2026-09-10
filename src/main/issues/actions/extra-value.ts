import { extraValueKey, fixForRow, fixSentence } from '../../../shared/issue-fixes'
import { rewriteSngPlan } from '../../assets/sng-asset'
import { writeChartAsset } from '../../assets/write'
import { chartTypeAt, type ChartIssueRow } from '../../catalog/issues'
import { readRepackPlan } from '../../downloads/sng-repack'
import { readChartIniFiles, type ChartIniFiles } from '../chart-ini'
import type { FixAction, FixContext } from '../fix'
import { assertKeyIsNotHashed, removeSongIniKey } from '../ini-edit'

/**
 * `extraValue`: remove a difficulty rating for an instrument the chart does not have.
 *
 * scan-chart raises this when `song.ini` sets, say, `diff_bass` while the chart file contains no
 * bass track (`checkExtraDifficulty`, node_modules/scan-chart/dist/index.js:2735). Clone Hero
 * shows the rating in the song list, so the chart advertises a bass part nobody can play. That is
 * the usual fingerprint of a Rock Band or Guitar Hero conversion that kept the source game's
 * ratings.
 *
 * This is the only fix in the milestone that deletes a value rather than adding or replacing one,
 * and it is the one where that is unambiguously right: scan-chart has already PROVEN the value is
 * wrong by reading the chart file and finding no such instrument. Nothing is being guessed. The
 * highest-volume fix available, at 93 rows across 23 charts of the 219-chart reference library.
 *
 * **It cannot move the multiplayer hash, and is checked twice over anyway.** `getChartHash` mixes
 * in seven ini keys and none of the eleven `diff_*` keys scan-chart raises this code for is among
 * them; `assertKeyIsNotHashed` refuses the seven (and the two legacy spellings that feed them)
 * before a byte is written; and `applyFix` re-scans afterwards and refuses to report success on a
 * hash that moved. The first of those is the one that would still hold if scan-chart's rule
 * changed under us.
 */

/**
 * `extraValueKey` (which `diff_*` key a row names, matched against scan-chart's own templates and
 * key list) lives in shared/issue-fixes.ts, because the renderer needs the same reading to decide
 * whether to draw a Fix button. A row whose wording it cannot parse gets no fix in either
 * process. Re-exported here so this module still reads as the one place `extraValue` is
 * understood.
 */
export { extraValueKey }

/**
 * The key this row names, or a refusal.
 *
 * Shared by `backup` and `apply` so the two cannot disagree about which value is at stake. A
 * backup of one key followed by the deletion of another would leave an undo that puts back
 * something the repair never removed.
 */
function requireExtraValueKey(row: ChartIssueRow): string {
  const key = extraValueKey(row)
  if (key === null) {
    throw new Error(
      `Encore does not recognize this issue's wording and will not guess which value to ` +
        `delete: ${JSON.stringify(row.description)}`
    )
  }
  return key
}

/** The chart's ini situation, with the "there is one" case narrowed for the callers below. */
async function requireChartIni(
  chartPath: string,
  chartType: 'folder' | 'sng'
): Promise<ChartIniFiles & { reads: string }> {
  const ini = await readChartIniFiles(chartPath, chartType)
  if (ini.reads === null) {
    throw new Error(`${chartPath} has no song.ini to edit. Scan the library again and retry.`)
  }
  return { ...ini, reads: ini.reads }
}

/**
 * A `.sng` that packs its own `song.ini` has two sources of truth for the same value: the packed
 * file, which is what scan-chart reads, and the header metadata, which is what Clone Hero's song
 * list reads. Editing either alone would leave the other saying the opposite, and editing both is
 * two changes to a chart the user asked one thing about. No archive in the reference library is in
 * this state; the one that is gets a sentence, not a surprise.
 */
function packedIniRefusal(chartPath: string): Error {
  return new Error(
    `${chartPath} packs its own song.ini as well as header metadata, and Encore will not ` +
      `guess which of the two Clone Hero reads. Remove the packed song.ini and re-scan.`
  )
}

/** Raised by both halves of the header edit, so a backup fails with the same words the fix would. */
function missingHeaderKey(key: string): Error {
  return new Error(
    `Encore could not find "${key}" in this chart's header metadata, even though the ` +
      `chart's metadata sets it. The chart has not been changed.`
  )
}

export const extraValueAction: FixAction = {
  code: 'extraValue',

  // Both delegate to shared/issue-fixes.ts, so main and the renderer cannot form two opinions
  // about which rows this repairs or what it promises to delete.
  appliesTo: (row) => fixForRow(row)?.actionCode === 'extraValue',

  describe: (row) => fixSentence(row, 'extraValue'),

  /**
   * Keep whichever of the two things this repair is about to edit.
   *
   * A folder chart's rating lives in a `song.ini` file, and the whole file is kept. It runs to a
   * few hundred bytes, and restoring it byte for byte is a stronger guarantee than reinstating one
   * line into a file whose formatting, ordering and line endings would then have to be reproduced
   * exactly. A `.sng` that has no packed `song.ini` keeps its rating in the archive's header
   * instead, so what is kept there is the key and the value it holds, and the undo writes it back
   * into the header.
   *
   * The refusals below are the same ones `apply` makes, in the same order, so a fix that cannot
   * run says so before anything has been copied rather than after.
   */
  backup: async (row) => {
    const key = requireExtraValueKey(row)
    assertKeyIsNotHashed(key)

    const chartPath = row.chartPath
    const chartType = chartTypeAt(chartPath)
    const ini = await requireChartIni(chartPath, chartType)

    const plan = {
      code: row.code,
      actionCode: 'extraValue' as const,
      describe: fixSentence(row, 'extraValue')
    }
    if (ini.synthetic) {
      const metadata = (await readRepackPlan(chartPath)).metadata
      if (!Object.hasOwn(metadata, key)) throw missingHeaderKey(key)
      return { ...plan, files: [], metadata: [{ key, value: metadata[key] }] }
    }
    if (chartType === 'sng') throw packedIniRefusal(chartPath)
    if (ini.data === null) throw new Error(`Could not read ${ini.reads} in ${chartPath}.`)
    return {
      ...plan,
      files: [{ fileName: ini.reads, content: { kind: 'data' as const, data: ini.data } }]
    }
  },

  apply: async (row, ctx) => {
    // Before anything is read, so a caller that reached this with a hashed key never gets as far
    // as opening the chart.
    const key = requireExtraValueKey(row)
    assertKeyIsNotHashed(key)

    const chartPath = row.chartPath
    const chartType = chartTypeAt(chartPath)
    ctx.onProgress?.({ phase: 'editing song.ini', percent: null })
    const ini = await requireChartIni(chartPath, chartType)

    if (ini.synthetic) {
      await removeFromSngHeader(chartPath, key, ctx)
      return
    }
    if (chartType === 'sng') throw packedIniRefusal(chartPath)

    if (ini.data === null) throw new Error(`Could not read ${ini.reads} in ${chartPath}.`)
    const edited = removeSongIniKey(ini.data, key)
    if (edited.removed === 0) {
      // Not a silent success. scan-chart found the value, so it is in the file somewhere this
      // could not see (an encoding or a layout the line editor does not handle), and returning
      // normally would report a fix that changed nothing.
      throw new Error(
        `Encore could not find a "${key}" line in ${ini.reads}, even though the chart's metadata ` +
          `sets it. The file has not been changed.`
      )
    }
    // The same name back, so no stale-sibling sweep is needed and no other file is disturbed.
    writeChartAsset(chartPath, ini.reads, edited.bytes, ctx.libraryFolders)
  }
}

/**
 * Drop the key from a `.sng`'s header metadata and repack.
 *
 * A `.sng` has no `song.ini` file: title, artist and every difficulty rating live in the
 * archive's header, and the `song.ini` scan-chart is given is synthesised from it
 * (`generateSongIniText`, downloads/sng-read-selective.ts). So the edit is to the header, and the
 * archive has to be rebuilt around it.
 *
 * Deleting the key rather than writing `-1` into it. Both silence the issue (the generator omits a
 * key holding its default), but `-1` would leave the header carrying a rating that means "unset",
 * which is a value where there should be no key at all.
 *
 * `verifyRepack` compares the rebuilt archive against the plan it was BUILT from, not against the
 * source, so a deliberately removed key verifies as correct. What it still proves is that the
 * rebuild is exactly what was asked for: it walks the new plan's metadata and then checks the
 * rebuild invented no key of its own, so this cannot quietly gain or lose anything else.
 */
async function removeFromSngHeader(sngPath: string, key: string, ctx: FixContext): Promise<void> {
  await rewriteSngPlan(
    sngPath,
    (plan) => {
      if (!Object.hasOwn(plan.metadata, key)) throw missingHeaderKey(key)
      // A fresh object rather than a `delete` on the plan's own: the caller's plan describes the
      // archive still on disk and is what a failed rebuild leaves behind.
      const metadata = Object.fromEntries(
        Object.entries(plan.metadata).filter(([name]) => name !== key)
      )
      return { ...plan, metadata }
    },
    ctx.libraryFolders
  )
}
