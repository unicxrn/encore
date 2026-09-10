import type { UpdateTarget } from '../../shared/app-update'

/**
 * Everything the probe reads, passed in rather than reached for.
 *
 * The real values come from Electron and the process, and none of them can be set from a test:
 * `app.isPackaged` is fixed by how the process was started, and the marker file lives inside a
 * packaged app's resources directory. Taking them as parameters is what lets the suite cover
 * platforms and packagings this machine is not.
 */
export interface UpdateTargetProbe {
  platform: NodeJS.Platform
  /** `app.isPackaged`. False under `electron-vite dev` and under `electron .`. */
  packaged: boolean
  env: Record<string, string | undefined>
  /**
   * The contents of the `package-type` marker, trimmed, or null when there is none.
   *
   * electron-builder's FpmTarget writes this file into the packaged resources directory for the
   * formats it produces (deb, rpm, pacman). Nothing else writes it, so an AppImage and a snap
   * both have none.
   */
  readPackageType: () => string | null
}

/**
 * Which of electron-updater's paths this copy of Encore will take.
 *
 * The order below is not arbitrary. It mirrors electron-updater's own selection so the sentence
 * the UI prints and the code that would actually run cannot disagree:
 *
 *   - `main.js` picks NsisUpdater on win32 and MacUpdater on darwin without looking further.
 *   - On Linux it defaults to AppImageUpdater, then reads `resourcesPath/package-type` and
 *     swaps in DebUpdater, RpmUpdater or PacmanUpdater when the marker names one.
 *   - AppImageUpdater then disables itself in `isUpdaterActive()` when APPIMAGE is unset, and
 *     logs "SNAP env is defined, updater is disabled" when SNAP is what it found instead.
 *
 * SNAP is checked before the marker here only because a snap never has one; the answer is the
 * same either way, and checking it first is what makes the snap case a named state rather than
 * the leftover.
 *
 * `packaged` comes first because none of the rest is meaningful without it: a dev run has no
 * resources directory to read a marker out of, and no release it could be an update to.
 */
export function detectUpdateTarget(probe: UpdateTargetProbe): UpdateTarget {
  if (!probe.packaged) return 'unpackaged'
  if (probe.platform === 'win32') return 'nsis'
  if (probe.platform === 'darwin') return 'macos'
  if (probe.platform !== 'linux') return 'unknown'
  // Set by snapd for every process inside a snap, and the same variable electron-updater reads.
  if (probe.env.SNAP) return 'snap'
  // Anything other than "deb" is a format Encore does not build. Treating rpm or pacman as
  // updatable would offer a download that findFile could only fail to resolve, since no release
  // carries those files.
  if (probe.readPackageType() === 'deb') return 'deb'
  // Set by the AppImage runtime to the absolute path of the running image, which is the file
  // AppImageUpdater replaces. Without it there is nothing for it to overwrite.
  if (probe.env.APPIMAGE) return 'appimage'
  return 'unknown'
}
