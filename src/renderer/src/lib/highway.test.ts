import { describe, expect, it } from 'vitest'
import {
  HIGHWAY_FRETS,
  HIGHWAY_HEIGHT,
  HIGHWAY_WIDTH,
  highwayDepth,
  highwayShape,
  highwayX
} from './highway'

/**
 * The still lane is the one picture in this app nothing else can check.
 *
 * jsdom applies no CSS and computes no layout, so a component test can say the `<svg>` is there
 * and how many shapes are in it and nothing about where any of them are. The geometry is a pure
 * function precisely so that part can be checked here, to the number, without a browser.
 */
const shape = highwayShape()

describe('the resting highway, as a drawing', () => {
  it('draws five lanes between six rails, with a fret on each', () => {
    expect(HIGHWAY_FRETS).toBe(5)
    expect(shape.lanes).toHaveLength(5)
    expect(shape.rails).toHaveLength(6)
    expect(shape.frets).toHaveLength(5)
  })

  it('keeps every part of the lane inside the box it is drawn in', () => {
    const xs = shape.rails.flatMap((r) => [r.x1, r.x2])
    expect(Math.min(...xs)).toBeGreaterThan(0)
    expect(Math.max(...xs)).toBeLessThan(HIGHWAY_WIDTH)
    // The lane stops short of both edges: a lane touching the top reads as a wall rather than a
    // horizon, and one touching the bottom leaves the frets half outside the frame.
    expect(highwayDepth(0).y).toBeGreaterThan(0)
    const lowest = shape.frets[0].cy + shape.frets[0].ry
    expect(lowest).toBeLessThan(HIGHWAY_HEIGHT)
  })

  /**
   * The claim the whole file rests on, pinned rather than assumed.
   *
   * Both the lane's y and its half-width are affine in the same eased depth, so a boundary's x is
   * affine in its y and four points draw exactly what the design's canvas samples at eighteen.
   * If anyone ever eases the two ends differently this test is what says the rails have stopped
   * being straight and the quads have stopped being the lane.
   */
  it('runs each lane boundary straight, so two points draw what the design samples at eighteen', () => {
    for (const [i, rail] of shape.rails.entries()) {
      for (let s = 1; s < 18; s++) {
        const p = s / 18
        const { half, y } = highwayDepth(p)
        const sampled = highwayX(i - 0.5, half)
        // Where the straight line between the two ends is at that same y.
        const online = rail.x1 + ((rail.x2 - rail.x1) * (y - rail.y1)) / (rail.y2 - rail.y1)
        expect(sampled).toBeCloseTo(online, 9)
      }
    }
  })

  it('eases depth rather than running it flat, which is what makes it a lane', () => {
    const far = highwayDepth(0)
    const near = highwayDepth(1)
    const half = highwayDepth(0.5)
    // Half way down the chart is well short of half way down the box: the far end crowds toward
    // the horizon. A linear depth would put this exactly on the midpoint.
    expect(half.y).toBeLessThan((far.y + near.y) / 2)
    expect(half.half).toBeLessThan((far.half + near.half) / 2)
    // And it still runs the right way: narrow and high at the far end, wide and low at the near.
    expect(far.y).toBeLessThan(near.y)
    expect(far.half).toBeLessThan(near.half)
  })

  it('lays the strike line exactly across the lane at the near end', () => {
    const left = shape.rails[0]
    const right = shape.rails[shape.rails.length - 1]
    expect(shape.strike.x1).toBe(left.x2)
    expect(shape.strike.x2).toBe(right.x2)
    expect(shape.strike.y1).toBe(left.y2)
    expect(shape.strike.y2).toBe(right.y2)
  })

  it('sits every fret on the strike line, centred in its own lane and clear of its neighbour', () => {
    for (const fret of shape.frets) {
      expect(fret.cy).toBe(shape.strike.y1)
      expect(fret.cx - fret.rx).toBeGreaterThan(shape.strike.x1)
      expect(fret.cx + fret.rx).toBeLessThan(shape.strike.x2)
      // Flattened, because the lane is seen from the player's angle and a circle there is not a
      // circle on screen.
      expect(fret.ry).toBeLessThan(fret.rx)
    }
    for (let i = 1; i < shape.frets.length; i++) {
      const gap = shape.frets[i].cx - shape.frets[i - 1].cx
      expect(gap).toBeGreaterThan(shape.frets[i].rx + shape.frets[i - 1].rx)
    }
  })

  it('runs the beat lines from the horizon toward the strike line, each narrower than the last', () => {
    const ys = shape.beats.map((b) => b.y1)
    expect(ys).toHaveLength(4)
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
    for (const beat of shape.beats) {
      expect(beat.y1).toBe(beat.y2)
      expect(beat.y1).toBeGreaterThan(highwayDepth(0).y)
      expect(beat.y1).toBeLessThan(shape.strike.y1)
      // Narrower than the strike line, because they are further away.
      expect(beat.x2 - beat.x1).toBeLessThan(shape.strike.x2 - shape.strike.x1)
      expect((beat.x1 + beat.x2) / 2).toBeCloseTo(HIGHWAY_WIDTH / 2, 9)
    }
  })

  it('writes each lane as the quad between the two rails beside it', () => {
    for (let i = 0; i < shape.lanes.length; i++) {
      const left = shape.rails[i]
      const right = shape.rails[i + 1]
      expect(shape.lanes[i]).toBe(
        `${left.x1},${left.y1} ${right.x1},${right.y1} ${right.x2},${right.y2} ${left.x2},${left.y2}`
      )
    }
  })
})
