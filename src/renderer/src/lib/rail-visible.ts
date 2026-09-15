/**
 * Whether the preview rail is on screen right now.
 *
 * Explore's rows fill the rail instead of navigating, which is only an answer while the rail can
 * be seen. Below the shell's breakpoint the column is `display: none`, and a click that filled a
 * hidden column would look like a click that did nothing.
 *
 * The breakpoint is not repeated here. It is written once, in App.svelte's media query, and this
 * reads the answer off the rail's own computed `display`, the same way `releaseIfHidden` in
 * Rail.svelte hands the preview viewport back when the window narrows. A later change to the
 * number needs no matching edit in this file or in that one.
 *
 * No rail in the document counts as hidden, which is the honest answer: a caller asking this is
 * asking whether it has somewhere to put a chart, and a column that is not rendered is not it.
 */
export function railOnScreen(doc: Document = document): boolean {
  const rail = doc.querySelector('.rail')
  const view = doc.defaultView
  if (rail === null || view === null) return false
  return view.getComputedStyle(rail).display !== 'none'
}
