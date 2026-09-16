import { describe, expect, it } from 'vitest'
import {
  HIGHWAY_BEATS_PER_TILE,
  HIGHWAY_FRETS,
  HIGHWAY_FRET_COLOURS,
  HIGHWAY_HEIGHT,
  HIGHWAY_LINE_W,
  HIGHWAY_WIDTH,
  highwayDepth,
  highwayProject,
  highwayQuad,
  highwayScale,
  highwayShape
} from './highway'
import { FIVE_FRET, laneLayout, laneRails } from './preview/lane-skin'

/**
 * The still lane is the one picture in this app nothing else can check.
 *
 * jsdom applies no CSS and computes no layout, so a component test can say the `<svg>` is there
 * and how many shapes are in it and nothing about where any of them are. The geometry is a pure
 * function precisely so that part can be checked here, to the number, without a browser.
 *
 * What it cannot check is that the numbers are the package's numbers. That is a question for an
 * engine and `scripts/measure-lane-skin.mjs` is what asks it: it draws this lane and a real
 * `ChartPreview` into two boxes of the same size and prints where each one puts its strike line,
 * its rails and its frets. The claims below are the arithmetic those measurements agreed with.
 */
const lane = laneLayout(FIVE_FRET)
const shape = highwayShape(lane)

/** The lane, in world x, straight from the package's own layout. */
const rails = laneRails(lane)
/** One lane, and the width of a hairline on it. */
const pitch = lane.centres[1] - lane.centres[0]
const lineW = HIGHWAY_LINE_W * pitch

/** A `points` list back into numbers, so a quad can be asked where its corners are. */
const corners = (points: string): { x: number; y: number }[] =>
  points.split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number)
    return { x, y }
  })

/**
 * Where the box's own edges are, for a box of a given aspect.
 *
 * `preserveAspectRatio="xMidYMid slice"` scales the drawing to the box's height and crops the
 * width, so a box of aspect `a` shows the middle `a * HIGHWAY_HEIGHT` user units of it.
 */
const cropped = (aspect: number): { left: number; right: number } => ({
  left: HIGHWAY_WIDTH / 2 - (aspect * HIGHWAY_HEIGHT) / 2,
  right: HIGHWAY_WIDTH / 2 + (aspect * HIGHWAY_HEIGHT) / 2
})

describe('the projection, which is the package camera worked out in advance', () => {
  /**
   * The four numbers the whole drawing hangs off, against the engine.
   *
   * These are what `scripts/measure-lane-skin.mjs` read off a real `ChartPreview` rendering a
   * real chart: the plane's far edge landed on row 77 of a 187 pixel box, its own edge falling
   * at 76.99, and a fret ring's centre on row 170.5 against 170.44. If a future version of
   * chart-preview moves its camera or its plane, these are the numbers that say so, and the lane
   * they draw is off by however much they moved.
   */
  it('puts the horizon and the strike line where the engine puts them', () => {
    expect(highwayProject(0, 0.9).y / HIGHWAY_HEIGHT).toBeCloseTo(0.4116845, 6)
    expect(highwayProject(0, -1).y / HIGHWAY_HEIGHT).toBeCloseTo(0.9113474, 6)
    // The plane's near edge is below the bottom of the box: the lane runs off it rather than
    // stopping short, which is what the renderer draws and what the old flat lane did not.
    expect(highwayProject(0, -1.1).y).toBeGreaterThan(HIGHWAY_HEIGHT)
    // And the horizon is inside it, so there is sky in the box and not just lane.
    expect(highwayProject(0, 0.9).y).toBeGreaterThan(0)
  })

  it('runs away from the viewer: further is deeper, smaller and higher up the box', () => {
    let last = highwayProject(0.5, -1.1)
    for (let y = -1; y <= 0.9; y += 0.1) {
      const here = highwayProject(0.5, y)
      expect(highwayDepth(y)).toBeGreaterThan(highwayDepth(y - 0.1))
      expect(highwayScale(y)).toBeLessThan(highwayScale(y - 0.1))
      expect(here.y).toBeLessThan(last.y)
      // Nearer the centre of the box across, too, because the scale it is multiplied by shrank.
      expect(here.x).toBeLessThan(last.x)
      last = here
    }
  })

  /**
   * The claim the whole file rests on, pinned rather than assumed.
   *
   * It used to be an accident worth checking: the lane's y and its half width were both affine in
   * one eased depth, so a boundary's x came out affine in its y. It is now a theorem, because a
   * perspective projection takes a straight line in the world to a straight line on the screen
   * and every boundary on the plane is straight. The test is the same shape as it was and asks
   * the same question of the projection that replaced the easing: sample a rail at eighteen
   * depths and every sample is on the line through its two ends.
   *
   * What it would catch is the projection stopping being one, which is what a fudge factor
   * anywhere in `highwayProject` would do. That is the reason the quads have four corners.
   */
  it('runs each lane boundary straight, so two points draw what eighteen would', () => {
    for (const rail of rails) {
      const near = highwayProject(rail, -1.1)
      const far = highwayProject(rail, 0.9)
      for (let s = 1; s < 18; s++) {
        const sampled = highwayProject(rail, -1.1 + (2 * s) / 18)
        const online = near.x + ((far.x - near.x) * (sampled.y - near.y)) / (far.y - near.y)
        expect(sampled.x).toBeCloseTo(online, 9)
      }
    }
  })

  it('crowds the far half of the lane into a fraction of the box, which is what makes it a lane', () => {
    const near = highwayProject(0, -1.1).y
    const far = highwayProject(0, 0.9).y
    const half = highwayProject(0, -0.1).y
    // Half way along the plane is well past half way up the picture of it.
    expect(half).toBeLessThan((near + far) / 2)
    // And a lane is a fraction of the width at the horizon that it is at the strike line.
    expect(highwayScale(0.9)).toBeLessThan(highwayScale(-1) / 3)
  })

  it('draws a rectangle of highway as its four projected corners, far edge first', () => {
    const quad = highwayQuad(-0.2, 0.3, -1, 0.5)
    expect(corners(quad)).toEqual([
      highwayProject(-0.2, 0.5),
      highwayProject(0.3, 0.5),
      highwayProject(0.3, -1),
      highwayProject(-0.2, -1)
    ])
  })
})

describe('the resting highway, as a drawing', () => {
  it('draws five lanes between six rails, with a fret on each', () => {
    expect(lane.centres).toHaveLength(HIGHWAY_FRETS)
    expect(shape.lanes).toHaveLength(HIGHWAY_FRETS)
    expect(shape.rails).toHaveLength(HIGHWAY_FRETS + 1)
    expect(shape.frets).toHaveLength(HIGHWAY_FRETS)
    expect(shape.frets.map((f) => f.colour)).toEqual(HIGHWAY_FRET_COLOURS)
  })

  /**
   * The box both places draw this in is 16:9, and the crop is what the drawing's width is for.
   * `Highway.svelte.test.ts` is what holds the two boxes to that aspect.
   */
  it('keeps the whole lane inside the 16:9 box it is cropped to', () => {
    const box = cropped(16 / 9)
    const xs = shape.rails.flatMap((points) => corners(points).map((p) => p.x))
    expect(Math.min(...xs)).toBeGreaterThan(box.left)
    expect(Math.max(...xs)).toBeLessThan(box.right)
    // With room to spare: the lane is the subject of the picture and not the frame of it.
    expect(Math.min(...xs) - box.left).toBeGreaterThan(HIGHWAY_HEIGHT / 4)
  })

  it('lays the plane out to the horizon, with the lane bed inside it', () => {
    const plane = corners(shape.plane)
    const bed = corners(shape.bed)
    // The apron: half a rail of plane either side of the outer rails, all the way down.
    expect(plane[0].x).toBeLessThan(bed[0].x)
    expect(plane[1].x).toBeGreaterThan(bed[1].x)
    expect(plane.map((p) => p.y)).toEqual(bed.map((p) => p.y))
    // Which is the same far edge the lane has, so the horizon is one line and not two.
    expect(plane[0].y).toBe(plane[1].y)
    expect(plane[0].y).toBeCloseTo(highwayProject(0, 0.9).y, 9)
  })

  it('writes each lane as the quad between the two rails beside it', () => {
    for (let i = 0; i < shape.lanes.length; i++) {
      expect(shape.lanes[i]).toBe(highwayQuad(rails[i], rails[i + 1], -1.1, 0.9))
    }
  })

  /**
   * A rail is a mark on the surface, so it narrows with the surface.
   *
   * This is the half of the drawing that a stroke cannot do, and the reason every rail is a quad.
   * Drawn as a stroke it would be the same width at the horizon as at the strike line, which is
   * about three and a half times too heavy.
   */
  it('narrows every rail toward the horizon rather than stroking it one width', () => {
    for (const points of shape.rails) {
      const [farLeft, farRight, nearRight, nearLeft] = corners(points)
      expect(nearRight.x - nearLeft.x).toBeGreaterThan((farRight.x - farLeft.x) * 3)
      expect(farRight.x - farLeft.x).toBeGreaterThan(0)
    }
  })

  it('lays the strike line across the lane at the depth the sprite sits at', () => {
    expect(shape.strike.y1).toBe(shape.strike.y2)
    expect(shape.strike.y1).toBeCloseTo(highwayProject(0, -1).y, 9)
    expect(shape.strike.x1).toBeCloseTo(highwayProject(rails[0], -1).x, 9)
    expect(shape.strike.x2).toBeCloseTo(highwayProject(rails[rails.length - 1], -1).x, 9)
    // Short of the plane's near end rather than on it: the highway carries on past the strike
    // line and off the bottom of the box, which is where the notes that were missed go.
    expect(shape.strike.y1).toBeLessThan(highwayProject(0, -1.1).y)
    expect(shape.strike.width).toBeGreaterThan(0)
  })

  it('sits every fret on the strike line, centred in its own lane and clear of its neighbour', () => {
    for (const [i, fret] of shape.frets.entries()) {
      expect(fret.cy).toBe(shape.strike.y1)
      expect(fret.cx).toBeCloseTo(highwayProject(lane.centres[i], -1).x, 9)
      expect(fret.cx - fret.rx).toBeGreaterThan(shape.strike.x1)
      expect(fret.cx + fret.rx).toBeLessThan(shape.strike.x2)
      // Flattened, because the ring is a circle lying on the lane and the lane is seen from
      // sixty degrees above it.
      expect(fret.ry).toBeLessThan(fret.rx)
    }
    for (let i = 1; i < shape.frets.length; i++) {
      const gap = shape.frets[i].cx - shape.frets[i - 1].cx
      expect(gap).toBeGreaterThan(shape.frets[i].rx + shape.frets[i - 1].rx)
    }
  })

  /**
   * The glow is the strike line's sprite and not a light over the box.
   *
   * The renderer draws it into that sprite, so it is as tall as the sprite and cut off at the
   * sprite's own edges. A wider light over the whole viewport is what the lane used to draw, and
   * it was the most visible thing that changed when a preview opened.
   */
  it('cuts the light over the strike line off at the sprite that carries it', () => {
    expect(shape.glow.cy).toBe(shape.strike.y1)
    expect(shape.glow.rx).toBeGreaterThan(shape.glow.width / 2)
    expect(shape.glow.ry).toBe(shape.glow.height / 2)
    expect(shape.glow.y).toBe(shape.glow.cy - shape.glow.height / 2)
    // Centred on the highway, which is where the renderer centres the sprite: very slightly off
    // the centre of the lane, because the package's own lanes are.
    expect(shape.glow.cx).toBeCloseTo(highwayProject(0, -1).x, 9)
    expect(shape.glow.cx).not.toBeCloseTo((shape.strike.x1 + shape.strike.x2) / 2, 6)
  })

  it('runs the beat lines from the horizon toward the strike line, each narrower than the last', () => {
    expect(shape.beats).toHaveLength(2 * HIGHWAY_BEATS_PER_TILE)
    const rows = shape.beats.map((points) => corners(points))
    const ys = rows.map((c) => c[0].y)
    // Far to near, which is top to bottom of the box.
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
    for (const [i, c] of rows.entries()) {
      const width = c[1].x - c[0].x
      expect(c[0].y).toBeGreaterThan(highwayProject(0, 0.9).y)
      if (i > 0) expect(width).toBeGreaterThan(rows[i - 1][1].x - rows[i - 1][0].x)
      // Edge to edge of the plane at its own depth, which is wider than the lane there: that is
      // how the texture draws them, across the apron and all. A quarter tile in from the far end
      // and then every half tile, which is where the tile puts them when it has not scrolled.
      const y = 0.9 - (i + 0.5) / HIGHWAY_BEATS_PER_TILE + lineW / 2
      expect(c[0].x).toBeCloseTo(highwayProject(-lane.planeWidth / 2, y).x, 9)
      expect(c[1].x).toBeCloseTo(highwayProject(lane.planeWidth / 2, y).x, 9)
      const bed = highwayProject(rails[rails.length - 1], y).x - highwayProject(rails[0], y).x
      expect(width).toBeGreaterThan(bed)
    }
    // The nearest one is short of the strike line, so the four sit on the lane and not under it.
    expect(rows[rows.length - 1][0].y).toBeLessThan(shape.strike.y1)
  })
})
