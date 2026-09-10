import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findChartPaths } from './scanner'

/**
 * How many charts the first-run probe will count before it gives up on an exact number.
 *
 * This runs before the window has drawn, so the walk has to be bounded: the cost is roughly one
 * readdir per directory, which is nothing on a warm cache (the 207-chart reference library walks
 * in ~1.5 ms) but is real I/O on a cold spinning disk. 1000 is above the size of most Clone Hero
 * libraries, so the common case still gets an exact count, while the worst case stays around a
 * second rather than unbounded.
 */
export const CHART_COUNT_CAP = 1000

export interface LibraryCandidate {
  /** The songs folder itself: the path that would be added to `libraryFolders`. */
  path: string
  /** Charts found, counted no further than CHART_COUNT_CAP. */
  chartCount: number
  /**
   * True when counting stopped at the cap, making `chartCount` a floor rather than a total.
   * The UI must say "1000+" for these; presenting the cap as an exact count would be a lie.
   */
  countCapped: boolean
}

/**
 * Where Clone Hero v1.x keeps its songs, per the game's own wiki.
 *
 * - Linux `~/.clonehero/Songs`, verified against a real install.
 * - macOS `~/Clone Hero/Songs` (wiki.clonehero.net, "Adding Custom Songs"): "On Mac, your Songs
 *   folder will be located in your home folder inside of the Clone Hero folder (~/Clone Hero)."
 *   Note this is NOT `~/Library/Application Support/...`, which is widely repeated but is the
 *   pre-v1.0 location and is now only the support directory (scores, song cache).
 * - Windows `<Documents>/Clone Hero/Songs` (wiki.clonehero.net, "Installation"): a typical
 *   install puts "settings, profiles, custom content, and songs" in "Documents > Clone Hero".
 *
 * None of these is Unity's `Application.persistentDataPath`; Clone Hero moved its user data out
 * of it in v1.0, so these cannot be derived from the engine's defaults.
 *
 * Two documented cases this cannot reach, both of which fall through to the folder picker:
 * a portable-mode Windows install, which keeps songs in `<install dir>/PlayerData` and has no
 * fixed path; and an install still on a pre-v1.0 version.
 *
 * An unrecognised platform yields no candidates rather than a guess, because a probe of an
 * invented path finds nothing and leaves the user with no explanation of why.
 */
function songsDir(home: string, platform: NodeJS.Platform, documents: string): string | null {
  switch (platform) {
    case 'linux':
      return join(home, '.clonehero', 'Songs')
    case 'darwin':
      return join(home, 'Clone Hero', 'Songs')
    case 'win32':
      return join(documents, 'Clone Hero', 'Songs')
    default:
      return null
  }
}

/**
 * Candidate chart libraries for a first run. Today that is at most one, since only the
 * platform's default location is probed. An array rather than a single value because the obvious
 * next source is the `[directories]` list in Clone Hero's settings.ini, which holds the extra
 * song folders a user with a split library added in-game.
 *
 * `home`, `platform` and `exists` are parameters rather than reads of `os.homedir()` and
 * `process.platform` so tests can drive every platform's path without a real install of it.
 * Counting still touches the disk: it is `findChartPaths`, the scanner's own walker, so that
 * "what counts as a chart" has exactly one definition and the count the user is offered here
 * matches the one the scan will produce.
 *
 * `documents` matters only on Windows, where OneDrive commonly redirects the Documents folder
 * away from `<home>/Documents`. Clone Hero's own troubleshooting page treats that redirected
 * folder as the game's real directory, so main passes Electron's resolved known folder and the
 * `<home>/Documents` default is only a fallback.
 *
 * Note `join` uses the separator of the platform the process is running on, not of `platform`.
 * That is correct in production, where the two are always the same, and it is why the tests
 * build their expected Windows paths with `join` too rather than with literal backslashes.
 */
export function detectChartLibraries(
  home: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
  documents: string = join(home, 'Documents')
): LibraryCandidate[] {
  const path = songsDir(home, platform, documents)
  if (!path) return []
  if (!exists(path)) return []
  const found = findChartPaths(path, CHART_COUNT_CAP)
  return [{ path, chartCount: found.length, countCapped: found.length === CHART_COUNT_CAP }]
}
