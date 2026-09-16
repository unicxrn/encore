/**
 * The shape of the note highway Encore draws while nothing is playing.
 *
 * Not a renderer. `<chart-preview-player>` is the renderer, and the moment a preview opens it
 * takes the box over; this is the still lane underneath it, so that a rail with a chart in it and
 * no preview running shows an instrument waiting rather than a hole. The numbers below are the
 * approved design's own perspective, read off its canvas script, so the still lane and the live
 * one are the same shape of lane rather than two ideas about what a highway looks like.
 *
 * Geometry only, and in a fixed viewBox: an SVG scales itself, so nothing here has to know how
 * wide the rail is, and a pure function of no arguments is a thing a node test can check to the
 * pixel. The component beside it owns every colour.
 */

/** The user-unit box the geometry is drawn in. 16:9, which is the aspect both frames use. */
export const HIGHWAY_WIDTH = 320
export const HIGHWAY_HEIGHT = 180

/**
 * Five lanes, always, whatever the selects above the lane say.
 *
 * Clone Hero draws four for drums and three for the six-fret guitars, and following that here
 * would be a second model of a renderer this app does not own: a hand-kept table of lane counts
 * that goes wrong the first time `chart-preview` changes one. The lane is the frame the track
 * appears in, the badge in the corner is what names the track, and pressing Play replaces this
 * with the real thing for the real instrument. The five colours are still the right five: they
 * are the order `chart-preview` names its five-fret lanes in, which is what guitar, bass, rhythm
 * and keys all load as.
 */
export const HIGHWAY_FRETS = 5

/**
 * How fast the lane runs away from the viewer.
 *
 * Depth is eased rather than linear, so the near end is wide and slow and the far end crowds
 * toward the horizon, which is what makes a flat drawing read as a lane rather than a triangle.
 */
const EASE = 1.95
/** The near and far ends, as fractions of the box: the lane stops short of both edges. */
const FAR_Y = 0.05
const NEAR_Y = 0.845
/** Half the lane's width at each end, as fractions of the box. */
const FAR_HALF = 0.055
const NEAR_HALF = 0.4
/** How much of a half-width one lane takes. The design's number, and what sets the lane's pitch. */
const LANE_PITCH = 2.3

export interface HighwayDepth {
  /** Distance down the box, in user units. */
  y: number
  /** Half the lane's width at that depth, in user units. */
  half: number
}

/** The lane's y and half-width at depth `p`, 0 at the horizon and 1 at the strike line. */
export function highwayDepth(p: number): HighwayDepth {
  const k = Math.pow(p, EASE)
  return {
    y: HIGHWAY_HEIGHT * (FAR_Y + (NEAR_Y - FAR_Y) * k),
    half: HIGHWAY_WIDTH * (FAR_HALF + (NEAR_HALF - FAR_HALF) * k)
  }
}

/**
 * The x of lane boundary `edge` at half-width `half`.
 *
 * `edge` counts boundaries, not lanes: -0.5 is the left rail, 4.5 the right, and a whole number
 * is the middle of the lane with that index.
 */
export function highwayX(edge: number, half: number): number {
  return HIGHWAY_WIDTH / 2 + (edge - (HIGHWAY_FRETS - 1) / 2) * (half / LANE_PITCH)
}

export interface HighwayLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface HighwayFret {
  cx: number
  cy: number
  rx: number
  ry: number
}

export interface HighwayShape {
  /** One quad per lane, far edge first, as an SVG `points` list. */
  lanes: string[]
  /** The six lane boundaries, horizon to strike line. */
  rails: HighwayLine[]
  /** Beat lines across the lane, far to near. */
  beats: HighwayLine[]
  /** The strike line the notes are hit on. */
  strike: HighwayLine
  /** The five fret circles sitting on it. */
  frets: HighwayFret[]
}

/**
 * Where the beat lines sit, as depths.
 *
 * Evenly spaced in depth rather than on screen, so the easing above puts them where a lane
 * running at a constant speed would: crowded at the horizon, open at the strike line.
 */
const BEATS = [0.2, 0.4, 0.6, 0.8]

/** How wide a fret circle is, as a fraction of the lane's pitch at the strike line. */
const FRET_RX = 0.185
/** How flat it is. A circle seen from the player's angle is an ellipse, and this is that angle. */
const FRET_FLATTEN = 0.62

/**
 * Every line and shape the still lane is made of.
 *
 * Straight lines, and that is not an approximation. Both y and half-width are affine in the same
 * eased depth, so a lane boundary's x is affine in its y: the design's canvas samples each edge
 * at eighteen points and every one of them lands on the line through the first and the last.
 */
export function highwayShape(): HighwayShape {
  const far = highwayDepth(0)
  const near = highwayDepth(1)
  const edges = (edge: number): HighwayLine => ({
    x1: highwayX(edge, far.half),
    y1: far.y,
    x2: highwayX(edge, near.half),
    y2: near.y
  })

  const rails: HighwayLine[] = []
  for (let i = 0; i <= HIGHWAY_FRETS; i++) rails.push(edges(i - 0.5))

  const lanes: string[] = []
  for (let i = 0; i < HIGHWAY_FRETS; i++) {
    const left = rails[i]
    const right = rails[i + 1]
    lanes.push(
      `${left.x1},${left.y1} ${right.x1},${right.y1} ${right.x2},${right.y2} ${left.x2},${left.y2}`
    )
  }

  const beats = BEATS.map((p) => {
    const { y, half } = highwayDepth(p)
    return { x1: highwayX(-0.5, half), y1: y, x2: highwayX(HIGHWAY_FRETS - 0.5, half), y2: y }
  })

  const strike: HighwayLine = {
    x1: highwayX(-0.5, near.half),
    y1: near.y,
    x2: highwayX(HIGHWAY_FRETS - 0.5, near.half),
    y2: near.y
  }

  const rx = (near.half / LANE_PITCH) * FRET_RX
  const frets: HighwayFret[] = []
  for (let i = 0; i < HIGHWAY_FRETS; i++) {
    frets.push({ cx: highwayX(i, near.half), cy: near.y, rx, ry: rx * FRET_FLATTEN })
  }

  return { lanes, rails, beats, strike, frets }
}
