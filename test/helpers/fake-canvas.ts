/**
 * A canvas that records what was drawn on it, for tests that run where there is no canvas.
 *
 * The renderer suite is jsdom and the rest of the suite is node, and neither has a 2d context:
 * jsdom's `getContext` returns null unless the `canvas` package is installed, and node has no
 * `HTMLCanvasElement` at all. The lane skin draws two canvases and hands them to `chart-preview`
 * as textures, so what IS checkable without an engine is that the right shapes were asked for at
 * the right coordinates, which is what this records.
 *
 * It is not a renderer and it is not trying to be. Anything about how the lane LOOKS is measured
 * by `scripts/measure-lane-skin.mjs` against a real WebGL context; this is for the arithmetic that
 * puts a fret in the middle of a lane.
 */

export interface DrawnRect {
  op: 'fillRect'
  x: number
  y: number
  w: number
  h: number
  fill: string
}
export interface DrawnEllipse {
  op: 'ellipse'
  x: number
  y: number
  rx: number
  ry: number
  fill: string
  stroke: string
  lineWidth: number
}
export type DrawnOp = DrawnRect | DrawnEllipse

export interface FakeCanvas {
  tagName: 'CANVAS'
  width: number
  height: number
  getContext(kind: string): FakeContext | null
  /** Everything drawn on it, in order. */
  ops: DrawnOp[]
}

interface FakeContext {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  shadowColor: string
  shadowBlur: number
  fillRect(x: number, y: number, w: number, h: number): void
  createRadialGradient(...args: number[]): { addColorStop(offset: number, colour: string): void }
  save(): void
  restore(): void
  translate(x: number, y: number): void
  scale(x: number, y: number): void
  beginPath(): void
  ellipse(x: number, y: number, rx: number, ry: number, ...rest: number[]): void
  fill(): void
  stroke(): void
}

/**
 * `supported: false` gives a canvas whose `getContext` answers null, which is what jsdom does and
 * what the lane skin's fallback path exists for.
 */
export function makeFakeCanvas(supported = true): FakeCanvas {
  const ops: DrawnOp[] = []
  // The transform the ellipse path is recorded through. Only the glow uses one, and it saves and
  // restores around itself, so a single pair of numbers is the whole of it.
  const pending: { x: number; y: number; rx: number; ry: number } = { x: 0, y: 0, rx: 0, ry: 0 }
  const ctx: FakeContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    shadowColor: '',
    shadowBlur: 0,
    fillRect: (x, y, w, h) => void ops.push({ op: 'fillRect', x, y, w, h, fill: ctx.fillStyle }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    beginPath: () => {},
    ellipse: (x, y, rx, ry) => {
      pending.x = x
      pending.y = y
      pending.rx = rx
      pending.ry = ry
    },
    fill: () => {
      const last = ops[ops.length - 1]
      // A fill straight after an ellipse is that ellipse's; the stroke that follows completes it.
      if (last?.op === 'ellipse' && last.x === pending.x && last.rx === pending.rx) return
      ops.push({
        op: 'ellipse',
        ...pending,
        fill: ctx.fillStyle,
        stroke: '',
        lineWidth: 0
      })
    },
    stroke: () => {
      const last = ops[ops.length - 1]
      if (last?.op !== 'ellipse') throw new Error('fake canvas: stroke without a path')
      last.stroke = ctx.strokeStyle
      last.lineWidth = ctx.lineWidth
    }
  }
  return {
    tagName: 'CANVAS',
    width: 0,
    height: 0,
    ops,
    getContext: (kind: string) => (supported && kind === '2d' ? ctx : null)
  }
}

/** The four colour tokens the lane skin reads, as a stand-in `getComputedStyle`. */
export const FAKE_TOKENS: Record<string, string> = {
  '--ground-0': '#070610',
  '--ground-3': '#161326',
  '--accent': '#8b5cf6',
  '--accent-tint': '#cdbefe'
}

/**
 * A document with just enough of one to build a lane skin against: `createElement('canvas')` and a
 * `getComputedStyle` that answers for the tokens in `tokens`.
 */
export function makeFakeDocument(
  tokens: Record<string, string> = FAKE_TOKENS,
  supported = true
): { doc: Document; canvases: FakeCanvas[] } {
  const canvases: FakeCanvas[] = []
  const doc = {
    documentElement: {},
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`fake document: no ${tag}`)
      const canvas = makeFakeCanvas(supported)
      canvases.push(canvas)
      return canvas
    },
    defaultView: {
      getComputedStyle: () => ({ getPropertyValue: (name: string) => tokens[name] ?? '' })
    }
  }
  return { doc: doc as unknown as Document, canvases }
}
