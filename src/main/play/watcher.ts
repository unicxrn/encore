import { watch, type FSWatcher } from 'chokidar'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PlayAvailability } from '../../shared/play'
import { parseScoreStats, type PlayRecord } from './scorestats'

/**
 * Watches Clone Hero's `scorestats.json` and records each new play.
 *
 * Built on the same chokidar shape as `catalog/watcher.ts`, and different from it in the three
 * ways this file demands:
 *
 * 1. **It watches a directory, not the file.** Clone Hero rewrites scorestats.json, and a
 *    rewrite on any platform may be an unlink-and-recreate rather than an in-place write. A
 *    watch on the file itself survives the first of those and then silently watches an inode
 *    nothing will ever touch again — the user plays all evening and Encore records nothing.
 *    Watching the parent directory and filtering by name is immune to that, and is also what
 *    makes a currently-absent file work: the directory exists on a Clone Hero install even
 *    before the first score is written.
 *
 * 2. **There is no debounce.** The library watcher waits two seconds for a batch of filesystem
 *    changes to settle before kicking off a whole rescan. Here the reaction is one small read
 *    and one INSERT OR IGNORE, and doing it twice costs nothing because the second is ignored.
 *    A delay would only widen the window in which a play is lost to a quit.
 *
 * 3. **Nothing it can encounter is an error.** See `PlayAvailability` and the note on `refresh`.
 *
 * What this cannot do is recover history. scorestats.json holds one play, so a play made while
 * Encore was not running is not in any file to be found later. The first read on startup picks
 * up at most the single most recent play, which may be months old and may already be recorded.
 */

export interface PlayWatcherOptions {
  /**
   * The scorestats.json path, or null on a platform where no location has been established.
   *
   * Null is a supported, non-exceptional state: `start` succeeds, watches nothing, and the
   * status reports `unknownPlatform` forever. That keeps every caller free of platform checks.
   */
  path: string | null
  /**
   * Persist one play. Returns true if it was new, false if already recorded.
   *
   * Injected rather than taking a database handle so the watcher can be tested without one, and
   * so the "already recorded" rule stays in the store where the UNIQUE constraint enforcing it
   * lives (see play/store.ts).
   */
  record: (play: PlayRecord) => boolean
  /** Called only when a genuinely new play was recorded, so a UI can refresh without polling. */
  onPlay?: (play: PlayRecord) => void
}

export class PlayWatcher {
  private readonly path: string | null
  private readonly record: (play: PlayRecord) => boolean
  private readonly onPlay?: (play: PlayRecord) => void
  private fsWatcher: FSWatcher | null = null
  private lastReason: PlayAvailability

  constructor(opts: PlayWatcherOptions) {
    this.path = opts.path
    this.record = opts.record
    this.onPlay = opts.onPlay
    this.lastReason = opts.path === null ? 'unknownPlatform' : 'noFile'
  }

  /** The path being watched, for a status the UI can show. Null when there is nothing to watch. */
  get watchedPath(): string | null {
    return this.path
  }

  /** What the last read found. See PlayAvailability: none of its values is an error. */
  get reason(): PlayAvailability {
    return this.lastReason
  }

  /**
   * Read scorestats.json once and record what it holds.
   *
   * Resolves with true only when a new play was recorded. Never rejects. The four ways this
   * comes back false are, in order of how often they happen: the file was unchanged since the
   * last read (every event but the first of each save), it does not exist (no Clone Hero, or no
   * play yet), it could not be read (permissions, or a rename caught mid-flight), and it did not
   * parse (a half-written save, or a shape we do not know).
   *
   * ENOENT is separated from every other read failure only to set the status, because the two
   * mean different things to a user: "Clone Hero has not recorded a score here" versus "there is
   * a file and Encore cannot use it". Neither is worth a log line — the second happens routinely
   * while Clone Hero is writing — and neither reaches a caller as an exception.
   */
  async refresh(): Promise<boolean> {
    if (this.path === null) {
      this.lastReason = 'unknownPlatform'
      return false
    }
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (err) {
      this.lastReason = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'noFile' : 'unreadable'
      return false
    }
    const play = parseScoreStats(text)
    if (play === null) {
      // Present but not usable. Deliberately NOT 'noFile': the file is there, and a status that
      // said otherwise would send a user looking for an install they already have.
      this.lastReason = 'unreadable'
      return false
    }
    this.lastReason = 'ok'
    if (!this.record(play)) return false
    this.onPlay?.(play)
    return true
  }

  /**
   * Begin watching, after one immediate read so a play made while Encore was closed is picked up.
   *
   * Resolves once the watcher is ready, or immediately when there is nothing to watch. It does
   * not reject: a directory that cannot be watched (no Clone Hero installed, so the parent does
   * not exist) is the ordinary case for most users, and making startup handle it as a failure
   * would put an error on screen for people who simply do not play the game on this machine.
   */
  async start(): Promise<void> {
    await this.stop()
    await this.refresh()
    if (this.path === null) return

    const file = this.path
    const fsw = watch(dirname(file), {
      ignoreInitial: true,
      // Depth 0 keeps this to the directory's own entries. Clone Hero's data root also holds
      // Songs/, which on a real library is tens of thousands of files, and recursing into it
      // would make this watcher many times more expensive than the library watcher it sits
      // beside — to learn nothing, since only one file here is ever read.
      depth: 0,
      ignored: (p: string) => p !== dirname(file) && p !== file
    })

    await new Promise<void>((resolve) => {
      const onChange = (): void => {
        void this.refresh()
      }
      fsw.on('add', onChange)
      fsw.on('change', onChange)
      // An unlink is worth a read: Clone Hero may be replacing the file rather than removing it,
      // and the read that follows either finds the replacement or sets `noFile` correctly.
      fsw.on('unlink', onChange)
      // Errors are swallowed on purpose and the watcher is kept: chokidar reports permission
      // problems on individual entries this way, and none of them stops the one file we want.
      fsw.on('error', () => {})
      fsw.on('ready', () => resolve())
    })
    this.fsWatcher = fsw
  }

  /** Close the watcher. Safe to call when it was never started or already stopped. */
  async stop(): Promise<void> {
    if (this.fsWatcher !== null) {
      await this.fsWatcher.close()
      this.fsWatcher = null
    }
  }
}
