/**
 * Encore's lane, painted onto the preview `chart-preview` renders.
 *
 * The package ships a game-style highway: a dark ornamented metal panel with five chrome buttons
 * on the strike line. Encore draws its own lane while nothing is playing (`../highway.ts` and the
 * `Highway` component), and pressing Play used to replace that lane with the package's, which is
 * two different pictures of the same thing one button apart. This builds the still lane's look as
 * two canvases and hands them to the renderer in place of the package's art.
 *
 * ── the seam ──
 * `prepareChartData` returns a `textures` object that `ChartPreview.create` then consumes:
 * `highwayTexture` becomes the map of the scrolling highway plane, `strikelineTexture` the map of
 * the strike line sprite, and `noteTextures` the note sprites. Between those two calls the object
 * is ours to edit, and editing it is the whole change: no fork, no patch, and nothing about note
 * timing, audio or the scene graph moves.
 *
 * The note sprites are deliberately left alone. Their colours are the game's own language, they
 * carry star power, HOPO, tap, open and kick in the artwork rather than in the colour, and the
 * still lane already paints Clone Hero's five fret colours, so the package's notes over this lane
 * are the same five colours they were.
 *
 * ── what the renderer expects of each texture ──
 * The highway map is applied to a `PlaneGeometry(planeWidth, 2)` with `wrapS`/`wrapT` set to
 * repeat and `repeat` set to (1, 2), so one tile covers `planeWidth` x 1 world units and the plane
 * shows two of them. Every frame the renderer writes `highwayTexture.offset.y`, which scrolls the
 * tile toward the viewer: anything drawn in it that varies down the tile MOVES, and anything whose
 * top edge does not match its bottom one shows a seam twice a second. That is why the ground here
 * is flat and the only horizontal marks are the beat lines, evenly spaced so the tile meets itself.
 *
 * The strike line map is applied to a `THREE.Sprite`, which is a billboard: it faces the camera
 * rather than lying on the highway, and the renderer sizes it from the image's own aspect ratio
 * (`aspect * 0.19` world units wide by `0.19` tall, and 0.141 for the six-fret guitars). So the
 * canvas's aspect ratio is what places the frets in the lane, and a circle that is meant to read
 * as lying flat on the highway has to be drawn already flattened.
 *
 * ── why the textures are edited rather than replaced ──
 * `THREE.Texture` is the package's class from the package's copy of three, and Encore does not
 * depend on three. Swapping the `image` of the texture the package already built keeps the wrap
 * mode, the repeat, the offset the renderer animates and the class identity all exactly as the
 * package set them, and leaves one thing changed, which is the picture.
 */

import { HIGHWAY_FRET_COLOURS } from '../highway'

/**
 * What colour a fret is, per instrument type.
 *
 * Five-fret guitars take the five in the order the still lane draws them, which is the order the
 * package names its lanes in. Four-lane drums are red, yellow, blue and green, in that order, and
 * not the guitar's first four: `calculateLane` in the package puts the red drum in lane 0 and the
 * green one in lane 3, and the package's own drum strike line is those four rings.
 *
 * The six-fret guitars have no fret colours at all. Their three lanes are a black and a white fret
 * together, their notes are drawn black and white, and the package's own six-fret strike line is a
 * neutral bar with three plain segments. Colouring them would invent a language the instrument
 * does not have, so they are white: no colour, said in the drawing rather than left out of it.
 */
const DRUM_FRETS = [
  HIGHWAY_FRET_COLOURS[1],
  HIGHWAY_FRET_COLOURS[2],
  HIGHWAY_FRET_COLOURS[3],
  HIGHWAY_FRET_COLOURS[0]
]
const SIX_FRET_FRETS = ['#ffffff', '#ffffff', '#ffffff']

/**
 * `instrumentTypes` from scan-chart, which `chart-preview` re-exports. Repeated as a type rather
 * than imported as one so this module stays importable in a node test; the caller passes the value
 * the package itself returned from `getInstrumentType`.
 */
export const SIX_FRET = 0
export const FIVE_FRET = 1
export const DRUMS = 2

/**
 * Where the package puts a lane, in the world units its scene is built in.
 *
 * These are `calculateNoteXOffset`, `addHighwayToScene` and `addStrikelineToScene` in
 * chart-preview 1.3.0, read out of `dist/index.mjs`, because none of the three is exported. A lane
 * is at `leftOffset - NOTE_SPAN_WIDTH / 2 + SCALE + PITCH * lane` with `SCALE` 0.105 and
 * `NOTE_SPAN_WIDTH` 0.95, and the highway plane under it is 1, 0.9 or 0.7 wide by instrument type.
 *
 * This is the one place in Encore that models the package's interior, and the reason it is worth
 * it is that there is no other way to line anything up with the notes: the package places those
 * itself and tells nobody where. The failure mode if a future version moves them is bounded and
 * visible rather than silent: the lane stripes and the frets drift off the notes, which are still
 * drawn in the right place by the package, and nothing stops playing.
 */
const SCALE = 0.105
const NOTE_SPAN_WIDTH = 0.95
/** One lane's width. The package's own step between two neighbouring lanes. */
const PITCH = (NOTE_SPAN_WIDTH - SCALE) / 5

export interface LaneLayout {
  /** How wide the highway plane is, and so how wide one tile of the highway texture is. */
  planeWidth: number
  /** Lane centres in world x, left to right. */
  centres: number[]
  /** The strike line sprite's height in world units, which the renderer fixes by type. */
  strikeHeight: number
  /** The fret colours for those lanes, left to right. */
  frets: string[]
}

/** The layout for one of the package's three instrument types. */
export function laneLayout(instrumentType: number): LaneLayout {
  const lanes = instrumentType === DRUMS ? 4 : instrumentType === SIX_FRET ? 3 : 5
  const leftOffset = instrumentType === DRUMS ? 0.135 : instrumentType === SIX_FRET ? 0.2 : 0.035
  const first = leftOffset - NOTE_SPAN_WIDTH / 2 + SCALE
  return {
    planeWidth: instrumentType === DRUMS ? 0.9 : instrumentType === SIX_FRET ? 0.7 : 1,
    centres: Array.from({ length: lanes }, (_, i) => first + PITCH * i),
    strikeHeight: instrumentType === SIX_FRET ? 0.141 : 0.19,
    frets:
      instrumentType === DRUMS
        ? DRUM_FRETS
        : instrumentType === SIX_FRET
          ? SIX_FRET_FRETS
          : HIGHWAY_FRET_COLOURS.slice(0, lanes)
  }
}

/** The lane boundaries, in world x: one more than there are lanes. */
export function laneRails(layout: LaneLayout): number[] {
  return Array.from(
    { length: layout.centres.length + 1 },
    (_, i) => layout.centres[0] - PITCH / 2 + PITCH * i
  )
}

/**
 * The colours the two lanes share, read out of the running document.
 *
 * Read rather than repeated: tokens.css is the one source for Encore's scale, and a second copy of
 * four hex values here is a second source the first time one of them is retuned. `getComputedStyle`
 * is what resolves a custom property, so this only answers inside a document that has the
 * stylesheet in it; everywhere else it throws and the caller keeps the package's art.
 */
export interface LaneColours {
  /** --ground-0, the recessed plane: the lane's floor. */
  ground: string
  /** --ground-3, the card step: the near end of the floor, and the lane's lift. */
  groundNear: string
  /** --accent, on the two outer rails and in the light over the strike line. */
  accent: string
  /** --accent-tint, the strike line itself. */
  accentTint: string
}

const TOKENS: Record<keyof LaneColours, string> = {
  ground: '--ground-0',
  groundNear: '--ground-3',
  accent: '--accent',
  accentTint: '--accent-tint'
}

export function laneColours(doc: Document): LaneColours {
  const view = doc.defaultView
  if (!view?.getComputedStyle) throw new Error('lane skin: no window to resolve tokens against')
  const style = view.getComputedStyle(doc.documentElement)
  const out = {} as LaneColours
  for (const [key, token] of Object.entries(TOKENS) as [keyof LaneColours, string][]) {
    const value = style.getPropertyValue(token).trim()
    if (value === '') throw new Error(`lane skin: ${token} is not declared`)
    out[key] = value
  }
  return out
}

/**
 * `#8b5cf6` at `alpha`.
 *
 * Every colour step in tokens.css is declared as a hex literal and `tokens.test.ts` is what holds
 * them that way, so this throws on anything else rather than producing a colour string the canvas
 * would silently ignore and draw black for.
 */
function fade(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`lane skin: ${hex} is not a hex colour`)
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * The still lane's own values, which is what makes the two lanes one lane.
 *
 * Every number here is the matching rule in `Highway.svelte`, converted from that component's
 * 320x180 viewBox into a fraction of a lane's width so it means the same thing at this scale.
 */
/** The lane floor, in two values a hair apart, so the lanes read as a gradient in brightness. */
const LANE_FILL = ['rgba(255, 255, 255, 0.006)', 'rgba(255, 255, 255, 0.018)']
/** Rails and beat lines. */
const LINE = 'rgba(255, 255, 255, 0.05)'
/** The outer two rails, which carry the lane's edge in the app's own colour. */
const EDGE_ALPHA = 0.3
/** A rail's width, as a fraction of a lane. The component's 1 unit against a 55.65 unit lane. */
const RAIL_W = 1 / 55.65
/** The strike line's, from the same pair: 2.2 units across the same lane. */
const STRIKE_W = 2.2 / 55.65

/**
 * How many beat lines one tile carries.
 *
 * The still lane draws four across a lane two tiles deep, so two to a tile is the same spacing,
 * and an even division is what lets the tile meet itself when the renderer scrolls it. They are
 * decoration and not beats: the renderer scrolls this texture at 1.35 world units a second while
 * the notes travel at 1.333, so anything in it drifts against the music by about one part in
 * eighty. Four lines a lane is what the resting picture shows, and that is all this claims.
 */
const BEATS_PER_TILE = 2

/** Resolution. One tile is a lane's depth, so height is the axis that carries the beat lines. */
const TILE_PX = 512

/**
 * The highway floor: one tile of lane, drawn so that its top edge meets its bottom one.
 *
 * The still lane's ground runs --ground-0 at the horizon to --ground-3 at the strike line, and
 * that gradient cannot come across: the renderer scrolls this texture past the camera, so anything
 * that varies down the tile runs down the lane twice a second. The depth that gradient was
 * imitating is drawn here by a real perspective camera instead, and the two steps it spans are
 * spent across the lane rather than down it: the lane itself is the lifted step and the apron
 * outside the rails is the recessed one.
 */
export function drawHighwayTile(
  canvas: HTMLCanvasElement,
  layout: LaneLayout,
  colours: LaneColours
): void {
  const w = Math.round(TILE_PX * layout.planeWidth)
  canvas.width = w
  canvas.height = TILE_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('lane skin: no 2d context')

  const x = (world: number): number => (0.5 + world / layout.planeWidth) * w
  const rails = laneRails(layout)
  const railW = Math.max(1, RAIL_W * PITCH * TILE_PX)

  ctx.fillStyle = colours.ground
  ctx.fillRect(0, 0, w, TILE_PX)
  ctx.fillStyle = colours.groundNear
  ctx.fillRect(x(rails[0]), 0, x(rails[rails.length - 1]) - x(rails[0]), TILE_PX)

  for (let i = 0; i < layout.centres.length; i++) {
    ctx.fillStyle = LANE_FILL[i % 2]
    ctx.fillRect(x(rails[i]), 0, x(rails[i + 1]) - x(rails[i]), TILE_PX)
  }

  // Beat lines before the rails, so a rail crosses one rather than being broken by it.
  ctx.fillStyle = LINE
  for (let i = 0; i < BEATS_PER_TILE; i++) {
    // Offset by half a step, so no beat line lands on the tile's own edge and gets split in two
    // by the wrap.
    const y = ((i + 0.5) / BEATS_PER_TILE) * TILE_PX
    ctx.fillRect(0, y - railW / 2, w, railW)
  }

  for (const [i, rail] of rails.entries()) {
    const edge = i === 0 || i === rails.length - 1
    ctx.fillStyle = edge ? fade(colours.accent, EDGE_ALPHA) : LINE
    ctx.fillRect(x(rail) - railW / 2, 0, railW, TILE_PX)
  }
}

/** How wide a fret ring is, as a fraction of a lane. See `drawStrikeline`. */
const FRET_RX = 0.44
/** How flat it is: the angle the package's camera looks at the highway from is 60 degrees. */
const FRET_FLATTEN = 0.5
/** The ring's outline, on the same scale as the strike line it sits on. */
const FRET_STROKE_W = STRIKE_W
/** The light over the strike line, as a fraction of a lane. The still lane's radial gradient. */
const GLOW_R = 3.4
const GLOW_ALPHA = 0.16

/** Resolution across the strike line. Its height falls out of the aspect the renderer needs. */
const STRIKE_PX = 1024

/**
 * The strike line and the five frets on it, as the sprite the renderer billboards at the lane's
 * near end.
 *
 * The canvas is sized so that its aspect ratio, times the height the renderer fixes by instrument
 * type, is exactly the lane's full width: that is the only handle on where anything in this image
 * lands, because the renderer centres the sprite on the highway and scales it from the image.
 *
 * The ring is `FRET_RX` of a lane wide where the still lane's is 0.185, and that is the one number
 * of the still lane's this does not keep. A ring at 0.185 is a third of the width of the note that
 * lands in it, so every note would cover its own fret and half the lane either side; the resting
 * lane has no notes and can draw the button small. The ring is drawn at the width of the package's
 * note sprite instead, which is what a fret on a strike line is for.
 */
export function drawStrikeline(
  canvas: HTMLCanvasElement,
  layout: LaneLayout,
  colours: LaneColours
): void {
  const rails = laneRails(layout)
  // Symmetric about the highway's centre, because the sprite is centred on it and cannot be
  // placed anywhere else. The lanes are very slightly off centre in the package's own layout, so
  // this spans the wider of the two sides and overhangs the other by a fraction of a rail.
  const halfWidth = Math.max(-rails[0], rails[rails.length - 1])
  const h = Math.round((STRIKE_PX * layout.strikeHeight) / (2 * halfWidth))
  canvas.width = STRIKE_PX
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('lane skin: no 2d context')

  /** World x to canvas px. The sprite's own half-width is what u = 0 and u = 1 mean. */
  const px = STRIKE_PX / (2 * halfWidth)
  const x = (world: number): number => (world + halfWidth) * px
  const midY = h / 2

  // The light over the strike line, which is where a player is looking. The still lane's glow,
  // drawn into this sprite rather than over the whole viewport, which would sit over the notes.
  // Squashed to the sprite's own height so it reaches zero at the top and bottom edges: a radial
  // gradient still at 10% where the image ends is a hard horizontal seam across the lane.
  const glowR = GLOW_R * PITCH * px
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR)
  glow.addColorStop(0, fade(colours.accent, GLOW_ALPHA))
  glow.addColorStop(1, fade(colours.accent, 0))
  ctx.save()
  ctx.translate(x(0), midY)
  ctx.scale(1, midY / glowR)
  ctx.fillStyle = glow
  ctx.fillRect(-glowR, -glowR, glowR * 2, glowR * 2)
  ctx.restore()

  const rx = FRET_RX * PITCH * px
  const ry = rx * FRET_FLATTEN
  const strokeW = Math.max(1, FRET_STROKE_W * PITCH * px)

  // The strike line, lit. `shadowBlur` is the sprite's own drop shadow: the component declares
  // `filter: drop-shadow(0 0 5px var(--accent))` on the same line, and this is that.
  ctx.save()
  ctx.shadowColor = colours.accent
  ctx.shadowBlur = strokeW * 2.5
  ctx.fillStyle = fade(colours.accentTint, 0.9)
  ctx.fillRect(x(rails[0]), midY - strokeW / 2, x(rails[rails.length - 1]) - x(rails[0]), strokeW)
  ctx.restore()

  // Outlined and not filled. A filled fret is what a hit note looks like, and the sprite is under
  // every note the chart has: filling these would light all five for the length of the song.
  for (const [i, centre] of layout.centres.entries()) {
    ctx.beginPath()
    ctx.ellipse(x(centre), midY, rx, ry, 0, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.fill()
    ctx.lineWidth = strokeW
    ctx.strokeStyle = layout.frets[i]
    ctx.stroke()
  }
}

/**
 * What `prepareChartData` hands back, in the two fields this touches.
 *
 * Structural rather than the package's own type: everything here needs is an object with an
 * `image` it can replace and a `needsUpdate` it can raise, and saying that is what lets a node
 * test hand it a plain object.
 */
export interface SkinnableTexture {
  image: unknown
  needsUpdate: boolean
  anisotropy?: number
}
export interface SkinnableTextures {
  highwayTexture: SkinnableTexture
  strikelineTexture: SkinnableTexture
}

/**
 * Anisotropic filtering on the highway, which is the one thing this asks of the renderer.
 *
 * The lane runs to a horizon, so its far end is sampled at a steep angle and a rail there is a
 * mip average of rail and floor, which is to say nothing. three clamps this to whatever the
 * context supports, so a value the machine cannot give is a smaller value and not a failure.
 */
const HIGHWAY_ANISOTROPY = 8

/**
 * Paints Encore's lane over the package's, in place.
 *
 * Returns whether it did. Everything here is best effort on purpose: a missing 2d context, a
 * document without tokens in it, a future package version that stops handing these back. A
 * preview that plays the package's highway is a preview that plays, and that is worth more than
 * the skin.
 */
export function skinLaneTextures(
  textures: SkinnableTextures | null | undefined,
  instrumentType: number,
  doc: Document | null | undefined
): boolean {
  if (!textures?.highwayTexture || !textures.strikelineTexture || !doc) return false
  try {
    const colours = laneColours(doc)
    const layout = laneLayout(instrumentType)
    const highway = doc.createElement('canvas')
    const strikeline = doc.createElement('canvas')
    drawHighwayTile(highway, layout, colours)
    drawStrikeline(strikeline, layout, colours)
    textures.highwayTexture.image = highway
    textures.highwayTexture.anisotropy = HIGHWAY_ANISOTROPY
    textures.highwayTexture.needsUpdate = true
    textures.strikelineTexture.image = strikeline
    textures.strikelineTexture.needsUpdate = true
    return true
  } catch {
    return false
  }
}
