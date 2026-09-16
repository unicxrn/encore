/**
 * Measure the player bar in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-player-bar.mjs
 *     SIZES=1121x800 node_modules/electron/dist/electron scripts/measure-player-bar.mjs
 *
 * A sibling of `measure-top-bar.mjs`, built the same way and for the same reason: the jsdom tests
 * apply no CSS and compute no layout, so every control in this bar is zero pixels wide and
 * nothing can crowd anything. This runs the built renderer in an offscreen window, which is never
 * shown on any desktop, and reads the geometry back out.
 *
 * The bar is a 70px row of three groups: a 240px chart name, a transport that takes what is left,
 * and a 240px group holding repeat, volume and the downloads toggle. A button was added to the
 * last of those, and one more control in a bar this tight is the size of change that pushes a
 * song title into an ellipsis. So the questions are:
 *
 *   height    The row is 70px and must stay 70px. Anything in it that grows the row instead of
 *             fitting inside it takes the height from the view above.
 *   title     The name box, and whether the name still fits in it. The two side groups declare a
 *             width but not `flex-shrink: 0`, so a middle group wider than the room left over
 *             takes the difference out of the title and the downloads label rather than
 *             overflowing, and the failure looks like a shorter name rather than like a bug.
 *   cost      The same measurement with the new button taken back out of the flow, which is
 *             exactly the layout before it: `.right` falls back to the slider at the same 12px
 *             from the downloads toggle, because `display: none` on a flex item takes its gap
 *             with it. The difference between the two passes is what the button cost.
 *   sideways  The bar, or the document, pushed wider than the window.
 *   ceded     Whether the transport is faded out, which it is for as long as a viewport is
 *             registered. This is the number that decided where repeat goes: a preview can only
 *             exist inside a registered viewport, so the transport is ceded in every state where
 *             the bar has a chart in it, and a control drawn there is reachable only while there
 *             is nothing to use it on. Measured from both surfaces that can start a preview,
 *             because the rail and the chart page register separately.
 *
 * Two states, because the empty one is not the one that breaks:
 *
 *   idle      no preview: the bar draws its wordmark where the name goes.
 *   playing   the longest title measured on api.enchor.us on 2026-09-16 (47 characters,
 *             "Untouched (live for Like A Version) (Harmonies"), the same string
 *             `measure-rail-panel.mjs` uses, under an artist long enough to clip on its own.
 *             Reached through the chart page's Preview tab, which is the one route to a preview
 *             that exists at every width: the rail is `display: none` below the shell's
 *             breakpoint, so at 960 and 1120 it has no Play button to press.
 *
 * The widths are the ones the shell supports: the window minimum is 960, the rail is 374px wide
 * and appears above 1120, and 1121 is where the layout changes shape, which is why it sits beside
 * 1120 in the list.
 *
 * The preview itself never loads. The stubbed catalog hands back a chart file with no bytes in
 * it, so `openPreview` publishes the name and then fails in the parser, which is all this needs:
 * the name is what the bar draws, and it is published before the load is attempted.
 *
 * What it touches: a throwaway user-data directory, and nothing else. No network, no catalogue,
 * no library, no settings: the preload it writes answers every call from memory.
 */

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const SIZES = (process.env.SIZES || '960x800,1120x800,1121x800,1280x800,1920x1080')
  .split(',')
  .map((s) => s.trim().split('x').map(Number))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-playerbar-'))
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

// One chart, named the longest way a real chart is named. Both lines of the bar's name box are
// over-long on purpose: the title is the 47-character one measured on api.enchor.us, and the
// artist under it is longer still, because the box is sized by the wider of the two.
const record = {
  path: '/library/long',
  chartType: 'folder',
  name: 'Untouched (live for Like A Version) (Harmonies)',
  artist: 'The Veronicas And A Deliberately Overlong Credited Guest Artist',
  album: 'A Studio Album With A Title Nobody Would Choose For A Narrow Column',
  genre: 'Rock',
  year: 2024,
  charter: 'ACharterWhoseHandleIsAlsoUnreasonablyLong',
  diffGuitar: 4,
  diffBass: 3,
  diffDrums: 5,
  songLength: 196000,
  albumArtMd5: null,
  instruments: ['guitar'],
  noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 2487 }],
  maxNps: [{ instrument: 'guitar', difficulty: 'expert', nps: 14.1 }],
  hasSoloSections: true,
  has2xKick: false,
  hasVideo: true,
  hasBackground: true,
  hasAlbumArt: true,
  hasLyrics: true,
  // The chart page prints short forms of these, and reads them without a guard.
  folderHash: 'f'.repeat(40),
  chartHash: 'c'.repeat(43),
  tempoMapHash: 't'.repeat(32),
  cloneHeroChecksum: 'd'.repeat(32),
  modifiedTime: 1767225600000,
  scanVersion: 1
}

const answers = {
  settingsGet: () => settings,
  catalogQuery: () => [record],
  catalogCount: () => 1,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  issuesLast: () => [],
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  favouritesList: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  appUpdateStatus: () => ({ state: 'idle' }),
  // Enough for buildSource to resolve. The bytes are empty, so the parse behind it fails, which
  // is after the point the name reaches the bar.
  chartReadFiles: () => [{ fileName: 'notes.chart', data: new Uint8Array() }]
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
 * The bar, as layout has it, measured twice: as it is, and with the two new buttons taken out of
 * the flow.
 *
 * `display: none` on a flex item removes the item and the gap beside it, so the second pass is
 * the layout this bar had before the buttons existed rather than an approximation of it. Both
 * passes read the same elements, so `cost` is a difference between two numbers measured the same
 * way in the same document.
 */
const SHAPE = `(() => {
  const bar = document.querySelector('.playerbar')
  const box = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return {
      left: Math.round(b.left),
      right: Math.round(b.right),
      width: Math.round(b.width),
      height: Math.round(b.height)
    }
  }
  // A box that declares an ellipsis and ran out of room. Rounded away at 1px, which is subpixel
  // text metrics rather than a clipped name.
  const clippedBy = (el) => (el ? Math.max(0, Math.round(el.scrollWidth - el.clientWidth)) : 0)

  const read = () => {
    const title = bar.querySelector('.now .title')
    const artist = bar.querySelector('.now .artist')
    return {
      bar: box(bar),
      now: box(bar.querySelector('.now')),
      transport: box(bar.querySelector('.transport')),
      right: box(bar.querySelector('.right')),
      title: box(title),
      titleSays: title ? title.textContent.trim() : null,
      titleClipped: clippedBy(title),
      artistClipped: clippedBy(artist),
      seek: box(bar.querySelector('.seek')),
      dl: box(bar.querySelector('.dl')),
      dlClipped: clippedBy(bar.querySelector('.dl')),
      barSideways: Math.round(bar.scrollWidth - bar.clientWidth),
      docSideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }
  }

  const steps = [...bar.querySelectorAll('.repeat')]
  const after = read()
  for (const el of steps) el.style.display = 'none'
  // Reading a box forces the layout the line above invalidated.
  const before = read()
  for (const el of steps) el.style.display = ''

  const transport = bar.querySelector('.transport')
  return {
    after,
    before,
    buttons: steps.map((el) => ({ says: el.getAttribute('aria-label'), ...box(el) })),
    repeatPressed: bar.querySelector('.repeat')?.getAttribute('aria-pressed') ?? null,
    ceded: transport ? getComputedStyle(transport).visibility === 'hidden' : null,
    railShown:
      document.querySelector('.rail') === null
        ? 'absent'
        : getComputedStyle(document.querySelector('.rail')).display
  }
})()`

const named = (text) =>
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${text}')`

function report(label, shape) {
  const verdict = (ok, bad) => (ok ? 'ok' : bad)
  const { after, before } = shape
  console.log(`  ${label}`)
  console.log(
    `    bar           ${after.bar.width}px wide, ${after.bar.height}px tall  ${verdict(after.bar.height === 70, 'HEIGHT MOVED')}`
  )
  console.log(
    `    groups        name ${after.now.width}px, transport ${after.transport.width}px, right ${after.right.width}px`
  )
  console.log(
    `    title box     ${after.title === null ? 'no name drawn (idle)' : `${after.title.width}px, ${after.titleClipped > 0 ? `CLIPPED BY ${after.titleClipped}px` : 'not clipped'}, artist ${after.artistClipped > 0 ? `clipped by ${after.artistClipped}px` : 'not clipped'}`}`
  )
  for (const s of shape.buttons) {
    console.log(
      `    button        ${String(s.width).padStart(3)}px at ${s.left}-${s.right}px  "${s.says}"`
    )
  }
  console.log(
    `    cost          name box ${after.now.width - before.now.width}px, title box ${
      after.title === null ? 'n/a' : after.title.width - before.title.width
    }px, seek ${after.seek.width - before.seek.width}px, downloads label ${after.right.width - before.right.width}px`
  )
  console.log(
    `    cost clipping title ${before.titleClipped}px to ${after.titleClipped}px, downloads ${before.dlClipped}px to ${after.dlClipped}px`
  )
  console.log(
    `    sideways      bar ${after.barSideways}px, document ${after.docSideways}px  ${verdict(after.barSideways === 0 && after.docSideways === 0, 'SCROLLS')}`
  )
  console.log(
    `    state         transport ${shape.ceded ? 'CEDED' : 'live'}, repeat aria-pressed=${shape.repeatPressed}, rail ${shape.railShown}`
  )
}

// Electron quits when the last window closes, and each size's window is destroyed before the next
// one is made. Without this the quit begins between the two and the next load is cancelled.
app.on('window-all-closed', () => {})

app
  .whenReady()
  .then(async () => {
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
      await waitFor(win, `document.querySelector('.playerbar')`)
      await sleep(600)

      console.log(`window ${width}x${height}`)
      report('idle', await evalIn(win, SHAPE))

      // Installed, then the chart, then its Preview tab, then Play. The rail is not in this path on
      // purpose: below the shell's breakpoint there is no rail to press Play in.
      await waitFor(win, named('Installed'))
      await evalIn(win, `${named('Installed')}.click(), 1`)
      await waitFor(win, `document.querySelector('button.row')`)
      await evalIn(win, `document.querySelector('button.row').click(), 1`)
      await waitFor(win, `document.querySelector('#tab-preview')`)
      await evalIn(win, `document.querySelector('#tab-preview').click(), 1`)
      const play = `[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Play preview')`
      await waitFor(win, play)
      await evalIn(win, `${play}.click(), 1`)
      await waitFor(win, `document.querySelector('.playerbar .now .title')`)
      await sleep(400)

      report('playing', await evalIn(win, SHAPE))

      // Repeat armed, because it is the one control whose box changes with its state: the pressed
      // rule adds a dot under the glyph, and a dot that grew the row would grow the bar.
      await evalIn(win, `document.querySelector('.playerbar .repeat').click(), 1`)
      await sleep(200)
      report('playing, repeat on', await evalIn(win, SHAPE))

      // And again through the rail, which is the other surface that can start a preview and the
      // one most previews come from. It registers a viewport of its own, so the answer to `ceded`
      // has to be the same one; this is what checks that rather than assuming it. Above the
      // shell's breakpoint only: below it the column is `display: none` and has no Play button.
      if (
        await evalIn(win, `getComputedStyle(document.querySelector('.rail')).display !== 'none'`)
      ) {
        await evalIn(win, `${named('Installed')}.click(), 1`)
        await waitFor(win, `document.querySelector('button.row')`)
        const fill = `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Preview '))`
        await waitFor(win, fill)
        await evalIn(win, `${fill}.click(), 1`)
        await waitFor(win, `document.querySelector('.rail .preview button.play')`)
        await evalIn(win, `document.querySelector('.rail .preview button.play').click(), 1`)
        await waitFor(win, `document.querySelector('.playerbar .now .title')`)
        await sleep(400)
        report('playing from the rail', await evalIn(win, SHAPE))
      }
      win.destroy()
    }
    app.exit(0)
  })
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
