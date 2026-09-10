import { DownloadInput, JobProgress, QueuedDownload } from '../shared-types'

type Runner = (
  input: DownloadInput,
  onProgress: (p: JobProgress) => void,
  signal: AbortSignal
) => Promise<string>

export class DownloadManager {
  /**
   * Entries are retained after completion as session history (done/error/canceled
   * stay visible in the queue UI). Add a clearFinished() when the UI needs it.
   */
  private items = new Map<string, QueuedDownload>()
  private controllers = new Map<string, AbortController>()
  private listeners: ((items: QueuedDownload[]) => void)[] = []
  private running = 0
  private idleResolvers: (() => void)[] = []

  constructor(private opts: { concurrency: number; runner: Runner }) {}

  onUpdate(listener: (items: QueuedDownload[]) => void): void {
    this.listeners.push(listener)
  }

  list(): QueuedDownload[] {
    return [...this.items.values()]
  }

  add(input: DownloadInput): void {
    const existing = this.items.get(input.md5)
    if (existing && existing.status !== 'canceled') return
    this.items.set(input.md5, {
      ...input,
      status: 'queued',
      percent: null,
      message: null,
      finalPath: null
    })
    this.notify()
    this.pump()
  }

  /** Re-queues an errored item. Canceled items are re-added via add(), not retried. */
  retry(md5: string): void {
    const item = this.items.get(md5)
    if (!item || item.status !== 'error') return
    item.status = 'queued'
    item.message = null
    item.percent = null
    this.notify()
    this.pump()
  }

  cancel(md5: string): void {
    const item = this.items.get(md5)
    if (!item) return
    this.controllers.get(md5)?.abort()
    if (item.status === 'queued') item.status = 'canceled'
    this.notify()
  }

  /** Removes items that have finished (done/canceled/error) and notifies listeners. */
  clearFinished(): void {
    for (const [key, item] of this.items) {
      if (item.status === 'done' || item.status === 'canceled' || item.status === 'error') {
        this.items.delete(key)
      }
    }
    this.notify()
  }

  /** Resolves when nothing is queued or running (test + shutdown helper). */
  idle(): Promise<void> {
    if (this.running === 0 && !this.nextQueued()) return Promise.resolve()
    return new Promise((r) => this.idleResolvers.push(r))
  }

  private nextQueued(): QueuedDownload | undefined {
    return [...this.items.values()].find((i) => i.status === 'queued')
  }

  private notify(): void {
    const snapshot = this.list()
    for (const l of this.listeners) l(snapshot)
  }

  private pump(): void {
    while (this.running < this.opts.concurrency) {
      const item = this.nextQueued()
      if (!item) break
      this.launch(item)
    }
    if (this.running === 0 && !this.nextQueued()) {
      for (const r of this.idleResolvers.splice(0)) r()
    }
  }

  private launch(item: QueuedDownload): void {
    item.status = 'running'
    this.running++
    this.notify()
    const controller = new AbortController()
    this.controllers.set(item.md5, controller)
    // Promise.resolve().then(...) turns a synchronously-throwing runner into a
    // rejection so the slot is always released and idle() cannot deadlock.
    Promise.resolve()
      .then(() =>
        this.opts.runner(
          item,
          (p: JobProgress) => {
            item.percent = p.percent
            this.notify()
          },
          controller.signal
        )
      )
      .then((finalPath: string) => {
        item.status = 'done'
        item.percent = 100
        item.finalPath = finalPath
      })
      .catch((err: unknown) => {
        item.status = controller.signal.aborted ? 'canceled' : 'error'
        item.message = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        this.running--
        this.controllers.delete(item.md5)
        this.notify()
        this.pump()
      })
  }
}
