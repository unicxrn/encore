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
 *   cover       The one fixed box in the row, and the thing that used to set its height.
 *   song        The column the difficulty column is taken out of, narrowest first: that is the
 *               row that decides whether a title fits.
 *   title       The box the chart's name gets, and `charter` the box beside it. These are what
 *               a wider difficulty column is paid for, and `clipped` alone does not report a
 *               price: a title that lost 74px and has not started ellipsising yet is still a
 *               title that lost 74px, and the next long name is where that shows.
 *   band        The badges under the subtitle, and how many lines they take. The set is not
 *               fixed per chart, so a band that wraps on some rows and not others is a list of
 *               two row heights, which is the thing the eye stumbles down.
 *   bar         The results bar over the list, which is one line until a sentence appears in it.
 *
 * The widths worth passing are the ones the shell supports. The window minimum is 960px and the
 * rail is 374px wide and appears above 1120px, so the view column is 722px at a 960px window,
 * 882px at 1120px, and then drops to 509px at 1121px when the rail takes its share back. 1121
 * is the narrowest this row is ever asked to be, and it is not the smallest window. 1280, 1600
 * and 1920 are the three above it, and they are where the row's two folds are crossed: the
 * difficulty comes back up beside the song at 800px of column, and the index at 900px.
 *
 *     VIEW=grid       the same list as cards
 *     VIEW=installed  the Installed list, which draws the same difficulty component
 *
 * After the rows, one more question, and it is the reason the widths above are the widths: where
 * does a click on a row actually land. Explore's destination is the preview rail, and the rail is
 * `display: none` below 1120px, so the same click has to reach the chart page there instead.
 * `LANDING` reads which of the two happened, off the same window the rows were just measured in,
 * and reports the rail's action row with it: the way through to the chart page lives in that row
 * and has to fit beside the action already in it.
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
// What Installed's health mark reads: the rows Encore's own issue scan left in main's memory,
// keyed by chart path. Two charts in three are clean, which is roughly the proportion measured
// against api.enchor.us, so the column is measured as it is actually drawn rather than as a
// column of thirty dots.
const issues = records.flatMap((row, i) =>
  i % 3 === 1
    ? [{ chartPath: row.path, kind: 'folder', code: 'noChart', description: 'no chart file' }]
    : i % 3 === 2
      ? [{ chartPath: row.path, kind: 'folder', code: 'albumArtSize', description: 'cover 2000px' }]
      : []
)
const answers = {
  settingsGet: () => settings,
  catalogQuery: () => records,
  catalogCount: () => records.length,
  issuesLast: () => issues,
  // Installed asks for these on its way to a first paint and reads into the answer without
  // checking, so an undefined here is the whole view crashing rather than a missing filter.
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  favouritesList: () => [],
  setlistsList: () => [],
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
  // How many lines a wrapping flex row actually took. Not the number of distinct tops: items of
  // different heights on one line have different tops, and counting those reports every row of
  // chips as two. A new line starts where an item begins at or below the bottom of the last one.
  // A child folded away by a container query still has a rect, at 0x0 in the corner, and it
  // would otherwise be counted as a line of its own. Only what is drawn takes a line.
  const lineCount = (items) => {
    const boxes = items
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0)
      .sort((a, b) => a.top - b.top)
    let lines = 0
    let floor = -Infinity
    for (const box of boxes) {
      if (box.top >= floor - 1) { lines++; floor = box.bottom }
      else floor = Math.max(floor, box.bottom)
    }
    return lines
  }
  const main = document.querySelector('.main') || document.querySelector('.library')
  const table = document.querySelector('.table')
  const rows = [...document.querySelectorAll('.table .row, .table .card')]
  const heights = [...new Set(rows.map(r => Math.round(r.getBoundingClientRect().height)))]
  // How many rows at each height, not just which heights exist: one tall row among twenty-four is
  // a different fact from half the list being tall, and only the counts tell the two apart.
  const heightCounts = heights.map((h) => h + 'px x' + rows.filter((r) => Math.round(r.getBoundingClientRect().height) === h).length)

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

  // The health marks actually drawn. Nothing on a clean chart is the rule, so what is checked is
  // that the ones with something to say got a mark and that the empty track still holds its
  // column open: a health cell that collapsed would step every row after it sideways.
  const health = rows.map((row) => {
    const cell = row.querySelector('.health')
    if (!cell) return null
    return {
      track: Math.round(cell.getBoundingClientRect().width),
      marked: !!cell.querySelector('.dot')
    }
  }).filter(Boolean)

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

  // The cover, which is the one fixed box in the row and the one the row's height used to be
  // set by. Every row has to agree about it: a cover sized from its column is a cover that
  // changes the row's height when the column does.
  // .thumb is Installed's class for the same box Explore calls .cover. Both are here because
  // the two lists are asked the same question and answered it with different names; without the
  // second selector this line reported nothing at all for Installed, at every width.
  const covers = [...new Set(rows.map((row) => {
    const art = row.querySelector('.cover, .art, .thumb')
    if (!art) return null
    const box = art.getBoundingClientRect()
    return Math.round(box.width) + 'x' + Math.round(box.height)
  }).filter(Boolean))]

  // The song column, which is what the difficulty column is taken out of. Reported as the
  // narrowest any row got, because that is the one that decides whether a title fits.
  const songs = rows.map((row) => {
    const cell = row.querySelector('.song')
    return cell ? Math.round(cell.getBoundingClientRect().width) : null
  }).filter((n) => n !== null)

  // The two text boxes a wider difficulty column is paid for out of, measured whether or not
  // they ran out of room. The boxes list below only reports a box that clipped, which says nothing
  // about a column that got narrower and has not crossed yet: the width is the price, and the
  // ellipsis count is what the price bought. A box folded away by a container query has no
  // width and is left out rather than reported as zero.
  const cell = (sel) => {
    const found = rows
      .map((row) => {
        const el = row.querySelector(sel)
        return el ? Math.round(el.getBoundingClientRect().width) : 0
      })
      .filter((n) => n > 0)
    return found.length ? { min: Math.min(...found), max: Math.max(...found), of: found.length } : null
  }
  const title = cell('.title')
  const charter = cell('.charter, .badge.charter')

  // The badge band under the subtitle, and the one thing about it worth watching: how many lines
  // it takes. The badges a chart carries are not a fixed set, so a band that wraps on some rows
  // and not others is a list whose rows are two heights. Counted by how many distinct tops the
  // badges in one band have, which is what a wrap actually is.
  const bands = rows.map((row) => {
    const band = row.querySelector('.badges')
    if (!band) return null
    const kids = [...band.children].filter((k) => k.getBoundingClientRect().width > 0)
    return {
      lines: lineCount(kids),
      badges: kids.length,
      width: Math.round(band.getBoundingClientRect().width)
    }
  }).filter(Boolean)

  // The bar over the list. One line is the design; two means something in it wrapped, which is
  // what the sentences that only appear sometimes are for.
  const barEl = document.querySelector('.rbar')
  const bar = barEl
    ? {
        height: Math.round(barEl.getBoundingClientRect().height),
        lines: lineCount([...barEl.children]),
        says: [...barEl.children].map((k) => (k.textContent || '').trim().replace(/\\s+/g, ' ')).filter(Boolean)
      }
    : null

  // Installed's row is a button and its two actions cannot sit inside it, so they are siblings
  // under .row-wrap and every pixel they take comes off the row's own grid. That is invisible in
  // the track list and is the first thing to look at when the title is tighter than the tracks
  // say it should be. No backticks in this comment: it is inside a template literal.
  const wrap = document.querySelector('.row-wrap')
  const actions = wrap
    ? [...wrap.children].filter((el) => el !== wrap.querySelector('.row')).map((el) => ({
        cls: el.className.toString().split(' ')[0],
        width: Math.round(el.getBoundingClientRect().width)
      }))
    : []

  return {
    viewWidth: Math.round(main.getBoundingClientRect().width),
    rowWidth: rows.length ? Math.round(rows[0].getBoundingClientRect().width) : null,
    actions,
    rows: rows.length,
    rowHeights: heightCounts,
    covers,
    songNarrowest: songs.length ? Math.min(...songs) : null,
    songWidest: songs.length ? Math.max(...songs) : null,
    title,
    charter,
    bandLines: [...new Set(bands.map((b) => b.lines))].sort(),
    bandWidth: bands.length ? Math.min(...bands.map((b) => b.width)) : null,
    bandBadges: [...new Set(bands.map((b) => b.badges))].sort(),
    bar,
    pipTrack: pips.length ? Math.min(...pips.map(p => p.track)) : null,
    pipDrawn: pips.length ? Math.max(...pips.map(p => p.drawn)) : null,
    pipGroups: [...new Set(pips.map(p => p.parts))],
    healthTracks: [...new Set(health.map(h => h.track))],
    healthMarked: health.filter(h => h.marked).length,
    healthOf: health.length,
    boxes: Object.values(boxes).sort((a, b) => a.narrowest - b.narrowest),
    byHeight,
    // Positive means the list is wider than the box it is in, which is Explore scrolling
    // sideways. It is the failure a grid track's automatic minimum causes and the reason every
    // text track in the row is minmax(0, ...).
    sidewaysBy: table.scrollWidth - table.clientWidth,
    docSidewaysBy: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

/**
 * Where a click on the first row landed, and what the rail's action row looks like when it did.
 *
 * Two outcomes, and exactly one of them is right at any width: the rail filled and the list is
 * still on screen, or the chart page replaced the list because there was no rail to fill. The
 * display is read rather than the window width, because that is what the code reads, and it is
 * what makes the breakpoint a single number in App.svelte rather than one repeated here.
 */
const LANDING = `(() => {
  const round = (n) => Math.round(n)
  const rail = document.querySelector('.rail')
  const page = document.querySelector('.detail')
  const table = document.querySelector('.table')
  return {
    railDisplay: rail ? getComputedStyle(rail).display : 'absent',
    railWidth: rail ? round(rail.getBoundingClientRect().width) : null,
    // What the rail is showing. The cover only exists once a chart is in it.
    railFilled: !!document.querySelector('.rail .art'),
    // The list, still there behind a filled rail. Gone means the page took the view.
    listStillUp: !!table,
    pageOpen: !!page,
    actions: rail
      ? [...rail.querySelectorAll('.actions button')].map((b) => ({
          label: (b.textContent || '').trim(),
          width: round(b.getBoundingClientRect().width),
          height: round(b.getBoundingClientRect().height),
          clipped: b.scrollWidth > b.clientWidth + 1
        }))
      : [],
    // One line, not two: a row that wrapped would take height the column budgeted for the
    // blocks that only appear sometimes.
    actionsHeight: rail && rail.querySelector('.actions')
      ? round(rail.querySelector('.actions').getBoundingClientRect().height)
      : null,
    railScrollsDown: rail ? rail.scrollHeight > rail.clientHeight + 1 : null
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
  // Exact text first, then the same word with something after it. The sidebar's nav items carry
  // a count inside the button now, so 'Installed' is 'Installed 30' to `textContent` and an
  // exact match waited forty seconds for a button that was on screen the whole time. The layout
  // toggles below are still exact, and they match first.
  const named = (label) =>
    `([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}')` +
    ` || [...document.querySelectorAll('button')].find(b => /^${label}\\b/.test(b.textContent.trim())))`

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
  console.log(
    `  rows          ${shape.rows}${shape.rowWidth === null ? '' : `, each ${shape.rowWidth}px wide`}`
  )
  if (shape.actions.length) {
    console.log(`  beside a row  ${shape.actions.map((a) => `.${a.cls} ${a.width}px`).join(', ')}`)
  }
  console.log(`  row heights   ${JSON.stringify(shape.rowHeights)}`)
  console.log(`  cover         ${shape.covers.join(', ')}`)
  if (shape.songNarrowest !== null) {
    console.log(`  song column   ${shape.songNarrowest}px to ${shape.songWidest}px`)
  }
  const box = (b) => (b === null ? 'folded away' : `${b.min}px to ${b.max}px on ${b.of} rows`)
  console.log(`  title box     ${box(shape.title)}`)
  console.log(`  charter box   ${box(shape.charter)}`)
  if (shape.bandWidth !== null) {
    console.log(
      `  badge band    ${shape.bandWidth}px wide, ${JSON.stringify(shape.bandLines)} lines, ${JSON.stringify(shape.bandBadges)} badges per row`
    )
  }
  if (shape.bar) {
    console.log(
      `  results bar   ${shape.bar.height}px tall on ${shape.bar.lines} line(s): ${shape.bar.says.join(' | ')}`
    )
  }
  console.log(
    `  pips          ${shape.pipDrawn}px drawn in a ${shape.pipTrack}px track, ${JSON.stringify(shape.pipGroups)} groups per row`
  )
  if (shape.healthOf) {
    console.log(
      `  health        ${shape.healthMarked}/${shape.healthOf} marked, track ${JSON.stringify(shape.healthTracks)}px`
    )
  }
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

  // Installed's row click opens the chart page and its rail button is a separate control, both
  // measured elsewhere; this leg is about Explore's row being the rail's way in.
  if (view !== 'installed') {
    await evalIn(win, `document.querySelector('.table .row, .table .card').click(), 1`)
    await sleep(1200)
    const landed = await evalIn(win, LANDING)
    console.log(
      `  row click     rail ${landed.railDisplay}${landed.railWidth === null ? '' : ` ${landed.railWidth}px`}, filled ${landed.railFilled}, list up ${landed.listStillUp}, chart page ${landed.pageOpen}`
    )
    // A hidden column measures zero, which is a fact about the query and not about the row.
    if (landed.railDisplay !== 'none' && landed.actions.length) {
      console.log(
        `  rail actions  ${landed.actions.map((a) => `${a.label} ${a.width}x${a.height}${a.clipped ? ' CLIPPED' : ''}`).join(', ')} in a ${landed.actionsHeight}px row, column scrolls ${landed.railScrollsDown}`
      )
    }
  }

  app.exit(0)
})
