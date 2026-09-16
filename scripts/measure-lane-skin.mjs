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
 *     SIZE=332x187 ...        the rail's highway block; 640x360 is the chart page's pane, and
 *                             anything else is a box neither of them is, which is the point: the
 *                             lane is projected against the box's height and the aspect drops out
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
 * `ChartPreview` on a real chart, driven through the same seam `preview/player.ts` drives. Both
 * are drawn into a box of the same size, both come back as straight pixels, and both go through
 * one `measure`, which is what makes the two columns comparable. What it prints of each:
 *
 *   horizon        where the highway plane's far edge lands down the box. The plane is finite and
 *                  there is nothing above it, so this is the one edge that says whether the two
 *                  lanes are the same distance away.
 *   planeSpan      how far the plane reaches across the box at three depths, which is the whole
 *                  of the perspective in three numbers.
 *   strikeRow      where the light at the strike line has its centre of mass. Comparative rather
 *                  than exact; see `measure`.
 *   strikeSpan     how far the strike line itself reaches, which is the lane's own width.
 *   frets          each ring's centre and width, where the ring can be told from the lane.
 *   corners        what the four corners of the box are, which is what the surround is.
 *   scrim          what a lighten scrim of --ground-0 over the box would move, and how much of
 *                  that would not be the surround.
 *   noteXs         where the package put the notes, against the lane model that draws the frets.
 *
 * It also writes a PNG of the page into `.build-tmp/lane-skin/`, which is for looking at: nothing
 * is measured off it, because a screenshot moves every colour in the page.
 *
 * Only the five-fret lane is a comparison. The still lane draws five whatever is playing, so on
 * drums or a six-fret guitar the two columns are a four or three lane highway against a five lane
 * one, deliberately, and only the horizon and the corners mean anything.
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
  /* Black, so the page behind the boxes cannot be mistaken for part of either lane, and square
     corners, because the rounding in the app belongs to the frame around the lane and would put
     the page's colour in the corner the measurement wants to read. */
  body { margin: 0; background: #000; }
  .hw { position: relative; width: ${width}px; height: ${height}px; overflow: hidden;
        background: var(--ground-0); }
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

/**
 * One lane, read off the picture, with no idea which lane it is looking at.
 *
 * Both columns go through this. That is the point of the harness and it is what the readback it
 * replaces got wrong: it took the brightest ROW of the playing lane, which is not the strike line
 * but the widest lit band below it, and compared that against the still lane's strike element read
 * off the DOM. Two different questions, one table, and the two columns were never comparable.
 *
 * `rgba` is straight pixels, top row first, four bytes each. The playing lane's come from
 * `readPixels` on the preview's own WebGL canvas and the still lane's from rasterising its SVG
 * into a 2D canvas the same size, so neither has been through a screenshot: `capturePage` lifts
 * black to about 3 and moves every other colour with it, which leaves the surround and the lane's
 * darkest step a hair apart and nothing reliable to threshold on.
 */
function measure(rgba, w, h) {
  const at = (x, y) => {
    const i = (y * w + x) * 4
    return [rgba[i], rgba[i + 1], rgba[i + 2]]
  }
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  const round = (n) => (n === null ? null : Number(n.toFixed(4)))
  /** Anything at all, against a surround that is exactly black in both lanes. */
  const lit = (x, y) => lum(at(x, y)) > 0.5

  /** The topmost row with anything on it, which is the highway plane's own far edge. */
  let horizon = null
  for (let y = 0; y < h && horizon === null; y++) {
    for (let x = 0; x < w; x++) {
      if (lit(x, y)) {
        horizon = y / h
        break
      }
    }
  }

  /** How far across the box the plane reaches at a given fraction down it. */
  const span = (v, threshold = 0.5) => {
    const y = Math.max(0, Math.min(h - 1, Math.round(v * h - 0.5)))
    let lo = -1
    let hi = -1
    for (let x = 0; x < w; x++) {
      if (lum(at(x, y)) > threshold) {
        if (lo < 0) lo = x
        hi = x
      }
    }
    return lo < 0 ? null : [round(lo / w), round((hi + 1) / w)]
  }

  /**
   * Where the strike line is, as the centre of the light around it rather than as one row.
   *
   * Everything the strike line sprite carries is symmetric about it, the bar, the rings and the
   * glow alike, so the bottom of the box has its centre of mass close to the line. It is a
   * comparative number and not the line itself: the lane widens toward the bottom of the window,
   * which pulls the centroid about a pixel below where the geometry puts the line, and the
   * geometric answer is the one `highway.test.ts` pins. What it is good for is that it does not
   * care that one lane is drawn by a rasteriser and the other by a texture minified eight times,
   * which are nothing like equally bright, so the two columns can be compared to a tenth of a
   * pixel.
   */
  const from = Math.floor(h * 0.8)
  const rows = []
  for (let y = from; y < h; y++) {
    let sum = 0
    for (let x = 0; x < w; x++) sum += lum(at(x, y))
    rows.push(sum / w)
  }
  const floor = Math.min(...rows)
  let weight = 0
  let moment = 0
  for (const [i, value] of rows.entries()) {
    weight += value - floor
    moment += (value - floor) * (from + i + 0.5)
  }
  const strikeRow = weight > 0 ? moment / weight : null

  /**
   * How far the strike line itself reaches across the box, which is the lane's own width.
   *
   * Read at the strike line's row against a threshold a quarter of that row's brightest pixel:
   * the bar covers the lane exactly, rail to rail, and outside it that row is apron and then
   * nothing. A fixed threshold would not do for both lanes, because the drawn bar is several
   * times brighter than the rendered one.
   */
  let strikeSpan = null
  if (strikeRow !== null) {
    const y = Math.round(strikeRow - 0.5)
    let max = 0
    for (let x = 0; x < w; x++) max = Math.max(max, lum(at(x, y)))
    strikeSpan = span((y + 0.5) / h, Math.max(4, max * 0.25))
  }

  /**
   * Each fret ring, by its own colour: the contiguous run of columns that carry it.
   *
   * A run around the strongest column and not a centroid over the whole row. A ring is an outline,
   * so its weight is in its two arcs and the midpoint between them is its centre, and warm colours
   * bleed into each other badly enough that a centroid over everything within reach of red lands
   * between the red ring and the orange one.
   *
   * Read at AT_MS=5000, the bar where every lane fires at once, this finds the note sitting on the
   * ring as well, which is the frame that answers whether a fret is under the note that lands in
   * it. Read at rest it finds the ring alone, and in the playing lane that ring has come off a
   * texture minified about eight times: `nearest` is how far the closest pixel got to the fret's
   * own colour, and a ring whose nearest is up near a hundred has been washed into the lane and
   * its run below is noise. What the frets line up with is settled by `noteXs` against
   * `laneCentres`, which is the package's own answer.
   */
  const band = strikeRow === null ? [0, h] : [strikeRow - h * 0.1, strikeRow + h * 0.1]
  const frets = FRET_COLOURS.map((colour) => {
    const want = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16))
    const columns = new Array(w).fill(0)
    let near = Infinity
    for (let y = Math.max(0, Math.ceil(band[0])); y < Math.min(h, band[1]); y++) {
      for (let x = 0; x < w; x++) {
        const c = at(x, y)
        const d = Math.hypot(c[0] - want[0], c[1] - want[1], c[2] - want[2])
        near = Math.min(near, d)
        columns[x] += Math.max(0, 1 - d / RING_TOLERANCE)
      }
    }
    const peak = Math.max(...columns)
    if (peak <= 0) return { cx: null, width: null, nearest: round(near) }
    const at0 = columns.indexOf(peak)
    let lo = at0
    let hi = at0
    for (let x = at0 - 1, miss = 0; x >= 0 && miss <= RING_GAP; x--) {
      if (columns[x] > peak * RING_FLOOR) {
        lo = x
        miss = 0
      } else miss++
    }
    for (let x = at0 + 1, miss = 0; x < w && miss <= RING_GAP; x++) {
      if (columns[x] > peak * RING_FLOOR) {
        hi = x
        miss = 0
      } else miss++
    }
    return {
      cx: round((lo + hi + 1) / 2 / w),
      width: round((hi - lo + 1) / w),
      nearest: round(near)
    }
  })

  /**
   * What a `mix-blend-mode: lighten` scrim of --ground-0 over the box would move.
   *
   * The alternative to painting the still lane's surround black: lift the renderer's black to
   * Encore's recessed step instead of painting Encore's step black. The two numbers are how much
   * of the box it would change and how much of that is not the surround, the second being the
   * cost, because every pixel in it is part of the lane or a note.
   */
  const ground = [0x07, 0x06, 0x10]
  let lifted = 0
  let liftedLit = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = at(x, y)
      if (c.some((v, i) => v < ground[i])) {
        lifted++
        if (c.some((v) => v > 0)) liftedLit++
      }
    }
  }

  return {
    horizon: round(horizon),
    planeSpan: { 0.5: span(0.5), 0.75: span(0.75), 0.9: span(0.9) },
    strikeRow: strikeRow === null ? null : round(strikeRow / h),
    strikeSpan,
    frets,
    corners: [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)].map((c) => round(lum(c))),
    scrim: { lifted: round(lifted / (w * h)), liftedLit: round(liftedLit / (w * h)) }
  }
}

/** The five, so the ring finder knows what it is looking for. Encore's, from `../highway.ts`. */
const FRET_COLOURS = ['#4ade80', '#f87171', '#facc15', '#60a5fa', '#fb923c']
/** How far off a fret's own colour a pixel may be and still count toward that ring. */
const RING_TOLERANCE = 110
/** How faint a column may be, against the ring's strongest, and still be part of the same ring. */
const RING_FLOOR = 0.1
/** How many columns of nothing a ring may have inside it. Its two arcs have the lane between. */
const RING_GAP = 3

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
      const W = ${width}, H = ${height}

      /** A byte array out to the main process, where the measuring is. */
      const b64 = (bytes) => {
        let s = ''
        for (let i = 0; i < bytes.length; i += 4096) {
          s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 4096, bytes.length)))
        }
        return btoa(s)
      }

      window.mountSvelte(window.Highway, { target: document.querySelector('#still .rest') })
      // A frame, because a Svelte component injects its own stylesheet from an effect and the
      // effects of a mount are flushed after it returns. Read any sooner and every rule in the
      // component is missing: the lane is still the right shape, since its geometry is in
      // attributes, and every colour in it is the initial value, which is black.
      await new Promise((r) => requestAnimationFrame(r))

      /**
       * The still lane as pixels, rasterised by the same engine that lays it out.
       *
       * An SVG loaded as an image has no stylesheet, so every computed value the component's own
       * <style> block supplies is written onto the clone first: this is the drawn lane and not a
       * second version of it. Rasterising rather than screenshotting is what keeps the two
       * columns comparable, since a screenshot moves every colour in the page.
       */
      const svg = document.querySelector('#still svg.highway')
      const clone = svg.cloneNode(true)
      const PAINT = [
        'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width',
        'stop-color', 'stop-opacity', 'filter'
      ]
      const inline = (src, dst) => {
        const cs = getComputedStyle(src)
        dst.setAttribute('style', PAINT.map((p) => p + ':' + cs.getPropertyValue(p)).join(';'))
        for (let i = 0; i < src.children.length; i++) inline(src.children[i], dst.children[i])
      }
      inline(svg, clone)
      clone.setAttribute('width', W)
      clone.setAttribute('height', H)
      const url = 'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent(new XMLSerializer().serializeToString(clone))
      const img = new Image()
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('the still lane did not rasterise'))
        img.src = url
      })
      const flat = document.createElement('canvas')
      flat.width = W
      flat.height = H
      const flatCtx = flat.getContext('2d')
      flatCtx.drawImage(img, 0, 0, W, H)
      const still = b64(new Uint8Array(flatCtx.getImageData(0, 0, W, H).data.buffer))

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
      // inside an animation frame and read back in the same one: the drawing buffer is not
      // preserved, so the picture is only there between the draw and the next composite.
      preview.audioManager.lastSeekChartTimeMs = ${atMs}
      await new Promise((r) => requestAnimationFrame(r))
      preview.animateFrame(false)

      const canvas = container.querySelector('canvas')
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      const w = canvas.width, h = canvas.height
      const px = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      // readPixels is bottom-up and the still lane's canvas is not, so this one is turned over
      // here rather than in two readers later.
      const rows = new Uint8Array(px.length)
      for (let y = 0; y < h; y++) {
        rows.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
      }
      const playing = b64(rows)

      // And then keep drawing it, so the compositor has a frame to hand back when the screenshot
      // is taken. The readback above had to come first, for the reason above it.
      const keep = () => {
        preview.animateFrame(false)
        requestAnimationFrame(keep)
      }
      requestAnimationFrame(keep)

      /**
       * Where the package itself put the notes, asked of the package.
       *
       * The layout table in lane-skin.ts is a model of calculateNoteXOffset, which the package
       * does not export, and both lanes hang off it: a fret half a lane out is a fret in the
       * wrong place and no amount of colour fixes it. Reading the x the package gave every note it
       * has on screen is the one check of that model that is not circular. Run at AT_MS=5000, the
       * bar where every lane fires at once, so there is one note per lane to read.
       */
      const noteXs = [
        ...new Set(
          [...preview.notesManager.noteGroups.values()].map((g) => Number(g.position.x.toFixed(4)))
        )
      ].sort((p, q) => p - q)

      const layout = window.laneLayout(type)
      return {
        skinned,
        instrument,
        canvas: [w, h],
        highwayImage: prepared.textures.highwayTexture.image?.tagName ?? null,
        strikeImage: prepared.textures.strikelineTexture.image?.tagName ?? null,
        noteXs,
        laneCentres: layout.centres.map((c) => Number(c.toFixed(4))),
        lanes: layout.centres.length,
        rails: window.laneRails(layout),
        pixels: { still, playing }
      }
      } catch (e) { return { error: String(e && e.stack || e) } }
    })()`
  )

  if (report.error) {
    console.error(report.error)
    app.exit(1)
    return
  }

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

  // A beat, so the frame the page finished drawing is the frame the compositor hands back. The
  // picture is for looking at; nothing below is measured off it.
  await new Promise((r) => setTimeout(r, 400))
  const shot = await win.webContents.capturePage()
  fs.writeFileSync(
    path.join(out, `lane-${instrument}-${skin ? 'skin' : 'package'}-${width}x${height}.png`),
    shot.toPNG()
  )

  const { pixels, ...rest } = report
  if (process.env.DUMP) {
    for (const [name, data] of Object.entries(pixels)) {
      fs.writeFileSync(
        path.join(out, `${name}-${width}x${height}.bin`),
        Buffer.from(data, 'base64')
      )
    }
  }
  const lanes = {
    still: measure(Buffer.from(pixels.still, 'base64'), width, height),
    playing: measure(Buffer.from(pixels.playing, 'base64'), width, height)
  }
  console.log(JSON.stringify({ ...rest, box: [width, height], lanes, motion }, null, 2))
  console.log('images in', out)
  app.quit()
})
