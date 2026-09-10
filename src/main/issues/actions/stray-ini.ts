import { join } from 'node:path'
import { fixForRow, fixSentence, invalidIniName } from '../../../shared/issue-fixes'
import { rewriteSngPlan } from '../../assets/sng-asset'
import { removeChartFiles } from '../../assets/write'
import { chartTypeAt, type ChartIssueRow } from '../../catalog/issues'
import { iniFileScanChartReads, readChartIniFiles } from '../chart-ini'
import type { FixAction, FixContext } from '../fix'

/**
 * `invalidIni` and `multipleIniFiles`: remove the `.ini` files Clone Hero is not reading.
 *
 * Two codes, one action, because they are two views of one state. `findIniData`
 * (node_modules/scan-chart/dist/index.js:347) walks a chart's files, counts everything with an
 * `.ini` extension, raises `invalidIni` for each one not named exactly `song.ini` and
 * `multipleIniFiles` if there is more than one. Then it reads exactly one of them. Every extra
 * file is inert: Clone Hero only ever opens `song.ini`. **One** chart in the 219-chart reference
 * library carries this: `In Flames - Take This Life (Neversoft).sng`, which raises both codes at
 * once. Its extra file is a `desktop.ini` that Windows Explorer left behind while someone
 * browsed the folder. (Re-measured at the close of M14. This said "two charts", which was one
 * chart's two rows counted as two charts; `stray-ini.test.ts` had it right.)
 *
 * ## Why the survivor is chosen and not assumed
 *
 * This is the one fix in the milestone that could genuinely break multiplayer, and the mechanism
 * is worth stating plainly. The file `findIniData` returns supplies every ini value scan-chart
 * reads, including the seven `getChartHash` mixes into a chart's identity. Delete the file it was
 * reading and the survivor's `hopo_frequency` takes over. That is a different hash, and a chart
 * the user can no longer play with anyone who has the original.
 *
 * "Keep the one called song.ini" is right almost always and wrong in the case that matters: a
 * chart whose ONLY ini is `desktop.ini` is read from `desktop.ini`, because `findIniData` falls
 * back to the last `.ini` of any name when nothing is called `song.ini`. So the survivor is
 * computed by scan-chart's own rule (`iniFileScanChartReads`, issues/chart-ini.ts) over the names
 * in the order the same reader supplied them, and anything else is removed. A chart where the
 * survivor is the file the row names is refused with a sentence rather than repaired into
 * silence.
 *
 * `applyFix` re-scans and refuses on a moved hash regardless, but that check fires after the file
 * is gone. This is what keeps it from firing.
 *
 * ## What each code removes
 *
 * - `invalidIni` names its file (`"desktop.ini" is not named "song.ini".`), so it removes that
 *   one and only that one. A chart with two stray inis raises two rows and the user can act on
 *   them separately.
 * - `multipleIniFiles` names nothing, so it removes every `.ini` that is not the survivor. That
 *   is the same set the `invalidIni` rows cover, which is not a coincidence: two files cannot
 *   both be named `song.ini` (a directory holds one name once, and the `.sng` reader keys entries
 *   by name), so `multipleIniFiles` always arrives with at least one `invalidIni` beside it.
 *   Fixing either code clears both rows.
 */

/**
 * `invalidIniName` parses the file an `invalidIni` row names out of scan-chart's own template. It
 * lives in shared/issue-fixes.ts, because the renderer needs the same reading to decide whether
 * to draw a Fix button. A row whose wording it cannot parse gets no fix in either process.
 * Re-exported here so this module still reads as the one place these two codes are understood.
 */
export { invalidIniName }

/**
 * The `.ini` files to remove, and the one to keep, for this row.
 *
 * Read fresh rather than taken from the row: the report may be minutes old, and a chart whose ini
 * files have changed since is one where the survivor may have changed too.
 */
async function resolveRemovals(
  row: ChartIssueRow,
  chartType: 'folder' | 'sng'
): Promise<{ survivor: string; remove: string[] }> {
  const { names } = await readChartIniFiles(row.chartPath, chartType)
  const survivor = iniFileScanChartReads(names)
  if (survivor === null) {
    throw new Error(`${row.chartPath} has no .ini files left. Scan the library again and retry.`)
  }
  const strays = names.filter((name) => name !== survivor)

  if (row.code === 'invalidIni') {
    const named = invalidIniName(row)
    if (named === null) {
      throw new Error(
        `Encore does not recognize this issue's wording and will not guess which file to ` +
          `delete: ${JSON.stringify(row.description)}`
      )
    }
    if (named === survivor) {
      throw new Error(
        `Encore will not remove ${named} from ${row.chartPath}: it is misnamed, but it is also ` +
          `the file scan-chart reads this chart's metadata from, so deleting it would change ` +
          `what Clone Hero matches this chart by. Rename it to song.ini instead.`
      )
    }
    if (!strays.includes(named)) {
      throw new Error(
        `${row.chartPath} no longer contains ${named}. Scan the library again and retry.`
      )
    }
    return { survivor, remove: [named] }
  }

  if (strays.length === 0) {
    throw new Error(
      `${row.chartPath} has only one .ini file left. Scan the library again and retry.`
    )
  }
  return { survivor, remove: strays }
}

export const strayIniAction: FixAction = {
  // One action, two codes. `code` is the label the UI groups availability by, and both codes
  // resolve to this action through `appliesTo`; nothing else in the framework reads it.
  code: 'invalidIni',

  // Both delegate to shared/issue-fixes.ts, so main and the renderer cannot form two opinions
  // about which rows this repairs or what it promises to delete. Note that this covers
  // `multipleIniFiles` rows as well as `invalidIni` ones, which is why the renderer asks
  // `fixForRow` rather than testing a row's code against the `code` field above.
  appliesTo: (row) => fixForRow(row)?.actionCode === 'invalidIni',

  describe: (row) => fixSentence(row, 'invalidIni'),

  /**
   * Keep every `.ini` file this repair is about to delete.
   *
   * Bytes, all of them: the reference library's one case is a 282-byte `desktop.ini`. Deleting a
   * file is the only one of the four repairs where the user cannot reconstruct what was lost by
   * looking at what is left, which is exactly why it needs the undo least in disk terms and most
   * in kind.
   *
   * `resolveRemovals` is the same call `apply` makes, under the same lock, so the set backed up is
   * the set deleted. `remove` is empty because this repair creates nothing: the undo puts files
   * back and takes nothing away.
   */
  backup: async (row) => {
    const chartPath = row.chartPath
    const chartType = chartTypeAt(chartPath)
    const { remove } = await resolveRemovals(row, chartType)
    return {
      code: row.code,
      actionCode: 'invalidIni',
      describe: fixSentence(row, 'invalidIni'),
      files: remove.map((fileName) => ({
        fileName,
        content:
          chartType === 'sng'
            ? ({ kind: 'sngEntry', sngPath: chartPath } as const)
            : ({ kind: 'copyFile', path: join(chartPath, fileName) } as const)
      }))
    }
  },

  apply: async (row, ctx) => {
    const chartPath = row.chartPath
    const chartType = chartTypeAt(chartPath)
    ctx.onProgress?.({ phase: 'removing stray .ini files', percent: null })
    const { remove } = await resolveRemovals(row, chartType)

    if (chartType === 'sng') {
      await removeSngEntries(chartPath, remove, ctx)
      return
    }
    removeChartFiles(chartPath, remove, ctx.libraryFolders)
  }
}

/**
 * Drop entries from a `.sng` and repack.
 *
 * The removal is asserted against the plan rather than assumed: a `.sng`'s scan list always
 * contains a `song.ini` whether or not the archive packs one (the reader synthesises it from the
 * header), so a name that came from that list is not automatically an entry that exists. It never
 * is the survivor, which is the only one that could be synthetic. But "never" here rests on a
 * rule in another module, and a rebuild that silently removed nothing would report a fix that did
 * nothing.
 */
async function removeSngEntries(sngPath: string, remove: string[], ctx: FixContext): Promise<void> {
  await rewriteSngPlan(
    sngPath,
    (plan) => {
      const entries = plan.entries.filter((entry) => !remove.includes(entry.fileName))
      if (entries.length === plan.entries.length) {
        throw new Error(
          `${sngPath} does not contain ${remove.join(', ')}. Scan the library again and retry.`
        )
      }
      return { ...plan, entries }
    },
    ctx.libraryFolders
  )
}
