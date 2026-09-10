/**
 * The keyboard side of a modal, shared by every `aria-modal` dialog in the app.
 *
 * `aria-modal` tells assistive tech that everything outside the dialog is inert. The browser does
 * not enforce that for the keyboard: Tab walks straight out of the last control into the view
 * behind, which the dialog has just declared hidden. These two helpers are what make the
 * declaration true, and they live here so the shortcut sheet, the welcome tour and the fix
 * confirmation cannot drift apart on it.
 *
 * Escape is deliberately NOT here. Each dialog's owner decides the dismiss order (App for the
 * sheet and the tour, the Tools view for its confirmation), and a second listener would race it.
 */

/**
 * Everything Tab can land on. `[tabindex="-1"]` is excluded because that is how a dialog card
 * makes itself focusable-by-script without joining the tab order.
 */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Move focus into `el` and return the function that hands it back.
 *
 * Without the restore, dismissing a dialog drops a keyboard user at the top of the document,
 * which is the very trap a modal exists to avoid. The check for `isConnected` covers an opener
 * that went away while the dialog was up (a "Fix" button whose row the fix removed); focusing
 * a detached element is a silent no-op in browsers, but blurring whatever holds focus now
 * would not be.
 */
export function takeFocus(el: HTMLElement): () => void {
  const opener = document.activeElement
  el.focus()
  return () => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
  }
}

/**
 * Keep Tab inside `container`. Call from the container's `keydown`; every key but Tab is left
 * alone, so a dialog with keys of its own (the tour's arrows and Enter) can handle them first or
 * after, as it likes.
 *
 * Shift+Tab from the container itself counts as "before the first control": the card is what
 * has focus when a dialog opens, and the browser would otherwise walk backwards out of it.
 * Forward Tab from the container is left to the browser, which correctly moves into the first
 * control. An empty container holds focus rather than losing it.
 */
export function wrapTab(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled')
  )
  if (items.length === 0) {
    event.preventDefault()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (event.shiftKey ? active === first || active === container : active === last) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }
}
