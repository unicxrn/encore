/**
 * Measure the Setlists view in a real engine, without a window.
 *
 *     npm run build
 *     env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE TMPDIR="$PWD/.build-tmp" \
 *       xvfb-run -a --server-args="-screen 0 1920x1080x24" \
 *       node_modules/electron/dist/electron scripts/measure-setlists.mjs \
 *       --ozone-platform=x11 --disable-gpu --disable-software-rasterizer
 *
 * The jsdom tests cannot answer any of this. They apply no CSS and compute no layout, so every
 * row is zero pixels wide and no name can run out of room. This runs the built renderer in an
 * offscreen window and reads the geometry back.
 *
 * The questions, and why each one is here rather than in a test:
 *
 *   pane       How much width the view actually gets. At 1280 the rail takes 374px and the
 *              sidebar 238px, which leaves the list about 660px; below 1121 the rail is not
 *              drawn and the list gets the lot. Both are here because the row is a grid and a
 *              grid's columns give way in an order you cannot guess.
 *   clipped    A name or an artist line cut off by its own box. Both declare `nowrap` and an
 *              ellipsis, so `scrollWidth > clientWidth` is what says it happened. The long leg
 *              is what that exists for.
 *   sideways   A row pushed wider than the pane, which is what would happen if the three icon
 *              buttons and the length refused to give and the name could not shrink.
 *   tabs       The picker strip. It wraps by design, so what matters is how many lines it takes
 *              at a realistic number of setlists and whether a long name is ellipsised rather
 *              than pushing the strip sideways.
 *   note       The sentence saying Clone Hero will not see a setlist. It is the one piece of
 *              running copy on the screen and the reason the screen is trustworthy, so how many
 *              lines it takes at each width is worth knowing.
 *
 * The legs:
 *
 *   plain    four setlists of ordinary names, one open with six charts in it, two of which the
 *            library does not hold.
 *   long     the longest title measured on api.enchor.us on 2026-09-16 (47 characters) against a
 *            setlist name at the 60-character cap and four setlists carrying it, which is what
 *            finds the column that gives way first.
 *
 * What it touches: a throwaway user-data directory and nothing else. The preload it writes
 * answers every call from memory; no network, no catalogue, no library.
 */

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { clickNav, evalIn, exitOnFailure, sleep, waitFor } from './harness-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// 960 is the window minimum, 1121 is where the rail appears and takes 374px off this view, and
// 1920 is a full screen. The middle one is the tight case and the reason the other two are here.
const SIZES = (process.env.SIZES || '960x800,1280x800,1920x1080')
  .split(',')
  .map((s) => s.trim().split('x').map(Number))

const leg = process.env.LEG || 'plain'

const LONG_TITLE = 'Untouched (live for Like A Version) (Harmonies)'
// The cap `SETLIST_NAME_MAX` holds a name to. A name at it is the widest tab the picker can ever
// be asked to draw, which is the only reason to measure one.
const LONG_NAME = 'Friday night at the Rose and Crown, the whole running order'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-setlists-'))
const preloadPath = path.join(scratch, 'preload.cjs')

const names =
  leg === 'long'
    ? [LONG_NAME, `${LONG_NAME} (2)`, `${LONG_NAME} (3)`, `${LONG_NAME} (4)`]
    : ['Friday night', 'Encores', 'Warm up', 'Drummer only']

const titles =
  leg === 'long'
    ? Array.from({ length: 6 }, (_, i) => `${LONG_TITLE} ${i + 1}`)
    : ['Everlong', 'YYZ', 'Painkiller', 'Chop Suey!', '505', 'Feel Good Inc.']

const artist = leg === 'long' ? 'A Band With A Genuinely Very Long Name Indeed' : 'Foo Fighters'
const charter = leg === 'long' ? 'SomebodyWithALongCharterNameHere' : 'Neversoft'

fs.writeFileSync(
  preloadPath,
  `const NAMES = ${JSON.stringify(names)}
const TITLES = ${JSON.stringify(titles)}
const ARTIST = ${JSON.stringify(artist)}
const CHARTER = ${JSON.stringify(charter)}

const settings = {
  libraryFolders: [{ path: '/library', isDefault: true }],
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

const entries = TITLES.map((name) => ({
  name,
  artist: ARTIST,
  charter: CHARTER,
  addedAt: '2026-09-16T00:00:00.000Z'
}))

const setlists = NAMES.map((name, i) => ({
  id: 'setlist-' + i,
  name,
  createdAt: '2026-09-16T00:00:0' + i + '.000Z',
  // Only the first carries charts: the view opens the first one, and four full setlists would
  // measure the same row four times over.
  entries: i === 0 ? entries : []
}))

// Two of the six are deliberately absent from the library, which is the state only a setlist has:
// an entry that outlived its chart, or one made for a chart on Chorus that was never downloaded.
const record = (name, i) => ({
  path: '/library/' + i + ' - ' + name,
  chartType: 'folder',
  name,
  artist: ARTIST,
  charter: CHARTER,
  album: null,
  songLength: 190000 + i * 17000,
  modifiedTime: 1,
  hasAlbumArt: false,
  hasVideo: false,
  hasBackground: false,
  hasLyrics: false
})

const answers = {
  settingsGet: () => settings,
  catalogQuery: () => [],
  catalogCount: () => 0,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  favouritesList: () => [],
  setlistsList: () => setlists,
  setlistsCharts: () => entries.map((e, i) => (i < 4 ? record(e.name, i) : null)),
  downloadList: () => [],
  issuesLast: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  sidecarStatus: () => ({ installed: false, version: null }),
  appUpdateStatus: () => ({
    currentVersion: '0.3.1',
    target: 'unpackaged',
    canApply: false,
    note: 'note',
    state: { kind: 'current' }
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

exitOnFailure('measure-setlists')

const SHAPE = `(() => {
  const view = document.querySelector('.setlists')
  const round = (n) => Math.round(n * 10) / 10
  const box = (el) => {
    const b = el.getBoundingClientRect()
    return { left: Math.round(b.left), width: Math.round(b.width), height: Math.round(b.height) }
  }
  // Positive is text the user cannot read, which is the number this whole script exists for.
  const clippedBy = (el) => Math.max(0, el.scrollWidth - el.clientWidth)
  const lines = (el) => {
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16
    return Math.round(el.getBoundingClientRect().height / lh)
  }

  const note = view.querySelector('.s-note')
  const tabs = [...view.querySelectorAll('.s-picker .s-tab')]
  const rows = [...view.querySelectorAll('.s-list .s-row')]

  return {
    pane: box(view).width,
    note: { lines: lines(note), width: box(note).width },
    picker: {
      count: tabs.length,
      // Tops tell the wrap apart from a strip that refused to: two distinct tops is two lines.
      lines: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size,
      widest: Math.max(...tabs.map((t) => box(t).width)),
      clipped: tabs.filter((t) => clippedBy(t.querySelector('.s-tab-name')) > 0).length,
      sidewaysBy: (view.querySelector('.s-picker') || { scrollWidth: 0, clientWidth: 0 })
        .scrollWidth -
        (view.querySelector('.s-picker') || { clientWidth: 0 }).clientWidth
    },
    summary: (view.querySelector('.s-summary') || { textContent: '' }).textContent.trim(),
    rows: rows.map((r) => {
      const name = r.querySelector('.s-name')
      const sub = r.querySelector('.s-sub')
      const len = r.querySelector('.s-len')
      const buttons = [...r.querySelectorAll('button')]
      return {
        says: name.textContent.trim().slice(0, 28),
        missing: r.classList.contains('missing'),
        height: box(r).height,
        nameWidth: box(name).width,
        nameClippedBy: round(clippedBy(name)),
        subClippedBy: round(clippedBy(sub)),
        length: len.textContent.trim(),
        buttons: buttons.length,
        buttonsFrom: buttons.length === 0 ? null : Math.round(buttons[0].getBoundingClientRect().left),
        sidewaysBy: r.scrollWidth - r.clientWidth
      }
    }),
    docSidewaysBy: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

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
    await clickNav(win, 'Setlists')
    await waitFor(win, `document.querySelectorAll('.setlists .s-list .s-row').length > 0`, {
      what: 'a setlist row'
    })
    await sleep(900)

    const s = await evalIn(win, SHAPE)
    console.log(`window ${width}x${height}  leg ${leg}  view pane ${s.pane}px`)
    console.log(
      `  note          ${s.note.lines} line(s) in ${s.note.width}px` +
        (s.note.lines > 6 ? '   LONG' : '')
    )
    console.log(
      `  picker        ${s.picker.count} tabs on ${s.picker.lines} line(s), widest ${s.picker.widest}px, ` +
        `${s.picker.clipped} name(s) ellipsised` +
        (s.picker.sidewaysBy > 0 ? `   STRIP SCROLLS BY ${s.picker.sidewaysBy}px` : '')
    )
    console.log(`  summary       ${s.summary}`)
    for (const r of s.rows) {
      console.log(
        `    ${r.says.padEnd(28)} ${String(r.height).padStart(3)}px  name ${String(r.nameWidth).padStart(3)}px` +
          `${r.nameClippedBy > 0 ? ` ELLIPSISED BY ${r.nameClippedBy}px` : ' whole'}` +
          `${r.subClippedBy > 0 ? `, sub by ${r.subClippedBy}px` : ''}` +
          `  ${r.length.padStart(5)}  ${r.buttons} buttons from ${r.buttonsFrom}px` +
          `${r.missing ? '  NOT HELD' : ''}${r.sidewaysBy > 0 ? '   ROW SCROLLS' : ''}`
      )
    }
    console.log(
      `  document      ${s.docSidewaysBy > 0 ? `SCROLLS SIDEWAYS BY ${s.docSidewaysBy}px` : 'no sideways scroll'}`
    )

    win.destroy()
  }
  app.exit(0)
})
