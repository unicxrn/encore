/**
 * Measure Explore's load-as-you-scroll in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-explore-append.mjs
 *     SIZE=1920x1080 node_modules/electron/dist/electron scripts/measure-explore-append.mjs
 *
 * The jsdom tests cannot answer this: they apply no CSS and compute no layout, so the list has no
 * height, nothing overflows and nothing can scroll. This runs the built renderer in an offscreen
 * window, which is never shown on any desktop but keeps producing frames, and reads the numbers
 * back out. Frames are the point: a window that is merely hidden produces none, and without them
 * Chromium dispatches no scroll events and runs no intersection observers, so everything measured
 * here would read as broken whatever the code did.
 *
 * It found this, at 1920x1080: the first 25 charts were 889px of grid in a box 889px tall, so the
 * list could not be scrolled, no scroll event was ever fired, and auto-append (which waited for
 * one) never ran. At 1280x800 the same page was 1219px in a 609px box and it worked, which is how
 * that shipped. Window size is the variable, so pass a few.
 *
 * What it touches: the live Chorus Encore API, a handful of requests against a budget of 50 a
 * minute, and a throwaway user-data directory. Not the catalogue, not the library, not settings:
 * the preload it writes below answers every call from memory.
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
  libraryFolders: ['/nonexistent'],
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
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  playStatus: () => ({ watching: false, since: null }),
  appUpdateStatus: () => ({ state: 'idle' })
}
window.encore = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
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

/** What the list is, as layout has it. The sentinel is the button at the end. */
const SHAPE = `(() => {
  const table = document.querySelector('.table')
  const sentinel = document.querySelector('button.more')
  const box = table.getBoundingClientRect()
  return {
    items: document.querySelectorAll('.card, .row').length,
    boxHeight: table.clientHeight,
    contentHeight: table.scrollHeight,
    offset: table.scrollTop,
    canScroll: table.scrollHeight > table.clientHeight,
    // Positive means the end of the list sits inside the 400px the observer looks ahead by,
    // which is where another page is meant to be on its way.
    endInsideLookaheadBy: sentinel
      ? Math.round(box.bottom + 400 - sentinel.getBoundingClientRect().top)
      : null
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

  const explore = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Explore')`
  await waitFor(win, explore)
  await evalIn(win, `${explore}.click(), 1`)
  await waitFor(win, `document.querySelectorAll('.card, .row').length > 0`)
  // Long enough for the pages that fill the first screen to land.
  await sleep(4000)

  console.log(`window ${width}x${height}`)
  console.log('first screen  ', JSON.stringify(await evalIn(win, SHAPE)))

  // A user's scroll rather than a jump to the end: 120px a frame, which is about a wheel notch.
  await evalIn(
    win,
    `window.__step = () => new Promise((done) => requestAnimationFrame(() => {
      const t = document.querySelector('.table')
      t.scrollTop = Math.min(t.scrollTop + 120, t.scrollHeight - t.clientHeight)
      done(t.scrollTop)
    }))
    1`
  )
  for (let i = 0; i < 60; i++) await evalIn(win, `window.__step()`)
  await sleep(4000)
  console.log('after scrolling', JSON.stringify(await evalIn(win, SHAPE)))

  app.exit(0)
})
