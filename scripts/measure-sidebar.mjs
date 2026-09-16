/**
 * Measure the sidebar's nav rows, and what the figures beside them cost, in a real engine.
 *
 *     npm run build
 *     env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE TMPDIR="$PWD/.build-tmp" \
 *       xvfb-run -a --server-args="-screen 0 1920x1080x24" \
 *       node_modules/electron/dist/electron scripts/measure-sidebar.mjs \
 *       --ozone-platform=x11 --disable-gpu --disable-software-rasterizer
 *
 * A sibling of `measure-top-bar.mjs` and built the same way, for the same reason: the jsdom tests
 * apply no CSS and compute no layout, so a nav row there is zero pixels wide and no label can run
 * out of room. This runs the built renderer in an offscreen window and reads the geometry back.
 *
 * The sidebar is a fixed 238px column with 12px of padding either side, which leaves 214px for a
 * row, and a row is an icon, a gap, a label and now a figure. So the questions are:
 *
 *   clipped    A label whose box is narrower than its text. The label declares `nowrap` and
 *              `text-overflow: ellipsis`, so the symptom is an ellipsis rather than a wrap, and
 *              `scrollWidth - clientWidth` is what says it happened.
 *   sideways   A row pushed wider than the column, which is what would happen if the figure
 *              could not shrink and the label refused to.
 *   headroom   Per label, the widest figure it can take before the first pixel is lost. The
 *              sweep at the bottom answers this for every row, including the ones that carry no
 *              figure at all, so "what happens to Asset Studio" has a number rather than a guess.
 *
 * The live half drives the figures through the fake preload: a library count, a download queue,
 * a duplicate report with spare copies in it, and an issue report. The issue pill is the one that
 * cannot be set from the preload alone, because the Issues view is what publishes it, so the
 * script navigates there and back the way a user would.
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

// The sidebar is a fixed track, so width should change nothing. 960 is the window minimum and
// 1121 is where the rail appears; both are here to show that the column does not move.
const SIZES = (process.env.SIZES || '960x800,1121x800,1920x1080')
  .split(',')
  .map((s) => s.trim().split('x').map(Number))

// Deliberately large. A library of 99,999 charts is past anything real (Chorus itself lists about
// 95,000), a queue of 9,999 is a selection nobody would make, and the two report figures are
// bounded by the library. If the row survives these it survives what users have.
const LIBRARY = Number(process.env.LIBRARY || 99999)
const QUEUED = Number(process.env.QUEUED || 9999)
const SPARE = Number(process.env.SPARE || 9999)
const BROKEN = Number(process.env.BROKEN || 99999)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-sidebar-'))
const preloadPath = path.join(scratch, 'preload.cjs')
fs.writeFileSync(
  preloadPath,
  `const LIBRARY = ${LIBRARY}
const QUEUED = ${QUEUED}
const SPARE = ${SPARE}
const BROKEN = ${BROKEN}

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
  gamePath: ''
}

// One identical set holding SPARE + 1 copies, which is SPARE copies the report calls spare.
const copy = (i) => ({
  path: '/home/someone/.clonehero/Songs/Rush - YYZ (' + i + ')',
  chartType: 'folder',
  name: 'YYZ',
  artist: 'Rush',
  charter: 'Ann',
  album: null,
  songLength: 300000,
  modifiedTime: 1,
  cloneHeroChecksum: 'a'.repeat(32),
  hasAlbumArt: false,
  hasVideo: false,
  hasBackground: false,
  hasLyrics: false,
  sizeBytes: null
})

// BROKEN charts each carrying one blocking finding, which is what the pill counts.
const issueRows = Array.from({ length: BROKEN }, (_, i) => ({
  chartPath: '/home/someone/.clonehero/Songs/chart-' + i,
  kind: 'folder',
  code: 'noAudio',
  description: 'No audio files were found.'
}))

const answers = {
  settingsGet: () => settings,
  catalogQuery: () => [],
  catalogCount: () => LIBRARY,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  catalogDuplicates: () => ({
    identical: [{ checksum: 'a'.repeat(32), copies: Array.from({ length: SPARE + 1 }, (_, i) => copy(i)) }],
    versions: [],
    alternates: [],
    totalCharts: LIBRARY,
    unidentifiedCharts: 0
  }),
  downloadList: () =>
    Array.from({ length: QUEUED }, (_, i) => ({
      md5: String(i).padStart(32, '0'),
      url: 'https://example.invalid/' + i,
      folderName: 'chart-' + i,
      status: i === 0 ? 'running' : 'queued',
      percent: null,
      message: null,
      finalPath: null
    })),
  issuesLast: () => issueRows,
  issuesFixable: () => [],
  backupsList: () => ({ backups: [], totalBytes: 0 }),
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  sidecarStatus: () => ({ installed: true, version: '2024.08.06' }),
  appUpdateStatus: () => ({
    currentVersion: '0.3.1',
    target: 'unpackaged',
    canApply: false,
    note: 'note',
    state: { kind: 'current' }
  }),
  gameExecutable: () => ({
    path: '',
    platform: 'linux',
    supported: true,
    kind: 'missing',
    executable: false,
    usable: false
  })
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
 * Every nav row as layout has it, plus the room its label has left.
 *
 * `clippedBy` is the number this script exists for: the label declares `nowrap` and an ellipsis,
 * so a positive value is text the user cannot read. `spare` is the same question asked the other
 * way round, in pixels the label still has, which is what makes the sweep below readable.
 */
const SHAPE = `(() => {
  const nav = document.querySelector('nav.sidebar')
  const rows = [...nav.querySelectorAll('.section .item')]

  // Width to two decimals as well as rounded: a label box 52.46px wide against text that needs
  // 52.46px is not short by half a pixel, and rounding one of the pair and not the other says it
  // is. \`clippedBy\` is the one that decides; \`spare\` only has to stop contradicting it.
  const box = (el) => {
    const b = el.getBoundingClientRect()
    return {
      left: Math.round(b.left),
      right: Math.round(b.right),
      width: Math.round(b.width),
      widthExact: Math.round(b.width * 100) / 100,
      height: Math.round(b.height)
    }
  }

  const canvas = document.createElement('canvas')
  const pen = canvas.getContext('2d')
  const textWidth = (el, text) => {
    const s = getComputedStyle(el)
    pen.font = s.fontStyle + ' ' + s.fontWeight + ' ' + s.fontSize + ' ' + s.fontFamily
    return Math.round(pen.measureText(text).width * 100) / 100
  }

  return {
    sidebar: box(nav),
    rows: rows.map((row) => {
      const label = row.querySelector('.label')
      const count = row.querySelector('.count')
      const glyph = row.querySelector('svg')
      return {
        says: label.textContent.trim(),
        figure: count === null ? null : count.textContent.trim(),
        pill: count !== null && count.classList.contains('pill'),
        row: box(row),
        label: box(label),
        count: count === null ? null : box(count),
        glyph: box(glyph),
        // What the label needs against what its box gives it.
        needs: textWidth(label, label.textContent.trim()),
        clippedBy: Math.max(0, label.scrollWidth - label.clientWidth),
        rowSideways: Math.round(row.scrollWidth - row.clientWidth)
      }
    }),
    // One row's fixed furniture, which is what the sweep prices the label against: the row's own
    // padding, the glyph, and the flex gaps either side of the label.
    frame: (() => {
      const row = rows[0]
      const s = getComputedStyle(row)
      return {
        track: Math.round(row.getBoundingClientRect().width),
        padding: Math.round(parseFloat(s.paddingLeft) + parseFloat(s.paddingRight)),
        gap: Math.round(parseFloat(s.columnGap || s.gap)),
        glyph: Math.round(row.querySelector('svg').getBoundingClientRect().width)
      }
    })(),
    // The mono face the figures are set in, priced per digit count, so the sweep can ask what a
    // label has left beside a figure that is not on screen right now.
    figureWidths: (() => {
      const count = nav.querySelector('.section .item .count')
      if (count === null) return null
      const s = getComputedStyle(count)
      const pad = Math.round(parseFloat(s.paddingLeft) + parseFloat(s.paddingRight))
      const samples = {}
      for (const [digits, text] of [[1,'9'],[2,'99'],[3,'999'],[4,'9,999'],[5,'99,999'],[6,'999,999']]) {
        samples[digits] = Math.round((textWidth(count, text) + pad) * 100) / 100
      }
      return samples
    })(),
    labelWidths: (() => {
      const label = nav.querySelector('.section .item .label')
      const out = {}
      for (const row of rows) out[row.querySelector('.label').textContent.trim()] =
        textWidth(label, row.querySelector('.label').textContent.trim())
      return out
    })()
  }
})()`

/**
 * The one row that can carry a figure and a chevron at once.
 *
 * Downloads is not a destination: it opens a panel, and the open state draws a chevron at the
 * row's far edge (`.item.open::after`). The figure sits at that edge too, so the two would be
 * drawn on top of each other without the margin `.item.open .count` adds. Positive `clearance`
 * is the gap between them.
 */
const CHEVRON = `(() => {
  const row = [...document.querySelectorAll('nav.sidebar .section .item')]
    .find(b => b.querySelector('.label').textContent.trim() === 'Downloads')
  const count = row.querySelector('.count')
  if (count === null) return null
  const after = getComputedStyle(row, '::after')
  const rowBox = row.getBoundingClientRect()
  const chevronRight = rowBox.right - parseFloat(after.right)
  const chevronLeft = chevronRight - parseFloat(after.width)
  return {
    open: row.classList.contains('open'),
    countRight: Math.round(count.getBoundingClientRect().right * 10) / 10,
    chevronLeft: Math.round(chevronLeft * 10) / 10,
    clearance: Math.round((chevronLeft - count.getBoundingClientRect().right) * 10) / 10
  }
})()`

const DOWNLOADS_ROW = `[...document.querySelectorAll('nav.sidebar .section .item')].find(b => b.querySelector('.label').textContent.trim() === 'Downloads')`

const NAV_READY = `document.querySelectorAll('nav.sidebar .section .item').length === 9`
const ISSUES_ROW = `[...document.querySelectorAll('nav.sidebar .section .item')].find(b => b.querySelector('.label').textContent.trim() === 'Issues')`
const HOME_ROW = `[...document.querySelectorAll('nav.sidebar .section .item')].find(b => b.querySelector('.label').textContent.trim() === 'Home')`

function report(label, shape) {
  console.log(`  ${label}`)
  console.log(`    column        ${shape.sidebar.width}px wide`)
  for (const r of shape.rows) {
    const fig =
      r.figure === null ? '   -   ' : `${r.figure.padStart(7)}${r.pill ? ' pill' : '     '}`
    const spare = Math.round((r.label.widthExact - r.needs) * 10) / 10
    console.log(
      `    ${r.says.padEnd(13)} label ${String(r.label.width).padStart(3)}px, needs ${String(r.needs).padStart(6)}px, ` +
        `${spare < 0 ? `SHORT BY ${-spare}px` : `${spare}px spare`}  ${
          r.clippedBy > 0 ? `ELLIPSISED BY ${r.clippedBy}px` : 'whole'
        }  figure ${fig}  ${r.rowSideways === 0 ? '' : 'ROW SCROLLS'}`
    )
  }
}

/** What every label has left beside a figure of each width, whether it carries one or not. */
function sweep(shape) {
  const { frame, figureWidths, labelWidths } = shape
  const room = frame.track - frame.padding - frame.glyph - frame.gap
  console.log(`  label sweep (row track ${frame.track}px, ${room}px for label plus figure)`)
  const digits = [0, 1, 2, 3, 4, 5, 6]
  console.log(
    `    ${'label'.padEnd(13)}${digits.map((d) => (d === 0 ? 'none' : `${d}d`).padStart(9)).join('')}`
  )
  for (const [name, width] of Object.entries(labelWidths)) {
    const cells = digits.map((d) => {
      const figure = d === 0 ? 0 : figureWidths[d] + frame.gap
      const spare = Math.round((room - figure - width) * 10) / 10
      return (spare < 0 ? `-${-spare}` : `${spare}`).padStart(9)
    })
    console.log(`    ${name.padEnd(13)}${cells.join('')}`)
  }
  console.log('    negative is the pixels of label the ellipsis eats at that figure width')
}

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
    await waitFor(win, NAV_READY)
    await sleep(900)

    console.log(`window ${width}x${height}`)
    report('resting', await evalIn(win, SHAPE))

    // The pill is published by the Issues view, not by the bridge, so it takes a visit. Back to
    // Home afterwards, because what is being measured is the sidebar on an ordinary screen.
    await evalIn(win, `${ISSUES_ROW}.click(), 1`)
    await waitFor(win, `document.querySelector('nav.sidebar .count.pill')`)
    await evalIn(win, `${HOME_ROW}.click(), 1`)
    await sleep(600)
    const withPill = await evalIn(win, SHAPE)
    report('after a scan has been seen', withPill)

    // The downloads panel open, which is the only state where a figure and a chevron share a row.
    await evalIn(win, `${DOWNLOADS_ROW}.click(), 1`)
    await waitFor(win, `document.querySelector('nav.sidebar .item.open')`)
    await sleep(300)
    const chevron = await evalIn(win, CHEVRON)
    console.log(
      `    downloads open  figure ends ${chevron.countRight}px, chevron starts ${chevron.chevronLeft}px, ` +
        `${chevron.clearance < 0 ? `OVERLAPPING BY ${-chevron.clearance}px` : `${chevron.clearance}px clear`}`
    )

    sweep(withPill)

    win.destroy()
  }
  app.exit(0)
})
