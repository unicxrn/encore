import { statSync } from 'node:fs'
import {
  WINDOWS_EXECUTABLE_RE,
  type GameExecutableKind,
  type GameExecutableReport
} from '../../shared/game-launch'

/**
 * Deciding whether a path is something Encore would start, per platform.
 *
 * The rules are short because they have to be conservative: this module says yes to a path that
 * is then handed to the operating system as a program to run, so everything it is unsure about
 * is a no. It reads metadata and never contents, and it writes nothing.
 */

/** Any of the three execute bits. One is enough: the user's shell starts the file on one of them. */
export const EXECUTE_BITS = 0o111

/** The part of `fs.Stats` this module reads, so a test can describe a file without creating one. */
export interface PathFacts {
  isFile: () => boolean
  isDirectory: () => boolean
  /** POSIX mode bits. Meaningless on Windows, and not read there. */
  mode: number
}

/** A stat that answers null rather than throwing, because "not there" is the ordinary case. */
export type StatFn = (path: string) => PathFacts | null

function statOrNull(path: string): PathFacts | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/**
 * Whether Encore launches the game on this platform at all.
 *
 * Linux and Windows, which are the two Encore itself ships for (AppImage, snap and deb; NSIS).
 *
 * macOS is deliberately absent rather than merely untested. A Mac app is a bundle, so the thing
 * to run is `Clone Hero.app/Contents/MacOS/Clone Hero` rather than the thing the user can see in
 * Finder, and starting it properly means `open -a`, which is a different mechanism from the one
 * below. The owner has no Mac to check any of that on, and a launcher that is wrong on a platform
 * nobody can test is worse than a launcher that says it does not cover it.
 */
export function gameLaunchSupported(platform: string): boolean {
  return platform === 'linux' || platform === 'win32'
}

/**
 * What one path is, in the terms the setting needs before it stores anything.
 *
 * The per-platform half is the whole of the judgement:
 *
 * - **Linux**: a regular file with an execute bit. That covers both shapes Clone Hero arrives in
 *   here, an AppImage and the `Clone Hero` binary inside an extracted release, and it is the same
 *   test the user's own shell applies. A freshly downloaded AppImage often has no execute bit at
 *   all, which is exactly the case worth refusing out loud: it is fixable in one command, and
 *   silently storing it would turn Launch into a button that never works.
 * - **Windows**: a regular file named `.exe`. The execute bits mean nothing on NTFS, so the
 *   extension is what is left, and `.bat`/`.cmd` are refused on purpose (see WINDOWS_EXECUTABLE_RE).
 * - **Anywhere else**: no. `supported` carries that, and the path is not even looked at, so a
 *   macOS user is told why rather than told their file is missing.
 *
 * `stat` is injected for the reason `exists` is injected throughout play/location.ts: the states
 * worth testing are a missing path, a directory, and a file without an execute bit, and none of
 * the three needs a real Clone Hero to describe.
 */
export function inspectGameExecutable(
  path: string,
  platform: NodeJS.Platform,
  stat: StatFn = statOrNull
): GameExecutableReport {
  const report: GameExecutableReport = {
    path,
    platform,
    supported: gameLaunchSupported(platform),
    kind: 'missing',
    executable: false,
    usable: false
  }
  // Nothing is stat'd on an unsupported platform or for a setting nobody has answered: both are
  // states the message explains on their own, and a probe would only add a second sentence about
  // a path that was never going to be run.
  if (!report.supported || path === '') return report

  const facts = stat(path)
  if (facts === null) return report
  const kind: GameExecutableKind = facts.isDirectory()
    ? 'directory'
    : facts.isFile()
      ? 'file'
      : 'missing'
  report.kind = kind
  if (kind !== 'file') return report

  if (platform === 'win32') {
    report.usable = WINDOWS_EXECUTABLE_RE.test(path)
    return report
  }
  report.executable = (facts.mode & EXECUTE_BITS) !== 0
  report.usable = report.executable
  return report
}
