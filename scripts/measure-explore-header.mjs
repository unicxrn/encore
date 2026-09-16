/**
 * Measure the Explore filter header in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-explore-header.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-explore-header.mjs
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so every
 * control is zero pixels wide, nothing wraps and nothing can overflow. This runs the built
 * renderer in an offscreen window, which is never shown on any desktop, and reads the geometry
 * back out. The step before this one found a title box at 0px this way, and the one before that
 * found labels ellipsised at 71px; jsdom called both of them fine.
 *
 * The five questions:
 *
 *   controls   Every control in the header, with its box and the width its own longest option
 *              needs. A `<select>` does not report truncation through `scrollWidth`, so the
 *              text is measured against the element's font on a canvas and compared to the box
 *              inside its padding. That is the only way to see a chip whose "Recently updated"
 *              has quietly become "Recently upda...".
 *   clipped    Anything that declares an ellipsis and ran out of room, the way the row script
 *              counts it.
 *   lines      How many lines the filter row wraps to, and how many the chip row under it wraps
 *              to. Wrapping is the design; wrapping to four lines at 509px would not be.
 *   rows       How many result rows fit in what is left of an 800px window. The header is paid
 *              for out of the list, so this is the price of every line the header grows by.
 *   sideways   The header pushing the view or the document wider than its box.
 *   room       What is left for the results underneath. A header that grew into the list is a
 *              header that cost more than it is worth, and the number here is what it left.
 *
 * The widths worth passing are the ones the shell supports. The window minimum is 960px and the
 * rail is 374px wide and appears above 1120px, so the view column is 722px at a 960px window,
 * 882px at 1120px, and then drops to 509px at 1121px when the rail takes its share back. 1121
 * is the narrowest this header is ever asked to be, and it is not the smallest window.
 *
 *     BAND=on   choose an instrument first, which is what turns the intensity band live and
 *               swaps its "pick an instrument" hint for two working selects
 *     CHIP=year open the Year chip's editor, which is the tallest of the five (it carries the
 *               decade presets) and the one that can reach past the bottom of the header
 *     SET=<text> with CHIP, type that into the open editor and apply it, which is how a chip
 *               carrying a long value (a charter's name, say) gets measured
 *
 * Both states are worth measuring and neither is the worse one everywhere: off carries the hint,
 * on carries two enabled selects and a longer accessible name.
 *
 * What it touches: the live Chorus Encore API, one request against a budget of 50 a minute, and
 * a throwaway user-data directory. Not the catalogue, not the library, not settings: the
 * preload it writes below answers every call from memory.
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
// Enough of a ChartRecord for Installed to draw a row, in the three states DiffPips tells
// apart: rated, charted but unrated, and not charted at all. Everything absent from these
// objects is filled in by the schema's defaults on the main side, which is not running here,
// so the fields Library actually reads are the ones spelled out.
const records = Array.from({ length: 30 }, (_, i) => ({
  path: '/library/Chart ' + i,
  chartType: 'folder',
  name: i % 3 === 0 ? 'A Very Long Chart Title To See Where It Truncates ' + i : 'Chart ' + i,
  artist: 'An Artist With A Reasonably Long Name',
  album: 'An Album Title That Is Also Long',
  genre: 'Metal',
  year: 2011,
  charter: 'SomeCharterName',
  diffGuitar: (i % 7) - 1,
  diffBass: i % 2 === 0 ? 3 : -1,
  diffDrums: 5,
  songLength: 250000,
  albumArtMd5: null,
  instruments: i % 2 === 0 ? ['guitar', 'bass', 'drums'] : ['guitar', 'drums'],
  noteCounts: [],
  maxNps: [],
  hasVideo: false,
  hasBackground: false,
  hasAlbumArt: false,
  hasLyrics: false
}))
const answers = {
  settingsGet: () => settings,
  catalogQuery: () => records,
  catalogCount: () => records.length,
  // Installed asks for these on its way to a first paint and reads into the answer without
  // checking, so an undefined here is the whole view crashing rather than a missing filter.
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  favouritesList: () => [],
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
 * What the header is, as layout has it.
 *
 * `needs` is the width the control's own text wants, measured on a canvas in the element's own
 * font: for a `<select>` that is its longest option, because any of them can be the one on
 * screen. `room` is that width against the box inside the padding, so a negative number is text
 * the control cannot draw. Selects are the reason this is here at all: they clip by shortening
 * the option they draw, and `scrollWidth` says nothing about it.
 */
const SHAPE = `(() => {
  const main = document.querySelector('.main')
  const bar = document.querySelector('.searchbar')
  const filters = document.querySelector('.filters')
  const table = document.querySelector('.table')

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
    (el.className.toString().split(' ')[0] || el.tagName.toLowerCase())

  const chips = document.querySelector('.fdrops')

  const controls = []
  for (const el of [
    ...bar.querySelectorAll('input'),
    ...filters.querySelectorAll('select, button'),
    ...chips.querySelectorAll(':scope > .fd-wrap > .fd')
  ]) {
    if (el.closest('.modes') && el.tagName === 'BUTTON' && controls.some((c) => c.what === 'modes')) continue
    const text =
      el.tagName === 'SELECT'
        ? [...el.options].map((o) => o.textContent || '').reduce((a, b) => (a.length >= b.length ? a : b), '')
        : (el.textContent || el.placeholder || '').trim()
    const needs = Math.round(textWidth(el, text))
    const box = Math.round(inner(el))
    controls.push({
      what: el.closest('.modes') ? 'modes' : named(el),
      says: text.slice(0, 22),
      width: Math.round(el.getBoundingClientRect().width),
      box,
      needs,
      // A select draws an arrow in its own padding, which 'inner' has already taken off.
      room: box - needs
    })
  }

  // Everything in the header that declares an ellipsis, counted the way the row script counts it.
  // The chips are in here because each one is capped at 240px and carries a value it did not
  // choose the length of: a charter's name is whatever the charter called themselves.
  const clipped = []
  for (const el of main.querySelectorAll('.searchbar *, .filters *, .fdrops *, .dropped *')) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
    if (el.scrollWidth - el.clientWidth > 1) {
      clipped.push({
        cls: el.className.toString().split(' ')[0],
        box: el.clientWidth,
        says: (el.textContent || '').trim().slice(0, 30)
      })
    }
  }

  // How many lines a wrapping row took, by walking its children in visual order and starting a
  // new line at the first one that clears the bottom of the line so far.
  //
  // Not by distinct tops, which is what this counted first and got wrong: the row is centred, so
  // a 20px group of difficulty dots and a 27px select sitting side by side have different tops
  // and counted as two lines. Overlap is the question, and overlap is what this asks.
  const lines = (el) => {
    const boxes = [...el.children]
      .map((child) => child.getBoundingClientRect())
      .sort((a, b) => a.top - b.top || a.left - b.left)
    let count = 0
    let bottom = -Infinity
    for (const box of boxes) {
      if (box.top >= bottom - 1) {
        count += 1
        bottom = box.bottom
      } else {
        bottom = Math.max(bottom, box.bottom)
      }
    }
    return count
  }

  // What one result row costs, measured rather than assumed: the rows are variable height, so
  // this is the first one and the count below is what fits beside it.
  const firstRow = document.querySelector('.table .row, .table .card')
  const rowHeight = firstRow ? Math.round(firstRow.getBoundingClientRect().height) : 0

  // An open chip editor hangs over the list rather than pushing it down, so it is measured
  // against the header it escapes rather than added to it.
  const open = document.querySelector('.fdrops .pop')
  const headerBottom = chips.getBoundingClientRect().bottom
  return {
    viewWidth: Math.round(main.getBoundingClientRect().width),
    headerHeight: Math.round(headerBottom - main.getBoundingClientRect().top),
    listHeight: Math.round(table.getBoundingClientRect().height),
    rows: document.querySelectorAll('.table .row, .table .card').length,
    rowHeight,
    rowsThatFit: rowHeight > 0 ? Math.floor(table.getBoundingClientRect().height / rowHeight) : 0,
    filterLines: lines(filters),
    chipLines: lines(chips),
    popOverhang: open
      ? Math.round(open.getBoundingClientRect().bottom - headerBottom)
      : null,
    controls,
    clipped,
    // Positive means the header is pushing its own column wider than the frame around it.
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
    // The intensity band is off until an instrument is chosen, so its live width is only
    // reachable through the control that turns it on.
    await evalIn(
      win,
      `(() => {
        const el = document.querySelector('[aria-label="Filter by instrument"]')
        el.value = 'guitarcoopghl'
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return 1
      })()`
    )
    await waitFor(win, `document.querySelector('.band select:not([disabled])')`)
  }
  // The list, not the grid the store opens in: a result row is what the header is paid for out
  // of, and `rowsThatFit` below is only a number anyone can use if the things being counted are
  // rows. The grid's cards are a different height and `measure-explore-row.mjs` is where they
  // are measured.
  await evalIn(win, `${named('List')}.click(), 1`)
  await waitFor(win, `document.querySelector('.table .row')`)

  const chipToOpen = process.env.CHIP
  if (chipToOpen) {
    // The editors are drawn only while one is open, and the Year one is the tall case: it is the
    // only chip carrying the decade presets.
    await evalIn(
      win,
      `(() => {
        const el = document.querySelector('#chip-${chipToOpen}') ||
          [...document.querySelectorAll('.fdrops .fd')]
            .find(b => (b.getAttribute('aria-controls') || '') === 'chip-${chipToOpen}')
        if (el && el.tagName === 'BUTTON') el.click()
        return 1
      })()`
    )
    await waitFor(win, `document.querySelector('#chip-${chipToOpen}')`)
    // A chip carries a value it did not choose the length of: a charter's name is whatever the
    // charter called themselves. SET is how the long case gets on screen, so `clipped` can say
    // whether the 240px cap ellipsises it or the row is pushed sideways instead.
    if (process.env.SET) {
      await evalIn(
        win,
        `(() => {
          const box = document.querySelector('#chip-${chipToOpen} input')
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(box, ${JSON.stringify(process.env.SET)})
          box.dispatchEvent(new Event('input', { bubbles: true }))
          ;[...document.querySelectorAll('#chip-${chipToOpen} button')]
            .find(b => b.textContent.trim() === 'Apply').click()
          return 1
        })()`
      )
      await sleep(1500)
    }
  }
  await waitFor(win, `document.querySelectorAll('.row, .card').length > 0`)
  await sleep(3000)

  const shape = await evalIn(win, SHAPE)
  console.log(
    `window ${width}x${height}  view ${shape.viewWidth}px  band ${band ? 'on' : 'off'}${chipToOpen ? `  chip ${chipToOpen} open` : ''}`
  )
  console.log(
    `  header        ${shape.headerHeight}px tall over a ${shape.listHeight}px list of ${shape.rows}`
  )
  console.log(
    `  rows left     ${shape.rowsThatFit} whole rows of ${shape.rowHeight}px in what the header left`
  )
  console.log(`  filter row    ${shape.filterLines} line${shape.filterLines === 1 ? '' : 's'}`)
  console.log(`  chip row      ${shape.chipLines} line${shape.chipLines === 1 ? '' : 's'}`)
  if (shape.popOverhang !== null) {
    console.log(`  open editor   ${shape.popOverhang}px past the bottom of the header`)
  }
  console.log(`  sideways      view ${shape.sidewaysBy}px, document ${shape.docSidewaysBy}px`)
  console.log('  controls')
  for (const c of shape.controls) {
    console.log(
      `    ${c.what.padEnd(34)} ${String(c.width).padStart(4)}px box, longest text ${String(c.needs).padStart(3)}px, ${c.room < 0 ? `SHORT BY ${-c.room}px` : `${c.room}px spare`}  "${c.says}"`
    )
  }
  console.log(
    shape.clipped.length === 0
      ? '  clipped       nothing'
      : '  clipped       ' +
          shape.clipped.map((c) => `.${c.cls} at ${c.box}px: "${c.says}"`).join('; ')
  )

  app.exit(0)
})
