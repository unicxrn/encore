import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSngEntriesForScan } from '../downloads/sng-read-selective'
import { readRepackPlan } from '../downloads/sng-repack'

/**
 * Which `.ini` file a chart's metadata actually comes from, decided the way scan-chart decides it.
 *
 * Two of M14's fixes edit or delete an ini file, and both of them are only safe if they agree with
 * `findIniData` (node_modules/scan-chart/dist/index.js:347) about which file that is. Guessing
 * "the one called song.ini" is right almost always and catastrophic the rest of the time: the file
 * scan-chart parses supplies the seven keys `getChartHash` mixes in, so deleting or editing the
 * wrong one moves the chart's multiplayer identity. `applyFix` would catch it afterwards, with the
 * chart already damaged; this is how the fix avoids getting there.
 *
 * `findIniData`'s rule, transcribed:
 *
 * - every file whose extension lower-cases to `ini` is counted, in the order the reader supplies
 *   them;
 * - the LAST one named exactly `song.ini` wins (`hasIniName` is an exact, case-sensitive match);
 * - failing that, the LAST `.ini` of any name wins, so a chart holding only `desktop.ini` really
 *   is read from `desktop.ini`;
 * - more than one, and `multipleIniFiles` is raised; any not named `song.ini`, and each raises
 *   `invalidIni`.
 *
 * Order therefore matters, and "the order the reader supplies them" is not an abstraction: it is
 * `readdirSync` for a folder chart and the selective `.sng` reader's entry list for an archive,
 * which are exactly the two readers `catalog/issues.ts` scans with. Anything else (sorting the
 * names for tidiness, say) would be a different answer to the same question.
 */
export interface ChartIniFiles {
  /** Every `.ini` scan-chart sees, in the order it sees them. */
  names: string[]
  /** The one `findIniData` hands to the parser, or null when the chart has no `.ini` at all. */
  reads: string | null
  /**
   * The bytes of the file named by `reads`, or null when there is none.
   *
   * For a `.sng` with no packed `song.ini` this is the ini parse-sng synthesises from the
   * archive's header metadata, a file that exists nowhere on disk. See `synthetic`.
   */
  data: Uint8Array | null
  /**
   * True when `reads` names a `.sng`'s synthesised `song.ini` rather than a real file.
   *
   * The distinction is the whole reason a `.sng`'s metadata fix is a different operation: there is
   * no file to edit, so the change has to be made to the archive's header metadata and the
   * archive repacked. Also false for a `.sng` that packs a real `song.ini`, because then the
   * packed file is what scan-chart reads and the header is not.
   */
  synthetic: boolean
}

/** scan-chart's `hasIniExtension`: the last dot-segment, lower-cased, is `ini`. */
export function hasIniExtension(fileName: string): boolean {
  return (fileName.split('.').pop() ?? '').toLowerCase() === 'ini'
}

/** scan-chart's `hasIniName`: exactly this, case-sensitively. Not `Song.ini`, not `SONG.INI`. */
export function hasIniName(fileName: string): boolean {
  return fileName === 'song.ini'
}

/**
 * `findIniData`'s choice, over names already in the reader's order.
 *
 * Exported so it can be tested against orderings a real chart is unlikely to produce but a real
 * filesystem is entitled to hand back.
 */
export function iniFileScanChartReads(names: string[]): string | null {
  let best: string | null = null
  let last: string | null = null
  for (const name of names) {
    if (!hasIniExtension(name)) continue
    last = name
    if (hasIniName(name)) best = name
  }
  return best ?? last
}

/** Read a chart's `.ini` situation, using the same reader the issue scan used. */
export async function readChartIniFiles(
  chartPath: string,
  chartType: 'folder' | 'sng'
): Promise<ChartIniFiles> {
  if (chartType === 'folder') {
    const names = readdirSync(chartPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter(hasIniExtension)
    const reads = iniFileScanChartReads(names)
    // A copy into its own ArrayBuffer, not a view into readFileSync's pool: this is handed
    // straight back to a writer, and a caller that trusted `.buffer` on a pooled Buffer would
    // write whatever else the pool happened to hold.
    const data = reads === null ? null : new Uint8Array(readFileSync(join(chartPath, reads)))
    return { names, reads, data, synthetic: false }
  }

  // The same call `catalog/issues.ts` makes, so the entry order this reasons about is the order
  // the issue row was raised from. Its first entry is always `song.ini` (the archive's own if it
  // packs one, otherwise the synthesised one), and the rest follow in header order.
  const { entries } = await readSngEntriesForScan(chartPath)
  const inis = entries.filter((entry) => hasIniExtension(entry.fileName))
  const reads = iniFileScanChartReads(inis.map((entry) => entry.fileName))
  const read = inis.find((entry) => entry.fileName === reads) ?? null
  return {
    names: inis.map((entry) => entry.fileName),
    reads,
    data: read?.data ?? null,
    // A `.sng` gets a `song.ini` whether or not it packs one, so the name alone cannot tell the
    // two apart. `sngPacksIni` asks the archive.
    synthetic: reads === 'song.ini' && !(await sngPacksIni(chartPath, 'song.ini'))
  }
}

/** Whether the archive really contains an entry with this name, as opposed to the reader's own. */
async function sngPacksIni(sngPath: string, fileName: string): Promise<boolean> {
  const plan = await readRepackPlan(sngPath)
  return plan.entries.some((entry) => entry.fileName === fileName)
}
