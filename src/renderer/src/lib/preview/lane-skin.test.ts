import { describe, expect, it } from 'vitest'
import {
  makeFakeCanvas,
  makeFakeDocument,
  FAKE_TOKENS
} from '../../../../../test/helpers/fake-canvas'
import {
  DRUMS,
  FIVE_FRET,
  SIX_FRET,
  drawHighwayTile,
  drawStrikeline,
  laneColours,
  laneLayout,
  laneRails,
  skinLaneTextures
} from './lane-skin'
import { HIGHWAY_FRET_COLOURS } from '../highway'

/**
 * What these can check, and what the harness checks instead.
 *
 * Nothing here has a canvas, a WebGL context or a stylesheet: the node project is node and the
 * renderer project is jsdom, and neither draws anything. So every claim in this file is
 * arithmetic: where a fret lands in its lane, how wide the strike line sprite has to be for the
 * renderer to place it across the lane, that a failure anywhere leaves the package's own art in
 * place. Everything about how the lane LOOKS is measured by `scripts/measure-lane-skin.mjs` in a
 * real engine, and the numbers it printed are in the commit that added it.
 */

/** The package's own lane step, recomputed here rather than imported, so a drift in it is red. */
const PITCH = (0.95 - 0.105) / 5

describe('the lane the package draws in', () => {
  /**
   * The layout is a model of chart-preview's interior, which is the one thing in this change that
   * can rot without anyone noticing. These are the numbers `calculateNoteXOffset` produces in
   * 1.3.0, written out so that a version that moves them is a failing test rather than a lane
   * whose stripes are half a fret off the notes.
   */
  it('puts a five-fret lane where the package puts its five-fret notes', () => {
    const layout = laneLayout(FIVE_FRET)
    expect(layout.planeWidth).toBe(1)
    expect(layout.strikeHeight).toBe(0.19)
    expect(layout.centres.map((c) => Number(c.toFixed(4)))).toEqual([
      -0.335, -0.166, 0.003, 0.172, 0.341
    ])
    expect(layout.frets).toEqual(HIGHWAY_FRET_COLOURS)
  })

  it('puts a four-lane drum kit where the package puts its drums', () => {
    const layout = laneLayout(DRUMS)
    expect(layout.planeWidth).toBe(0.9)
    expect(layout.centres.map((c) => Number(c.toFixed(4)))).toEqual([-0.235, -0.066, 0.103, 0.272])
    // Red, yellow, blue, green: the package's `calculateLane` puts the red drum in lane 0 and the
    // green one in lane 3, which is not the guitar's first four colours.
    expect(layout.frets).toEqual([
      HIGHWAY_FRET_COLOURS[1],
      HIGHWAY_FRET_COLOURS[2],
      HIGHWAY_FRET_COLOURS[3],
      HIGHWAY_FRET_COLOURS[0]
    ])
  })

  it('draws three lanes for a six-fret guitar, on the narrower highway it gets', () => {
    const layout = laneLayout(SIX_FRET)
    expect(layout.planeWidth).toBe(0.7)
    // The renderer scales this instrument's strike line sprite to 0.141 rather than 0.19.
    expect(layout.strikeHeight).toBe(0.141)
    expect(layout.centres.map((c) => Number(c.toFixed(4)))).toEqual([-0.17, -0.001, 0.168])
    // And no fret colours, because the instrument has none: its notes are black and white and the
    // package's own strike line for it is a neutral bar.
    expect(layout.frets).toEqual(['#ffffff', '#ffffff', '#ffffff'])
  })

  it("spaces every instrument at the package's one lane step", () => {
    for (const type of [SIX_FRET, FIVE_FRET, DRUMS]) {
      const { centres } = laneLayout(type)
      for (let i = 1; i < centres.length; i++) {
        expect(centres[i] - centres[i - 1]).toBeCloseTo(PITCH, 12)
      }
    }
  })

  it('brackets the lanes with one more rail than there are lanes, half a lane out each side', () => {
    for (const type of [SIX_FRET, FIVE_FRET, DRUMS]) {
      const layout = laneLayout(type)
      const rails = laneRails(layout)
      expect(rails).toHaveLength(layout.centres.length + 1)
      expect(rails[0]).toBeCloseTo(layout.centres[0] - PITCH / 2, 12)
      expect(rails[rails.length - 1]).toBeCloseTo(
        layout.centres[layout.centres.length - 1] + PITCH / 2,
        12
      )
      // And the whole lane fits on the highway plane it is drawn on, which is what stops a rail
      // being clipped off the edge of the texture.
      expect(rails[0]).toBeGreaterThan(-layout.planeWidth / 2)
      expect(rails[rails.length - 1]).toBeLessThan(layout.planeWidth / 2)
    }
  })
})

describe('the colours, which come from tokens.css and nowhere else', () => {
  it('reads the four steps the lane is painted in off the document', () => {
    const { doc } = makeFakeDocument()
    expect(laneColours(doc)).toEqual({
      ground: FAKE_TOKENS['--ground-0'],
      groundNear: FAKE_TOKENS['--ground-3'],
      accent: FAKE_TOKENS['--accent'],
      accentTint: FAKE_TOKENS['--accent-tint']
    })
  })

  /**
   * The realistic failure: this module runs somewhere the stylesheet is not, and every
   * `getPropertyValue` answers with the empty string. A canvas painted in `''` is a black canvas,
   * and a black lane that looks deliberate is worse than the package's own art.
   */
  it('refuses a document that has no tokens in it rather than painting in nothing', () => {
    const { doc } = makeFakeDocument({})
    expect(() => laneColours(doc)).toThrow(/--ground-0/)
    const partial = makeFakeDocument({ ...FAKE_TOKENS, '--accent-tint': '' })
    expect(() => laneColours(partial.doc)).toThrow(/--accent-tint/)
  })
})

const COLOURS = {
  ground: '#070610',
  groundNear: '#161326',
  accent: '#8b5cf6',
  accentTint: '#cdbefe'
}

describe('the highway tile', () => {
  it('is as wide as the plane it tiles, so a lane in it is a lane on the highway', () => {
    for (const type of [SIX_FRET, FIVE_FRET, DRUMS]) {
      const layout = laneLayout(type)
      const canvas = makeFakeCanvas()
      drawHighwayTile(canvas as unknown as HTMLCanvasElement, layout, COLOURS)
      expect(canvas.width / canvas.height).toBeCloseTo(layout.planeWidth, 2)
    }
  })

  it("draws a rail on every lane boundary, the outer two in the app's accent", () => {
    const layout = laneLayout(FIVE_FRET)
    const canvas = makeFakeCanvas()
    drawHighwayTile(canvas as unknown as HTMLCanvasElement, layout, COLOURS)
    // The rails are the only full-height narrow rects, and they come last.
    const rails = canvas.ops.filter(
      (op) => op.op === 'fillRect' && op.h === canvas.height && op.w < canvas.width / 10
    )
    expect(rails).toHaveLength(6)
    const accent = rails.filter(
      (r) => r.op === 'fillRect' && r.fill.startsWith('rgba(139, 92, 246')
    )
    expect(accent).toHaveLength(2)
    expect(accent[0]).toBe(rails[0])
    expect(accent[1]).toBe(rails[rails.length - 1])
    // Each rail sits where the layout says the lane boundary is.
    const expected = laneRails(layout).map((r) => (0.5 + r / layout.planeWidth) * canvas.width)
    for (const [i, rail] of rails.entries()) {
      if (rail.op !== 'fillRect') throw new Error('not a rect')
      expect(rail.x + rail.w / 2).toBeCloseTo(expected[i], 6)
    }
  })

  /**
   * The renderer scrolls this texture, so the tile has to meet itself. A beat line on the tile's
   * own edge is split in two by the wrap and reads as two half-weight lines a whole lane apart.
   */
  it('keeps every beat line clear of the edge the tile wraps at', () => {
    const layout = laneLayout(FIVE_FRET)
    const canvas = makeFakeCanvas()
    drawHighwayTile(canvas as unknown as HTMLCanvasElement, layout, COLOURS)
    // The only full-width rects that are not the whole tile: the ground behind it is the same
    // width and the tile's full height, and nothing else in the drawing spans it.
    const beats = canvas.ops.filter(
      (op) => op.op === 'fillRect' && op.w === canvas.width && op.h < canvas.height / 10
    )
    expect(beats).toHaveLength(2)
    for (const beat of beats) {
      if (beat.op !== 'fillRect') throw new Error('not a rect')
      expect(beat.y).toBeGreaterThan(0)
      expect(beat.y + beat.h).toBeLessThan(canvas.height)
    }
  })
})

describe('the strike line sprite', () => {
  /**
   * The one thing the renderer takes from this image is its aspect ratio, which it multiplies by a
   * fixed height to get the sprite's width in world units. So the aspect IS the placement: get it
   * wrong and every fret is off the lane it belongs to, in a way no colour or shape can fix.
   */
  it('is shaped so the renderer lays it exactly across the lane', () => {
    for (const type of [SIX_FRET, FIVE_FRET, DRUMS]) {
      const layout = laneLayout(type)
      const canvas = makeFakeCanvas()
      drawStrikeline(canvas as unknown as HTMLCanvasElement, layout, COLOURS)
      const rails = laneRails(layout)
      // What `addStrikelineToScene` computes: aspect * strikeHeight, centred on the highway.
      const worldWidth = (canvas.width / canvas.height) * layout.strikeHeight
      const outer = Math.max(-rails[0], rails[rails.length - 1])
      expect(worldWidth / 2).toBeCloseTo(outer, 2)
    }
  })

  it("puts one ring on each lane centre, in that lane's colour, outlined and not filled", () => {
    const layout = laneLayout(FIVE_FRET)
    const canvas = makeFakeCanvas()
    drawStrikeline(canvas as unknown as HTMLCanvasElement, layout, COLOURS)
    const rings = canvas.ops.filter((op) => op.op === 'ellipse')
    expect(rings).toHaveLength(5)

    const halfWidth = (canvas.width / canvas.height) * layout.strikeHeight * 0.5
    for (const [i, ring] of rings.entries()) {
      if (ring.op !== 'ellipse') throw new Error('not an ellipse')
      const world = (ring.x / canvas.width) * 2 * halfWidth - halfWidth
      expect(world).toBeCloseTo(layout.centres[i], 2)
      expect(ring.stroke).toBe(layout.frets[i])
      expect(ring.lineWidth).toBeGreaterThan(0)
      // Dark inside rather than lit: a filled fret is what a hit note looks like, and this sprite
      // sits under every note in the chart.
      expect(ring.fill).toBe('rgba(0, 0, 0, 0.5)')
      // Flattened, because the lane is seen from the player's angle and a circle there is not one.
      expect(ring.ry).toBeLessThan(ring.rx)
    }
    // And they sit on one line, which is the strike line.
    expect(new Set(rings.map((r) => (r.op === 'ellipse' ? r.y : 0))).size).toBe(1)
  })

  /**
   * The ring is the one number the playing lane does not take from the still one: the still lane's
   * is 0.185 of a lane and the note that lands in it is 0.875, so a ring at the resting size would
   * be a third of the width of the note covering it. Pinned as a range rather than a value so the
   * claim is the one that matters, which is that the ring is about the size of the note.
   */
  it('draws a ring about as wide as the note that lands in it', () => {
    const layout = laneLayout(FIVE_FRET)
    const canvas = makeFakeCanvas()
    drawStrikeline(canvas as unknown as HTMLCanvasElement, layout, COLOURS)
    const ring = canvas.ops.find((op) => op.op === 'ellipse')
    if (ring?.op !== 'ellipse') throw new Error('no ring')
    const perPx = ((canvas.width / canvas.height) * layout.strikeHeight) / canvas.width
    const diameter = ring.rx * 2 * perPx
    // The package's five-fret note sprite is 0.105 tall at aspect 2, of which the puck is about
    // 70% of the width: measured at 0.148 world units.
    expect(diameter).toBeGreaterThan(0.12)
    expect(diameter).toBeLessThan(PITCH)
  })
})

describe('what happens at the seam, and what happens when it fails', () => {
  const makeTextures = (): {
    highwayTexture: { image: unknown; needsUpdate: boolean; anisotropy?: number }
    strikelineTexture: { image: unknown; needsUpdate: boolean }
  } => ({
    highwayTexture: { image: { tagName: 'IMG' }, needsUpdate: false },
    strikelineTexture: { image: { tagName: 'IMG' }, needsUpdate: false }
  })

  it('replaces both pictures with ours and asks for the upload', () => {
    const textures = makeTextures()
    const { doc, canvases } = makeFakeDocument()
    expect(skinLaneTextures(textures, FIVE_FRET, doc)).toBe(true)
    expect(canvases).toHaveLength(2)
    expect(textures.highwayTexture.image).toBe(canvases[0])
    expect(textures.strikelineTexture.image).toBe(canvases[1])
    expect(textures.highwayTexture.needsUpdate).toBe(true)
    expect(textures.strikelineTexture.needsUpdate).toBe(true)
    // The lane runs to a horizon, so its far end is sampled at a steep angle; three clamps this
    // to whatever the context supports.
    expect(textures.highwayTexture.anisotropy).toBeGreaterThan(1)
  })

  it('skins every instrument the package has a highway for', () => {
    for (const type of [SIX_FRET, FIVE_FRET, DRUMS]) {
      const textures = makeTextures()
      const { doc } = makeFakeDocument()
      expect(skinLaneTextures(textures, type, doc)).toBe(true)
      expect((textures.highwayTexture.image as { tagName: string }).tagName).toBe('CANVAS')
      expect((textures.strikelineTexture.image as { tagName: string }).tagName).toBe('CANVAS')
    }
  })

  /**
   * The whole point of the fallback: a preview that opens on the package's highway is a preview
   * that opens. Each of these is a real way this can fail: no 2d context (jsdom, a headless
   * check), no stylesheet (a document without tokens), nothing handed back at all (a future
   * version of the package that stops returning these two).
   */
  it("leaves the package's own art alone when it cannot build ours", () => {
    const noContext = makeTextures()
    expect(skinLaneTextures(noContext, FIVE_FRET, makeFakeDocument(FAKE_TOKENS, false).doc)).toBe(
      false
    )
    expect((noContext.highwayTexture.image as { tagName: string }).tagName).toBe('IMG')
    expect(noContext.highwayTexture.needsUpdate).toBe(false)

    const noTokens = makeTextures()
    expect(skinLaneTextures(noTokens, FIVE_FRET, makeFakeDocument({}).doc)).toBe(false)
    expect((noTokens.highwayTexture.image as { tagName: string }).tagName).toBe('IMG')

    expect(skinLaneTextures(null, FIVE_FRET, makeFakeDocument().doc)).toBe(false)
    expect(skinLaneTextures(makeTextures(), FIVE_FRET, null)).toBe(false)
  })

  /**
   * And it fails whole rather than half: the strike line is drawn second, so a failure there must
   * not leave Encore's highway under the package's chrome frets.
   */
  it('does not half-skin the lane when the second picture is the one that fails', () => {
    const textures = makeTextures()
    const { doc } = makeFakeDocument()
    // The highway draws, the strike line does not: Encore's floor under the package's chrome
    // frets is the one outcome that is worse than either picture on its own.
    let made = 0
    ;(doc as unknown as { createElement: (tag: string) => unknown }).createElement = () =>
      makeFakeCanvas(made++ === 0)
    expect(skinLaneTextures(textures, FIVE_FRET, doc)).toBe(false)
    expect((textures.highwayTexture.image as { tagName: string }).tagName).toBe('IMG')
    expect(textures.highwayTexture.needsUpdate).toBe(false)
  })
})
