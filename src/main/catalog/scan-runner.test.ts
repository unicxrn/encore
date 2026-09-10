import { describe, expect, it, vi } from 'vitest'
import { ScanRunner } from './scan-runner'
import { LibraryScanCanceled } from './scanner'

/**
 * A `run` whose scans finish only when the test says so.
 *
 * The whole point of this class is what happens BETWEEN a scan starting and finishing, so every
 * test needs a scan parked in that window. `settle(n)` resolves the nth one; `fail(n, err)`
 * rejects it.
 */
function deferredRuns(): {
  run: () => Promise<void>
  calls: () => number
  settle: (n: number) => Promise<void>
  fail: (n: number, err: unknown) => Promise<void>
} {
  const resolvers: { resolve: () => void; reject: (err: unknown) => void }[] = []
  return {
    run: () =>
      new Promise<void>((resolve, reject) => {
        resolvers.push({ resolve, reject })
      }),
    calls: () => resolvers.length,
    settle: async (n) => {
      resolvers[n].resolve()
      // Two turns: one for the `run` promise's own handlers, one for the `.finally` that decides
      // whether a queued rescan starts.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    fail: async (n, err) => {
      resolvers[n].reject(err)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

const make = (
  over: Partial<ConstructorParameters<typeof ScanRunner>[0]> = {}
): {
  runner: ScanRunner
  abort: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} => {
  const abort = vi.fn()
  const onError = vi.fn()
  return {
    runner: new ScanRunner({ run: () => Promise.resolve(), abort, onError, ...over }),
    abort,
    onError
  }
}

describe('ScanRunner', () => {
  it('runs one scan per start when nothing is in flight', async () => {
    const d = deferredRuns()
    const { runner } = make({ run: d.run })
    runner.start()
    expect(d.calls()).toBe(1)
    await d.settle(0)
    runner.start()
    expect(d.calls()).toBe(2)
  })

  it('queues a single rescan for any number of starts during one scan', async () => {
    // The library watcher fires on every change; a burst of file events during a scan must cost
    // one follow-up scan, not one per event.
    const d = deferredRuns()
    const { runner } = make({ run: d.run })
    runner.start()
    runner.start()
    runner.start()
    runner.start()
    expect(d.calls()).toBe(1)
    await d.settle(0)
    expect(d.calls()).toBe(2)
    await d.settle(1)
    expect(d.calls()).toBe(2)
  })

  it('drops the queued rescan when the scan is cancelled', async () => {
    // Without this the cancel is undone by whatever the watcher noticed while the scan ran: the
    // user presses Cancel, the scan unwinds, and a fresh one starts in the same breath.
    const d = deferredRuns()
    const { runner, abort } = make({ run: d.run })
    runner.start()
    runner.start() // a watcher event lands mid-scan
    runner.cancel()
    expect(abort).toHaveBeenCalledTimes(1)
    await d.fail(0, new LibraryScanCanceled())
    expect(d.calls()).toBe(1)
  })

  it('drops a rescan queued after the cancel but before the scan unwound', async () => {
    // Charts in flight keep the scan alive for a moment after the abort, and the watcher does not
    // stop firing in that window. A cancel means stop, and it has to outrank anything the same
    // stopped scan is still trailing.
    const d = deferredRuns()
    const { runner } = make({ run: d.run })
    runner.start()
    runner.cancel()
    runner.start()
    await d.fail(0, new LibraryScanCanceled())
    expect(d.calls()).toBe(1)
  })

  it('starts a fresh scan after a cancelled one, rather than wedging', async () => {
    const d = deferredRuns()
    const { runner } = make({ run: d.run })
    runner.start()
    runner.cancel()
    await d.fail(0, new LibraryScanCanceled())

    runner.start()
    expect(d.calls()).toBe(2)
    // And that scan is cancellable in its own right, because the canceling flag did not stick.
    const { runner: r2, abort } = make({ run: d.run })
    r2.start()
    r2.cancel()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('does not report a cancellation as a scan failure', async () => {
    // It reaches the renderer as `canceled` on the progress stream; an `error` event on top of
    // that would put "Scan failed" on screen for something the user asked for.
    const d = deferredRuns()
    const { runner, onError } = make({ run: d.run })
    runner.start()
    runner.cancel()
    await d.fail(0, new LibraryScanCanceled())
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a genuine failure and still runs the rescan queued during it', async () => {
    const d = deferredRuns()
    const { runner, onError } = make({ run: d.run })
    runner.start()
    runner.start()
    const boom = new Error('disk went away')
    await d.fail(0, boom)
    expect(onError).toHaveBeenCalledWith(boom)
    expect(d.calls()).toBe(2)
  })

  it('does not abort anything when nothing is running', () => {
    // A stray abort would land on the module-level slot in scanner.ts, where the next scan to
    // claim it is the one that would die.
    const { runner, abort } = make()
    runner.cancel()
    expect(abort).not.toHaveBeenCalled()
  })

  it('does not wedge when run throws synchronously instead of rejecting', async () => {
    // `run` is a closure over settings loading and IPC sending, both of which can throw before
    // the first await. A throw that escaped start() would leave `running` true forever, and no
    // scan would ever start again for the life of the process.
    const boom = new Error('settings unreadable')
    const { runner, onError } = make({
      run: () => {
        throw boom
      }
    })
    expect(() => runner.start()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(boom)

    const d = deferredRuns()
    const { runner: ok } = make({ run: d.run })
    ok.start()
    expect(d.calls()).toBe(1)
    // And the same runner recovers, rather than needing a new one.
    runner.start()
    expect(onError).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(2)
  })
})
