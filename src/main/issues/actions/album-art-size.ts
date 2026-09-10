import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixForRow, fixSentence } from '../../../shared/issue-fixes'
import { writeSngAssetContent } from '../../assets/sng-asset'
import { writeChartAsset } from '../../assets/write'
import { chartTypeAt } from '../../catalog/issues'
import { readSngEntriesForScan } from '../../downloads/sng-read-selective'
import type { FixAction } from '../fix'

/**
 * `albumArtSize`: re-encode a chart's cover to exactly 512x512.
 *
 * scan-chart accepts two sizes and no others: `extractImageMetadata`
 * (node_modules/scan-chart/dist/index.js:2641) builds `"${height}x${width}"` and passes the image
 * only when that string is `"500x500"` or `"512x512"`. Not "at most 512", not "square": those two
 * literals. 39 charts of the 219-chart reference library carry this row, the largest fixable group
 * in the milestone.
 *
 * **The M5 art encoder cannot do this job, and must not be changed so it can.** `encodeAlbumArt`
 * (src/main/art-encode.ts) bounds the LONGEST EDGE to 512 while preserving aspect ratio, which is
 * exactly right for the display cache it feeds and produces 509x512 from this library's 770x774
 * cover, a file scan-chart flags again with a different number in the message. A true square is
 * a different operation, so it is a different function (`encodeSquareAlbumArt`).
 *
 * ## Centre-crop, not stretch
 *
 * Measured on the real thing before choosing, by reading every affected cover's SOF/IHDR
 * dimensions rather than trusting the issue text:
 *
 * | source shape                     | charts |
 * | -------------------------------- | ------ |
 * | exactly square (256 … 1425 px)   | 25     |
 * | within 5% of square              | 13     |
 * | 1280x1024 (5:4)                  | 1      |
 *
 * For 38 of the 39, the two answers are nearly the same thing: a crop trims at most 2.5% off each
 * edge, a stretch distorts by at most 5%, and neither is visible on a 512 px cover. The decision
 * is made by the last one, and there a crop takes the middle 1024x1024 (which for that chart is
 * the album cover itself, sitting inside a wallpaper-shaped image), while a stretch squashes the
 * lettering horizontally by 20%. Crop's failure mode is bounded to the edges and leaves everything
 * it keeps geometrically true; stretch's applies to every pixel and scales with how non-square the
 * source is. Album art is judged on faces and lettering, so crop wins.
 *
 * ## Two things this does that look unnecessary and are not
 *
 * **A cover that is already 512x512 is still re-encoded.** Four charts in the reference library are
 * genuinely 512x512 and still raise the row, because scan-chart reads `image.ImageWidth ||
 * image["Image Width"]`, and for a JPEG resized by Photoshop the first of those is an EXIF tag
 * holding the width BEFORE the resize. One reads `512x4016`. Its width comes from EXIF (4016), its
 * height from the JPEG's own SOF marker (512), and the two describe different images. Re-encoding
 * drops the EXIF block, so the only dimensions left are the real ones. Verified end to end under
 * Electron on all four.
 *
 * **A cover smaller than 512 is scaled up.** 256x256 becomes 512x512 and gains nothing but bytes.
 * There is no way around it: 256x256 is not one of the two sizes scan-chart accepts, so the only
 * alternative to upscaling is leaving the row unfixed.
 *
 * The container is preserved: a `.png` is written back as PNG, a `.jpg` as JPEG, under the same
 * name. Converting to JPEG would be smaller for the upscaled PNGs (381 KB against 91 KB, measured)
 * but would flatten any transparency to black and rename a file in the user's chart, neither of
 * which is what "the art is the wrong size" asked for.
 *
 * Nothing here is hashed by `getChartHash`: album art is not part of a chart's gameplay identity,
 * and neither the chart file nor `song.ini` is opened. `applyFix` proves it afterwards.
 */

/**
 * scan-chart's `hasAlbumName` (index.js:122): three exact, lower-case names.
 *
 * Deliberately NOT `ALBUM_ART_RE` (catalog/media-re.ts), which is the case-insensitive form the
 * art writer uses. That one is right for deciding what a new cover supersedes and wrong here: an
 * `Album.PNG` is not a cover to scan-chart, so it cannot be the file this row is about, and
 * re-encoding it would be acting on a file the report never mentioned.
 */
function isAlbumName(fileName: string): boolean {
  return ['album.jpg', 'album.jpeg', 'album.png'].includes(fileName)
}

/** Which encoder `encodeSquareAlbumArt` should produce, from the name being written back. */
function formatOf(fileName: string): 'png' | 'jpeg' {
  return fileName.endsWith('.png') ? 'png' : 'jpeg'
}

/**
 * The cover scan-chart actually read, and its bytes.
 *
 * `findAlbumData` (index.js:2620) keeps the LAST album-named file it walks past, so a chart with
 * both `album.png` and `album.jpg` is measured by whichever the reader supplies second. That is
 * also the one this must re-encode: fixing the other would leave the flagged file in place and the
 * row exactly where it was. The `multipleAlbumArt` that such a chart also carries is a different
 * question (which cover do you want?), and this does not answer it either way, so it
 * deliberately leaves both files present and only resizes the one being complained about.
 *
 * Both branches read in the same order the issue scan read in: `readdirSync` for a folder chart
 * and the selective reader's entry list for a `.sng` (`catalog/issues.ts`).
 */
async function readCover(
  chartPath: string,
  chartType: 'folder' | 'sng'
): Promise<{ fileName: string; data: Uint8Array }> {
  if (chartType === 'folder') {
    const names = readdirSync(chartPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter(isAlbumName)
    const fileName = names[names.length - 1]
    if (fileName === undefined) {
      throw new Error(
        `${chartPath} no longer has album art to resize. Scan the library again and retry.`
      )
    }
    // Copied into its own ArrayBuffer rather than handed on as a pooled Buffer: the encoder and
    // the repacker both read `.buffer`, and a view into readFileSync's pool would give them
    // whatever else the pool held.
    return { fileName, data: new Uint8Array(readFileSync(join(chartPath, fileName))) }
  }

  const { entries } = await readSngEntriesForScan(chartPath)
  const covers = entries.filter((entry) => isAlbumName(entry.fileName))
  const cover = covers[covers.length - 1]
  if (cover === undefined) {
    throw new Error(
      `${chartPath} no longer has album art to resize. Scan the library again and retry.`
    )
  }
  return { fileName: cover.fileName, data: cover.data }
}

export const albumArtSizeAction: FixAction = {
  code: 'albumArtSize',

  // Both delegate to shared/issue-fixes.ts, so main and the renderer cannot form two opinions
  // about which rows this repairs or what it promises to rewrite.
  appliesTo: (row) => fixForRow(row)?.actionCode === 'albumArtSize',

  describe: (row) => fixSentence(row, 'albumArtSize'),

  availability: async (ctx) => ({
    available: ctx.image !== undefined,
    reason: ctx.image ? null : 'Image encoding is not available in this build.'
  }),

  /**
   * Keep the cover as it is, under its own name.
   *
   * `remove` is empty because this repair replaces a file in place: the name does not change, so
   * writing the original back is the whole of the undo. That is also why this is the one repair
   * whose backup is exactly its own output's predecessor. A re-encode is lossy, and re-encoding
   * the 512x512 result back to the source's 770x774 would not return the file the user had.
   *
   * `readCover` is called here and again in `apply`, on the same chart under the same lock, so the
   * two see the same file. Both reads are of one cover, about 1 MB in this library.
   */
  backup: async (row) => {
    const cover = await readCover(row.chartPath, chartTypeAt(row.chartPath))
    return {
      code: row.code,
      actionCode: 'albumArtSize',
      describe: fixSentence(row, 'albumArtSize'),
      files: [{ fileName: cover.fileName, content: { kind: 'data', data: cover.data } }]
    }
  },

  apply: async (row, ctx) => {
    const encode = ctx.image
    if (!encode) throw new Error('Image encoding is not available in this build.')

    const chartPath = row.chartPath
    const chartType = chartTypeAt(chartPath)
    ctx.onProgress?.({ phase: 'reading album art', percent: null })
    const cover = await readCover(chartPath, chartType)

    ctx.onProgress?.({ phase: 'resizing', percent: null })
    const resized = encode(cover.data, formatOf(cover.fileName))

    ctx.onProgress?.({ phase: 'writing', percent: null })
    if (chartType === 'sng') {
      // No `removeMatching`: the name is unchanged, so nothing is superseded. A chart with a
      // second cover under another name keeps it, which is `multipleAlbumArt`'s business.
      await writeSngAssetContent(
        chartPath,
        cover.fileName,
        { kind: 'data', data: resized },
        ctx.libraryFolders
      )
    } else {
      writeChartAsset(chartPath, cover.fileName, resized, ctx.libraryFolders)
    }
  }
}

/** Exported for the test that pins this rule to scan-chart's `hasAlbumName`. */
export const albumArtNameRules = { isAlbumName, formatOf }
