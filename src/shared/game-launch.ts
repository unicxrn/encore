/**
 * Where Clone Hero itself is, as a question the user can answer.
 *
 * Deliberately free of any zod import, for the reason `score-folder.ts` records: Settings draws
 * its row from `describeGameExecutable`, and pulling this type out of a schema module would put
 * the whole zod runtime into the renderer's startup bundle for one sentence.
 *
 * Encore does not guess this path. It knows where the songs are, because a library folder is a
 * folder it scans, and it knows where the score files are, because Clone Hero writes those to a
 * fixed place per platform. The program itself is installed wherever the user put it: Steam, an
 * extracted zip, an AppImage in a downloads folder. So there is no probe here and no candidate
 * list, only a path somebody chose and the check that refuses a bad one before it is stored.
 */

/** What is at the path Encore was given. */
export type GameExecutableKind = 'missing' | 'directory' | 'file'

/**
 * What one path is, so a setting can refuse a useless one and say why.
 *
 * The shape exists so that "nothing there", "that is a folder" and "that is a file Encore would
 * not be able to start" are three different answers rather than one silent failure. Storing any
 * of them without saying which is the defect this check exists to prevent: the user would have
 * pointed Encore at something that cannot run and been told nothing until they pressed Launch.
 */
export interface GameExecutableReport {
  /** The path inspected, exactly as it was given. Empty when nothing has been chosen yet. */
  path: string
  /** The platform the rules below were applied for, as Node names it. */
  platform: string
  /**
   * Whether Encore launches anything at all here. False on macOS and on any platform it does not
   * know: see `gameLaunchSupported` in main/game/executable.ts for why macOS is deliberate.
   */
  supported: boolean
  kind: GameExecutableKind
  /**
   * Whether the file carries an execute bit for somebody. Asked on Linux, where a file without
   * one cannot be started at all and a freshly downloaded AppImage usually has none. Always
   * false on Windows, where the extension decides instead and this is never read.
   */
  executable: boolean
  /** The one test: whether Encore would be willing to run this path. */
  usable: boolean
}

/**
 * The name Windows starts a program by.
 *
 * Only `.exe`. A `.bat` or a `.cmd` is a script the command interpreter runs, which is the one
 * shape of "executable" that would put a user-chosen path in front of a shell, and Node refuses
 * to spawn one without `shell: true` anyway. Kept here rather than in the checker so the refusal
 * message and the check cannot disagree about what was wanted.
 */
export const WINDOWS_EXECUTABLE_RE = /\.exe$/i

/**
 * One sentence saying what Encore makes of the path it was given.
 *
 * Lives beside the type rather than in the component for the reason `describeScoreFolder` does:
 * both sides need to agree on it, and the tests that pin the wording run against this rather
 * than against rendered markup.
 */
export function describeGameExecutable(report: GameExecutableReport): string {
  if (!report.supported) {
    return report.platform === 'darwin'
      ? 'Encore does not launch Clone Hero on macOS. Nobody has been able to test it there, so it is left out rather than shipped on a guess.'
      : `Encore does not know how to launch Clone Hero on ${report.platform}.`
  }
  if (report.path === '') {
    return 'No Clone Hero chosen yet. Point Encore at the program you start the game with.'
  }
  if (report.kind === 'missing') return `There is nothing at ${report.path}.`
  if (report.kind === 'directory') {
    return report.platform === 'win32'
      ? `${report.path} is a folder. Choose the .exe inside it.`
      : `${report.path} is a folder. Choose the program inside it, not the folder itself.`
  }
  if (report.usable) return `Encore starts Clone Hero with ${report.path}.`
  if (report.platform === 'win32') {
    return `${report.path} is not a .exe. Choose the program Windows starts Clone Hero with.`
  }
  return `${report.path} is not marked executable, so nothing can start it. Run chmod +x on it, or choose the file you normally start the game with.`
}
