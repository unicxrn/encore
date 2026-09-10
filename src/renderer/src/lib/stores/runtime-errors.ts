import { writable, type Writable } from 'svelte/store'

/**
 * The errors an error boundary cannot see.
 *
 * `<svelte:boundary>` catches what throws while Svelte is rendering or running an effect. It does
 * NOT catch a rejected promise from a store, a `setTimeout` callback, or a click handler that
 * throws. Those unwind through the event loop, miss every boundary, and today land nowhere at
 * all. In a packaged build the user cannot open DevTools, so "nowhere at all" means the app
 * quietly stops doing the thing they asked for and never says why.
 *
 * So: window-level handlers, and the most recent one shown as a dismissible strip. Deliberately
 * one error rather than a list: this is a "something went wrong in the background" notice, not a
 * log viewer, and a failing interval could otherwise stack a hundred entries.
 */
export interface RuntimeError {
  /** Where it came from, for the copied report. */
  context: string
  /** The raw thrown value, so the strip can build the same report a boundary does. */
  value: unknown
}

/** The most recent unhandled error, or null when there is nothing to report. */
export const runtimeError: Writable<RuntimeError | null> = writable(null)

export function dismissRuntimeError(): void {
  runtimeError.set(null)
}

/**
 * Install the window-level handlers. Returns a teardown, like the other `init*` store functions.
 *
 * Neither handler calls `preventDefault()`. The console entry Electron would print is the only
 * record a developer running `npm run dev` has, and suppressing it to make the strip look tidy
 * would trade the debuggable channel for the cosmetic one.
 */
export function installGlobalErrorHandlers(target: Window = window): () => void {
  const onError = (event: ErrorEvent): void => {
    // A failed <img> fires an `error` event too. Those do not bubble, so they only reach a
    // window listener registered with capture, and this one is not. The target check makes that
    // a guarantee rather than a spec detail we are relying on. A broken album-art URL is
    // already handled where it happens, and is not worth a banner.
    if (event.target !== null && event.target !== target) return
    // `error` is null for a cross-origin script error. There the browser withholds everything
    // but "Script error.", so the message is all there is.
    runtimeError.set({ context: 'unhandled error', value: event.error ?? event.message })
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    runtimeError.set({ context: 'unhandled promise rejection', value: event.reason })
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
