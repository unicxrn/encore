/**
 * Measure the Explore result row in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-explore-row.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-explore-row.mjs
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so every
 * row is zero pixels tall, nothing ellipsises and nothing can overflow. This runs the built
 * renderer in an offscreen window, which is never shown on any desktop but keeps producing
 * frames, and reads the geometry back out.
 *
 * The four questions, and why each one is here rather than in a test:
 *
 *   clipped     Text cut off by its own box. `scrollWidth > clientWidth` on an element with
 *               `text-overflow: ellipsis` is what an ellipsis actually is, and the step before
 *               this one found labels ellipsised at 71px that every test called fine.
 *   heights     Rows of one height. A list whose rows disagree by a few pixels is a list the
 *               eye stumbles down, and the two causes are an image sized from its column and a
 *               badge that wraps. Both are invisible until something is measured.
 *   pips        The difficulty column staying inside its track. Eighteen 3px bars plus their
 *               gaps is a fixed width, and a grid track is not, so this compares the two.
 *   sideways    `.table` scrolling horizontally, which is what a grid track with an automatic
 *               minimum does to a row holding a long title.
 *
 * The widths worth passing are the ones the shell supports. The window minimum is 960px and the
 * rail is 374px wide and appears above 1120px, so the view column is 722px at a 960px window,
 * 882px at 1120px, and then drops to 509px at 1121px when the rail takes its share back. 1121
 * is the narrowest this row is ever asked to be, and it is not the smallest window.
 *
 *     VIEW=grid       the same list as cards
 *     VIEW=installed  the Installed list, which draws the same difficulty component
 *
 * Installed is here because it shares `DiffPips` with Explore, and a component whose width is
 * fixed has to be checked against every track it is dropped into, not just the one it was
 * written for. It reads a stubbed catalogue, never the user's.
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
 * What the rows are, as layout has it.
 *
 * `clipped` counts only elements that declare an ellipsis, because an element that wraps is not
 * clipped by being taller than one line, and one with `overflow: hidden` and no ellipsis has
 * made its own decision. The 1px tolerance is for subpixel text metrics: a box 140.4px wide
 * holding 140.9px of text is not a truncation anybody can see.
 */
const SHAPE = `(() => {
  const main = document.querySelector('.main') || document.querySelector('.library')
  const table = document.querySelector('.table')
  const rows = [...document.querySelectorAll('.table .row, .table .card')]
  const heights = [...new Set(rows.map(r => Math.round(r.getBoundingClientRect().height)))]

  // Every element that CAN ellipsise, grouped by class, with the narrowest box any of them got
  // and how many actually ran out of room. An ellipsis on a 60-character title in a 280px box is
  // the feature working; the same ellipsis in a 71px box is the defect the last step found, and
  // only the box width separates the two.
  const boxes = {}
  for (const row of rows) {
    for (const el of row.querySelectorAll('*')) {
      if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
      const cls = el.className.toString().split(' ')[0]
      const seen = boxes[cls] || (boxes[cls] = { cls, narrowest: Infinity, of: 0, clipped: 0, says: '' })
      seen.of++
      // Only a box that ran out of room counts toward the narrowest. A flex item sized from
      // its own content is as wide as its text when nothing is squeezing it, so a short title
      // in a roomy row reports a small box and means nothing by it.
      if (el.scrollWidth - el.clientWidth > 1) {
        seen.clipped++
        if (el.clientWidth < seen.narrowest) {
          seen.narrowest = el.clientWidth
          seen.says = (el.textContent || '').trim().slice(0, 38)
        }
      }
    }
  }

  // Why the rows are the heights they are: for each distinct height, one row's tallest child.
  const byHeight = {}
  for (const row of rows) {
    const h = Math.round(row.getBoundingClientRect().height)
    if (byHeight[h]) continue
    let tallest = null
    for (const el of row.children) {
      if (getComputedStyle(el).display === 'none') continue
      const box = Math.round(el.getBoundingClientRect().height)
      if (!tallest || box > tallest.box) {
        tallest = { box, cls: el.className.toString().split(' ')[0] }
      }
    }
    byHeight[h] = tallest
  }

  // The difficulty column against its own track. The pips are fixed at 3px with 2px gaps and
  // 6px between the three parts, so a track that shrank under them would clip silently.
  const pips = rows.map((row) => {
    const cell = row.querySelector('.diffs, .c-diffs')
    if (!cell) return null
    const parts = [...cell.querySelectorAll('.part')]
    const drawn = parts.length ? Math.round(
      parts[parts.length - 1].getBoundingClientRect().right - parts[0].getBoundingClientRect().left
    ) : 0
    return { track: Math.round(cell.getBoundingClientRect().width), drawn, parts: parts.length }
  }).filter(Boolean)

  return {
    viewWidth: Math.round(main.getBoundingClientRect().width),
    rows: rows.length,
    rowHeights: heights,
    pipTrack: pips.length ? Math.min(...pips.map(p => p.track)) : null,
    pipDrawn: pips.length ? Math.max(...pips.map(p => p.drawn)) : null,
    pipGroups: [...new Set(pips.map(p => p.parts))],
    boxes: Object.values(boxes).sort((a, b) => a.narrowest - b.narrowest),
    byHeight,
    // Positive means the list is wider than the box it is in, which is Explore scrolling
    // sideways. It is the failure a grid track's automatic minimum causes and the reason every
    // text track in the row is minmax(0, ...).
    sidewaysBy: table.scrollWidth - table.clientWidth,
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

  const view = process.env.VIEW || 'list'
  const named = (label) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}')`

  const nav = view === 'installed' ? 'Installed' : 'Explore'
  await waitFor(win, named(nav))
  await evalIn(win, `${named(nav)}.click(), 1`)
  if (view !== 'installed') {
    // The store's default layout is grid, so both of these are chosen rather than assumed.
    const layout = view === 'grid' ? 'Grid' : 'List'
    await waitFor(win, named(layout))
    await evalIn(win, `${named(layout)}.click(), 1`)
  }
  await waitFor(win, `document.querySelectorAll('.row, .card').length > 0`)
  // Long enough for the covers to decode and for the pages that fill the first screen to land.
  await sleep(4000)

  const shape = await evalIn(win, SHAPE)
  console.log(`window ${width}x${height}  view ${shape.viewWidth}px  ${view}`)
  console.log(`  rows          ${shape.rows}`)
  console.log(`  row heights   ${JSON.stringify(shape.rowHeights)}`)
  console.log(
    `  pips          ${shape.pipDrawn}px drawn in a ${shape.pipTrack}px track, ${JSON.stringify(shape.pipGroups)} groups per row`
  )
  console.log(`  sideways      list ${shape.sidewaysBy}px, document ${shape.docSidewaysBy}px`)
  for (const [h, tallest] of Object.entries(shape.byHeight)) {
    console.log(`    ${h}px tall, set by .${tallest.cls} at ${tallest.box}px`)
  }
  console.log('  text boxes')
  for (const box of shape.boxes) {
    console.log(
      box.clipped === 0
        ? `    .${box.cls} 0/${box.of} ellipsised`
        : `    .${box.cls} ${box.clipped}/${box.of} ellipsised, tightest ${box.narrowest}px: "${box.says}"`
    )
  }

  app.exit(0)
})
