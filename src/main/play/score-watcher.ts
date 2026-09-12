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
 * THE BACKUPS, and the four combinations a read may try:
 *
 * Clone Hero keeps `scoredata_backup.bin` and `scoresext_backup.bin` beside the primaries, one
 * save behind, and renames a file it considers damaged to `scoredata_corrupted_<n>.bin`. So when
 * a primary refuses to parse there is usually a readable file a few plays older sitting next to
 * it, and reporting nothing while it is there would be a choice, not a limit.
 *
 * The pairs are tried in this order and the FIRST that merges wins: primary with primary, primary
 * with backup, backup with primary, backup with backup. Three consequences, all deliberate:
 *
 * - **A good primary pair is never passed over.** A backup is older by definition, so preferring
 *   one would silently drop plays that are recorded in the file Encore can read perfectly well.
 *   The first combination succeeding ends the search before any backup is parsed.
 * - **A mixed pair is allowed, and `mergeScoreFiles` is the judge of it.** A live file beside a
 *   backup of the other is exactly the torn pair the merge already refuses: it demands the same
 *   charts on both sides, one to one, with matching rows per chart. So a mixed pair either
 *   describes one coherent state or it is refused, and the case it lets through is the useful
 *   one: the two files agree on which charts exist and differ only in a score the older half has
 *   not caught up with.
 * - **The fallback is visible.** `usedBackup` says the numbers came from at least one file the
 *   game keeps as a spare. It is not an error and not a `reason` of its own (see
 *   shared/play.ts), but a user comparing a total against the game's own screen deserves to know
 *   why it is a play or two short.
 *
 * Quarantined files are never read at all, and `location.ts` records why.
 *
 * IMPORT IS A READ. Nothing here writes to Clone Hero's files, opens them for writing, or moves
 * them. They are another program's live data. `read-only.test.ts` fails the suite if any module
 * in this directory so much as imports something that could write.
 */

export interface ScoreFileWatcherOptions {
  /**
   * The four paths, or null on a platform where no location has been established and the user has
   * not named one.
   *
   * Null is a supported, non-exceptional state: `start` succeeds, watches nothing, and the status
   * reports `unknownPlatform` until the user points Encore at a folder, which keeps every caller
   * free of platform checks.
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

/** One file that parsed, and whether it was the backup rather than the primary. */
interface ParsedCandidate<T> {
  file: T
  isBackup: boolean
}

interface CandidateRead<T> {
  /** Those that parsed, primary first. Empty when neither did. */
  parsed: ParsedCandidate<T>[]
  /** True when every path was absent, which is what tells `noFile` from `unreadable`. */
  allMissing: boolean
}

/**
 * Read a primary and its backup, keeping whichever parse.
 *
 * Both are read even when the primary is fine, because the alternative is a second round trip
 * once the primary turns out not to be, and these are a few kilobytes each. The parse is what
 * decides: a file the game has half written reads without error and refuses to decode, which is
 * the case the backup exists for.
 */
async function readCandidates<T>(
  paths: string[],
  parse: (bytes: Uint8Array) => T | null
): Promise<CandidateRead<T>> {
  const parsed: ParsedCandidate<T>[] = []
  let allMissing = true
  for (const [index, path] of paths.entries()) {
    let bytes: Uint8Array
    try {
      bytes = await readFile(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') allMissing = false
      continue
    }
    allMissing = false
    const file = parse(bytes)
    if (file !== null) parsed.push({ file, isBackup: index > 0 })
  }
  return { parsed, allMissing }
}

export class ScoreFileWatcher {
  private paths: ScoreDataPaths | null
  private readonly importCharts: (charts: ChartBest[]) => ScoreImportResult
  private readonly onImport?: (result: ScoreImportResult) => void
  private fsWatcher: FSWatcher | null = null
  private lastReason: PlayAvailability
  private lastImport: string | null = null
  private backupUsed = false

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

  /** The directory holding them, which is what a user picks and what the UI names. */
  get watchedFolder(): string | null {
    return this.paths === null ? null : dirname(this.paths.scoreData)
  }

  /**
   * Whether the last successful read used one of Clone Hero's backup files.
   *
   * False until a read succeeds, and false again the moment one succeeds from the primaries: it
   * describes the last good read, not whether a fallback ever happened this session.
   */
  get usedBackup(): boolean {
    return this.backupUsed
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
    const p = this.paths
    const [data, ext] = await Promise.all([
      readCandidates([p.scoreData, p.scoreDataBackup], parseScoreData),
      readCandidates([p.scoresExt, p.scoresExtBackup], parseScoresExt)
    ])
    if (data.parsed.length === 0 || ext.parsed.length === 0) {
      // A side is `noFile` only when neither its primary nor its backup was there at all, which
      // is the ordinary "no Clone Hero, or a version too old to have written this file" case.
      // Something present and unusable is 'unreadable', deliberately: a status saying otherwise
      // would send a user looking for an install they already have.
      this.lastReason = data.allMissing || ext.allMissing ? 'noFile' : 'unreadable'
      return false
    }
    // Primary with primary first, so a readable pair is never passed over for older numbers. See
    // the module comment for the other three combinations and what the merge does with them.
    let merged: ChartBest[] | null = null
    let usedBackup = false
    outer: for (const d of data.parsed) {
      for (const e of ext.parsed) {
        merged = mergeScoreFiles(d.file, e.file)
        if (merged !== null) {
          usedBackup = d.isBackup || e.isBackup
          break outer
        }
      }
    }
    if (merged === null) {
      this.lastReason = 'unreadable'
      return false
    }
    this.lastReason = 'ok'
    this.backupUsed = usedBackup
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

    const watched = new Set<string>(Object.values(this.paths))
    const dir = dirname(this.paths.scoreData)
    const fsw = watch(dir, {
      ignoreInitial: true,
      // Depth 0, as in play/watcher.ts. Unity's data directory is small today, but it is another
      // program's and nothing stops it growing; only four files in it are ever read.
      depth: 0,
      // The backups are watched as well as the primaries. The game rewrites them as part of the
      // same save, which costs an extra read that finds nothing new, and it is what makes a
      // replaced backup reach a user whose primary is damaged without a restart. Quarantined
      // files are not in the set and so are never even stat'ed.
      ignored: (p: string) => p !== dir && !watched.has(p)
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

  /**
   * Point the watcher at a different set of files and read them.
   *
   * The one caller is the settings handler, when the user chooses a score folder or clears the
   * one they chose. Doing it here rather than asking the user to restart matters because the
   * setting exists for people Encore's probe cannot help: being told to restart before finding
   * out whether the folder they picked worked is most of the way back to failing silently.
   *
   * Resumes watching only if it was watching, so a retarget before `start` stays a retarget.
   * Never rejects, for the same reason `start` does not.
   */
  async retarget(paths: ScoreDataPaths | null): Promise<void> {
    const wasWatching = this.fsWatcher !== null
    // Before the first await, deliberately: the settings handler calls this and returns, and the
    // renderer asks where Encore is reading as soon as its own call resolves. Swapping the paths
    // after an await would answer that question with the folder the user just stopped using.
    this.paths = paths
    // Back to the state a fresh watcher would be in. Carrying `usedBackup` or a reason across a
    // change of folder would describe the old one.
    this.lastReason = paths === null ? 'unknownPlatform' : 'noFile'
    this.backupUsed = false
    await this.stop()
    if (wasWatching) await this.start()
    else await this.refresh()
  }

  /** Close the watcher. Safe to call when it was never started or already stopped. */
  async stop(): Promise<void> {
    if (this.fsWatcher !== null) {
      await this.fsWatcher.close()
      this.fsWatcher = null
    }
  }
}
