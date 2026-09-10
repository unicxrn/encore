import { LibraryScanCanceled } from './scanner'

export interface ScanRunnerOptions {
  /**
   * Run one whole scan. Rejects with `LibraryScanCanceled` when `abort` took effect, and with
   * anything else when the scan genuinely failed.
   */
  run: () => Promise<void>
  /** Fire the abort for the scan `run` started. Only ever called while one is in flight. */
  abort: () => void
  /** Report a scan that failed for some reason other than a cancel. */
  onError: (err: unknown) => void
}

/**
 * Serialises library scans, and decides what a cancel means for a rescan already queued behind
 * one.
 *
 * Lives here rather than as three closed-over booleans in `wireIpc` because that function reaches
 * for `app.getPath` and `BrowserWindow` on the first line and so cannot be imported under vitest.
 * The rules below are the whole reason cancellation is more than an `abort()` call, and they were
 * previously only assertable by running the app.
 *
 * Two scans must never overlap: they write the same catalog rows and would race each other's
 * freshness checks. So a `start()` during a scan sets a flag and one follow-up scan runs when the
 * current one lands. That is what keeps a download landing mid-scan from needing a manual
 * rescan, and it is why a burst of watcher events costs one rescan rather than one per event.
 *
 * A CANCEL drops that queued rescan, including one queued after the cancel but before the scan
 * finished unwinding. The alternative is a cancel that undoes itself: the user presses Cancel, and
 * whatever the watcher happened to notice during the scan starts the whole thing again a moment
 * later. Nothing is lost by dropping it (the watcher fires again on the next change, and the
 * Scan button is one click away), whereas a Cancel that visibly restarts the job is the control
 * not working.
 *
 * The invariant that matters most is that `running` always comes back down: a runner stuck with it
 * true never scans again for the life of the process, and the library silently stops tracking the
 * disk. Every path out of `run` goes through the same `finally`, and `run` is invoked inside a
 * promise chain so that a synchronous throw (settings loading or IPC sending; `run` is a closure
 * over both) becomes a rejection rather than escaping `start`.
 */
export class ScanRunner {
  private running = false
  private pendingRescan = false
  /** Set by `cancel()`, read once by the `finally` of the scan it cancelled, then cleared. */
  private canceling = false

  constructor(private readonly opts: ScanRunnerOptions) {}

  start(): void {
    if (this.running) {
      this.pendingRescan = true
      return
    }
    this.running = true
    this.pendingRescan = false
    // The async wrapper is what turns a synchronous throw from `run` into a rejection this chain
    // can catch. Without it such a throw would propagate out of `start()` past the `finally`.
    void (async () => this.opts.run())()
      .catch((err: unknown) => {
        // A cancel is not a failure. It has already reached the renderer as a `canceled` progress
        // event; an error on top of that would put "Scan failed" on screen for something the user
        // asked for.
        if (!(err instanceof LibraryScanCanceled)) this.opts.onError(err)
      })
      .finally(() => {
        this.running = false
        const canceled = this.canceling
        this.canceling = false
        const queued = this.pendingRescan
        this.pendingRescan = false
        if (queued && !canceled) this.start()
      })
  }

  /**
   * Stop the running scan, if there is one.
   *
   * The guard does more than tidy up: `abort` fires a module-level slot in scanner.ts, so a stray
   * call with nothing running could only ever hit some later scan.
   */
  cancel(): void {
    if (!this.running) return
    this.canceling = true
    this.opts.abort()
  }
}
