import { describe, expect, it } from 'vitest'
import { coverRect, generateBackground } from './generate'

// ---------------------------------------------------------------------------
// coverRect: pure math, so no canvas stub is needed
// ---------------------------------------------------------------------------

describe('coverRect', () => {
  it('scales landscape art to fill a 16:9 target (width is the binding edge)', () => {
    // 800×400 art into 1920×1080
    // scale = max(1920/800, 1080/400) = max(2.4, 2.7) = 2.7
    const { dx, dy, dw, dh } = coverRect(800, 400, 1920, 1080)
    expect(dw).toBeCloseTo(2160) // 800 * 2.7
    expect(dh).toBeCloseTo(1080) // 400 * 2.7
    expect(dx).toBeCloseTo((1920 - 2160) / 2) // centered, negative (overflows left/right)
    expect(dy).toBeCloseTo(0) // exactly fits height
  })

  it('scales portrait art to fill a 16:9 target (height is the binding edge)', () => {
    // 400×800 art into 1920×1080
    // scale = max(1920/400, 1080/800) = max(4.8, 1.35) = 4.8
    const { dx, dy, dw, dh } = coverRect(400, 800, 1920, 1080)
    expect(dw).toBeCloseTo(1920) // exactly fits width
    expect(dh).toBeCloseTo(3840) // 800 * 4.8
    expect(dx).toBeCloseTo(0)
    expect(dy).toBeCloseTo((1080 - 3840) / 2) // centered, negative (overflows top/bottom)
  })

  it('returns zero offsets for exact-fit art', () => {
    const { dx, dy, dw, dh } = coverRect(1920, 1080, 1920, 1080)
    expect(dx).toBeCloseTo(0)
    expect(dy).toBeCloseTo(0)
    expect(dw).toBeCloseTo(1920)
    expect(dh).toBeCloseTo(1080)
  })

  it('handles square art into a 16:9 target (width is the binding edge)', () => {
    // 500×500 art into 1920×1080
    // scale = max(1920/500, 1080/500) = max(3.84, 2.16) = 3.84
    const { dx, dy, dw, dh } = coverRect(500, 500, 1920, 1080)
    expect(dw).toBeCloseTo(1920)
    expect(dh).toBeCloseTo(1920)
    expect(dx).toBeCloseTo(0)
    expect(dy).toBeCloseTo((1080 - 1920) / 2)
  })
})

// ---------------------------------------------------------------------------
// generateBackground: wiring tests with stub canvas/ctx
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub canvas + context that records calls. The ctx is the
 * stand-in for OffscreenCanvasRenderingContext2D, and only the properties the
 * implementation touches are needed.
 */
function makeStubCanvas(
  w: number,
  h: number
): {
  canvas: {
    width: number
    height: number
    getContext: () => {
      filter: string
      drawImage: (...args: unknown[]) => void
    }
    convertToBlob: (opts: unknown) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>
  }
  ctx: { filter: string; drawImage: (...args: unknown[]) => void }
  calls: { drawImage: unknown[]; filter: string[]; convertToBlob: unknown[] }
} {
  const calls = {
    drawImage: [] as unknown[],
    filter: [] as string[],
    convertToBlob: [] as unknown[]
  }

  const ctx = {
    get filter() {
      return calls.filter.at(-1) ?? ''
    },
    set filter(v: string) {
      calls.filter.push(v)
    },
    drawImage(...args: unknown[]) {
      calls.drawImage.push(args)
    }
  }

  const blob = {
    arrayBuffer: async () => new ArrayBuffer(4)
  }

  const canvas = {
    width: w,
    height: h,
    getContext: () => ctx,
    convertToBlob: async (opts: unknown) => {
      calls.convertToBlob.push(opts)
      return blob
    }
  }

  return { canvas, ctx, calls }
}

/**
 * Minimal stub ImageBitmap-like object the impl treats as ImageBitmap.
 */
function stubBitmap(width: number, height: number): { width: number; height: number } {
  return { width, height }
}

describe('generateBackground', () => {
  it('sets the correct filter string on the context', async () => {
    const { canvas, calls } = makeStubCanvas(1920, 1080)
    const bitmap = stubBitmap(800, 600)

    await generateBackground(new Uint8Array([1, 2, 3]), {
      createCanvas: () => canvas as unknown as OffscreenCanvas,
      decode: async () => bitmap as unknown as ImageBitmap
    })

    expect(calls.filter).toContain('blur(40px) brightness(0.4)')
  })

  it('respects custom blurPx and brightness options', async () => {
    const { canvas, calls } = makeStubCanvas(1920, 1080)
    const bitmap = stubBitmap(800, 600)

    await generateBackground(new Uint8Array([1]), {
      blurPx: 20,
      brightness: 0.6,
      createCanvas: () => canvas as unknown as OffscreenCanvas,
      decode: async () => bitmap as unknown as ImageBitmap
    })

    expect(calls.filter).toContain('blur(20px) brightness(0.6)')
  })

  it('calls drawImage with coverRect-computed coords for landscape art', async () => {
    const W = 1920
    const H = 1080
    const iw = 800
    const ih = 400

    const { canvas, calls } = makeStubCanvas(W, H)
    const bitmap = stubBitmap(iw, ih)

    await generateBackground(new Uint8Array([1]), {
      createCanvas: () => canvas as unknown as OffscreenCanvas,
      decode: async () => bitmap as unknown as ImageBitmap
    })

    expect(calls.drawImage).toHaveLength(1)
    const [, dx, dy, dw, dh] = calls.drawImage[0] as [unknown, number, number, number, number]

    const expected = coverRect(iw, ih, W, H)
    expect(dx).toBeCloseTo(expected.dx)
    expect(dy).toBeCloseTo(expected.dy)
    expect(dw).toBeCloseTo(expected.dw)
    expect(dh).toBeCloseTo(expected.dh)
  })

  it('calls drawImage with coverRect-computed coords for portrait art', async () => {
    const W = 1920
    const H = 1080
    const iw = 400
    const ih = 800

    const { canvas, calls } = makeStubCanvas(W, H)
    const bitmap = stubBitmap(iw, ih)

    await generateBackground(new Uint8Array([1]), {
      createCanvas: () => canvas as unknown as OffscreenCanvas,
      decode: async () => bitmap as unknown as ImageBitmap
    })

    const [, dx, dy, dw, dh] = calls.drawImage[0] as [unknown, number, number, number, number]
    const expected = coverRect(iw, ih, W, H)
    expect(dx).toBeCloseTo(expected.dx)
    expect(dy).toBeCloseTo(expected.dy)
    expect(dw).toBeCloseTo(expected.dw)
    expect(dh).toBeCloseTo(expected.dh)
  })

  it('calls convertToBlob with type image/png', async () => {
    const { canvas, calls } = makeStubCanvas(1920, 1080)
    const bitmap = stubBitmap(600, 600)

    await generateBackground(new Uint8Array([1]), {
      createCanvas: () => canvas as unknown as OffscreenCanvas,
      decode: async () => bitmap as unknown as ImageBitmap
    })

    expect(calls.convertToBlob).toHaveLength(1)
    expect(calls.convertToBlob[0]).toEqual({ type: 'image/png' })
  })

  it('respects custom width and height options', async () => {
    const canvasSizes: [number, number][] = []
    const bitmap = stubBitmap(600, 600)

    await generateBackground(new Uint8Array([1]), {
      width: 3840,
      height: 2160,
      createCanvas: (w, h) => {
        canvasSizes.push([w, h])
        return makeStubCanvas(w, h).canvas as unknown as OffscreenCanvas
      },
      decode: async () => bitmap as unknown as ImageBitmap
    })

    expect(canvasSizes).toEqual([[3840, 2160]])
  })

  it('returns a Uint8Array from the blob', async () => {
    const { canvas } = makeStubCanvas(1920, 1080)
    const bitmap = stubBitmap(600, 600)

    const result = await generateBackground(new Uint8Array([1]), {
      createCanvas: () => canvas as unknown as OffscreenCanvas,
      decode: async () => bitmap as unknown as ImageBitmap
    })

    expect(result).toBeInstanceOf(Uint8Array)
  })

  it('passes the artBytes to the decode function', async () => {
    const { canvas } = makeStubCanvas(1920, 1080)
    const received: Uint8Array[] = []
    const artBytes = new Uint8Array([10, 20, 30])

    await generateBackground(artBytes, {
      createCanvas: () => canvas as unknown as OffscreenCanvas,
      decode: async (bytes) => {
        received.push(bytes)
        return stubBitmap(400, 400) as unknown as ImageBitmap
      }
    })

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(artBytes)
  })
})
