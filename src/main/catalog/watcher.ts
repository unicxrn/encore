import { watch, type FSWatcher } from 'chokidar'

export interface LibraryWatcherOptions {
  /** Milliseconds of quiet time before onChange fires. Default: 2000. */
  debounceMs?: number
  /** Called once after filesystem changes settle. */
  onChange: () => void
}

/**
 * Watches one or more library root directories with chokidar and fires
 * `onChange` after a debounce window of filesystem quiet.  Ignores any
 * path that contains `.encore-tmp` (download staging).
 */
export class LibraryWatcher {
  private readonly debounceMs: number
  private readonly onChange: () => void
  private fsWatcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(opts: LibraryWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 2000
    this.onChange = opts.onChange
  }

  /**
   * Start watching `roots`.  If a watcher is already running it is closed
   * first, so calling start() again with new roots acts as a restart.
   * Resolves once the underlying watcher has emitted the 'ready' event.
   */
  async start(roots: string[]): Promise<void> {
    // Close any prior watcher before opening a new one.
    await this.stop()

    return new Promise<void>((resolve, reject) => {
      const fsw = watch(roots, {
        ignoreInitial: true,
        ignored: (p: string) => p.includes('.encore-tmp')
      })

      const onReady = (): void => {
        this.fsWatcher = fsw
        resolve()
      }

      const onError = (err: unknown): void => {
        // If we haven't resolved yet, reject.  After ready, errors are
        // non-fatal (chokidar emits them for permission issues on files).
        if (this.fsWatcher == null) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }

      const resetDebounce = (): void => {
        if (this.timer !== null) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          this.onChange()
        }, this.debounceMs)
      }

      fsw.on('ready', onReady)
      fsw.on('error', onError)
      fsw.on('add', resetDebounce)
      fsw.on('change', resetDebounce)
      fsw.on('unlink', resetDebounce)
      fsw.on('addDir', resetDebounce)
      fsw.on('unlinkDir', resetDebounce)
    })
  }

  /**
   * Close the watcher and cancel any pending debounce timer.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.fsWatcher !== null) {
      await this.fsWatcher.close()
      this.fsWatcher = null
    }
  }
}
