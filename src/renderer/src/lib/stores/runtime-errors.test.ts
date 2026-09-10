import { get } from 'svelte/store'
import { afterEach, describe, expect, it } from 'vitest'
import { dismissRuntimeError, installGlobalErrorHandlers, runtimeError } from './runtime-errors'

/**
 * A stand-in for `window` that hands back the listeners it was given.
 *
 * A real EventTarget would need `ErrorEvent` and `PromiseRejectionEvent` to dispatch through, and
 * Node has only the first. Capturing the listener and calling it directly tests the same contract
 * (which handler is registered under which name, and what it puts in the store) without making
 * the test depend on which event classes this runtime happens to ship.
 */
function fakeWindow(): {
  target: Window
  fire: (type: string, event: unknown) => void
  registered: () => string[]
  removed: () => string[]
} {
  const listeners = new Map<string, (event: never) => void>()
  const removals: string[] = []
  const target = {
    addEventListener: (type: string, fn: (event: never) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => {
      removals.push(type)
      listeners.delete(type)
    }
  } as unknown as Window
  return {
    target,
    fire: (type, event) => listeners.get(type)?.(event as never),
    registered: () => [...listeners.keys()],
    removed: () => removals
  }
}

afterEach(() => {
  runtimeError.set(null)
})

describe('installGlobalErrorHandlers', () => {
  it('registers both handlers a boundary cannot cover', () => {
    const win = fakeWindow()
    installGlobalErrorHandlers(win.target)
    expect(win.registered().sort()).toEqual(['error', 'unhandledrejection'])
  })

  it('records a thrown error with its value intact', () => {
    const win = fakeWindow()
    installGlobalErrorHandlers(win.target)
    const boom = new Error('store blew up')

    win.fire('error', { target: win.target, error: boom, message: 'store blew up' })

    expect(get(runtimeError)).toEqual({ context: 'unhandled error', value: boom })
  })

  it('falls back to the message when the error object is withheld', () => {
    // A cross-origin script error arrives with error === null and nothing but "Script error.".
    const win = fakeWindow()
    installGlobalErrorHandlers(win.target)

    win.fire('error', { target: null, error: null, message: 'Script error.' })

    expect(get(runtimeError)?.value).toBe('Script error.')
  })

  it('ignores an error event fired at something other than the window', () => {
    // A broken album-art <img> is handled where it happens; it is not a banner.
    const win = fakeWindow()
    installGlobalErrorHandlers(win.target)

    win.fire('error', { target: { tagName: 'IMG' }, error: new Error('404'), message: '404' })

    expect(get(runtimeError)).toBeNull()
  })

  it('records an unhandled rejection with its reason', () => {
    const win = fakeWindow()
    installGlobalErrorHandlers(win.target)
    const reason = new Error('IPC rejected')

    win.fire('unhandledrejection', { reason })

    expect(get(runtimeError)).toEqual({ context: 'unhandled promise rejection', value: reason })
  })

  it('keeps only the most recent error, so a failing loop cannot stack a hundred', () => {
    const win = fakeWindow()
    installGlobalErrorHandlers(win.target)

    win.fire('unhandledrejection', { reason: new Error('first') })
    win.fire('unhandledrejection', { reason: new Error('second') })

    expect((get(runtimeError)?.value as Error).message).toBe('second')
  })

  it('removes both handlers on teardown', () => {
    const win = fakeWindow()
    const off = installGlobalErrorHandlers(win.target)

    off()

    expect(win.removed().sort()).toEqual(['error', 'unhandledrejection'])
    expect(win.registered()).toEqual([])
  })
})

describe('dismissRuntimeError', () => {
  it('clears the store', () => {
    runtimeError.set({ context: 'unhandled error', value: new Error('x') })
    dismissRuntimeError()
    expect(get(runtimeError)).toBeNull()
  })
})
