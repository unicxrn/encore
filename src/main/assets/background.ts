import { assertUnderLibrary } from './library-guard'
import { writeSngAsset } from './sng-asset'
import { replacementOf, writeWithUndo } from './undoable-write'
import { writeChartAsset } from './write'

/** The one name the background writer produces. Clone Hero reads `background.png` and nothing else. */
const BACKGROUND_FILE = 'background.png'

/**
 * Write a renderer-generated background into a chart, keeping the one it replaces.
 *
 * The bytes come from the renderer, where the background is drawn on an OffscreenCanvas, which is
 * why this cannot run in the main-process batch. They used to land straight on `writeChartFile`,
 * overwriting whatever `background.png` the chart had. A user who generated one over a background
 * they liked had no way back. This is the same write with what it replaces copied aside first;
 * see `writeWithUndo`.
 *
 * No `removeMatching`: there is exactly one accepted name, so nothing is superseded and a
 * `background.jpg` the chart also holds is not this writer's business.
 *
 * `backupDir` is where the previous background is kept, or `null` for no undo.
 */
export async function writeBackground(
  chartPath: string,
  chartType: 'folder' | 'sng',
  data: Uint8Array,
  libraryFolders: { path: string }[],
  backupDir: string | null
): Promise<void> {
  // Before the chart is read, not only before it is written: the backup lists and hashes the
  // chart first, and a renderer-supplied path must not be read from outside the library either.
  assertUnderLibrary(chartPath, libraryFolders)
  const chart = { chartPath, chartType, backupDir }
  await writeWithUndo(chart, 'background', async () => {
    // Replaced in place when it was there; created, and so removed by the undo, when not.
    return {
      ...(await replacementOf(chart, BACKGROUND_FILE)),
      // The two writers directly rather than `writeChartFile`, which would take the lock
      // `writeWithUndo` already holds.
      write: async () => {
        if (chartType === 'sng')
          await writeSngAsset(chartPath, BACKGROUND_FILE, data, libraryFolders)
        else writeChartAsset(chartPath, BACKGROUND_FILE, data, libraryFolders)
      }
    }
  })
}
