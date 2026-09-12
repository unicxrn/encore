/**
 * Measure Home's play panel and Installed's play badge in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-play-panel.mjs
 *     SIZE=1280x800 node_modules/electron/dist/electron scripts/measure-play-panel.mjs
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so the tile
 * grid has no columns, the caveat has no position on a page and a badged row has no height to
 * compare against an unbadged one. This runs the built renderer in an offscreen window, which is
 * never shown on any desktop, and reads the boxes back out. Same technique, and same reasons, as
 * measure-explore-append.mjs.
 *
 * Three questions, all of which jsdom answers wrongly by answering zero:
 *
 * 1. Does the caveat sit above every figure in LAYOUT, not just in the DOM? DOM order is what the
 *    component test pins; a float or a grid could still paint it under the tiles.
 *    2. Do five tiles fit the width, and how do they wrap when they do not?
 *    3. Does a row that gained a play badge stay exactly as tall as one that did not? The badge is
 *    inside the title line, and a badge that grows the line grows every row in the list.
 *
 * Touches nothing real: the preload written below answers every call from memory, from a
 * throwaway user-data directory, with no network and no catalogue.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-playpanel-'))
const preloadPath = path.join(scratch, 'preload.cjs')

/** Four installed charts, two of which have a play on record. */
const CHECKSUMS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)]

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
const checksums = ${JSON.stringify(CHECKSUMS)}
const charts = checksums.map((sum, i) => ({
  path: '/library/Rush - Chart ' + i,
  name: 'Chart ' + i,
  artist: 'Rush',
  album: 'Moving Pictures',
  genre: 'Rock',
  charter: 'someone',
  year: 1981,
  songLength: 273000,
  chartType: 'folder',
  folderHash: 'chart-' + i,
  modifiedTime: 0,
  cloneHeroChecksum: sum,
  instruments: ['guitar', 'bass', 'drums'],
  diffGuitar: 4,
  diffBass: 3,
  diffDrums: 5,
  albumArtMd5: null
}))
const answers = {
  settingsGet: () => settings,
  catalogQuery: () => charts,
  catalogCount: () => charts.length,
  catalogFacets: () => ({ artists: ['Rush'], genres: ['Rock'], charters: ['someone'], years: [1981] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  updatesLast: () => [],
  appUpdateStatus: () => ({ state: 'idle' }),
  playStatus: () => ({
    available: true,
    reason: 'ok',
    path: '/home/player/.clonehero/scorestats.json',
    playCount: 412
  }),
  playSummaries: (list) =>
    (list || [])
      .filter((sum) => sum === checksums[0] || sum === checksums[2])
      .map((sum, i) => ({
        checksum: sum,
        timesPlayed: i === 0 ? 137 : 1,
        bestScore: 1234567,
        bestStars: 5,
        bestAccuracy: 0.9812,
        everFc: true,
        lastPlayedAt: '2026-09-01T20:00:00.0000000Z'
      })),
  playStats: () => ({
    totalPlays: 412,
    chartsPlayed: 177,
    fcCount: 58,
    pfcCount: 4,
    notesHit: 1043998,
    totalNotes: 1102771,
    bestScore: 1234567,
    longestStreak: 2048,
    firstPlayedAt: '2026-03-03T18:04:11.1234567Z',
    lastPlayedAt: '2026-09-01T20:00:00.0000000Z',
    byInstrument: [{ key: 'guitar', plays: 400 }],
    byDifficulty: [{ key: 'expert', plays: 400 }],
    topCharts: Array.from({ length: 10 }, (_, i) => ({
      checksum: String(i).repeat(32).slice(0, 32),
      songName: i === 0 ? 'A song with a deliberately long title that has to ellipsise' : 'Chart ' + i,
      artistName: 'Rush',
      charterName: 'someone',
      timesPlayed: 137 - i * 12,
      bestScore: 1234567 - i * 1000
    }))
  })
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

async function waitFor(win, expression, timeoutMs = 20000) {
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

/** The panel, as layout has it. */
const PANEL = `(() => {
  const round = (n) => Math.round(n)
  const caveat = document.querySelector('.caveat')
  const tiles = [...document.querySelectorAll('.tile')]
  const rows = [...document.querySelectorAll('.top-row')]
  const home = document.querySelector('.home')
  const tops = [...new Set(tiles.map((t) => round(t.getBoundingClientRect().top)))]
  return {
    caveatBottom: caveat ? round(caveat.getBoundingClientRect().bottom) : null,
    firstTileTop: tiles.length ? round(tiles[0].getBoundingClientRect().top) : null,
    // Positive means the caveat finishes before the first figure begins, in painted pixels.
    caveatClearsFiguresBy: caveat && tiles.length
      ? round(tiles[0].getBoundingClientRect().top - caveat.getBoundingClientRect().bottom)
      : null,
    tiles: tiles.length,
    tileRows: tops.length,
    tileWidth: tiles.length ? round(tiles[0].getBoundingClientRect().width) : null,
    // Any tile whose text spills its box is a number the user cannot read.
    tilesOverflowing: tiles.filter((t) => t.scrollWidth > t.clientWidth + 1).length,
    topRows: rows.length,
    topRowHeight: rows.length ? round(rows[0].getBoundingClientRect().height) : null,
    pageScrollsSideways: home ? home.scrollWidth > home.clientWidth + 1 : null
  }
})()`

/** The Installed list, comparing a badged row against an unbadged one. */
const LIST = `(() => {
  const round = (n) => Math.round(n)
  const rows = [...document.querySelectorAll('.row')]
  const heights = rows.map((r) => round(r.getBoundingClientRect().height))
  const badged = rows.filter((r) => r.querySelector('.badge.plays'))
  const bare = rows.filter((r) => !r.querySelector('.badge.plays'))
  const titleOf = (r) => r.querySelector('.title')
  return {
    rows: rows.length,
    badgedRows: badged.length,
    badgeText: badged.map((r) => r.querySelector('.badge.plays').textContent.replace(/\\s+/g, ' ').trim()),
    distinctRowHeights: [...new Set(heights)],
    badgedHeight: badged.length ? round(badged[0].getBoundingClientRect().height) : null,
    bareHeight: bare.length ? round(bare[0].getBoundingClientRect().height) : null,
    // The title is what gives way to a badge; it must still have width to show something.
    titleWidthBadged: badged.length ? round(titleOf(badged[0]).getBoundingClientRect().width) : null,
    titleWidthBare: bare.length ? round(titleOf(bare[0]).getBoundingClientRect().width) : null,
    caveat: (document.querySelector('.caveat')?.textContent ?? '').replace(/\\s+/g, ' ').trim()
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

  await waitFor(win, `document.querySelector('.tile')`)
  await sleep(500)
  console.log(`window ${width}x${height}`)
  console.log('home panel ', JSON.stringify(await evalIn(win, PANEL), null, 1))

  const installed = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Installed')`
  await waitFor(win, installed)
  await evalIn(win, `${installed}.click(), 1`)
  await waitFor(win, `document.querySelector('.badge.plays')`)
  await sleep(500)
  console.log('installed  ', JSON.stringify(await evalIn(win, LIST), null, 1))

  app.exit(0)
})
