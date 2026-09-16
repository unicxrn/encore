/**
 * Measure the chart page in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-detail.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-detail.mjs
 *     RECORD=sng node_modules/electron/dist/electron scripts/measure-detail.mjs
 *     SOURCE=remote node_modules/electron/dist/electron scripts/measure-detail.mjs
 *     TAB=preview node_modules/electron/dist/electron scripts/measure-detail.mjs
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so the
 * difficulty grid is zero pixels wide, nothing ellipsises and nothing can overflow. This runs the
 * built renderer in an offscreen window, which is never shown on any desktop but keeps producing
 * frames, and reads the geometry back out. It is the sibling of measure-explore-row.mjs and
 * measure-play-stats.mjs and works the same way.
 *
 * The questions, and why each one is here rather than in a test:
 *
 *   column     How wide the page's own box is, and how many columns it took. The page asks a
 *              container query rather than a media query because the answer is not a function of
 *              the window: the rail appears above 1120px and takes 374px, so the column is 842px
 *              at a 1120px window and 469px at a 1121px one. Both numbers are printed.
 *   grid       The difficulty grid against the card it is in. Its rating column and its four
 *              difficulty squares are fixed widths and the instrument column is not, so this
 *              compares the two and reports any square whose number is wider than the square.
 *   clipped    Text cut off by its own box. `scrollWidth > clientWidth` on an element with
 *              `text-overflow: ellipsis` is what an ellipsis actually is, and the step before
 *              this one found labels ellipsised at 71px that every test called fine.
 *   sideways   The page wider than the column holding it, which is what a fixed-width table in a
 *              narrow card does.
 *   preview    The preview pane's two columns, or its one. A fixed 260px options column left the
 *              highway 191px at the narrowest width the shell supports.
 *
 * The widest real case is the default record: every instrument in the matrix order, every
 * difficulty charted, five-digit note counts, and a guitar rating of 73. That last number is not
 * invented. Asking api.enchor.us for `{instrument: 'guitar', minIntensity: 7}` on 2026-09-16
 * answers with 2,419 charts, and one page of them carries 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
 * 17, 18, 19, 20, 23, 30 and 73.
 *
 * What it touches: nothing. The preload answers every call from memory, and `fetch` is stubbed
 * for api.enchor.us so the remote leg costs no request against that endpoint's 50-per-minute
 * budget. Not the catalogue, not the library, not settings.
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

// Every instrument the grid knows, every difficulty charted, and five-digit counts: the widest
// row set and the widest number the page can be asked to draw at once.
const ORDER = ['guitar', 'bass', 'drums', 'keys', 'rhythm', 'guitarcoop', 'guitarghl', 'bassghl', 'rhythmghl', 'guitarcoopghl']
const DIFFS = ['easy', 'medium', 'hard', 'expert']
const everyCount = []
const everyNps = []
for (const instrument of ORDER) {
  for (const [i, difficulty] of DIFFS.entries()) {
    everyCount.push({ instrument, difficulty, count: 3000 + i * 3458 })
    everyNps.push({ instrument, difficulty, nps: 4.25 + i * 3.5 })
  }
}

// Enough of a ChartRecord for the chart page to draw itself. Everything absent is filled in by
// the schema's defaults on the main side, which is not running here, so the fields the page
// actually reads are the ones spelled out.
const base = {
  chartType: 'folder',
  artist: 'An Artist With A Reasonably Long Name',
  album: 'An Album Title That Is Also Rather Long',
  genre: 'Progressive Metal',
  year: 2011,
  charter: 'SomeCharterNameOfRealisticLength',
  songLength: 254000,
  albumArtMd5: null,
  albumTrack: 4,
  playlistTrack: 12,
  icon: 'guitarhero',
  drumType: 'fourLanePro',
  previewStartTime: 41000,
  loadingPhrase: 'A loading phrase of the length charters actually write into song.ini',
  modifiedTime: 1750000000000,
  cloneHeroChecksum: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  chartHash: 'bXlDaGFydEhhc2hWYWx1ZUFzQmFzZTY0PT0=',
  tempoMapHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
  folderHash: 'h',
  instruments: ORDER,
  maxNps: [],
  noteCounts: [],
  hasVideo: false,
  hasBackground: false,
  hasAlbumArt: false,
  hasLyrics: true,
  hasVocals: true,
  has2xKick: true,
  proDrums: true,
  fiveLaneDrums: false,
  hasSoloSections: true,
  hasOpenNotes: true,
  hasTapNotes: false,
  hasForcedNotes: true,
  hasFlexLanes: false,
  modchart: false,
  diffVocals: 4,
  diffBand: 5,
  diffDrumsReal: 6
}

const records = {
  // The widest real case: every instrument, every difficulty, a rating past the ceiling.
  wide: {
    ...base,
    path: '/home/someone/.clonehero/Songs/An Artist With A Reasonably Long Name - A Song Title That Keeps Going (SomeCharterNameOfRealisticLength)',
    name: 'A Song Title That Keeps Going And Going Past Where It Fits',
    noteCounts: everyCount,
    maxNps: everyNps,
    diffGuitar: 73,
    diffBass: 6,
    diffDrums: 5,
    diffKeys: 4,
    diffRhythm: 3,
    diffGuitarCoop: 2,
    diffGuitarGhl: 1,
    diffBassGhl: 0,
    diffRhythmGhl: 6,
    diffGuitarCoopGhl: 7
  },
  // The other chart shape, and a rating song.ini carries for a part the notes do not have.
  sng: {
    ...base,
    chartType: 'sng',
    path: '/home/someone/.clonehero/Songs/An Artist - A Packed Chart (Charter).sng',
    name: 'A Packed Chart',
    noteCounts: [
      { instrument: 'guitar', difficulty: 'expert', count: 1408 },
      { instrument: 'guitar', difficulty: 'hard', count: 902 }
    ],
    maxNps: [{ instrument: 'guitar', difficulty: 'expert', nps: 9.4 }],
    diffGuitar: 4,
    diffKeys: 3,
    diffRhythm: 2
  },
  // Nobody has counted the notes: the ratings are all that is known, and every square says so.
  unscanned: {
    ...base,
    path: '/home/someone/.clonehero/Songs/An Artist - An Unscanned Chart (Charter)',
    name: 'An Unscanned Chart',
    instruments: [],
    noteCounts: [],
    maxNps: [],
    diffGuitar: 4,
    diffBass: 3,
    diffDrums: 5
  }
}

// The chosen record first, then the others, each exactly once: Installed keys its rows on the
// path, and two rows sharing one would take the view down before anything could be measured.
const chosen = records[process.env.RECORD || 'wide'] || records.wide
const list = [chosen, ...Object.values(records).filter((r) => r !== chosen)]

const answers = {
  settingsGet: () => settings,
  catalogQuery: () => list,
  catalogCount: () => list.length,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  favouritesList: () => [],
  setlistsList: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  appUpdateStatus: () => ({ state: 'idle' }),
  chartLyricLines: () => ({ none: 'No vocals track in this chart' }),
  updatesCheck: () => ({ verdicts: [] })
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

// One synthetic Chorus result, so the remote leg of this costs no request against the live
// endpoint's 50-per-minute budget. It carries all three issue arrays, because the issue card is
// the one block of the page only a remote chart ever draws.
const remoteChart = {
  chartId: 634733,
  songId: 4711,
  md5: 'd'.repeat(32),
  albumArtMd5: null,
  hasVideoBackground: false,
  name: 'A Song Title That Keeps Going And Going Past Where It Fits',
  artist: 'An Artist With A Reasonably Long Name',
  album: 'An Album Title That Is Also Rather Long',
  genre: 'Progressive Metal',
  year: '2011',
  charter: 'SomeCharterNameOfRealisticLength',
  song_length: 254000,
  diff_guitar: 73,
  diff_bass: 6,
  diff_drums: 5,
  diff_keys: 4,
  diff_vocals: 4,
  modifiedTime: '2026-05-16T18:34:48.885Z',
  packName: 'A Pack Name Of Some Length',
  modchart: false,
  folderIssues: [{ folderIssue: 'albumArtSize', description: 'album art is 2000x2000' }],
  metadataIssues: [{ metadataIssue: 'missingValue', description: 'no album_track in song.ini' }],
  notesData: {
    instruments: ORDER,
    noteCounts: everyCount,
    maxNps: everyNps,
    has2xKick: true,
    hasSoloSections: true,
    hasOpenNotes: false,
    hasTapNotes: true,
    hasForcedNotes: true,
    hasFlexLanes: false,
    chartIssues: [
      { noteIssue: 'babySustain', description: 'a very short sustain' },
      { noteIssue: 'babySustain', description: 'another very short sustain' },
      { noteIssue: 'brokenNote', description: 'a note out of order' }
    ]
  }
}
const realFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input && input.url
  if (typeof url === 'string' && url.includes('api.enchor.us')) {
    const body = JSON.stringify({ found: 1, out_of: 1, page: 1, data: [remoteChart] })
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  return realFetch(input, init)
}
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
 * The page, as layout has it.
 *
 * `clipped` counts only elements that declare an ellipsis, because an element that wraps is not
 * clipped by being taller than one line, and one with `overflow: hidden` and no ellipsis has made
 * its own decision. The 1px tolerance is for subpixel text metrics.
 */
const SHAPE = `(() => {
  const round = (n) => Math.round(n)
  const detail = document.querySelector('.detail')
  if (!detail) return { missing: true }
  const rail = document.querySelector('.rail')
  const cols = detail.querySelector('.cols')
  const card = detail.querySelector('.matrix-card')
  const table = detail.querySelector('.matrix')

  // How many columns the container query took. Read off the boxes rather than off the rule, the
  // same way rail-visible.ts reads the rail's display: the number stays written down once.
  const columns = cols
    ? new Set([...cols.children].map((c) => round(c.getBoundingClientRect().left))).size
    : null

  const boxes = {}
  for (const el of detail.querySelectorAll('*')) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
    const cls = el.className.toString().split(' ')[0] || el.tagName.toLowerCase()
    const seen = boxes[cls] || (boxes[cls] = { cls, narrowest: Infinity, of: 0, clipped: 0, says: '' })
    seen.of++
    if (el.scrollWidth - el.clientWidth > 1) {
      seen.clipped++
      if (el.clientWidth < seen.narrowest) {
        seen.narrowest = el.clientWidth
        seen.says = (el.textContent || '').trim().slice(0, 40)
      }
    }
  }

  // The grid's own columns, and any square whose number is wider than the square holding it.
  // \`table-layout: fixed\` does not clip, so a five-digit count in a 62px square spills over its
  // neighbour in silence.
  let grid = null
  if (table) {
    const head = [...table.querySelectorAll('thead th')].map((th) => ({
      says: (th.textContent || '').trim() || 'instrument',
      width: round(th.getBoundingClientRect().width)
    }))
    let overflow = 0
    let tightest = null
    for (const cell of table.querySelectorAll('tbody td, tbody th')) {
      const by = cell.scrollWidth - cell.clientWidth
      if (by > overflow) {
        overflow = by
        tightest = (cell.textContent || '').trim().slice(0, 24)
      }
    }
    grid = {
      rows: table.querySelectorAll('tbody tr').length,
      head,
      tableWidth: round(table.getBoundingClientRect().width),
      cardWidth: round(card.getBoundingClientRect().width),
      // Positive means the grid is wider than the card it is in.
      cardSidewaysBy: card.scrollWidth - card.clientWidth,
      cellOverflowBy: overflow,
      tightest
    }
  }

  // The preview pane, when that tab is up: one column or two, and how big the highway got.
  const pane = detail.querySelector('.pane')
  const viewport = detail.querySelector('.pane .viewport')
  const options = detail.querySelector('.pane .options')
  const preview = pane
    ? {
        columns: getComputedStyle(pane).gridTemplateColumns,
        optionsWidth: options ? round(options.getBoundingClientRect().width) : null,
        highway: viewport
          ? round(viewport.getBoundingClientRect().width) + 'x' + round(viewport.getBoundingClientRect().height)
          : null
      }
    : null

  return {
    railDisplay: rail ? getComputedStyle(rail).display : 'absent',
    railWidth: rail ? round(rail.getBoundingClientRect().width) : null,
    // The container query's own subject: the page's content box, which is what it measures.
    columnWidth: cols ? round(cols.getBoundingClientRect().width) : round(detail.clientWidth),
    columns,
    cards: [...detail.querySelectorAll('.cols .card, .cols .matrix-card')].map((c) =>
      round(c.getBoundingClientRect().width)
    ),
    pageHeight: round(detail.getBoundingClientRect().height),
    grid,
    preview,
    boxes: Object.values(boxes).sort((a, b) => a.narrowest - b.narrowest),
    detailSidewaysBy: detail.scrollWidth - detail.clientWidth,
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

  const source = process.env.SOURCE || 'local'
  const named = (label) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}')`

  if (source === 'remote') {
    // Explore's row fills the rail where there is one, so the way through is the rail's own
    // "All details"; below the breakpoint the same click opens the page directly.
    await waitFor(win, named('Explore'))
    await evalIn(win, `${named('Explore')}.click(), 1`)
    // The store's default layout is grid, so the list is chosen rather than assumed.
    await waitFor(win, named('List'))
    await evalIn(win, `${named('List')}.click(), 1`)
    await waitFor(win, `document.querySelectorAll('.table .row, .table .card').length > 0`)
    await evalIn(win, `document.querySelector('.table .row, .table .card').click(), 1`)
    await sleep(1200)
    // Above the shell's breakpoint the row filled the rail, and the way on is the rail's own.
    await evalIn(win, `(${named('All details')} || { click() {} }).click(), 1`)
  } else {
    await waitFor(win, named('Installed'))
    await evalIn(win, `${named('Installed')}.click(), 1`)
    await waitFor(win, `document.querySelectorAll('.table .row, .table .card').length > 0`)
    await evalIn(win, `document.querySelector('.table .row, .table .card').click(), 1`)
  }
  await waitFor(win, `document.querySelector('.detail')`)

  const tab = process.env.TAB || 'overview'
  if (tab === 'preview') {
    await waitFor(win, `${named('PREVIEW')}`)
    await evalIn(win, `${named('PREVIEW')}.click(), 1`)
  }
  // Long enough for the cover to decode and for the container query to settle.
  await sleep(2500)

  const shape = await evalIn(win, SHAPE)
  if (shape.missing) {
    console.log(`window ${width}x${height}  ${source}  NO CHART PAGE OPENED`)
    app.exit(1)
    return
  }
  const record = process.env.RECORD || 'wide'
  console.log(
    `window ${width}x${height}  ${source}/${record}/${tab}  rail ${shape.railDisplay}${shape.railWidth ? ` ${shape.railWidth}px` : ''}`
  )
  console.log(`  column        ${shape.columnWidth}px, laid out in ${shape.columns} column(s)`)
  console.log(`  cards         ${JSON.stringify(shape.cards)}`)
  console.log(`  page          ${shape.pageHeight}px tall`)
  if (shape.grid) {
    console.log(
      `  grid          ${shape.grid.rows} rows, table ${shape.grid.tableWidth}px in a ${shape.grid.cardWidth}px card`
    )
    console.log(
      `    columns     ${shape.grid.head.map((h) => `${h.says} ${h.width}px`).join(', ')}`
    )
    console.log(
      `    overflow    card ${shape.grid.cardSidewaysBy}px, widest square over by ${shape.grid.cellOverflowBy}px${shape.grid.tightest ? ` ("${shape.grid.tightest}")` : ''}`
    )
  }
  if (shape.preview) {
    console.log(`  preview       columns ${shape.preview.columns}`)
    console.log(`    options     ${shape.preview.optionsWidth}px, highway ${shape.preview.highway}`)
  }
  console.log(`  sideways      page ${shape.detailSidewaysBy}px, document ${shape.docSidewaysBy}px`)
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
// Without this a timed-out wait rejects into nothing and the offscreen window sits there
// producing frames until something kills it.
process.on('unhandledRejection', (err) => {
  console.error(`measure-detail failed: ${err instanceof Error ? err.message : String(err)}`)
  app.exit(1)
})
