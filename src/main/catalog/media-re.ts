/**
 * Video file extensions, shared by the scanner's `hasVideo` flag and the preview reader that
 * leaves video out of what it hands the renderer.
 *
 * There is no matching AUDIO_RE any more. Both scanners used to have one, to decide which files
 * NOT to read; they now decide that by asking whether scan-chart parses the file at all
 * (`isParsedByScanChart`), which covers audio without naming it, and covers the renamed
 * `video.mp4.disabled` an extension list never would.
 */
export const VIDEO_RE = /\.(mp4|avi|webm|mkv|mov)$/i

/**
 * The cover names Clone Hero reads, matched case-insensitively.
 *
 * Lives here rather than in the scanner because the art writer needs the same rule: it removes
 * the cover a chart already had when it writes one in a different format, and a writer whose
 * idea of "a cover" were narrower than the scanner's would leave behind exactly the duplicate
 * the scanner then reports.
 *
 * scan-chart's own `hasAlbumName` is an exact match on `album.jpg`/`album.jpeg`/`album.png`, so
 * this pattern is deliberately the wider of the two: `Album.jpg` counts as a cover here and does
 * not count as one to scan-chart. Being wider is the safe direction for both users of the
 * pattern: the scanner reports a cover that the game may ignore, and the writer clears a file
 * that would otherwise sit next to the new cover forever.
 */
export const ALBUM_ART_RE = /^album\.(png|jpe?g)$/i
