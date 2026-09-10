import { deflateSync } from 'node:zlib'

/**
 * Build a real, parseable greyscale PNG of the given size.
 *
 * A fixture rather than a checked-in file because the tests that need one need SEVERAL sizes: the
 * `albumArtSize` fix is judged by what scan-chart reads back out of a cover, so a test has to be
 * able to say "this chart's art is 300x300" and "the fix wrote 512x512" without a binary blob per
 * case.
 *
 * It has to be a genuine PNG, not a stub with a plausible header. scan-chart hands album art to
 * exifreader (`extractImageMetadata`), which reads the dimensions out of the IHDR chunk and
 * rejects anything it cannot parse as `badAlbumArt`, so a fixture that only looked right would
 * turn every one of these tests into a test of a different issue code.
 *
 * Greyscale, one byte per pixel, one filter byte per row: the smallest thing that is still a
 * valid PNG. Deflated all-zero rows, so a 512x512 fixture is a few hundred bytes.
 */
export function makePng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  // Each scanline is preceded by its filter byte, which stays 0 (None) along with the pixels.
  const raw = Buffer.alloc(height * (width + 1))
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}

/** One length-prefixed, CRC-suffixed PNG chunk. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** PNG's CRC-32, table built on first use. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
