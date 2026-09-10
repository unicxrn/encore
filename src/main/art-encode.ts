import { nativeImage } from 'electron'

/** Longest edge of a cached cover. 512 is the largest the detail page ever draws. */
export const ART_MAX_EDGE = 512
/** Quality 80: visually indistinguishable from source at this size, ~5x smaller than PNG. */
export const ART_JPEG_QUALITY = 80

/**
 * Namespaces the on-disk cache directory. Bump it whenever either constant above changes.
 *
 * A cached cover is never re-encoded in place (writeAlbumArt skips any md5 whose file already
 * exists), and there is no in-app "clear art cache". Without this segment in the path, changing
 * ART_MAX_EDGE or ART_JPEG_QUALITY would silently leave every already-scanned user on the old
 * rendition forever.
 */
export const ART_CACHE_VERSION = 'v1'

/**
 * Re-encode a chart's cover to a bounded JPEG.
 *
 * scan-chart hands back the original file untouched despite its typedoc claiming otherwise,
 * so covers arrive as PNG or JPEG at anything from 300x300 to 1400x1400. Storing them as-is
 * costs ~29MB for 182 charts and would serve PNG bytes under a .jpg name.
 *
 * Aspect ratio is preserved rather than forced square: most covers are square, and the ones
 * that are not would be distorted by a forced resize. Throws when the image cannot be
 * decoded; the caller decides whether that is fatal (it is not; see writeAlbumArt).
 */
export function encodeAlbumArt(data: Uint8Array): Uint8Array {
  const image = nativeImage.createFromBuffer(Buffer.from(data))
  if (image.isEmpty()) throw new Error('album art could not be decoded')
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  const bounded =
    longest > ART_MAX_EDGE
      ? image.resize({
          width: Math.round((width * ART_MAX_EDGE) / longest),
          height: Math.round((height * ART_MAX_EDGE) / longest),
          quality: 'best'
        })
      : image
  return new Uint8Array(bounded.toJPEG(ART_JPEG_QUALITY))
}

/**
 * The edge scan-chart accepts. It also accepts 500x500; 512 is the one the message asks for.
 */
export const SQUARE_ART_EDGE = 512

/**
 * Quality for a cover written back INTO the user's chart, as opposed to into the display cache.
 *
 * Higher than `ART_JPEG_QUALITY` on purpose. That number encodes a trade against 29 MB of cache
 * for 182 charts, where the file is regenerable and never seen at more than 512 px. This one
 * replaces a file the user owns and cannot get back, and in the four reference-library covers that
 * are already 512x512 the re-encode buys nothing but a dropped EXIF tag, so it should cost as
 * little of the image as it can. Measured on those four: 90 gives 30-107 KB, 95 gives 42-137 KB.
 * A cover is a rounding error beside a chart's audio either way.
 */
export const SQUARE_ART_JPEG_QUALITY = 95

/**
 * Re-encode a cover to exactly 512x512, cropping to a square from the centre first.
 *
 * Separate from `encodeAlbumArt` rather than a flag on it, because the two want opposite things.
 * That one bounds the longest edge and preserves aspect ratio, which is correct for the display
 * cache and produces 509x512 from a 770x774 cover, a size scan-chart flags. This one is for the
 * `albumArtSize` fix and has to produce the literal square scan-chart accepts. Neither behaviour
 * is wrong; they are answers to different questions, and merging them would make the display
 * cache start distorting covers to satisfy a check it is not subject to.
 *
 * See issues/actions/album-art-size.ts for the measurements behind crop-rather-than-stretch and
 * for why an already-512x512 cover still has to go through this.
 *
 * `format` is the container to write back, not the one that came in: the fix keeps the cover's
 * existing file name, so a `.png` must come back out as PNG even though JPEG would be smaller.
 *
 * Like `encodeAlbumArt`, this lives on Electron's `nativeImage` and therefore cannot run under
 * vitest: `electron` resolves to a CJS stub there and `nativeImage` is `undefined`. That is why
 * the fix framework takes it as an injected capability (`FixContext.image`) rather than importing
 * it: see the same reasoning for the scanner's art encoder in catalog/scanner.ts.
 */
export function encodeSquareAlbumArt(data: Uint8Array, format: 'png' | 'jpeg'): Uint8Array {
  const image = nativeImage.createFromBuffer(Buffer.from(data))
  if (image.isEmpty()) throw new Error('album art could not be decoded')
  const { width, height } = image.getSize()
  const edge = Math.min(width, height)
  const square =
    width === height
      ? image
      : image.crop({
          // Rounded rather than floored so the two margins differ by at most one pixel; on an odd
          // difference the extra row comes off the bottom or the right.
          x: Math.round((width - edge) / 2),
          y: Math.round((height - edge) / 2),
          width: edge,
          height: edge
        })
  const sized =
    edge === SQUARE_ART_EDGE
      ? square
      : square.resize({ width: SQUARE_ART_EDGE, height: SQUARE_ART_EDGE, quality: 'best' })
  return new Uint8Array(format === 'png' ? sized.toPNG() : sized.toJPEG(SQUARE_ART_JPEG_QUALITY))
}
