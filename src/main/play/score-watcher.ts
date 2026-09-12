import { watch, type FSWatcher } from 'chokidar'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PlayAvailability } from '../../shared/play'
import type { ScoreDataPaths } from './location'
import { mergeScoreFiles, parseScoreData, parseScoresExt, type ChartBest } from './scoredata'
import type { ScoreImportResult } from './score-store'

/**
 * Watches Clone Hero's `scoredata.bin` and `scoresext.bin` and imports what they hold.
 *
 * WHEN THE IMPORT RUNS, and why that is the answer:
 *
 * 1. **Once at startup, before anything is watched.** This is the whole point of the feature. The
 *    files change while Encore is closed, which is exactly the history Encore was never there for,
 *    and the only moment that history can be picked up is the next launch. Nothing about it is
 *    deferred to a user action: a Stats page that said "import your old scores" would be asking
 *    the user to press a button for data already sitting on their disk.
 *
 * 2. **On every change to either file while Encore is open.** The game rewrites both after every
 *    song, so a play made with Encore running lands in the lifetime count within a moment of the
 *    song ending, and the lifetime totals do not sit a whole session behind the observed ones.
 *
 * The mechanism is `play/watcher.ts`'s, deliberately, and its three reasons carry over whole:
 *
 * - **It watches the directory, not the files.** A rewrite on any platform may be an
 *   unlink-and-recreate rather than an in-place write, and a watch on the file itself survives the
 *   first of those and then watches an inode nothing will ever touch again. Watching the parent
 *   and filtering by name is immune to that, and is also what makes a currently-absent file work:
 *   most Clone Hero installs that have never written `scoresext.bin` still have the directory.
 * - **There is no debounce.** Two files means chokidar reports one save two or three times, and
 *   each report costs a read of a few kilobytes and a diff that finds nothing to write (see
 *   score-store.ts). A delay would buy nothing and would widen the window in which a play is lost
 *   to a quit.
 * - **Nothing it can encounter is an error.** No Clone Hero, no score yet, a half-written file
 *   caught mid-save: all ordinary, all reported as a `PlayAvailability` rather than thrown.
 *
 * The one thing that is genuinely different: this reads a PAIR, and a pair can be torn. The game
 * writes both files, and a read landing between the two writes gets one current file and one
 * stale one. `mergeScoreFiles` refuses such a pair outright rather than pairing a chart's score
 * with its neighbour's, so a torn read imports nothing and sets `unreadable` for a moment; the
 * event for the second file arrives immediately after and imports the whole thing correctly.
 *
 * IMPORT IS A READ. Nothing here writes to Clone Hero's files, opens them for writing, or moves
 * them. They are another program's live data.
 */

export interface ScoreFileWatcherOptions {
  /**
   * The two paths, or null on a platform where no location has been established.
   *
   * Null is a supported, non-exceptional state: `start` succeeds, watches nothing, and the status
   * reports `unknownPlatform` forever, which keeps every caller free of platform checks.
   */
  paths: ScoreDataPaths | null
  /**
   * Store what the files hold. Returns what changed.
   *
   * Injected rather than taking a database handle, as `PlayWatcher.record` is, so the watcher can
   * be tested without one and so the diff rule stays in the store.
   */
  importCharts: (charts: ChartBest[]) => ScoreImportResult
  /** Called only when the import actually wrote something, so a UI can refresh without polling. */
  onImport?: (result: ScoreImportResult) => void
}

export class ScoreFileWatcher {
  private readonly paths: ScoreDataPaths | null
  private readonly importCharts: (charts: ChartBest[]) => ScoreImportResult
  private readonly onImport?: (result: ScoreImportResult) => void
  private fsWatcher: FSWatcher | null = null
  private lastReason: PlayAvailability
  private lastImport: string | null = null

  constructor(opts: ScoreFileWatcherOptions) {
    this.paths = opts.paths
    this.importCharts = opts.importCharts
    this.onImport = opts.onImport
    this.lastReason = opts.paths === null ? 'unknownPlatform' : 'noFile'
  }

  /** The paths being read, for a status the UI can show. Null when there is nothing to watch. */
  get watchedPaths(): ScoreDataPaths | null {
    return this.paths
  }

  /** What the last read found. See PlayAvailability: none of its values is an error. */
  get reason(): PlayAvailability {
    return this.lastReason
  }

  /**
   * When the files were last read and imported without refusal, ISO 8601, or null before that
   * has happened at all. Set by a read that found nothing new as well as by one that wrote,
   * because both mean the stored data is current as of then.
   *
   * Encore's own clock, and the only date anywhere near this data. It says when the files were
   * read, never when anything was played: the files carry no play dates at all.
   */
  get lastImportAt(): string | null {
    return this.lastImport
  }

  /**
   * Read both files once and import what they hold.
   *
   * Resolves with true only when the import wrote something, which is what tells a caller whether
   * a UI needs refreshing. Never rejects. The ways this comes back false, commonest first: the
   * files say what was already stored (every read after the first, all session long), a file is
   * missing (no Clone Hero, or a version that has never written `scoresext.bin`), a file could
   * not be read, one of them did not parse, and the two did not agree with each other.
   *
   * ENOENT is separated from every other read failure only to set the status, because the two
   * mean different things to a user: "Clone Hero has recorded no scores here" against "there are
   * files and Encore cannot use them".
   */
  async refresh(): Promise<boolean> {
    if (this.paths === null) {
      this.lastReason = 'unknownPlatform'
      return false
    }
    let bytes: [Uint8Array, Uint8Array]
    try {
      bytes = await Promise.all([readFile(this.paths.scoreData), readFile(this.paths.scoresExt)])
    } catch (err) {
      this.lastReason = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'noFile' : 'unreadable'
      return false
    }
    const data = parseScoreData(bytes[0])
    const ext = parseScoresExt(bytes[1])
    // Present but not usable, which a torn pair also looks like. Deliberately NOT 'noFile': the
    // files are there, and a status saying otherwise would send a user looking for an install
    // they already have.
    if (data === null || ext === null) {
      this.lastReason = 'unreadable'
      return false
    }
    const merged = mergeScoreFiles(data, ext)
    if (merged === null) {
      this.lastReason = 'unreadable'
      return false
    }
    this.lastReason = 'ok'
    const result = this.importCharts(merged)
    this.lastImport = new Date().toISOString()
    if (!result.wrote) return false
    this.onImport?.(result)
    return true
  }

  /**
   * Import once, then begin watching.
   *
   * The import comes first and is awaited, so a window opening straight afterwards finds the
   * lifetime data already there rather than watching it appear. Resolves once the watcher is
   * ready, or immediately when there is nothing to watch, and does not reject: a directory that
   * cannot be watched is the ordinary case for anyone who does not play the game on this machine.
   */
  async start(): Promise<void> {
    await this.stop()
    await this.refresh()
    if (this.paths === null) return

    const { scoreData, scoresExt } = this.paths
    const dir = dirname(scoreData)
    const fsw = watch(dir, {
      ignoreInitial: true,
      // Depth 0, as in play/watcher.ts. Unity's data directory is small today, but it is another
      // program's and nothing stops it growing; only two files in it are ever read.
      depth: 0,
      ignored: (p: string) => p !== dir && p !== scoreData && p !== scoresExt
    })

    await new Promise<void>((resolve) => {
      const onChange = (): void => {
        void this.refresh()
      }
      fsw.on('add', onChange)
      fsw.on('change', onChange)
      // An unlink is worth a read: the game may be replacing a file rather than removing it, and
      // the read that follows either finds the replacement or sets `noFile` correctly.
      fsw.on('unlink', onChange)
      // Swallowed on purpose and the watcher kept: chokidar reports permission problems on
      // individual entries this way, and none of them stops the two files we want.
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
