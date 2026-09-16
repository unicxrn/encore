/**
 * Measure Home and the first-run screens in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-home.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-home.mjs
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so the
 * hero is zero pixels tall, no row can push another off screen and nothing ellipsises. This runs
 * the built renderer in an offscreen window, which is never shown on any desktop but keeps
 * producing frames, and reads the geometry back out. The step that rebuilt the Explore filter
 * header found a title box at 0px this way, and the one before it found labels ellipsised at
 * 71px; jsdom called both of them fine.
 *
 * The questions, and why each one is here rather than in a test:
 *
 *   hero      How tall the top of the window is, and what it costs the rows under it. The hero
 *             is the one block on this page whose height is not set by a list, so it is the one
 *             that can push the first row off a default window. `firstRowBottom` is the answer:
 *             the bottom edge of the first chart row, against the height of the scrolling box.
 *   rows      Rows of one height, the way the Explore row script counts them. A list whose rows
 *             disagree by a few pixels is a list the eye stumbles down.
 *   pips      The difficulty column staying inside its track. Eighteen 3px bars plus their gaps
 *             is a fixed width and a grid track is not, so this compares the two.
 *   clipped   Text cut off by its own box: `scrollWidth > clientWidth` on an element that
 *             declares an ellipsis, which is what an ellipsis actually is.
 *   title     The box the chart's name gets, `charter` the box beside it, and `cover` the one
 *             fixed square in the row. The first two are what a wider difficulty column is paid
 *             for, and `clipped` alone does not report a price: a title that lost 74px and has
 *             not started ellipsising yet is still a title that lost 74px.
 *   sideways  The page pushing itself wider than its column.
 *   landing   Where a row click goes. Home's rows fill the preview rail, and the rail is
 *             `display: none` below 1120px, so the same click has to reach the chart page
 *             there instead. Read off the same window the rows were just measured in.
 *
 * The widths worth passing are the ones the shell supports. The window minimum is 960px and the
 * rail is 374px wide and appears above 1120px, so the view column is 722px at a 960px window,
 * 882px at 1120px, and then drops to 509px at 1121px when the rail takes its share back. 1121 is
 * the narrowest this page is ever asked to be, and it is not the smallest window.
 *
 *     MODE=full     a library with charts in it (the default)
 *     MODE=empty    a library folder configured and a catalog with nothing in it
 *     MODE=nofolder no library folder at all, which is the first thing a new user sees
 *     MODE=scan     a scan running, which is what Home shows for the whole of a first scan
 *     MODE=welcome  the first-run folder picker, with a candidate found
 *     MODE=nothing  the same picker with nothing detected, so it asks for a folder by hand
 *     MODE=tour     the welcome tour, over the picker, on every one of its five screens
 *
 * The empty modes matter as much as the full one: Home with no charts is what a new user meets,
 * and an empty state that reads as a failure is a first run that reads as one.
 *
 * What it touches: a throwaway user-data directory, and nothing else. Not the catalogue, not the
 * library, not settings, and not the network: the preload it writes below answers every call
 * from memory, and `fetch` is stubbed with a canned search result so the latest-charts row fills
 * without spending one of api.enchor.us's 50 requests a minute.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
const mode = process.env.MODE || 'full'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-measure-'))
const preloadPath = path.join(scratch, 'preload.cjs')

fs.writeFileSync(
  preloadPath,
  `const MODE = ${JSON.stringify(mode)}
const settings = {
  // 'nofolder' is the state that renders Welcome instead of Home; every other mode has one.
  libraryFolders: MODE === 'nofolder' || MODE === 'welcome' || MODE === 'nothing' || MODE === 'tour'
    ? []
    : [{ path: '/home/player/.clonehero/Songs', isDefault: true }],
  downloadFormat: 'sng',
  downloadConcurrency: 3,
  downloadVideos: false,
  chartFolderName: '{artist} - {name} ({charter})',
  previewVolume: 50,
  // The tour is a layer over whatever is underneath, so it is the one thing this flag decides.
  tourSeen: MODE !== 'tour',
  lastSeenVersion: '9.9.9'
}

// Enough of a ChartRecord for a row to draw, in the three states DiffPips tells apart: rated,
// charted but unrated, and not charted at all. Everything absent here is filled in by the
// schema's defaults on the main side, which is not running, so the fields Home reads are the
// ones spelled out. The titles are deliberately long: a row that truncates has to be seen
// truncating, and a library of "Chart 1" would never show it.
const records = Array.from({ length: 10 }, (_, i) => ({
  path: '/home/player/.clonehero/Songs/Chart ' + i,
  chartType: 'folder',
  name: i % 3 === 0 ? 'A Very Long Chart Title To See Where It Truncates ' + i : 'Chart ' + i,
  artist: 'An Artist With A Reasonably Long Name',
  album: 'An Album Title That Is Also Rather Long',
  genre: 'Metal',
  year: 2011,
  charter: 'SomeCharterWithALongName',
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
const stocked = MODE === 'full' || MODE === 'scan'

const answers = {
  settingsGet: () => settings,
  settingsSet: () => undefined,
  catalogQuery: () => (stocked ? records : []),
  // Two counts, told apart by the filter: the whole library, and the charts still missing one of
  // the four assets. The hero draws both.
  catalogCount: (filter) => (stocked ? (filter && filter.missing ? 31 : 207) : 0),
  catalogScan: () => undefined,
  catalogScanCancel: () => undefined,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  // The picker's probe. 'nothing' is the branch that found no Clone Hero folder at all.
  libraryDetect: () =>
    MODE === 'nothing' ? [] : [{ path: '/home/player/.clonehero/Songs', chartCount: 207, countCapped: false }],
  pickFolder: () => null,
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  appUpdateStatus: () => ({ state: 'idle' })
}

// The scan store subscribes to this on startup, and a progress event is the only way Home is
// told a scan is running. Held so MODE=scan can deliver one, which is the state Home is in for
// the whole of a first run's first scan.
let onScan = () => {}
window.encore = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      // The row's health dot reads this synchronously rather than over IPC, so it has to be a
      // value and not a promise-returning function like everything else here.
      if (key === 'platform') return process.platform
      if (key === 'onScanProgress') {
        return (cb) => {
          onScan = cb
          return () => {}
        }
      }
      if (key.startsWith('on')) return () => () => {}
      return (...args) => Promise.resolve(answers[key] ? answers[key](...args) : undefined)
    }
  }
)
window.measureScan = (percent) =>
  onScan({
    jobId: 'scan',
    kind: 'scan',
    phase: 'scanning',
    percent,
    message: null,
    status: 'running'
  })

// The latest-charts row, answered from memory. Ten results with the fields Home reads, and one
// of them carrying a metadata issue so the row's health dot is on screen to be measured. The
// cover md5s are null on purpose: a 40px box is a 40px box whether or not a CDN answers, and a
// measurement that waited on the network would not be the same measurement twice.
const search = {
  found: 10,
  out_of: 95214,
  page: 1,
  data: Array.from({ length: 10 }, (_, i) => ({
    chartId: i + 1,
    songId: 900 + i,
    md5: String(i).repeat(32).slice(0, 32),
    albumArtMd5: null,
    hasVideoBackground: i === 2,
    name: i % 3 === 0 ? 'Another Extremely Long Song Title For Truncation ' + i : 'Song ' + i,
    artist: 'Artist Number ' + i + ' With A Long Name',
    album: 'An Album With A Name Of Its Own',
    genre: 'Rock',
    year: '199' + (i % 10),
    charter: 'ACharterWithALongName' + i,
    song_length: 250000 + i * 1000,
    diff_guitar: (i % 7) - 1,
    diff_bass: i % 2 === 0 ? 3 : null,
    diff_drums: 5,
    diff_keys: null,
    diff_vocals: null,
    notesData: { instruments: i % 2 === 0 ? ['guitar', 'bass', 'drums'] : ['guitar', 'drums'] },
    metadataIssues: i === 1 ? [{ metadataIssue: 'missingValue', description: 'no year' }] : []
  }))
}
// A real Response, not a shape that looks like one: searchCharts tells an answer from a thrown
// error with an instanceof check, and a plain object carrying ok: true falls through it into the
// retry path and ends on screen as "could not load the latest charts".
window.fetch = () =>
  Promise.resolve(
    new Response(JSON.stringify(search), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
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
 * Home, as layout has it.
 *
 * `firstRowBottom` is the number this script exists for. The hero is the only block here whose
 * height answers to nothing but its own content, so it is the only one that can push the first
 * chart off a default window, and a hero that did would be a page whose top half says what you
 * have and whose bottom half is not there. It is measured against the scrolling box rather than
 * the window, because the topbar and the player bar take 120px of the 800 before Home sees any
 * of it.
 *
 * `clipped` counts only elements that declare an ellipsis, because an element that wraps is not
 * clipped by being taller than one line. The 1px tolerance is for subpixel text metrics.
 */
const HOME = `(() => {
  const round = (n) => Math.round(n)
  const view = document.querySelector('.view')
  const home = document.querySelector('.home')
  const hero = document.querySelector('.hero')
  const rows = [...document.querySelectorAll('.home .row')]
  const blocks = [...document.querySelectorAll('.home .row-block')]
  const viewBox = view.getBoundingClientRect()

  // How many rows at each height, not just which heights exist, which is how the Explore row
  // script counts them: one tall row among twelve is a different fact from half the list being
  // tall, and only the counts tell the two apart.
  const heights = [...new Set(rows.map((r) => round(r.getBoundingClientRect().height)))].map(
    (h) => h + 'px x' + rows.filter((r) => round(r.getBoundingClientRect().height) === h).length
  )

  const boxes = {}
  for (const el of home.querySelectorAll('*')) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
    const cls = el.className.toString().split(' ')[0]
    const seen = boxes[cls] || (boxes[cls] = { cls, narrowest: Infinity, of: 0, clipped: 0, says: '' })
    seen.of++
    if (el.scrollWidth - el.clientWidth > 1) {
      seen.clipped++
      if (el.clientWidth < seen.narrowest) {
        seen.narrowest = el.clientWidth
        seen.says = (el.textContent || '').trim().slice(0, 34)
      }
    }
  }

  const pips = rows.map((row) => {
    const cell = row.querySelector('.diffs')
    if (!cell) return null
    const parts = [...cell.querySelectorAll('.part')]
    const drawn = parts.length
      ? round(parts[parts.length - 1].getBoundingClientRect().right - parts[0].getBoundingClientRect().left)
      : 0
    return { track: round(cell.getBoundingClientRect().width), drawn, parts: parts.length }
  }).filter(Boolean)

  // The cover, and the two text boxes a wider difficulty column is paid for out of. The boxes
  // list above only reports a box that clipped, which says nothing about a column that got narrower
  // and has not crossed yet: the width is the price and the ellipsis count is what it bought.
  // A box folded away by a container query has no width and is left out rather than called zero.
  const cell = (sel) => {
    const found = rows
      .map((row) => {
        const el = row.querySelector(sel)
        return el ? round(el.getBoundingClientRect().width) : 0
      })
      .filter((n) => n > 0)
    return found.length ? { min: Math.min(...found), max: Math.max(...found), of: found.length } : null
  }
  const covers = [...new Set(rows.map((row) => {
    const art = row.querySelector('.cover')
    if (!art) return null
    const b = art.getBoundingClientRect()
    return round(b.width) + 'x' + round(b.height)
  }).filter(Boolean))]

  // Each labelled region, with the heading that names it and where its top edge sits relative to
  // the box that scrolls. A section with no accessible name is not a landmark at all, so the name
  // is read back rather than assumed.
  const sections = blocks.map((block) => {
    const id = block.getAttribute('aria-labelledby')
    const head = id ? document.getElementById(id) : null
    return {
      named: head ? (head.textContent || '').trim() : null,
      top: round(block.getBoundingClientRect().top - viewBox.top)
    }
  })

  const firstRow = rows[0] || null
  return {
    viewWidth: round(viewBox.width),
    viewHeight: round(viewBox.height),
    heroHeight: hero ? round(hero.getBoundingClientRect().height) : null,
    // What the hero says, so an empty library can be read back rather than inferred.
    heroText: hero ? (hero.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null,
    heroSideways: hero ? hero.scrollWidth - hero.clientWidth : null,
    rows: rows.length,
    rowHeights: heights,
    firstRowBottom: firstRow ? round(firstRow.getBoundingClientRect().bottom - viewBox.top) : null,
    lastRowBottom: rows.length
      ? round(rows[rows.length - 1].getBoundingClientRect().bottom - viewBox.top)
      : null,
    sections,
    covers,
    title: cell('.title'),
    charter: cell('.charter'),
    pipTrack: pips.length ? Math.min(...pips.map((p) => p.track)) : null,
    pipDrawn: pips.length ? Math.max(...pips.map((p) => p.drawn)) : null,
    pipGroups: [...new Set(pips.map((p) => p.parts))],
    boxes: Object.values(boxes).sort((a, b) => a.narrowest - b.narrowest),
    pageTallerBy: round(home.getBoundingClientRect().height - viewBox.height),
    sidewaysBy: view.scrollWidth - view.clientWidth,
    docSidewaysBy: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

/** Where a click on the first Home row landed, read the way the Explore script reads it. */
const LANDING = `(() => {
  const round = (n) => Math.round(n)
  const rail = document.querySelector('.rail')
  return {
    railDisplay: rail ? getComputedStyle(rail).display : 'absent',
    railWidth: rail ? round(rail.getBoundingClientRect().width) : null,
    railFilled: !!document.querySelector('.rail .art'),
    homeStillUp: !!document.querySelector('.home'),
    pageOpen: !!document.querySelector('.detail')
  }
})()`

/**
 * The first-run card, and the tour over it.
 *
 * `overflows` is the one that matters on a short window: the picker is centred in the view, so a
 * card taller than the box it is centred in is a card with its button below the fold and no
 * scrollbar to reach it.
 */
const FIRSTRUN = `(() => {
  const round = (n) => Math.round(n)
  const view = document.querySelector('.view')
  const card = document.querySelector('.welcome .card')
  const tour = document.querySelector('.tour .card')
  const box = view.getBoundingClientRect()
  const shape = (el) => el === null ? null : {
    width: round(el.getBoundingClientRect().width),
    height: round(el.getBoundingClientRect().height),
    top: round(el.getBoundingClientRect().top),
    bottom: round(el.getBoundingClientRect().bottom)
  }
  const buttons = [...(card ? card.querySelectorAll('button') : [])].map((b) => ({
    label: (b.textContent || '').trim(),
    width: round(b.getBoundingClientRect().width),
    height: round(b.getBoundingClientRect().height),
    clipped: b.scrollWidth > b.clientWidth + 1
  }))
  return {
    viewWidth: round(box.width),
    viewHeight: round(box.height),
    card: shape(card),
    tour: shape(tour),
    tourFoot: shape(document.querySelector('.tour .foot')),
    tourTitle: tour ? (document.querySelector('.tour .title') || {}).textContent : null,
    buttons,
    overflowsBy: card ? round(card.getBoundingClientRect().height - box.height + 48) : null,
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

  if (mode === 'welcome' || mode === 'nothing' || mode === 'tour') {
    await waitFor(
      win,
      `document.querySelector('.welcome .card') || document.querySelector('.tour')`
    )
    await sleep(1200)
    if (mode === 'tour') {
      // Every screen, because the card is pinned at one height and the footer at another, and a
      // screen that broke either would be the one nobody looked at. The count comes off the
      // card's own "1 of N" rather than being written here, so a screen added to the tour is a
      // screen this measures.
      const total = Number(
        (await evalIn(win, `document.querySelector('.tour .count').textContent`)).split(' of ')[1]
      )
      for (let step = 1; step <= total; step += 1) {
        const shape = await evalIn(win, FIRSTRUN)
        console.log(
          `window ${width}x${height}  view ${shape.viewWidth}x${shape.viewHeight}  tour screen ${step}: "${shape.tourTitle}"`
        )
        console.log(
          `  card          ${shape.tour.width}x${shape.tour.height}, footer ${shape.tourFoot.height}px, top ${shape.tour.top} bottom ${shape.tour.bottom}`
        )
        if (step < total) {
          await evalIn(
            win,
            `[...document.querySelectorAll('.tour button')].find(b => b.textContent.trim() === 'Next').click(), 1`
          )
          await sleep(500)
        }
      }
      app.exit(0)
      return
    }
    const shape = await evalIn(win, FIRSTRUN)
    console.log(`window ${width}x${height}  view ${shape.viewWidth}x${shape.viewHeight}  ${mode}`)
    console.log(
      `  card          ${shape.card.width}x${shape.card.height}, top ${shape.card.top}, bottom ${shape.card.bottom}`
    )
    console.log(
      `  fits          ${shape.overflowsBy <= 0 ? 'yes' : `NO, ${shape.overflowsBy}px past the box`}`
    )
    console.log(
      `  buttons       ${shape.buttons.map((b) => `${b.label} ${b.width}x${b.height}${b.clipped ? ' CLIPPED' : ''}`).join(', ')}`
    )
    console.log(`  sideways      document ${shape.docSidewaysBy}px`)
    app.exit(0)
    return
  }

  // With no folder configured the first-run picker stands in Home's place, so the one path to
  // Home's own no-folder state is the way a user reaches it: answer the picker with "Explore
  // charts instead", which sets nothing, then come back through the sidebar.
  if (mode === 'nofolder') {
    const named = (label) =>
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}')`
    await waitFor(win, named('Explore charts instead'))
    await evalIn(win, `${named('Explore charts instead')}.click(), 1`)
    await waitFor(win, named('Home'))
    await evalIn(win, `${named('Home')}.click(), 1`)
  }

  await waitFor(win, `document.querySelector('.home')`)
  // A running scan is a progress event, not a call: `catalog:scan` resolves once the scan has
  // STARTED, and everything Home draws about it comes from the event stream after that.
  if (mode === 'scan') await evalIn(win, `window.measureScan(42), 1`)
  // Long enough for both rows to land and for the covers that have one to decode.
  await sleep(3000)

  const shape = await evalIn(win, HOME)
  console.log(`window ${width}x${height}  view ${shape.viewWidth}x${shape.viewHeight}  ${mode}`)
  console.log(`  hero          ${shape.heroHeight}px tall, sideways ${shape.heroSideways}px`)
  console.log(`  hero says     "${shape.heroText}"`)
  console.log(`  rows          ${shape.rows}, heights ${JSON.stringify(shape.rowHeights)}`)
  console.log(
    `  first row     bottom at ${shape.firstRowBottom}px of a ${shape.viewHeight}px box  ${
      shape.firstRowBottom !== null && shape.firstRowBottom <= shape.viewHeight
        ? 'ON SCREEN'
        : 'OFF SCREEN'
    }`
  )
  for (const section of shape.sections) {
    console.log(
      `    ${section.named === null ? 'UNNAMED SECTION' : `"${section.named}"`} starts at ${section.top}px`
    )
  }
  console.log(`  cover         ${shape.covers.join(', ')}`)
  const box = (b) => (b === null ? 'folded away' : `${b.min}px to ${b.max}px on ${b.of} rows`)
  console.log(`  title box     ${box(shape.title)}`)
  console.log(`  charter box   ${box(shape.charter)}`)
  console.log(
    `  pips          ${shape.pipDrawn}px drawn in a ${shape.pipTrack}px track, ${JSON.stringify(shape.pipGroups)} groups per row`
  )
  console.log(
    `  page          ${shape.pageTallerBy > 0 ? `${shape.pageTallerBy}px past the box, scrolls` : 'fits the box'}`
  )
  console.log(`  sideways      view ${shape.sidewaysBy}px, document ${shape.docSidewaysBy}px`)
  console.log('  text boxes')
  for (const box of shape.boxes) {
    console.log(
      box.clipped === 0
        ? `    .${box.cls} 0/${box.of} ellipsised`
        : `    .${box.cls} ${box.clipped}/${box.of} ellipsised, tightest ${box.narrowest}px: "${box.says}"`
    )
  }

  if (shape.rows > 0) {
    await evalIn(win, `document.querySelector('.home .row').click(), 1`)
    await sleep(1200)
    const landed = await evalIn(win, LANDING)
    console.log(
      `  row click     rail ${landed.railDisplay}${landed.railWidth === null ? '' : ` ${landed.railWidth}px`}, filled ${landed.railFilled}, Home up ${landed.homeStillUp}, chart page ${landed.pageOpen}`
    )
  }

  app.exit(0)
})
