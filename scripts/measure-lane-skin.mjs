/**
 * Measure the playing preview's lane against the still one, in a real engine, without a window.
 *
 *     env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE TMPDIR="$PWD/.build-tmp" \
 *       xvfb-run -a --server-args="-screen 0 1920x1080x24" \
 *       node_modules/electron/dist/electron scripts/measure-lane-skin.mjs \
 *       --ozone-platform=x11 --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
 *
 *     SKIN=off ...            the package's own art, for the before picture
 *     INSTRUMENT=drums ...    guitar (default), drums, guitarghl
 *     SIZE=374x187 ...        the rail's highway block; 640x360 is the chart page's pane
 *     AT_MS=5000 ...          the bar where every lane fires at once, for the alignment leg
 *
 * Why this harness and not a test. jsdom applies no CSS, computes no layout and has no WebGL, so
 * nothing about this lane is visible to the renderer suite: the textures are canvases, the lane is
 * a perspective projection of them, and the question the whole change turns on is whether the
 * picture a user sees when they press Play is the picture they were already looking at. That is a
 * question for an engine.
 *
 * Unlike the other harnesses here this one does not boot the app. It boots the two things the app
 * puts in that box: the real `Highway` component, compiled by the real Svelte compiler, and a real
 * `ChartPreview` on a real chart, driven through the same seam `preview/player.ts` drives. Both are
 * drawn into the same 16:9 box at the same size, and the page reads back:
 *
 *   still / playing   a PNG of each, side by side and overlaid, into `.build-tmp/lane-skin/`.
 *   strike            where the lit line lands down the box in each, as a fraction of its height.
 *                     This is the mark a player's eye is on, and the one thing that moving at the
 *                     swap would read as the picture being replaced rather than starting.
 *   rails             where the outermost lane edge lands across the box at the strike line, and
 *                     at the far end. The still lane draws its perspective; the playing one is
 *                     given one by a camera, and this is what says how far apart the two are.
 *   frets             each ring's centre across the box, against the note that lands on it.
 *   cover             whether the highway plane reaches the corners of the box or leaves the
 *                     renderer's black clear colour showing around it.
 *
 * What it touches: `.build-tmp/lane-skin/` and a throwaway user-data directory. It fetches the
 * package's note sprites from static.enchor.us, which is what the app does when a preview opens.
 *
 * WebGL here is ANGLE over SwiftShader, which is software all the way down and never reaches the
 * graphics driver. That is deliberate: the `--disable-gpu` invocation the other harnesses use has
 * no WebGL at all, and the machine's own driver is the thing CLAUDE.md's xvfb box exists to keep
 * Chromium away from.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { compile } from 'svelte/compiler'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const out = path.join(root, '.build-tmp', 'lane-skin')
fs.mkdirSync(out, { recursive: true })

const [width, height] = (process.env.SIZE || '374x187').split('x').map(Number)
const instrument = process.env.INSTRUMENT || 'guitar'
const skin = process.env.SKIN !== 'off'
/**
 * Where in the chart to stop. 5000 is the bar where every lane fires at once, which is the frame
 * that answers whether a fret is under the note that lands on it.
 */
const atMs = Number(process.env.AT_MS || 250)

/** Svelte for esbuild. The component is the app's own; compiling it here is what keeps it so. */
const sveltePlugin = {
  name: 'svelte',
  setup(b) {
    b.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, 'utf8')
      const { js } = compile(source, {
        filename: args.path,
        css: 'injected',
        generate: 'client'
      })
      return { contents: js.code, loader: 'js' }
    })
  }
}

/**
 * A chart with something in every lane: singles walking up the frets, a three-note chord, a
 * sustain and a run of eighths, so the question of whether the package's notes read over this lane
 * is asked of notes that overlap, sustain and sit side by side rather than of one green circle.
 */
const CHART = `[Song]
{
  Name = "Lane"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
}
[ExpertSingle]
{
  192 = N 0 0
  288 = N 1 0
  384 = N 2 0
  480 = N 3 0
  576 = N 4 0
  768 = N 0 0
  768 = N 2 0
  768 = N 4 0
  960 = N 1 192
  1152 = N 3 0
  1248 = N 2 0
  1344 = N 1 0
  1440 = N 0 0
  1920 = N 0 0
  1920 = N 1 0
  1920 = N 2 0
  1920 = N 3 0
  1920 = N 4 0
}
[ExpertDrums]
{
  192 = N 0 0
  288 = N 1 0
  384 = N 2 0
  480 = N 3 0
  576 = N 4 0
  768 = N 1 0
  768 = N 3 0
  1920 = N 1 0
  1920 = N 2 0
  1920 = N 3 0
  1920 = N 4 0
}
[ExpertGHLGuitar]
{
  192 = N 0 0
  288 = N 1 0
  384 = N 2 0
  480 = N 3 0
  576 = N 4 0
  672 = N 5 0
  1920 = N 0 0
  1920 = N 1 0
  1920 = N 2 0
  1920 = N 3 0
  1920 = N 4 0
  1920 = N 5 0
}
`
const SONG_INI = `[song]
name = Lane
artist = Harness
charter = Harness
album = None
genre = None
year = 2026
diff_guitar = 4
song_length = 10000
`

/**
 * Three seconds of silence, because scan-chart calls a folder with no audio in it unplayable and
 * `prepareChartData` refuses to parse one. Nothing here plays it.
 */
function silentWav(seconds = 3, rate = 8000) {
  const samples = seconds * rate
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + samples * 2, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(samples * 2, 40)
  return b
}
const WAV = silentWav()

const entry = path.join(out, 'entry.mjs')
fs.writeFileSync(
  entry,
  `import { mount } from 'svelte'
import Highway from ${JSON.stringify(path.join(root, 'src/renderer/src/lib/components/Highway.svelte'))}
import { prepareChartData, ChartPreview, getInstrumentType } from 'chart-preview'
import { skinLaneTextures, laneLayout, laneRails } from ${JSON.stringify(path.join(root, 'src/renderer/src/lib/preview/lane-skin.ts'))}
window.Highway = Highway
window.mountSvelte = mount
window.prepareChartData = prepareChartData
window.ChartPreview = ChartPreview
window.getInstrumentType = getInstrumentType
window.skinLaneTextures = skinLaneTextures
window.laneLayout = laneLayout
window.laneRails = laneRails
`
)

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: path.join(out, 'bundle.js'),
  plugins: [sveltePlugin],
  logLevel: 'warning'
})

const tokens = fs.readFileSync(path.join(root, 'src/renderer/src/lib/tokens.css'), 'utf8')
const page = `<!doctype html>
<meta charset="utf-8">
<style>${tokens}</style>
<style>
  body { margin: 0; background: var(--ground-1); }
  /* The rail's own frame, so the box under test is the box the app draws. */
  .hw { position: relative; width: ${width}px; height: ${height}px; overflow: hidden;
        border-radius: var(--radius); background: var(--ground-0); }
  .viewport { position: absolute; inset: 0; }
  .viewport chart-preview-player, .viewport canvas { display: block; width: 100%; height: 100%; }
  .rest { position: absolute; inset: 0; pointer-events: none; }
  #still, #playing { position: absolute; left: 0; }
  #still { top: 0; }
  /* Something for the reduced-motion leg to ask about: a CSS animation the global rule can turn
     off, in the same document as the preview it does not reach. */
  .motion-probe { animation: probe 1s linear infinite; }
  @keyframes probe { to { opacity: 1; } }
  #playing { top: ${height + 8}px; }
</style>
<div class="hw" id="still"><div class="rest"></div></div>
<div class="hw" id="playing"><div class="viewport"></div></div>
<script src="bundle.js"></script>
`
fs.writeFileSync(path.join(out, 'index.html'), page)
fs.writeFileSync(path.join(out, 'notes.chart'), CHART)
fs.writeFileSync(path.join(out, 'song.ini'), SONG_INI)
fs.writeFileSync(path.join(out, 'song.wav'), WAV)

app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.whenReady().then(async () => {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'encore-lane-skin-')))
  const win = new BrowserWindow({
    show: false,
    width: Math.max(width + 40, 900),
    height: height * 2 + 80,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  win.webContents.debugger.attach('1.3')
  await win.loadFile(path.join(out, 'index.html'))

  const report = await win.webContents.executeJavaScript(
    `(async () => { try {
      const chart = ${JSON.stringify(CHART)}
      const ini = ${JSON.stringify(SONG_INI)}
      const enc = new TextEncoder()
      const files = [
        { fileName: 'notes.chart', data: enc.encode(chart) },
        { fileName: 'song.ini', data: enc.encode(ini) },
        { fileName: 'song.wav', data: Uint8Array.from(atob(${JSON.stringify(WAV.toString('base64'))}), (c) => c.charCodeAt(0)) }
      ]
      const instrument = ${JSON.stringify(instrument)}
      const difficulty = 'expert'

      window.mountSvelte(window.Highway, { target: document.querySelector('#still .rest') })

      const prepared = await window.prepareChartData(files, instrument, difficulty, 0, {
        animationsEnabled: false
      })
      const type = window.getInstrumentType(instrument)
      const skinned = ${skin}
        ? window.skinLaneTextures(prepared.textures, type, document)
        : false
      const container = document.querySelector('#playing .viewport')
      const preview = await window.ChartPreview.create({
        parsedChart: prepared.parsedChart,
        textures: prepared.textures,
        audioFiles: prepared.audioFiles,
        instrument,
        difficulty,
        startDelayMs: prepared.startDelayMs,
        audioLengthMs: prepared.audioLengthMs,
        container
      })
      // One frame, at a chart time where the first notes are part way down the lane. Drawn
      // inside an animation frame and then given two more before anything reads it back: an
      // offscreen window composites what it was given at the last frame boundary, and a WebGL
      // canvas written outside one is captured empty.
      preview.audioManager.lastSeekChartTimeMs = ${atMs}
      const frame = () => new Promise((r) => requestAnimationFrame(r))
      await frame()
      preview.animateFrame(false)

      const canvas = container.querySelector('canvas')
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      const w = canvas.width, h = canvas.height
      const px = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      // readPixels is bottom-up; everything below reads rows from the top of the picture.
      const at = (x, y) => {
        const i = ((h - 1 - y) * w + x) * 4
        return [px[i], px[i + 1], px[i + 2]]
      }

      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
      const rows = []
      for (let y = 0; y < h; y++) {
        let sum = 0
        for (let x = 0; x < w; x++) sum += lum(at(x, y))
        rows.push(sum / w)
      }
      const brightestRow = rows.indexOf(Math.max(...rows))

      // The lane's outer edge, read as the widest run of not-black on a row.
      const span = (y) => {
        let lo = -1, hi = -1
        for (let x = 0; x < w; x++) {
          if (lum(at(x, y)) > 2) { if (lo < 0) lo = x; hi = x }
        }
        return lo < 0 ? null : [lo / w, hi / w]
      }

      const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)].map(lum)

      /**
       * Where the package itself put the notes, asked of the package.
       *
       * The layout table in lane-skin.ts is a model of calculateNoteXOffset, which the package
       * does not export, and the whole lane hangs off it: a fret half a lane out is a fret in the
       * wrong place and no amount of colour fixes it. Reading the x the package gave every note it
       * has on screen is the one check of that model that is not circular. Run at AT_MS=5000, the
       * bar where every lane fires at once, so there is one note per lane to read.
       */
      const noteXs = [
        ...new Set(
          [...preview.notesManager.noteGroups.values()].map((g) => Number(g.position.x.toFixed(4)))
        )
      ].sort((p, q) => p - q)

      // And then keep drawing it, so the compositor has a frame to hand back when the screenshot
      // is taken. readPixels above had to come first: the drawing buffer is not preserved, so the
      // pixels are only there between the draw and the next composite.
      const keep = () => {
        preview.animateFrame(false)
        requestAnimationFrame(keep)
      }
      requestAnimationFrame(keep)

      // The still lane, read off the DOM the engine actually laid out: the two numbers that say
      // whether the swap moves the picture are where the strike line sits down the box and how
      // far the lane reaches across it.
      const box = document.querySelector('#still').getBoundingClientRect()
      const svg = document.querySelector('#still svg.highway')
      const rect = (sel) => {
        const el = svg.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return r
      }
      const strikeEl = rect('.strike')
      const railEls = [...svg.querySelectorAll('.rail')].map((el) => el.getBoundingClientRect())
      const fretEls = [...svg.querySelectorAll('.fret')].map((el) => el.getBoundingClientRect())
      const still = {
        strikeRow: (strikeEl.top + strikeEl.height / 2 - box.top) / box.height,
        strikeSpan: [
          (railEls[0].left - box.left) / box.width,
          (railEls[railEls.length - 1].right - box.left) / box.width
        ],
        fretWidth: fretEls[0].width / box.width,
        fretCentres: fretEls.map((r) => (r.left + r.width / 2 - box.left) / box.width)
      }

      const layout = window.laneLayout(type)
      return {
        still,
        skinned,
        instrument,
        canvas: [w, h],
        highwayImage: prepared.textures.highwayTexture.image?.tagName ?? null,
        strikeImage: prepared.textures.strikelineTexture.image?.tagName ?? null,
        strikeRow: brightestRow / h,
        strikeSpan: span(brightestRow),
        farSpan: span(Math.round(h * 0.06)),
        midSpan: span(Math.round(h * 0.5)),
        corners,
        noteXs,
        laneCentres: window.laneLayout(type).centres.map((c) => Number(c.toFixed(4))),
        lanes: layout.centres.length,
        rails: window.laneRails(layout)
      }
      } catch (e) { return { error: String(e && e.stack || e) } }
    })()`
  )

  /**
   * What reduced motion does to a preview a user chose to start.
   *
   * The app has one piece of reduced-motion machinery, the `*` rule at the foot of tokens.css, and
   * it turns off CSS transitions and animations. The playing preview is neither: chart-preview
   * renders through `setAnimationLoop`, which is `requestAnimationFrame`, and no CSS rule reaches
   * it. This asks the engine both halves of that with the media feature actually emulated: that
   * the rule is on (a CSS animation on the page computes to none) and that animation frames keep
   * arriving anyway.
   */
  const motion = {}
  for (const value of ['no-preference', 'reduce']) {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value }]
    })
    motion[value] = await win.webContents.executeJavaScript(
      `(async () => {
        const probe = document.createElement('div')
        probe.className = 'motion-probe'
        document.body.appendChild(probe)
        const css = getComputedStyle(probe).animationName
        probe.remove()
        let frames = 0
        const tick = () => { frames++; requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        await new Promise((r) => setTimeout(r, 500))
        return { animationName: css, framesIn500ms: frames }
      })()`
    )
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })

  // A beat, so the frame the page finished drawing is the frame the compositor hands back.
  await new Promise((r) => setTimeout(r, 400))
  const shot = await win.webContents.capturePage()
  fs.writeFileSync(
    path.join(out, `lane-${instrument}-${skin ? 'skin' : 'package'}-${width}x${height}.png`),
    shot.toPNG()
  )

  console.log(JSON.stringify({ ...report, motion }, null, 2))
  console.log('images in', out)
  app.quit()
})
