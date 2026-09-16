import { spawn as nodeSpawn } from 'node:child_process'
import { dirname } from 'node:path'

/**
 * Starting a process Encore does not own.
 *
 * Everything else Encore spawns is a sidecar it fetched, ran for a few seconds and read the
 * output of. This is the opposite: a program the user installed, which outlives the press that
 * started it and must outlive Encore itself. Three rules follow from that, and each one is a
 * line below rather than a preference.
 *
 * **No shell, ever.** The path comes from a file picker, so it holds whatever the user's
 * filesystem holds: spaces are ordinary, and a quote or a `$` in a folder name is legal on every
 * platform Encore runs on. `spawn(command, args)` with no `shell` option hands the command to
 * `execve` as one string and never splits it, so a path is a path. The moment a shell is
 * involved, `/games/Clone Hero/"weird$dir"/CloneHero` becomes several words and one of them is
 * whatever the shell decides `$dir` means. There is no interpolation here and no command line is
 * ever built; the argument vector is empty because the game takes no arguments from Encore.
 *
 * **Detached, with no inherited stdio.** `detached: true` puts the child in its own process
 * group, so the signals that stop Encore do not reach it, and `unref()` drops it from Encore's
 * event loop so quitting Encore does not wait on a game somebody is still playing.
 * `stdio: 'ignore'` is the other half: a piped stdout is a handle Encore holds open for the life
 * of the child, which would both keep the process referenced and fill a buffer nothing reads.
 *
 * **A failure that reaches the user.** `spawn` does not throw for a path that cannot be run; the
 * child emits `error` a tick later. So this resolves on the child's own `spawn` event and rejects
 * on `error`, which gives the caller something to put on screen instead of a button that did
 * nothing.
 */

/** The subset of a spawned child this module uses; the seam a test replaces. */
export interface SpawnedGame {
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'spawn', listener: () => void): unknown
  unref(): void
}

/**
 * The options every launch uses. Spelled as a type rather than left to the call site so a test
 * can assert the three properties above were really asked for, and so `shell` has nowhere to go:
 * it is not a field here, and adding one would be a visible change rather than a quiet one.
 */
export interface SpawnGameOptions {
  detached: true
  stdio: 'ignore'
  cwd: string
}

export type SpawnGameFn = (
  command: string,
  args: string[],
  options: SpawnGameOptions
) => SpawnedGame

export interface LaunchGameDeps {
  /** Injected so a test can assert what would have been run without running a game. */
  spawn?: SpawnGameFn
}

/**
 * Start the game at `execPath` and let go of it.
 *
 * Resolves once the operating system has accepted the process, which is as much as a launcher can
 * honestly claim: a game that starts and then crashes on its own is not something Encore can
 * report on, because by then Encore has no handle to it.
 *
 * `cwd` is the executable's own directory. Clone Hero reads its settings, profiles and songs list
 * relative to where it is installed, and a child inherits Encore's working directory unless told
 * otherwise, which on a packaged Linux build is `/` as often as not.
 */
export function launchGame(execPath: string, deps: LaunchGameDeps = {}): Promise<void> {
  const spawn: SpawnGameFn =
    deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options))
  return new Promise((resolve, reject) => {
    // No interpolation, no quoting, no command line: the path is the command, and the argument
    // vector is empty. See the module comment for why that is the whole security argument.
    const child = spawn(execPath, [], {
      detached: true,
      stdio: 'ignore',
      cwd: dirname(execPath)
    })
    child.on('error', (err) => {
      reject(err instanceof Error ? err : new Error(String(err)))
    })
    child.on('spawn', () => {
      resolve()
    })
    // After the listeners, so nothing is missed, and unconditionally: a child that failed to
    // spawn has nothing to unreference and does not mind being told.
    child.unref()
  })
}
