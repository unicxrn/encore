/**
 * What every offscreen measurement harness in this folder needs, in one place.
 *
 * The harnesses each grew their own copy of the same four helpers, and the copies drifted. That
 * cost days: the sidebar's nav rows gained counts, so the Installed row's `textContent` went
 * from "Installed" to "Installed 1,204", and every copy that matched a button by exact text
 * stopped matching the row it had always clicked. Some of those runs then waited out forty
 * seconds and reported the view as never appearing, which is a true sentence about a false
 * cause; others had no handler on the rejected promise at all, so Electron sat with a finished
 * job and no reason to quit and the run never ended.
 *
 * So the two things worth sharing are the two things that went wrong: how a nav row is addressed,
 * and what happens when something never arrives.
 *
 * `scripts/check-harnesses.mjs` reads this file's exports back out of every harness and fails if
 * one of them stops using them.
 */
import { app } from 'electron'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `code` in the renderer as a user gesture, which is what a click needs to count. */
export const evalIn = (win, code) => win.webContents.executeJavaScript(code, true)

/**
 * A sidebar nav row, addressed by the label beside its glyph.
 *
 * The row is `<button class="item">` holding a glyph, `<span class="label">` and, on five of the
 * eleven rows, a `<span class="count">`. The count is why matching the button's whole text broke:
 * it is inside the button, so `textContent` carries it. The label span never does, and neither
 * does it carry the row's `aria-label`, which spells the same figure out in words for a screen
 * reader. Reading the label alone is therefore immune to a row gaining, losing or changing a
 * count, which is the change that actually keeps happening.
 *
 * A row renamed outright ("Assets" became "Asset Studio", "Stats" became "Statistics") still
 * misses, because nothing in the DOM identifies a row except what it says. That is the reason
 * `clickNav` prints the labels it did find: a rename then costs one legible error instead of
 * forty seconds of silence and a wrong diagnosis.
 */
export const navRow = (label) =>
  `[...document.querySelectorAll('nav.sidebar .section .item')]` +
  `.find(b => b.querySelector('.label')?.textContent.trim() === ${JSON.stringify(label)})`

/** Every nav label on screen, for the message a missed row prints. */
const NAV_LABELS = `[...document.querySelectorAll('nav.sidebar .section .item .label')].map(e => e.textContent.trim()).join(', ')`

/**
 * A button whose whole visible text is `text`.
 *
 * For the controls that are not nav rows and not quick action tiles: Grid, List, Apply, Clear.
 * None of them carries a figure or a note, so exact text is still the right question to ask about
 * them, and asking it exactly is what keeps "List" from matching "All details".
 */
export const buttonNamed = (text) =>
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`

/**
 * One of the sidebar's quick action tiles, addressed by its own name.
 *
 * The same shape of problem as the nav rows, and it bit at the same time: the tile draws a name
 * in a `<b>` over a note in a `<span>`, so "Surprise me" is "Surprise me Five charts at random"
 * to `textContent`, and every exact match on the whole tile stopped matching when the note was
 * added. The `<b>` is the name on its own.
 */
export const quickAction = (label) =>
  `[...document.querySelectorAll('.quick-btn')]` +
  `.find(b => b.querySelector('.quick-text b')?.textContent.trim() === ${JSON.stringify(label)})`

/** A button whose `aria-label` is exactly `label`. */
export const buttonLabelled = (label) =>
  `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)})`

/**
 * Waits for `expression` to be truthy in the renderer, or throws saying what it waited for.
 *
 * `what` is how the failure reads, so give it the thing rather than the selector wherever the
 * selector is not already the clearest statement of it. `context` is a second expression,
 * evaluated only on the way out, whose value is appended to the message: it is how a missed nav
 * row reports which rows were on screen instead.
 */
export async function waitFor(win, expression, opts = {}) {
  const { what = expression, timeoutMs = 40000, context = null } = opts
  const started = Date.now()
  for (;;) {
    const ok = await evalIn(
      win,
      `(() => { try { return !!(${expression}) } catch (e) { return false } })()`
    )
    if (ok) return true
    if (Date.now() - started > timeoutMs) {
      let extra = ''
      if (context !== null) {
        const seen = await evalIn(
          win,
          `(() => { try { return String(${context}) } catch (e) { return 'unreadable: ' + e.message } })()`
        )
        extra = `\n  what is there instead: ${seen}`
      }
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${extra}`
      )
    }
    await sleep(200)
  }
}

/**
 * Waits for `expression` and answers whether it arrived, instead of throwing when it does not.
 *
 * For a leg that is allowed to be unreachable. Use it only where the harness prints that the leg
 * was not reached: a swallowed timeout that prints nothing is the failure this whole file exists
 * to stop.
 */
export async function reached(win, expression, timeoutMs = 8000) {
  try {
    await waitFor(win, expression, { timeoutMs })
    return true
  } catch {
    return false
  }
}

/** Waits for the sidebar's `label` row and clicks it, naming the rows on screen if it is not there. */
export async function clickNav(win, label, opts = {}) {
  const selector = navRow(label)
  await waitFor(win, selector, {
    what: `the sidebar's ${label} row`,
    context: NAV_LABELS,
    ...opts
  })
  await evalIn(win, `${selector}.click(), 1`)
}

/** Waits for the button reading `text` and clicks it. */
export async function clickButton(win, text, opts = {}) {
  const selector = buttonNamed(text)
  await waitFor(win, selector, { what: `the ${text} button`, ...opts })
  await evalIn(win, `${selector}.click(), 1`)
}

/**
 * Leaves `label` and comes back, so its component mounts again.
 *
 * This was written to get past what looked like a renderer fault: a `writable` written after the
 * app had mounted redrew nothing, so pressing Explore's List left a grid on screen and a finished
 * search left an empty one, while a fresh mount read the right value. The renderer was not at
 * fault. The preload each harness writes below answered `catalogDuplicates` with undefined, the
 * store handed that to a derived that reads `report.identical`, and the throw escaped
 * svelte/store's drain loop, whose queue is module-global: from that moment every `set` in the
 * renderer updated its value and notified nobody. One channel missing from a stub froze the whole
 * window before the first click, and only a remount could draw anything again.
 *
 * `stores/duplicates.ts` now refuses an answer that is not a report, so nothing here depends on
 * this any more. Measured against the built renderer with the same stub: Repeat, Installed's
 * Favourites filter, Explore's advanced panel and a finished search all redraw in place, without
 * a round trip. It is kept because every caller below is timed around it, and it costs a
 * navigation rather than a wrong number.
 */
export async function remount(win, label, { via, settleMs = 1500 } = {}) {
  const waypoint = via ?? (label === 'Home' ? 'Explore' : 'Home')
  await clickNav(win, waypoint)
  await sleep(settleMs)
  await clickNav(win, label)
  await sleep(settleMs)
}

/**
 * Opens Explore with its first search drawn, in `mode` ("List" or "Grid") when one is asked for.
 *
 * The mode is chosen rather than assumed: the store opens in grid. The round trip is left in for
 * the reason `remount` gives, not because the view needs one.
 *
 * The wait is tried again rather than timed once, because the search goes to the live Chorus
 * Encore API and how long it takes is not this harness's to know. A check that lands mid-flight
 * sees an empty grid, which is the one outcome worth more than any amount of waiting to avoid:
 * an empty grid measures, and its numbers are wrong.
 */
export async function openExplore(win, { mode = null, searchMs = 6000, tries = 4 } = {}) {
  await clickNav(win, 'Explore')
  await waitFor(win, `document.querySelector('.filters select')`, {
    what: "Explore's filter row"
  })
  if (mode !== null) await clickButton(win, mode)
  const drawn = `document.querySelectorAll('.table .row, .table .card').length > 0`
  for (let attempt = 1; attempt <= tries; attempt++) {
    await sleep(searchMs)
    await remount(win, 'Explore')
    if (await reached(win, drawn, 2000)) return
  }
  throw new Error(
    `Explore drew no row after ${tries} tries of ${Math.round(searchMs / 1000)}s and a remount.` +
      `\n  what is there instead: ` +
      (await evalIn(
        win,
        `document.querySelector('.table')?.textContent.trim().slice(0, 160) ?? 'no .table on screen'`
      ))
  )
}

/**
 * Makes a failure say so and stop, rather than sit.
 *
 * Nearly every harness here is `app.whenReady().then(async () => { ... })` with nothing after it.
 * A throw inside that leaves a rejected promise, and an Electron app with no window shown and no
 * `app.exit` reached has nothing to make it quit: the run hangs until something outside kills it,
 * having printed not one word about what it was waiting for. Node's own warning about the
 * unhandled rejection is printed, which is how `measure-explore-row.mjs` was found still running
 * after seven minutes.
 *
 * `deadlineMs` covers the other shape of hang, where nothing rejects because nothing resolves: a
 * renderer that stops answering takes `executeJavaScript` with it and no timeout inside `waitFor`
 * ever gets to run. The default is far longer than the slowest harness here (about two minutes)
 * on purpose, because it is a backstop and not a budget.
 */
export function exitOnFailure(name, { deadlineMs = 10 * 60 * 1000 } = {}) {
  const die = (reason, err) => {
    const said = err instanceof Error ? err.stack || err.message : String(err)
    console.error(`\n${name} ${reason}: ${said}`)
    app.exit(1)
  }
  process.on('unhandledRejection', (err) => die('failed', err))
  process.on('uncaughtException', (err) => die('failed', err))
  setTimeout(() => {
    die('ran past its deadline', new Error(`still running after ${Math.round(deadlineMs / 1000)}s`))
  }, deadlineMs)
}
