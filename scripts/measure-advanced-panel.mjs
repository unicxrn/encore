/**
 * Measure Explore's advanced search panel in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-advanced-panel.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-advanced-panel.mjs
 *     BAND=on node_modules/electron/dist/electron scripts/measure-advanced-panel.mjs
 *
 * A sibling of measure-explore-header.mjs, which measures the row of chips this panel drops out
 * of. The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so
 * every control is zero pixels wide, no column resolves and no row wraps. This runs the built
 * renderer in an offscreen window, which is never shown on any desktop, and reads the geometry
 * back out. Earlier steps found a title box at 0px this way and labels ellipsised at 71px; jsdom
 * called both of them fine.
 *
 * The seven questions:
 *
 *   form       How tall the controls want to be, and how much of that the panel scrolls past
 *              rather than taking out of the list. The panel is bounded; see its `max-height`.
 *   columns    How many columns the `auto-fit` grid actually resolved to, by the distinct left
 *              edges of its fieldsets. One at the narrow end is the design; two at 509px and one
 *              at 882px would mean the floor is wrong.
 *   rows       Every field row that wrapped, counted by vertical overlap rather than by tops:
 *              the children are centred against each other, so a 26px box and a 24px pill on one
 *              line start at two different offsets. A label, a box and two modifier pills in a
 *              264px column is the thing most likely to break, and a row wrapping is not wrong by
 *              itself; what is wrong is a box left at a width nothing can be typed into.
 *   controls   Every control in the panel, with its box and the width its own text needs. Text
 *              is measured against the element's font on a canvas, because a value scrolled out
 *              of an `<input>` reports nothing useful and a button's label just overflows.
 *   overflow   Anything whose content is wider than its box, ellipsis or not.
 *   sideways   The panel pushing the view or the document wider than its frame.
 *   room       What is left for the results underneath. The panel is the header's second storey,
 *              and a storey that leaves no list is a storey that cost more than it is worth. A
 *              height, not a row count: this run reaches no network, so Explore's list is an empty
 *              box of the right size and nothing here can say how many rows or cards fit in it.
 *
 * The widths worth passing are the ones the shell supports. The window minimum is 960px and the
 * rail is 374px wide and appears above 1120px, so the view column is 722px at a 960px window and
 * 882px at 1120px, and then drops to 509px at 1121px when the rail takes its share back. 1121 is
 * the narrowest this panel is ever asked to be, and it is not the smallest window. `railOn` in
 * the output says which side of that line the run landed on, read off the rail's own computed
 * display rather than from the number, the way `railOnScreen` does.
 *
 *     BAND=on   choose an instrument first, which is what turns the intensity pair live and
 *               swaps its "pick an instrument" note for the instrument's name
 *
 * Both states are worth measuring: off, the intensity row carries a note no other row has; on,
 * it carries the instrument's name, and "Guitar co-op" is the longest of those.
 *
 * What it touches: the live Chorus Encore API, one request against a budget of 50 a minute, and
 * a throwaway user-data directory. Not the catalogue, not the library, not settings: the preload
 * it writes below answers every call from memory.
 */

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-measure-'))
const preloadPath = path.join(scratch, 'preload.cjs')
fs.writeFileSync(
  preloadPath,
  `const settings = {
  libraryFolders: [{ path: '/library', isDefault: true }],
  downloadFormat: 'sng',
  downloadConcurrency: 3,
  downloadVideos: false,
  chartFolderName: '{artist} - {name} ({charter})',
  previewVolume: 50,
  tourSeen: true,
  lastSeenVersion: '9.9.9'
}
const answers = {
  settingsGet: () => settings,
  catalogQuery: () => [],
  catalogCount: () => 0,
  // Installed asks for these on its way to a first paint and reads into the answer without
  // checking, so an undefined here is the whole view crashing rather than a missing filter.
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  appUpdateStatus: () => ({ state: 'idle' })
}
window.encore = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      // The row's health dot reads this synchronously rather than over IPC, so it has to be a
      // value and not a promise-returning function like everything else here.
      if (key === 'platform') return process.platform
      if (key.startsWith('on')) return () => () => {}
      return (...args) => Promise.resolve(answers[key] ? answers[key](...args) : undefined)
    }
  }
)
`
)
app.setPath('userData', path.join(scratch, 'userdata'))
app.commandLine.appendSwitch('disable-gpu')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evalIn = (win, code) => win.webContents.executeJavaScript(code, true)

async function waitFor(win, expression, timeoutMs = 40000) {
  const started = Date.now()
  for (;;) {
    const ok = await evalIn(
      win,
      `(() => { try { return !!(${expression}) } catch (e) { return false } })()`
    )
    if (ok) return true
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${expression}`)
    await sleep(200)
  }
}

/**
 * What the panel is, as layout has it.
 *
 * `needs` is the width the control's own text wants, measured on a canvas in the element's own
 * font. For a text box that is the value it is holding or, empty, its placeholder; for a button
 * it is the label. `room` is that against the box inside its padding, so a negative number is
 * text the control cannot draw.
 */
const SHAPE = `(() => {
  const main = document.querySelector('.main')
  const panel = document.querySelector('#advanced-panel')
  const table = document.querySelector('.table')
  const rail = document.querySelector('.rail')

  const canvas = document.createElement('canvas')
  const pen = canvas.getContext('2d')
  const textWidth = (el, text) => {
    const style = getComputedStyle(el)
    pen.font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily
    return pen.measureText(text).width
  }
  const inner = (el) => {
    const style = getComputedStyle(el)
    return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  }
  const named = (el) =>
    el.getAttribute('aria-label') ||
    (el.textContent || '').trim() ||
    (el.className.toString().split(' ')[0] || el.tagName.toLowerCase())

  const controls = []
  for (const el of panel.querySelectorAll('input, button')) {
    const text = el.tagName === 'INPUT' ? el.value || el.placeholder || '' : (el.textContent || '').trim()
    const needs = Math.round(textWidth(el, text))
    const box = Math.round(inner(el))
    controls.push({
      what: named(el).slice(0, 44),
      says: text.slice(0, 22),
      width: Math.round(el.getBoundingClientRect().width),
      box,
      needs,
      room: box - needs,
      off: el.disabled === true
    })
  }

  // Which columns the auto-fit grid resolved to, and how tall each one came out.
  const cols = [...document.querySelectorAll('.cols > fieldset')].map((el) => {
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }
  })
  const columnCount = new Set(cols.map((c) => c.left)).size

  // Every field row that wrapped, plus the narrowest box left on it. A row wrapping is fine; a
  // 12px box on it is not.
  //
  // Counted by vertical overlap rather than by distinct tops. The children are centred against
  // each other, so a 26px box and a 24px pill on ONE line start at two different offsets, and
  // counting tops reported every text row as four lines when it is two.
  const lineCount = (kids) => {
    const rects = kids.map((el) => el.getBoundingClientRect()).sort((a, b) => a.top - b.top)
    let lines = 0
    let bottom = -Infinity
    for (const r of rects) {
      if (r.top >= bottom) lines += 1
      bottom = Math.max(bottom, r.bottom)
    }
    return lines
  }
  const wrapped = []
  for (const row of panel.querySelectorAll('.row')) {
    const kids = [...row.children]
    const lines = lineCount(kids)
    if (lines < 2) continue
    const boxes = kids.filter((el) => el.tagName === 'INPUT')
    wrapped.push({
      label: (kids[0].textContent || '').trim().slice(0, 16),
      lines,
      narrowest: boxes.length
        ? Math.min(...boxes.map((el) => Math.round(el.getBoundingClientRect().width)))
        : null
    })
  }

  // Anything whose content is wider than its box, whether or not it declares an ellipsis.
  const overflow = []
  for (const el of panel.querySelectorAll('*')) {
    if (el.scrollWidth - el.clientWidth > 1) {
      overflow.push({
        cls: el.className.toString().split(' ')[0] || el.tagName.toLowerCase(),
        box: el.clientWidth,
        by: el.scrollWidth - el.clientWidth,
        says: (el.textContent || '').trim().slice(0, 30)
      })
    }
  }

  const top = main.getBoundingClientRect().top
  const panelBox = panel.getBoundingClientRect()
  const body = panel.querySelector('.body')
  return {
    // What the form wants, against what it got. The second number is what the panel scrolls
    // past rather than taking out of the list underneath.
    formHeight: body.scrollHeight,
    hidden: Math.max(0, body.scrollHeight - body.clientHeight),
    viewWidth: Math.round(main.getBoundingClientRect().width),
    railOn: rail !== null && getComputedStyle(rail).display !== 'none',
    panelHeight: Math.round(panelBox.height),
    // The whole header block: the search box, the filter row and the panel under them.
    headerHeight: Math.round(panelBox.bottom - top),
    listHeight: table === null ? 0 : Math.round(table.getBoundingClientRect().height),
    columnCount,
    cols,
    controls,
    wrapped,
    overflow,
    // Positive means the panel is pushing its own column wider than the frame around it.
    sidewaysBy: Math.round(main.scrollWidth - main.clientWidth),
    docSidewaysBy: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      offscreen: true
    }
  })
  win.webContents.setFrameRate(30)
  await win.loadFile(path.join(here, '..', 'out', 'renderer', 'index.html'))

  const named = (label) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}')`

  await waitFor(win, named('Explore'))
  await evalIn(win, `${named('Explore')}.click(), 1`)
  await waitFor(win, `document.querySelector('.filters select')`)

  const band = process.env.BAND === 'on'
  if (band) {
    // The intensity pair is off until an instrument is chosen, so its live width is only
    // reachable through the filter row's own control. Co-op (GHL) is the longest instrument
    // name, which is what the row's "rated for ..." note has to fit.
    await evalIn(
      win,
      `(() => {
        const el = document.querySelector('[aria-label="Filter by instrument"]')
        el.value = 'guitarcoopghl'
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return 1
      })()`
    )
  }

  // The panel is shut until it is asked for, which is the point of the button.
  await evalIn(win, `document.querySelector('.adv').click(), 1`)
  await waitFor(win, `document.querySelector('#advanced-panel')`)
  await sleep(2500)

  const shape = await evalIn(win, SHAPE)
  console.log(
    `window ${width}x${height}  view ${shape.viewWidth}px  rail ${shape.railOn ? 'open' : 'closed'}  band ${band ? 'on' : 'off'}`
  )
  console.log(
    `  panel         ${shape.panelHeight}px, in a ${shape.headerHeight}px header over a ${shape.listHeight}px list`
  )
  console.log(
    `  form          ${shape.formHeight}px of controls, ${shape.hidden === 0 ? 'all of it on screen' : `${shape.hidden}px behind the panel's own scroll`}`
  )
  console.log(
    `  columns       ${shape.columnCount} (${shape.cols.map((c) => `${c.width}x${c.height}`).join(', ')})`
  )
  console.log(`  sideways      view ${shape.sidewaysBy}px, document ${shape.docSidewaysBy}px`)
  console.log(
    shape.wrapped.length === 0
      ? '  wrapped rows  none'
      : '  wrapped rows  ' +
          shape.wrapped
            .map(
              (r) =>
                `${r.label} over ${r.lines} lines${r.narrowest === null ? '' : `, narrowest box ${r.narrowest}px`}`
            )
            .join('; ')
  )
  console.log('  controls')
  for (const c of shape.controls) {
    console.log(
      `    ${c.what.padEnd(46)} ${String(c.width).padStart(4)}px box, text ${String(c.needs).padStart(3)}px, ${c.room < 0 ? `SHORT BY ${-c.room}px` : `${c.room}px spare`}${c.off ? '  [off]' : ''}  "${c.says}"`
    )
  }
  console.log(
    shape.overflow.length === 0
      ? '  overflow      nothing'
      : '  overflow      ' +
          shape.overflow.map((o) => `.${o.cls} by ${o.by}px at ${o.box}px: "${o.says}"`).join('; ')
  )

  app.exit(0)
})
