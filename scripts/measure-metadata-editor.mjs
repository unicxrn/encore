/**
 * Measure the metadata editor in a real browser engine, without a window.
 *
 *     node_modules/electron/dist/electron scripts/measure-metadata-editor.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-metadata-editor.mjs
 *     RAIL=off STATE=long node_modules/electron/dist/electron scripts/measure-metadata-editor.mjs
 *
 * On this machine it has to be boxed into a virtual framebuffer, because Chromium's buffer
 * allocation on an NVIDIA card in a Wayland session takes the whole machine down:
 *
 *     env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE TMPDIR="$PWD/.build-tmp" \
 *       xvfb-run -a --server-args="-screen 0 1920x1080x24" \
 *       node_modules/electron/dist/electron scripts/measure-metadata-editor.mjs \
 *       --ozone-platform=x11 --disable-gpu --disable-software-rasterizer
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so every
 * box is zero pixels wide, no row wraps and nothing can overflow.
 *
 * ## What it builds, and why it is not the app
 *
 * Every other measure script in here loads `out/renderer/index.html` and clicks the view's own
 * nav entry. This view has no nav entry yet: it lands before the shell is wired to it, so nothing
 * imports the component and the production bundle does not contain it. So this builds a page of
 * its own that mounts the component alone, with the app's tokens and typefaces, inside a
 * REPRODUCTION of the shell's grid rather than the shell itself.
 *
 * That reproduction is the one thing to distrust here, and it is checkable: the widths it
 * produces are printed, and the shell's own documented geometry (238px sidebar throughout, a
 * 374px rail above 1120px, so a view column of 722 / 882 / 509 / 668 / 1308px at the five widths
 * below) is printed beside them. A mismatch means this file is measuring the wrong column and
 * nothing it says about the form can be trusted. Re-run it against the real shell once the nav
 * entry exists.
 *
 * ## What it asks
 *
 *   groups     Every card, with its box. A card wider than the column it sits in is the failure
 *              mode a screenshot hides.
 *   controls   Every box and button, with the width its own text needs, measured on a canvas in
 *              the element's own font. A negative `room` is text the control cannot draw.
 *   rows       Whether a field row kept its box beside its label or stacked it underneath.
 *              Stacking is the design below a certain width and a surprise above it, so the
 *              state is printed rather than asserted.
 *   clipped    Anything that declares an ellipsis and ran out of room.
 *   sideways   The view or the document pushed wider than its own box. A long chart path and the
 *              gameplay table are the two things most likely to do it.
 *
 *   SIZE=WxH   the window. The five worth passing are 960 (the minimum), 1120, 1121 (where the
 *              rail appears and the column drops to 509px, narrower than at the minimum), 1280
 *              (the default) and 1920.
 *   RAIL=off   draw no rail column at any width, which is the collapsed state.
 *   STATE=long a chart whose every field is at the long end of what a real one holds, with a
 *              deeply nested path and every one of the seven gameplay keys set.
 *   STATE=find the finder, with 25 results, which is the state the nav entry opens on.
 *
 * What it touches: nothing. The preload answers every call from memory.
 */

import { app, BrowserWindow } from 'electron'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalIn, exitOnFailure, sleep, waitFor } from './harness-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
const railWanted = process.env.RAIL !== 'off'
const state =
  process.env.STATE === 'long' ? 'long' : process.env.STATE === 'find' ? 'find' : 'plain'
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'encore-measure-'))

// ── the fixture ────────────────────────────────────────────────────────────────
// The plain case is the one somebody arrives with: a chart missing its album and year. The long
// case is every field at the long end of what a real song.ini holds, which is where a label and
// a box stop fitting on one line.
const CHART =
  state === 'long'
    ? {
        path: '/mnt/storage/games/clone-hero/Clone Hero Songs/Downloaded from Chorus Encore/Dream Theater - Six Degrees of Inner Turbulence II. About to Crash (CSC August 2021)',
        chartType: 'folder',
        name: 'Six Degrees of Inner Turbulence: II. About to Crash (Reprise)',
        artist: 'Dream Theater',
        album: 'Six Degrees of Inner Turbulence',
        genre: 'Progressive Metal',
        year: 2002,
        charter: 'CSC August 2021'
      }
    : {
        path: '/home/u/.clonehero/Songs/Rush - YYZ',
        chartType: 'folder',
        name: 'YYZ',
        artist: 'Rush',
        album: null,
        genre: 'Rock',
        year: null,
        charter: 'Harmonix'
      }

const FIELDS =
  state === 'long'
    ? {
        name: 'Six Degrees of Inner Turbulence: II. About to Crash (Reprise)',
        artist: 'Dream Theater feat. an unusually long guest credit',
        album: 'Six Degrees of Inner Turbulence (Deluxe Remastered Edition)',
        genre: 'Progressive Metal',
        year: '2002',
        charter: 'CSC August 2021'
      }
    : { name: 'YYZ', artist: 'Rush', album: '', genre: 'Rock', year: '', charter: 'Harmonix' }

// All seven, which is the widest this table ever gets. Real charts set one or two.
const GAMEPLAY =
  state === 'long'
    ? [
        { key: 'hopo_frequency', value: '170' },
        { key: 'eighthnote_hopo', value: 'True' },
        { key: 'multiplier_note', value: '103' },
        { key: 'sustain_cutoff_threshold', value: '64' },
        { key: 'chord_snap_threshold', value: '10' },
        { key: 'five_lane_drums', value: 'False' },
        { key: 'pro_drums', value: 'True' }
      ]
    : [
        { key: 'hopo_frequency', value: '3' },
        { key: 'pro_drums', value: 'True' }
      ]

const RESULTS = Array.from({ length: 25 }, (_, i) => ({
  ...CHART,
  path: `${CHART.path} ${i}`,
  name: `${CHART.name} ${i}`
}))

// ── the page ───────────────────────────────────────────────────────────────────
// The shell's grid, reproduced: a 238px sidebar, the view, and a 374px rail above 1120px. See
// the note at the top of this file about why it is a reproduction and how to tell it is wrong.
const entry = path.join(scratch, 'entry.ts')
fs.writeFileSync(
  entry,
  `import { mount } from 'svelte'
import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import ${JSON.stringify(path.join(repo, 'src/renderer/src/lib/tokens.css'))}
import MetadataEditor from ${JSON.stringify(path.join(repo, 'src/renderer/src/lib/components/MetadataEditor.svelte'))}

const read = {
  chartPath: ${JSON.stringify(CHART.path)},
  chartType: 'folder',
  iniName: 'song.ini',
  synthetic: false,
  fields: ${JSON.stringify(FIELDS)},
  gameplay: ${JSON.stringify(GAMEPLAY)},
  refusal: null
}
window.encore = new Proxy({}, {
  get(_t, key) {
    if (key === 'platform') return 'linux'
    if (key === 'chartReadMetadata') return () => Promise.resolve(read)
    if (key === 'catalogQuery') return () => Promise.resolve(${JSON.stringify(RESULTS)})
    if (typeof key === 'string' && key.startsWith('on')) return () => () => {}
    return () => Promise.resolve(undefined)
  }
})

mount(MetadataEditor, {
  target: document.querySelector('.view'),
  props: { chart: ${state === 'find' ? 'null' : JSON.stringify(CHART)} }
})
`
)

fs.writeFileSync(
  path.join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>metadata editor</title>
<style>
  html, body { height: 100%; }
  .shell { display: grid; height: 100vh; grid-template-columns: 238px 1fr${railWanted ? ' 374px' : ''}; }
  .side { border-right: 1px solid var(--hairline); background: var(--ground-2); }
  .view { min-width: 0; overflow-y: auto; }
  .rail { border-left: 1px solid var(--hairline); background: var(--ground-2); }
  @media (max-width: 1120px) { .rail { display: none; } .shell { grid-template-columns: 238px 1fr; } }
</style></head>
<body><div class="shell"><div class="side"></div><div class="view"></div>${railWanted ? '<div class="rail"></div>' : ''}</div>
<script type="module" src="/entry.ts"></script></body></html>`
)

fs.writeFileSync(
  path.join(scratch, 'vite.config.mjs'),
  `import { svelte } from ${JSON.stringify(path.join(repo, 'node_modules/@sveltejs/vite-plugin-svelte/src/index.js'))}
export default {
  root: ${JSON.stringify(scratch)},
  // Relative asset URLs: the page is loaded over file://, where Vite's default absolute
  // /assets/… resolves to the filesystem root and the bundle silently never loads.
  base: './',
  plugins: [svelte()],
  define: { __APP_VERSION__: '"0.0.0-measure"' },
  build: { outDir: ${JSON.stringify(path.join(scratch, 'dist'))}, emptyOutDir: true }
}`
)

// Built in a child process rather than in this one: Vite pulls in esbuild's native binding and a
// good deal of Node's module machinery, and Electron's main process is not where that belongs.
// `ELECTRON_RUN_AS_NODE` runs the same binary as plain Node, so nothing extra has to be installed.
const build = spawnSync(
  process.execPath,
  [
    path.join(repo, 'node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    path.join(scratch, 'vite.config.mjs')
  ],
  { cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }
)
if (build.status !== 0) {
  console.error(build.stdout)
  console.error(build.stderr)
  process.exit(1)
}

app.setPath('userData', path.join(scratch, 'userdata'))
app.commandLine.appendSwitch('disable-gpu')

exitOnFailure('measure-metadata-editor')

const SHAPE = `(() => {
  const view = document.querySelector('.view')
  const page = document.querySelector('.editor')

  const canvas = document.createElement('canvas')
  const pen = canvas.getContext('2d')
  const textWidth = (el, text) => {
    const style = getComputedStyle(el)
    pen.font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily
    return pen.measureText(text).width
  }
  const inner = (el) => {
    const style = getComputedStyle(el)
    return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  }
  const lines = (el) => {
    const style = getComputedStyle(el)
    const lh = parseFloat(style.lineHeight)
    return Number.isFinite(lh) ? Math.round(el.getBoundingClientRect().height / lh) : 1
  }

  const groups = [...page.querySelectorAll('.group')].map((el) => ({
    name: (el.querySelector('h2').textContent || '').trim(),
    width: Math.round(el.getBoundingClientRect().width),
    height: Math.round(el.getBoundingClientRect().height)
  }))

  const controls = []
  for (const el of page.querySelectorAll('input, button')) {
    const text = (el.textContent || el.value || el.placeholder || '').trim()
    const box = Math.round(inner(el))
    const needs = Math.round(textWidth(el, text))
    controls.push({
      what: el.id || (el.textContent || '').trim() || el.tagName.toLowerCase(),
      says: text.slice(0, 30),
      width: Math.round(el.getBoundingClientRect().width),
      box,
      needs,
      room: box - needs
    })
  }

  // Whether a field row put its box on a line of its own. Not the distinct tops of the children:
  // the label block is two lines tall and the box is centred against it, so their tops differ in
  // the ordinary case too. What says "stacked" is the box starting at or below the label's bottom.
  const rows = [...page.querySelectorAll('.row')].map((row) => {
    const label = row.querySelector('.row-text').getBoundingClientRect()
    const control = row.querySelector('input').getBoundingClientRect()
    return {
      label: (row.querySelector('.row-label').textContent || '').trim(),
      stacked: control.top >= label.bottom - 1,
      boxWidth: Math.round(control.width)
    }
  })

  const clipped = []
  for (const el of page.querySelectorAll('*')) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
    if (el.scrollWidth - el.clientWidth > 1) {
      clipped.push({
        cls: el.className.toString().split(' ')[0],
        box: el.clientWidth,
        says: (el.textContent || '').trim().slice(0, 30)
      })
    }
  }

  const overflowing = []
  for (const el of page.querySelectorAll('.chosen-path, .was, .g-row, .prose, .lede, .saved')) {
    if (el.scrollWidth - el.clientWidth > 1) {
      overflowing.push({
        cls: el.className.toString().split(' ')[0],
        by: el.scrollWidth - el.clientWidth,
        says: (el.textContent || '').trim().slice(0, 30)
      })
    }
  }

  const path = page.querySelector('.chosen-path')
  return {
    viewWidth: Math.round(view.getBoundingClientRect().width),
    columnWidth: Math.round(page.getBoundingClientRect().width),
    columnLeft: Math.round(page.getBoundingClientRect().left - view.getBoundingClientRect().left),
    pageHeight: Math.round(page.getBoundingClientRect().height),
    groups,
    controls,
    rows,
    clipped,
    overflowing,
    pathLines: path ? lines(path) : 0,
    pathChars: path ? (path.textContent || '').length : 0,
    sidewaysBy: Math.round(view.scrollWidth - view.clientWidth),
    docSidewaysBy: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

/** The shell's own documented view-column widths, to check the reproduction above against. */
const EXPECTED_COLUMN = { 960: 722, 1120: 882, 1121: 509, 1280: 668, 1920: 1308 }

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width,
      height,
      show: false,
      webPreferences: {
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        offscreen: true
      }
    })
    win.webContents.setFrameRate(30)
    // A page that fails to boot would otherwise show up as a `waitFor` timeout with nothing said
    // about why, which is how the first run of this script was spent.
    win.webContents.on('console-message', (_e, _level, message) =>
      console.error(`  page: ${message}`)
    )
    win.webContents.on('did-fail-load', (_e, code, description) =>
      console.error(`  page failed to load: ${code} ${description}`)
    )
    await win.loadFile(path.join(scratch, 'dist', 'index.html'))

    await waitFor(win, `document.querySelector('.editor')`, { what: 'the metadata editor' })
    if (state === 'find') {
      await evalIn(
        win,
        `(() => { const el = document.querySelector('#metaedit-search'); el.value = 'a'; el.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`
      )
      await waitFor(win, `document.querySelectorAll('.result').length === 25`, {
        what: '25 search results',
        context: `document.querySelectorAll('.result').length + ' drawn'`
      })
    } else {
      await waitFor(win, `document.querySelector('#metaedit-album')`, { what: 'the album field' })
      // One field dirtied, so the "Was …" line and the enabled primary button are both measured.
      await evalIn(
        win,
        `(() => { const el = document.querySelector('#metaedit-album'); el.value = 'Moving Pictures (Deluxe)'; el.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`
      )
      await waitFor(win, `document.querySelector('.was')`, {
        what: 'the was line under a dirtied field'
      })
    }
    await sleep(1500)

    const shape = await evalIn(win, SHAPE)
    const railDrawn = railWanted && width > 1120
    const expected = EXPECTED_COLUMN[width]
    console.log(
      `window ${width}x${height}  view ${shape.viewWidth}px  rail ${railDrawn ? 'open' : 'closed'}  state ${state}`
    )
    if (expected !== undefined) {
      const matches = railWanted && shape.viewWidth === expected
      console.log(
        `  shell check   view column ${shape.viewWidth}px against the shell's documented ${expected}px: ${
          railWanted
            ? matches
              ? 'MATCHES'
              : 'DIFFERS, do not trust anything below'
            : 'n/a, rail forced off'
        }`
      )
    }
    console.log(
      `  column        ${shape.columnWidth}px, ${shape.columnLeft}px in from the view's left edge, ${shape.pageHeight}px tall`
    )
    console.log(`  sideways      view ${shape.sidewaysBy}px, document ${shape.docSidewaysBy}px`)
    console.log('  groups')
    for (const g of shape.groups) {
      console.log(`    ${g.name.padEnd(38)} ${String(g.width).padStart(4)}px x ${g.height}px`)
    }
    console.log('  controls')
    for (const c of shape.controls) {
      console.log(
        `    ${c.what.padEnd(22)} ${String(c.width).padStart(4)}px wide, ${String(c.box).padStart(4)}px inside, text ${String(c.needs).padStart(4)}px, ${c.room < 0 ? `SHORT BY ${-c.room}px` : `${c.room}px spare`}  "${c.says}"`
      )
    }
    console.log(
      '  field rows    ' +
        shape.rows
          .map((r) => `${r.label}: ${r.boxWidth}px ${r.stacked ? 'STACKED' : 'beside'}`)
          .join('; ')
    )
    if (shape.pathChars > 0) {
      console.log(`  chart path    ${shape.pathChars} chars over ${shape.pathLines} lines`)
    }
    console.log(
      shape.clipped.length === 0
        ? '  clipped       nothing'
        : '  clipped       ' +
            shape.clipped.map((c) => `.${c.cls} at ${c.box}px: "${c.says}"`).join('; ')
    )
    console.log(
      shape.overflowing.length === 0
        ? '  overflowing   nothing'
        : '  overflowing   ' +
            shape.overflowing.map((o) => `.${o.cls} by ${o.by}px: "${o.says}"`).join('; ')
    )

    app.exit(0)
  })
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
