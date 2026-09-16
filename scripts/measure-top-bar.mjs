/**
 * Measure the title bar in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-top-bar.mjs
 *     SIZES=1121x800 node_modules/electron/dist/electron scripts/measure-top-bar.mjs
 *
 * A sibling of `measure-explore-header.mjs`, built the same way and for the same reason: the
 * jsdom tests apply no CSS and compute no layout, so every control there is zero pixels wide and
 * nothing can overlap anything. This runs the built renderer in an offscreen window, which is
 * never shown on any desktop, and reads the geometry back out.
 *
 * The title bar is 50px tall and shares its row with the search field and the three window
 * controls. Adding two buttons to it is exactly the change that pushes something off the end, so
 * the five questions are:
 *
 *   height     The row is 50px and must stay 50px. Anything in it that grows the row instead of
 *              fitting inside it takes the height from the view underneath.
 *   overlap    The search field's right edge against the buttons' left edge. This is the defect
 *              the change had to fix rather than cause: the field used to be absolutely centred,
 *              which placed it from the row's midpoint with no knowledge of what was to its
 *              right, and at 1121px a 420px box centred on 441 ran to 651 while the buttons
 *              began at 497.
 *   clipped    A button whose label ran out of room. Both declare `white-space: nowrap`, so the
 *              symptom is text spilling out of the box rather than wrapping.
 *   sideways   The bar, or the document, pushed wider than the window.
 *   corner     The close button's right edge against `innerWidth`. It is flush there by design
 *              (see the focus-ring rule in App.svelte), and a stray padding would move it.
 *
 * It also presses Launch Clone Hero with a main that refuses, because the failure note is the
 * one part of this bar whose size is not known in advance. The note is `position: absolute`, so
 * the claim is that a message of any length costs the row nothing, and this is what checks it
 * rather than assuming it.
 *
 * The widths worth passing are the ones the shell supports: the window minimum is 960, the rail
 * is 374px wide and appears above 1120, so the bar is 722px at 960, 882px at 1120, and then
 * 883px at 1121 when it spans the view and the rail together. 1121 is where the layout changes
 * shape, which is why it is in the default list twice over.
 *
 * What it touches: a throwaway user-data directory, and nothing else. No network, no catalogue,
 * no library, no settings: the preload it writes below answers every call from memory.
 */

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const SIZES = (process.env.SIZES || '960x800,1120x800,1121x800,1280x800,1920x1080')
  .split(',')
  .map((s) => s.trim().split('x').map(Number))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-topbar-'))
const preloadPath = path.join(scratch, 'preload.cjs')
fs.writeFileSync(
  preloadPath,
  `// A library folder and a Clone Hero, so both buttons are in the state a configured user has.
// The game path is deliberately long and holds a space, because the failure note prints it back.
const settings = {
  libraryFolders: [{ path: '/home/someone/.clonehero/Songs', isDefault: true }],
  downloadFormat: 'sng',
  downloadConcurrency: 3,
  downloadVideos: false,
  chartFolderName: '{artist} - {name} ({charter})',
  previewVolume: 50,
  tourSeen: true,
  lastSeenVersion: '9.9.9',
  scoreFolder: '',
  gamePath: '/home/someone/Games/Clone Hero/Clone Hero'
}
const answers = {
  settingsGet: () => settings,
  catalogQuery: () => [],
  catalogCount: () => 0,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  appUpdateStatus: () => ({ state: 'idle' }),
  gameExecutable: () => ({
    path: settings.gamePath,
    platform: 'linux',
    supported: true,
    kind: 'file',
    executable: true,
    usable: true
  }),
  // The refusal the note has to draw, at about the length a real one is: main sends back the
  // sentence describeGameExecutable produced, and every one of those names the path.
  gameLaunch: () =>
    Promise.reject(new Error('There is nothing at ' + settings.gamePath + '.'))
}
window.encore = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
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
 * What the title bar is, as layout has it.
 *
 * `overlap` is the number this script exists for: positive means the search field is drawn under
 * the buttons. `clippedBy` is the label that ran out of room, measured the way the row script
 * measures a nowrap box, and `corner` is the gap the window controls must not grow.
 */
const SHAPE = `(() => {
  const bar = document.querySelector('.topbar')
  const search = bar.querySelector('.search')
  const input = search.querySelector('input')
  const kbd = search.querySelector('.kbd')
  const actions = bar.querySelector('.actions')
  const controls = bar.querySelector('.controls')
  const note = bar.querySelector('.topbar-note')
  const view = document.querySelector('.view')

  const box = (el) => {
    const b = el.getBoundingClientRect()
    return {
      left: Math.round(b.left),
      right: Math.round(b.right),
      top: Math.round(b.top),
      bottom: Math.round(b.bottom),
      width: Math.round(b.width),
      height: Math.round(b.height)
    }
  }

  const canvas = document.createElement('canvas')
  const pen = canvas.getContext('2d')
  const textWidth = (el, text) => {
    const s = getComputedStyle(el)
    pen.font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily
    return Math.round(pen.measureText(text).width)
  }

  const buttons = [...actions.querySelectorAll('button')].map((b) => ({
    says: b.textContent.trim(),
    ...box(b),
    clippedBy: Math.max(0, b.scrollWidth - b.clientWidth)
  }))

  const s = box(search)
  const a = box(actions)
  return {
    bar: box(bar),
    search: s,
    // What the field can still show: the placeholder against the room left inside its padding,
    // minus the key hint sitting on top of it at the right.
    searchRoom:
      Math.round(
        input.clientWidth -
          parseFloat(getComputedStyle(input).paddingLeft) -
          parseFloat(getComputedStyle(input).paddingRight)
      ) - textWidth(input, input.placeholder),
    kbd: box(kbd).width,
    actions: a,
    buttons,
    controls: box(controls),
    note: note === null ? null : box(note),
    viewTop: Math.round(box(view).top),
    overlap: s.right - a.left,
    corner: Math.round(window.innerWidth - box(controls).right),
    barSideways: Math.round(bar.scrollWidth - bar.clientWidth),
    docSideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

const LAUNCH = `[...document.querySelectorAll('.topbar .actions button')].find(b => b.textContent.trim() === 'Launch Clone Hero')`

function report(label, shape) {
  const verdict = (ok, bad) => (ok ? 'ok' : bad)
  console.log(`  ${label}`)
  console.log(
    `    bar           ${shape.bar.width}px wide, ${shape.bar.height}px tall  ${verdict(shape.bar.height === 50, 'HEIGHT MOVED')}`
  )
  console.log(
    `    search        ${shape.search.left}-${shape.search.right}px, placeholder ${
      shape.searchRoom < 0 ? `SHORT BY ${-shape.searchRoom}px` : `${shape.searchRoom}px spare`
    }, hint ${shape.kbd}px`
  )
  for (const b of shape.buttons) {
    console.log(
      `    button        ${String(b.width).padStart(4)}px at ${b.left}-${b.right}px  ${
        b.clippedBy > 0 ? `CLIPPED BY ${b.clippedBy}px` : 'not clipped'
      }  "${b.says}"`
    )
  }
  console.log(
    `    controls      ${shape.controls.left}-${shape.controls.right}px, ${shape.corner}px from the window edge  ${verdict(shape.corner === 0, 'NOT FLUSH')}`
  )
  console.log(
    `    overlap       search to buttons ${shape.overlap}px  ${verdict(shape.overlap <= 0, 'OVERLAPPING')}`
  )
  console.log(
    `    sideways      bar ${shape.barSideways}px, document ${shape.docSideways}px  ${verdict(shape.barSideways === 0 && shape.docSideways === 0, 'SCROLLS')}`
  )
  if (shape.note !== null) {
    console.log(
      `    note          ${shape.note.width}x${shape.note.height}px at ${shape.note.left}-${shape.note.right}px, top ${shape.note.top}px  ${verdict(
        shape.note.left >= 0 && shape.note.right <= shape.bar.right,
        'OFF THE END'
      )}`
    )
  }
}

// Electron quits when the last window closes, and each size's window is destroyed before the
// next one is made. Without this the quit begins between the two and the next load is cancelled.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  for (const [width, height] of SIZES) {
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
    await waitFor(win, LAUNCH)
    await sleep(600)

    console.log(`window ${width}x${height}`)
    const resting = await evalIn(win, SHAPE)
    report('resting', resting)

    // The failure note, at the length a real refusal is. Its own box is out of flow, so what is
    // being checked is that the row above it did not move.
    await evalIn(win, `${LAUNCH}.click(), 1`)
    await waitFor(win, `document.querySelector('.topbar-note')`)
    await sleep(200)
    const refused = await evalIn(win, SHAPE)
    report('launch refused', refused)
    console.log(
      `    row cost      bar ${refused.bar.height - resting.bar.height}px, view top ${refused.viewTop - resting.viewTop}px`
    )
    win.destroy()
  }
  app.exit(0)
})
