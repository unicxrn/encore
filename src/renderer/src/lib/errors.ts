import { APP_VERSION } from '../../../shared/constants'

/**
 * Turning an unknown thrown value into something a user can read out loud and a maintainer can
 * act on.
 *
 * Every caller here runs AFTER something has already gone wrong: an error boundary's fallback,
 * or the window-level handlers in `stores/runtime-errors.ts`. So this module deliberately imports
 * nothing but a build-time string constant: anything with behaviour could be the thing that broke.
 *
 * `unknown` rather than `Error` because that is genuinely what arrives. `throw 'nope'` is legal,
 * a rejected promise carries whatever it was rejected with, and an `ErrorEvent` from a
 * cross-origin script has a null `error`. All three have to produce a sentence.
 */

/** The one line that goes at the top of a fallback. Never empty. */
export function errorHeadline(err: unknown): string {
  if (err instanceof Error) {
    // `message` is empty on `new Error()`, which would render a blank headline; the name is the
    // only thing left that says anything.
    return err.message.trim() !== '' ? err.message : err.name
  }
  if (typeof err === 'string' && err.trim() !== '') return err
  if (err === null) return 'null was thrown'
  if (err === undefined) return 'undefined was thrown'
  // A thrown object stringifies to '[object Object]', which says nothing. JSON says more, and
  // falls back to String() for the cyclic and BigInt cases where it throws.
  if (typeof err === 'object') {
    try {
      const json = JSON.stringify(err)
      if (json !== undefined && json !== '{}') return json
    } catch {
      /* cyclic or non-serialisable, so String() below */
    }
  }
  return String(err)
}

/**
 * The full text the Copy button puts on the clipboard.
 *
 * The stack is the point: a screenshot of a stack trace is how bugs actually get reported, and in
 * a packaged build the user cannot open DevTools to find one. The app version rides along because
 * "which build was that" is the first question anyone reading the report will ask, and the user
 * should not have to go and look it up in Settings.
 *
 * `context` names where it happened ("Tools view", "unhandled promise rejection"). The boundary
 * knows that and the stack often does not, once the code is minified.
 */
export function errorReport(err: unknown, context: string): string {
  const lines = [`Encore ${APP_VERSION} (${context})`, errorHeadline(err)]
  if (err instanceof Error && typeof err.stack === 'string' && err.stack.trim() !== '') {
    lines.push('', err.stack)
  }
  return lines.join('\n')
}

/**
 * Copy `text`, reporting whether it landed.
 *
 * Resolves false rather than throwing: the caller is already showing an error, and a second one
 * about the clipboard would bury the first. `navigator.clipboard` is absent under jsdom and can
 * reject in a page without focus, so both the missing API and the rejection are the same answer.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard
    if (!clipboard?.writeText) return false
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
