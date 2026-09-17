/**
 * The shape of the note highway Encore draws while nothing is playing.
 *
 * Not a renderer. `<chart-preview-player>` is the renderer, and the moment a preview opens it
 * takes the box over; this is the still lane underneath it, so that a rail with a chart in it and
 * no preview running shows an instrument waiting rather than a hole.
 *
 * The lane is the package's lane, projected the way the package's camera projects it, so pressing
 * Play swaps one picture for the same picture. `preview/lane-skin.ts` already paints Encore's art
 * into the textures the package renders; what this adds is the other half of that, which is the
 * frame the art is seen in. Everything below is read out of chart-preview 1.3.0's own source
 * (`dist/index.mjs`, and `src/ChartPreview.ts` beside it): the camera, the highway plane and the
 * strike line sprite are all things the package places and tells nobody about, so the numbers are
 * copied and the arithmetic is Encore's.
 *
 * Geometry in a fixed viewBox, plus the one set of colours that is not Encore's. A pure function
 * of the lane it is asked to draw is a thing a node test can check to the pixel, and the box's
 * own aspect ratio stays out of it: see `HIGHWAY_WIDTH` for how. Every other colour belongs to
 * the component.
 */

/**
 * The user-unit box the geometry is drawn in, and what its two numbers mean.
 *
 * The height is the drawn box's height. `preserveAspectRatio="xMidYMid slice"` on the `<svg>`
 * scales this box until it covers the drawn one and centres it, so while the drawn box is no
 * wider than this one, the scale is set by the height alone and the width is simply cropped.
 * That is what lets every number below be a constant: the package's camera has a 90 degree
 * VERTICAL field of view and takes its aspect from the container, so a world length covers the
 * same fraction of the box's height whatever the box's aspect is, and only the crop changes.
 *
 * The width is therefore not the box's width but the widest box this drawing covers, 4:1. A box
 * wider than that would be covered by scaling to its width instead, and the whole lane would sit
 * too low. Both boxes that draw this are 16:9, which `Highway.svelte.test.ts` holds them to.
 */
export const HIGHWAY_HEIGHT = 180
export const HIGHWAY_WIDTH = 720

/**
 * Five lanes, always, whatever the selects above the lane say.
 *
 * Clone Hero draws four for drums and three for the six-fret guitars, and the component hands
 * this module the package's five-fret lane either way. Picking the lane to match the selects
 * would be a picture that changes shape while nothing is playing; the lane is the frame the track
 * appears in, the badge in the corner is what names the track, and pressing Play replaces this
 * with the real thing for the real instrument. Five is also the right five for most of what
 * plays: guitar, bass, rhythm and keys all load as a five-fret lane.
 */
export const HIGHWAY_FRETS = 5

/**
 * Clone Hero's five frets, in the order `chart-preview` names its five-fret lanes: green, red,
 * yellow, blue, orange.
 *
 * Values rather than custom properties, and here rather than in tokens.css, because they name the
 * buttons on a controller and not anything in Encore's palette. The red in particular is the
 * guitar's second fret and not --danger: drawn from that token it would be the app's error colour
 * saying something it does not mean, and it would move the day the error colour is retuned.
 * tokens.css is the one source for the scale, and the way to keep that true is to declare a colour
 * that is not in the scale as what it is instead of inventing a token for it.
 *
 * Here rather than in the component because the still lane is no longer the only thing that paints
 * them: `preview/lane-skin.ts` draws the same five onto the strike line the playing preview
 * renders, and two lists would be two sets of frets the first time one of them was retuned.
 */
export const HIGHWAY_FRET_COLOURS = ['#4ade80', '#f87171', '#facc15', '#60a5fa', '#fb923c']

/**
 * The marks on the lane, as fractions of one lane's width.
 *
 * Shared with `preview/lane-skin.ts`, which draws these same marks into the textures the playing
 * preview renders. One number each rather than one here and one there: a rail retuned on one side
 * of the swap and not the other is a rail that jumps when a user presses Play, which is the whole
 * defect this module exists to keep out.
 */
/** A rail or a beat line. A hairline: a lane is about 56 of these across. */
export const HIGHWAY_LINE_W = 1 / 55.65
/** The strike line itself, and the outline of a fret ring. */
export const HIGHWAY_STRIKE_W = 2.2 / 55.65
/** Half a fret ring, which is about as wide as the note that lands in it. */
export const HIGHWAY_FRET_RX = 0.44
/** How flat a ring is: a circle lying on the highway, seen from 60 degrees above it. */
export const HIGHWAY_FRET_FLATTEN = 0.5
/** The light over the strike line, which is where a player is looking. */
export const HIGHWAY_GLOW_R = 3.4
export const HIGHWAY_GLOW_ALPHA = 0.16

/**
 * How many beat lines one tile of the highway texture carries.
 *
 * The texture repeats twice over the plane, so this many times two is what the lane shows. They
 * are decoration and not beats, and while a preview plays the renderer scrolls them; this module
 * draws them where the tile sits at offset zero, which is where the texture starts.
 */
export const HIGHWAY_BEATS_PER_TILE = 2

/**
 * The lane to draw, in the world units the package's scene is built in.
 *
 * `laneLayout` in `preview/lane-skin.ts` is what produces one, from the package's own lane
 * arithmetic. Declared here and imported there rather than the other way round, so that this
 * module depends on nothing.
 */
export interface HighwayLane {
  /** How wide the highway plane is. The lane sits on it with an apron either side. */
  planeWidth: number
  /** Lane centres in world x, left to right. Evenly spaced, which is where the pitch comes from. */
  centres: number[]
  /** The strike line sprite's height in world units, which the renderer fixes by instrument type. */
  strikeHeight: number
  /** The fret colours for those lanes, left to right. */
  frets: string[]
}

/**
 * chart-preview 1.3.0's camera: `ChartCamera`, a `THREE.PerspectiveCamera`.
 *
 * 90 degrees of vertical field of view at (0, -1.3, 0.8), pitched 60 degrees so it looks down and
 * along the highway. `aspect` is the container's, and it scales x alone: tan(45 degrees) is 1, so
 * a point's height on screen is its height in camera space over its depth, and its offset across
 * the screen is that same ratio divided by the aspect. Measured in the box's HEIGHT, then, both
 * axes are the same simple ratio and the aspect drops out. That is the projection this module
 * implements, and the reason it can hold still while the box changes shape.
 */
const CAMERA_Y = -1.3
const CAMERA_Z = 0.8
const CAMERA_PITCH = Math.PI / 3
const SIN_PITCH = Math.sin(CAMERA_PITCH)
const COS_PITCH = Math.cos(CAMERA_PITCH)

/**
 * The highway plane: `PlaneGeometry(planeWidth, 2)` at y = -0.1, on z = 0, from
 * `addHighwayToScene`.
 *
 * Finite, which is the thing a flat drawing of a lane gets wrong. Its far edge is a horizon
 * partway down the box with nothing above it but the colour the renderer clears to, and its near
 * edge is below the bottom of the box, so the lane runs off the bottom rather than stopping.
 */
const PLANE_NEAR_Y = -1.1
const PLANE_FAR_Y = 0.9

/**
 * How many times the highway texture repeats over the plane, from the `repeat` the package sets
 * on it. One tile is therefore half the plane deep, and the plane shows two of them.
 */
const TEXTURE_REPEAT = 2

/** Where `addStrikelineToScene` puts the strike line sprite. */
const STRIKE_Y = -1

/** How far in front of the camera a point at `y` on the highway plane is. */
export function highwayDepth(y: number): number {
  return SIN_PITCH * (y - CAMERA_Y) + COS_PITCH * CAMERA_Z
}

/**
 * User units per world unit at that depth, across the lane and down the box alike.
 *
 * One number for both axes because the sprite the strike line is drawn on is a billboard: it
 * faces the camera, so what is drawn in it is scaled and never foreshortened.
 */
export function highwayScale(y: number): number {
  return HIGHWAY_HEIGHT / (2 * highwayDepth(y))
}

export interface HighwayPoint {
  x: number
  y: number
}

/** Where a point on the highway plane lands in the box. */
export function highwayProject(x: number, y: number): HighwayPoint {
  const scale = highwayScale(y)
  // How far above the camera's own axis the point is, which is what the vertical divides.
  const up = COS_PITCH * (y - CAMERA_Y) - SIN_PITCH * CAMERA_Z
  return { x: HIGHWAY_WIDTH / 2 + x * scale, y: HIGHWAY_HEIGHT / 2 - up * scale }
}

/**
 * A rectangle of highway, projected: an SVG `points` list, far edge first.
 *
 * Everything drawn on the plane is one of these, including the rails and the beat lines, which
 * are rectangles the width of a line rather than strokes. A stroke is one width along its whole
 * length and a rail is not: it is a mark on a surface running away from the viewer, so it narrows
 * with everything else. Drawn as a stroke it would be several times too heavy at the horizon.
 */
export function highwayQuad(x0: number, x1: number, y0: number, y1: number): string {
  const corners = [
    highwayProject(x0, y1),
    highwayProject(x1, y1),
    highwayProject(x1, y0),
    highwayProject(x0, y0)
  ]
  return corners.map((p) => `${p.x},${p.y}`).join(' ')
}

export interface HighwayEllipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

export interface HighwayFret extends HighwayEllipse {
  colour: string
}

export interface HighwayStrike {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Stroked rather than filled, so the width is the line's own. */
  width: number
}

export interface HighwayGlow extends HighwayEllipse {
  /**
   * The sprite the glow is drawn in, which is narrower than the glow and therefore cuts it off.
   * Drawn as the sprite's rectangle filled with the gradient, which is what the renderer shows.
   */
  x: number
  y: number
  width: number
  height: number
}

export interface HighwayShape {
  /** The highway plane, far edge first: the apron the lane sits on. */
  plane: string
  /** The lane floor, between the outer two rails. */
  bed: string
  /** One quad per lane. */
  lanes: string[]
  /** The lane boundaries, one more than there are lanes. */
  rails: string[]
  /** Beat lines across the plane, far to near. */
  beats: string[]
  /** The strike line the notes are hit on. */
  strike: HighwayStrike
  /** The light over it. */
  glow: HighwayGlow
  /** The fret rings sitting on it. */
  frets: HighwayFret[]
}

/**
 * Every line and shape the still lane is made of.
 *
 * Straight lines, and that is not an approximation: a perspective projection takes a straight line
 * in the world to a straight line on the screen, and every boundary here is straight on the plane.
 * So four corners draw a rail exactly, however many points anyone samples it at.
 */
export function highwayShape(lane: HighwayLane): HighwayShape {
  const pitch = lane.centres[1] - lane.centres[0]
  const rails = [
    ...lane.centres.map((c) => c - pitch / 2),
    lane.centres[lane.centres.length - 1] + pitch / 2
  ]
  const outer = [rails[0], rails[rails.length - 1]]
  const planeHalf = lane.planeWidth / 2
  const lineW = HIGHWAY_LINE_W * pitch

  const deep = (x0: number, x1: number): string => highwayQuad(x0, x1, PLANE_NEAR_Y, PLANE_FAR_Y)

  const beats: string[] = []
  const tileDepth = (PLANE_FAR_Y - PLANE_NEAR_Y) / TEXTURE_REPEAT
  for (let i = 0; i < TEXTURE_REPEAT * HIGHWAY_BEATS_PER_TILE; i++) {
    // Half a step in, so no beat line lands on the tile's own edge: the tile has to meet itself
    // when the renderer scrolls it, and this is where that puts them.
    const y = PLANE_FAR_Y - ((i + 0.5) * tileDepth) / HIGHWAY_BEATS_PER_TILE
    // Edge to edge of the plane rather than of the lane, which is how wide the texture draws them.
    beats.push(highwayQuad(-planeHalf, planeHalf, y - lineW / 2, y + lineW / 2))
  }

  // Everything on the strike line is on the sprite, so it is all at one depth and one scale.
  const scale = highwayScale(STRIKE_Y)
  const y = highwayProject(0, STRIKE_Y).y
  const at = (x: number): number => highwayProject(x, STRIKE_Y).x
  const strikeW = HIGHWAY_STRIKE_W * pitch * scale
  // The sprite is centred on the highway and cannot be placed anywhere else, so it spans the
  // wider of the two sides of the lane: the package's lanes are very slightly off centre.
  const spriteHalf = Math.max(-outer[0], outer[1]) * scale
  const spriteHalfHeight = (lane.strikeHeight / 2) * scale
  const rx = HIGHWAY_FRET_RX * pitch * scale

  return {
    plane: deep(-planeHalf, planeHalf),
    bed: deep(outer[0], outer[1]),
    lanes: lane.centres.map((_, i) => deep(rails[i], rails[i + 1])),
    rails: rails.map((r) => deep(r - lineW / 2, r + lineW / 2)),
    beats,
    strike: { x1: at(outer[0]), y1: y, x2: at(outer[1]), y2: y, width: strikeW },
    glow: {
      cx: at(0),
      cy: y,
      rx: HIGHWAY_GLOW_R * pitch * scale,
      // As tall as the sprite, which is how the gradient is drawn into it: a radial gradient
      // still lit where the image ends is a hard horizontal seam across the lane.
      ry: spriteHalfHeight,
      x: at(0) - spriteHalf,
      y: y - spriteHalfHeight,
      width: spriteHalf * 2,
      height: spriteHalfHeight * 2
    },
    frets: lane.centres.map((c, i) => ({
      cx: at(c),
      cy: y,
      rx,
      ry: rx * HIGHWAY_FRET_FLATTEN,
      colour: lane.frets[i]
    }))
  }
}
