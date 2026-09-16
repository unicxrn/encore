/**
 * Measure the Settings view in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-settings.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-settings.mjs
 *     PATHS=long node_modules/electron/dist/electron scripts/measure-settings.mjs
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so every
 * control is zero pixels wide, nothing wraps and nothing can overflow. This runs the built
 * renderer in an offscreen window, which is never shown on any desktop, and reads the geometry
 * back out. Earlier steps of the redesign found a title box at 0px this way and labels
 * ellipsised at 71px; jsdom called both of them fine.
 *
 * What it asks:
 *
 *   groups     Every group card, with its box and how tall it came out. A card at 0px, or one
 *              wider than the column it sits in, is the failure mode a screenshot hides.
 *   controls   Every input and button in the view, with its box and the width its own text
 *              needs, measured on a canvas in the element's own font. A negative `room` is text
 *              the control cannot draw.
 *   rows       Whether a control row kept its control beside its label or stacked it underneath.
 *              Stacking is the design below a certain width and a surprise above it, so the
 *              state is printed rather than asserted.
 *   clipped    Anything that declares an ellipsis and ran out of room, counted the way the
 *              Explore scripts count it. The library path is deliberately NOT in this set: it
 *              wraps instead, and the library-path block below is what says whether that is working.
 *   sideways   The view or the document being pushed wider than its own box. A long library
 *              path is the thing most likely to do it.
 *
 * The widths worth passing are the ones the shell supports. The window minimum is 960px, the
 * rail is 374px and appears above 1120px, and the sidebar is 238px throughout, so the view
 * column is 722px at a 960px window, 882px at 1120px, 509px at 1121px where the rail takes its
 * share back, 668px at the 1280px default and 1308px at 1920px. 509px is the narrowest this
 * view is ever asked to be and it is not the smallest window.
 *
 *     PATHS=long   three library folders with deeply nested paths, the longest 100 characters,
 *                  instead of the two ordinary ones
 *     PATHS=none   no library folders at all, which is what a first run looks like
 *     ARMED=on     press Clear once first, so the undo row is measured carrying "Delete them
 *                  permanently" rather than the four-letter label it rests on
 *
 * What it touches: nothing. The preload below answers every call from memory, so there is no
 * catalogue, no library, no settings file and no network.
 */

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
const paths =
  process.env.PATHS === 'long' ? 'long' : process.env.PATHS === 'none' ? 'none' : 'ordinary'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-measure-'))
const preloadPath = path.join(scratch, 'preload.cjs')

// The ordinary case and the worst one. The long set is not invented: it is a second drive, a
// Steam library and a Wine prefix, which is where these folders actually end up.
const FOLDERS =
  paths === 'none'
    ? []
    : paths === 'long'
      ? [
          {
            path: '/mnt/storage/games/clone-hero/Clone Hero Songs/Downloaded from Chorus Encore',
            isDefault: true
          },
          {
            path: '/home/a-rather-long-user-name/.steam/steam/steamapps/common/Clone Hero/Songs',
            isDefault: false
          },
          {
            path: '/home/a-rather-long-user-name/.wine/drive_c/users/a-rather-long-user-name/Documents/Clone Hero/Songs',
            isDefault: false
          }
        ]
      : [
          { path: '/home/u/.clonehero/Songs', isDefault: true },
          { path: '/mnt/music/charts', isDefault: false }
        ]

fs.writeFileSync(
  preloadPath,
  `const settings = {
  libraryFolders: ${JSON.stringify(FOLDERS)},
  downloadFormat: 'sng',
  downloadConcurrency: 3,
  downloadVideos: false,
  chartFolderName: '{artist} - {name} ({charter})',
  previewVolume: 50,
  tourSeen: true,
  lastSeenVersion: '9.9.9',
  scoreFolder: ''
}
const answers = {
  settingsGet: () => settings,
  settingsSet: () => undefined,
  // The longest of the four states this line has: a found folder, named with both files.
  scoreFolderReport: () => ({
    folder: '/home/a-rather-long-user-name/.config/unity3d/srylain Inc_/Clone Hero',
    exists: true,
    lookedFor: ['scoredata.bin', 'scoresext.bin', 'scoredata_backup.bin', 'scoresext_backup.bin'],
    found: ['scoredata.bin', 'scoresext.bin'],
    quarantined: [],
    usable: true
  }),
  // Installed, with the longest version string either tool prints.
  sidecarStatus: (name) => ({
    installed: true,
    version: name === 'ffmpeg' ? 'ffmpeg version 6.1.1-3ubuntu5' : '2024.08.06',
    path: '/s/bin'
  }),
  backupsList: () => ({ backups: [], totalBytes: 512 * 1024 * 1024 }),
  backupsClear: () => undefined,
  // The AppImage note is the longest of the four, and 'available' is the state that puts the
  // most buttons on the Encore row.
  appUpdateStatus: () => ({
    currentVersion: '0.4.0',
    target: 'appimage',
    canApply: true,
    note: 'Encore downloads the new AppImage and replaces this one when you restart.',
    state: { kind: 'available', version: '0.5.0' }
  }),
  catalogQuery: () => [],
  catalogCount: () => 0,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  downloadList: () => [],
  favouritesList: () => [],
  setlistsList: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 })
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

const SHAPE = `(() => {
  const view = document.querySelector('.view')
  const page = document.querySelector('.settings')

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
  const lines = (el) => {
    const style = getComputedStyle(el)
    const lh = parseFloat(style.lineHeight)
    return Number.isFinite(lh) ? Math.round(el.getBoundingClientRect().height / lh) : 1
  }

  const groups = [...page.querySelectorAll('.group')].map((el) => ({
    name: (el.querySelector('h2').textContent || '').trim(),
    width: Math.round(el.getBoundingClientRect().width),
    height: Math.round(el.getBoundingClientRect().height)
  }))

  const controls = []
  for (const el of page.querySelectorAll('input, button')) {
    if (el.type === 'radio') continue
    const text = (el.textContent || el.value || '').trim()
    const needs = Math.round(textWidth(el, text))
    const box = Math.round(inner(el))
    controls.push({
      what: el.getAttribute('aria-label') || el.id || text || el.tagName.toLowerCase(),
      says: text.slice(0, 26),
      width: Math.round(el.getBoundingClientRect().width),
      box,
      needs,
      room: box - needs
    })
  }

  // Whether a row put its control on a line of its own. Not the distinct tops of the children:
  // the label block is two lines tall and the control is centred against it, so their tops
  // differ in the ordinary case too. What says "wrapped" is the control starting at or below
  // the label block's bottom edge.
  const wrapped = [...page.querySelectorAll('.row')].map((row) => {
    const text = row.querySelector('.row-text').getBoundingClientRect()
    const control = row.querySelector('input').getBoundingClientRect()
    return {
      label: (row.querySelector('.row-label').textContent || '').trim(),
      stacked: control.top >= text.bottom - 1,
      controlWidth: Math.round(control.width)
    }
  })

  const clipped = []
  for (const el of page.querySelectorAll('*')) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
    if (el.scrollWidth - el.clientWidth > 1) {
      clipped.push({
        cls: el.className.toString().split(' ')[0],
        box: el.clientWidth,
        says: (el.textContent || '').trim().slice(0, 30)
      })
    }
  }

  // The longest library path, how many lines it took, and whether its row grew sideways.
  const paths = [...page.querySelectorAll('.path')].map((el) => ({
    chars: (el.textContent || '').length,
    width: Math.round(el.getBoundingClientRect().width),
    lines: lines(el),
    overflows: el.scrollWidth - el.clientWidth > 1
  }))

  const example = page.querySelector('.example')
  const score = page.querySelector('.score-folder')
  return {
    viewWidth: Math.round(view.getBoundingClientRect().width),
    columnWidth: Math.round(page.getBoundingClientRect().width),
    columnLeft: Math.round(page.getBoundingClientRect().left - view.getBoundingClientRect().left),
    pageHeight: Math.round(page.getBoundingClientRect().height),
    groups,
    controls,
    wrapped,
    clipped,
    paths,
    exampleLines: example ? lines(example) : 0,
    scoreLines: score ? lines(score) : 0,
    sidewaysBy: Math.round(view.scrollWidth - view.clientWidth),
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

  await waitFor(win, named('Settings'))
  await evalIn(win, `${named('Settings')}.click(), 1`)
  await waitFor(win, `document.querySelectorAll('.settings .group').length === 4`)
  if (paths !== 'none') await waitFor(win, `document.querySelector('.settings .path')`)
  if (process.env.ARMED === 'on') {
    // The second label is nearly four times the width of the first, and it appears in a row that
    // is already carrying a name and a status. Resting on the short one would measure the state
    // this row is almost never in when it matters.
    await waitFor(
      win,
      `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Clear')`
    )
    await evalIn(
      win,
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear').click(), 1`
    )
    await waitFor(
      win,
      `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Delete them permanently')`
    )
  }
  await sleep(2000)

  const shape = await evalIn(win, SHAPE)
  const railOn = width > 1120
  console.log(
    `window ${width}x${height}  view ${shape.viewWidth}px  rail ${railOn ? 'open' : 'closed'}  paths ${paths}`
  )
  console.log(
    `  column        ${shape.columnWidth}px, ${shape.columnLeft}px in from the view's left edge, ${shape.pageHeight}px tall`
  )
  console.log(`  sideways      view ${shape.sidewaysBy}px, document ${shape.docSidewaysBy}px`)
  console.log('  groups')
  for (const g of shape.groups) {
    console.log(`    ${g.name.padEnd(16)} ${String(g.width).padStart(4)}px x ${g.height}px`)
  }
  console.log('  controls')
  for (const c of shape.controls) {
    console.log(
      `    ${c.what.padEnd(38)} ${String(c.width).padStart(4)}px wide, ${String(c.box).padStart(3)}px inside, text ${String(c.needs).padStart(3)}px, ${c.room < 0 ? `SHORT BY ${-c.room}px` : `${c.room}px spare`}  "${c.says}"`
    )
  }
  console.log(
    '  rows          ' +
      shape.wrapped
        .map((r) => `${r.label}: ${r.controlWidth}px ${r.stacked ? 'STACKED' : 'beside'}`)
        .join('; ')
  )
  console.log(shape.paths.length === 0 ? '  library paths no folders yet' : '  library paths')
  for (const p of shape.paths) {
    console.log(
      `    ${String(p.chars).padStart(3)} chars in ${String(p.width).padStart(4)}px, ${p.lines} line${p.lines === 1 ? '' : 's'}${p.overflows ? ', OVERFLOWS' : ''}`
    )
  }
  console.log(
    `  score line    ${shape.scoreLines} lines      example line  ${shape.exampleLines} lines`
  )
  console.log(
    shape.clipped.length === 0
      ? '  clipped       nothing'
      : '  clipped       ' +
          shape.clipped.map((c) => `.${c.cls} at ${c.box}px: "${c.says}"`).join('; ')
  )

  app.exit(0)
})
