/**
 * Background generation from album art via OffscreenCanvas.
 * Decodes art bytes → draws cover-fitted, blurred, darkened → exports PNG bytes.
 *
 * OffscreenCanvas is only available in browser/worker contexts. In Node (tests)
 * the canvas and decode functions are injected via GenerateOptions.
 */

export interface GenerateOptions {
  /** Output width in pixels. Default: 1920. */
  width?: number
  /** Output height in pixels. Default: 1080. */
  height?: number
  /** CSS blur radius in pixels. Default: 40. */
  blurPx?: number
  /** CSS brightness multiplier (0 to 1). Default: 0.4. */
  brightness?: number
  /** Factory for the output canvas. Default: new OffscreenCanvas(w, h). */
  createCanvas?: (w: number, h: number) => OffscreenCanvas
  /** Decodes image bytes into a bitmap. Default: createImageBitmap(new Blob([bytes])). */
  decode?: (bytes: Uint8Array) => Promise<ImageBitmap>
}

/**
 * Compute a cover-fit draw rect: scale the image uniformly so it fills the
 * target box, cropping any overflow, centered.
 *
 * Exported as a pure helper so tests can TDD the math independently of canvas.
 */
export function coverRect(
  iw: number,
  ih: number,
  w: number,
  h: number
): { dx: number; dy: number; dw: number; dh: number } {
  const scale = Math.max(w / iw, h / ih)
  const dw = iw * scale
  const dh = ih * scale
  const dx = (w - dw) / 2
  const dy = (h - dh) / 2
  return { dx, dy, dw, dh }
}

/**
 * Generate a blurred, darkened background PNG from album art bytes.
 *
 * @param artBytes  Raw bytes of the source album art (JPEG or PNG).
 * @param opts      Optional overrides for dimensions, filter params, and
 *                  injectable canvas/decode factories (for testing in Node).
 * @returns         PNG bytes suitable for writing as background.png.
 */
export async function generateBackground(
  artBytes: Uint8Array,
  opts?: GenerateOptions
): Promise<Uint8Array> {
  const w = opts?.width ?? 1920
  const h = opts?.height ?? 1080
  const blurPx = opts?.blurPx ?? 40
  const brightness = opts?.brightness ?? 0.4

  const decodeImage =
    opts?.decode ?? ((bytes: Uint8Array) => createImageBitmap(new Blob([bytes as BlobPart])))
  const makeCanvas = opts?.createCanvas ?? ((cw: number, ch: number) => new OffscreenCanvas(cw, ch))

  const bitmap = await decodeImage(artBytes)
  const canvas = makeCanvas(w, h)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D

  ctx.filter = `blur(${blurPx}px) brightness(${brightness})`

  const { dx, dy, dw, dh } = coverRect(bitmap.width, bitmap.height, w, h)
  ctx.drawImage(bitmap as unknown as ImageBitmap, dx, dy, dw, dh)

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const arrayBuffer = await blob.arrayBuffer()
  return new Uint8Array(arrayBuffer)
}
