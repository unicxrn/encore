/**
 * Measure what Surprise me adds to the screen, in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-surprise.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-surprise.mjs
 *     STATE=empty node_modules/electron/dist/electron scripts/measure-surprise.mjs
 *
 * Two things are new and neither is visible to jsdom, which applies no CSS and computes no
 * layout: the sidebar tile stopped being disabled, and Explore grew a line over its list.
 *
 * The questions:
 *
 *   tile       The quick action's box, and whether its label still fits. It was drawn disabled
 *              before this step, so the only thing that changed is which colour rule applies;
 *              the number here is what says the box did not move with it.
 *   band       The note over the list: how tall, how many lines it wraps to, and whether its
 *              Shuffle button ended up on a line of its own. It shares `.dropped` with the
 *              advanced-filters note, which is measured at up to two lines of 68ch; this one is
 *              a longer sentence and is the reason to look again.
 *   cost       What the band took from the list underneath it. A line that pushes the first row
 *              off the screen is a line that cost more than it says.
 *   sideways   The band pushing its column, or the document, wider than its box.
 *   clipped    Anything in the band that declares an ellipsis and ran out of room.
 *
 * The states, because the longest sentence is not the one anybody sees most:
 *
 *   found    five charts and a catalog size, which is the ordinary answer.
 *   unowned  the same, plus the line admitting the library could not be read. The longest
 *            sentence this feature can produce, and the one most likely to wrap badly.
 *   empty    every chart drawn was one the user already has: no rows at all under the line,
 *            which is the state the search empty text must NOT also answer.
 *
 * The widths worth passing are the shell's: the window minimum is 960px, and the rail is 374px
 * and appears above 1120px, so the view column is 722px at 960, 882px at 1120 and 509px at 1121.
 *
 * What it touches: a throwaway user-data directory and nothing else. The preload answers every
 * IPC call from memory, and the one leg that would otherwise reach api.enchor.us answers its own
 * search, so this makes no request against the 50 a minute that API allows.
 */

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
const state = process.env.STATE || 'found'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-surprise-measure-'))
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

const STATE = ${JSON.stringify(state)}

// One page of results, shaped the way api.enchor.us shapes one. The names are long on purpose:
// a surprise offers charts nobody searched for, so the row has no say in how long they are.
const COUNTS = [
  { instrument: 'guitar', difficulty: 'expert', count: 1200 },
  { instrument: 'bass', difficulty: 'expert', count: 640 }
]
const PAGE = Array.from({ length: 40 }, (_, i) => ({
  chartId: i + 1,
  songId: i + 1,
  md5: String(i + 1).padStart(32, 'a'),
  albumArtMd5: null,
  hasVideoBackground: false,
  name: 'Untouched (live for Like A Version) (Harmonies) ' + (i + 1),
  artist: 'The Veronicas And A Deliberately Overlong Credited Guest Artist',
  album: 'From Zero',
  genre: 'Rock',
  year: '2024',
  charter: 'ACharterWhoseHandleIsAlsoUnreasonablyLong',
  song_length: 196000,
  diff_guitar: 4,
  diff_bass: 3,
  diff_drums: 5,
  diff_keys: -1,
  diff_vocals: -1,
  modifiedTime: '2026-01-01T00:00:00.000Z',
  notesData: { instruments: ['guitar', 'bass'], noteCounts: COUNTS, maxNps: [] },
  folderIssues: [],
  metadataIssues: []
}))

const realFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = String(typeof input === 'string' ? input : (input && input.url) || '')
  if (url.includes('api.enchor.us')) {
    return Promise.resolve(
      new Response(JSON.stringify({ found: 95299, out_of: 95299, page: 1, data: PAGE }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
  }
  return realFetch(input, init)
}

const answers = {
  settingsGet: () => settings,
  catalogQuery: () => [],
  catalogCount: () => 0,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  // The three states this script is about, expressed where the feature reads ownership:
  // nothing owned, everything owned, and a catalog that will not answer at all.
  existsByMeta: (keys) => {
    if (STATE === 'unowned') return Promise.reject(new Error('catalog is closed'))
    if (!Array.isArray(keys)) return []
    return keys.map(() => STATE === 'empty')
  },
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
      // The row's health dot reads this synchronously rather than over IPC.
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
  const main = document.querySelector('.main')
  const table = document.querySelector('.table')
  const bar = document.querySelector('.rbar')
  const band = document.querySelector('.dropped')
  const tile = [...document.querySelectorAll('.quick-btn')].find(
    (b) => b.textContent.trim() === 'Surprise me'
  )

  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }
  }

  // How many lines the band wrapped to, by the distinct tops of its own children. The sentence
  // and the button are its two children, so two tops means the button fell onto its own line.
  const bandTops = band
    ? [...new Set([...band.children].map((el) => Math.round(el.getBoundingClientRect().top)))]
    : []

  const clipped = []
  for (const el of main.querySelectorAll('.dropped, .dropped *')) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
    if (el.scrollWidth - el.clientWidth > 1) {
      clipped.push({ cls: el.className.toString().split(' ')[0], box: el.clientWidth })
    }
  }

  const shuffle = band ? band.querySelector('button') : null
  const firstRow = document.querySelector('.table .row, .table .card')

  return {
    viewWidth: Math.round(main.getBoundingClientRect().width),
    tile: box(tile),
    tileDisabled: tile ? tile.disabled : null,
    tileClipped: tile ? tile.scrollWidth - tile.clientWidth > 1 : null,
    band: box(band),
    bandLines: bandTops.length,
    bandText: band ? (band.textContent || '').trim().replace(/\\s+/g, ' ') : null,
    shuffle: box(shuffle),
    barTop: box(bar) && box(bar).top,
    listHeight: Math.round(table.getBoundingClientRect().height),
    rows: document.querySelectorAll('.table .row, .table .card').length,
    firstRowTop: firstRow ? Math.round(firstRow.getBoundingClientRect().top) : null,
    windowHeight: window.innerHeight,
    emptyText: (() => {
      const p = [...main.querySelectorAll('.empty')].map((el) => (el.textContent || '').trim())
      return p.length === 0 ? null : p.join(' | ')
    })(),
    clipped,
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

  await waitFor(win, named('Surprise me'))
  const before = await evalIn(win, `${named('Surprise me')}.getBoundingClientRect().width`)
  await evalIn(win, `${named('Surprise me')}.click(), 1`)
  await waitFor(win, `document.querySelector('.dropped')`)
  // The band goes up before the rows arrive (it says what is being looked for), so wait for the
  // answer rather than for the line.
  await waitFor(win, `!document.querySelector('.dropped').textContent.includes('Looking for')`)
  await sleep(2000)

  const shape = await evalIn(win, SHAPE)
  console.log(`window ${width}x${height}  view ${shape.viewWidth}px  state ${state}`)
  console.log(
    `  tile          ${shape.tile.w}x${shape.tile.h}px, disabled ${shape.tileDisabled}, ${shape.tileClipped ? 'CLIPPED' : 'not clipped'}, width before the press ${Math.round(before)}px`
  )
  console.log(
    `  band          ${shape.band.w}x${shape.band.h}px on ${shape.bandLines} line${shape.bandLines === 1 ? '' : 's'}, Shuffle ${shape.shuffle.w}x${shape.shuffle.h}px`
  )
  console.log(`  says          "${shape.bandText}"`)
  console.log(
    `  cost          list ${shape.listHeight}px of a ${shape.windowHeight}px window, ${shape.rows} rows, first row at ${shape.firstRowTop}px`
  )
  console.log(`  empty text    ${shape.emptyText === null ? 'none' : `"${shape.emptyText}"`}`)
  console.log(`  sideways      view ${shape.sidewaysBy}px, document ${shape.docSidewaysBy}px`)
  console.log(
    shape.clipped.length === 0
      ? '  clipped       nothing'
      : '  clipped       ' + shape.clipped.map((c) => `.${c.cls} at ${c.box}px`).join('; ')
  )

  app.exit(0)
})
