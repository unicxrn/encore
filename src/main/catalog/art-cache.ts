import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The cached rendition of a chart's cover.
 *
 * `md5` is scan-chart's hash of the SOURCE image and names the file; the file's contents are
 * the re-encoded rendition, so the name is not a hash of the bytes it labels. That trade buys
 * the skip in writeAlbumArt: an already-cached cover costs one existsSync, not a decode.
 */
export interface AlbumArt {
  data: Uint8Array
  md5: string
}

/** Art file names are bare md5s. Anything else is rejected rather than sanitized. */
const MD5_RE = /^[0-9a-f]{32}$/

/**
 * Resolve the cache path for an md5, or null when the input is not one.
 *
 * The md5 reaches this function from a URL the renderer builds, so it is untrusted input:
 * validating the shape rather than escaping it means a traversal attempt has no path to
 * resolve to, instead of a path that merely happens to be outside the cache today.
 */
export function artFilePath(artDir: string, md5: string): string | null {
  return MD5_RE.test(md5) ? join(artDir, `${md5}.jpg`) : null
}

/**
 * Cache a chart's cover, returning the md5 to store on the chart row, or null if there is none.
 *
 * Never throws. The scanner wraps upsertChart in the same try/catch as this call, so any throw
 * here would cost the chart its entire catalog row: a full disk or a read-only volume would
 * present as "N charts failed to scan" over a near-empty library rather than a complete library
 * without covers. A cover is decoration; the row is the data.
 *
 * Dedupe is by source hash. On a real library only ~17% of charts share a cover, so this is not
 * primarily a write-skipping optimisation. It is what makes a rescan cheap and idempotent.
 */
export function writeAlbumArt(
  artDir: string,
  art: AlbumArt | null,
  encode: (data: Uint8Array) => Uint8Array
): string | null {
  if (art === null) return null
  const file = artFilePath(artDir, art.md5)
  // A malformed md5 is damaged upstream data, not a caller mistake: drop the art, keep the chart.
  if (file === null) return null
  if (existsSync(file)) return art.md5
  // Sibling of the final name, so the rename below stays on one filesystem and is atomic. The
  // name can be deterministic like writeChartAsset's because write-then-rename here is wholly
  // synchronous: no other task in this process can interleave between the two calls.
  const tmp = `${file}.tmp`
  try {
    mkdirSync(artDir, { recursive: true })
    // A process killed between the write and the rename leaves this temp behind, and `wx` would
    // then fail with EEXIST on every later attempt. That costs more than one cover: the chart
    // row is still written with a current folderHash and scanVersion, so the scan after that
    // skips the chart outright and the cover never lands until the folder changes or
    // SCAN_VERSION bumps.
    rmSync(tmp, { force: true })
    // wx refuses to follow a dangling symlink planted at the temp path. Clearing the temp first
    // does not weaken that: rmSync unlinks a symlink itself rather than its target, so the
    // create below is still exclusive.
    writeFileSync(tmp, encode(art.data), { flag: 'wx' })
    // A write that dies partway leaves only tmp, so `file` is never a truncated cover that the
    // existsSync skip above would then treat as cached and never repair.
    renameSync(tmp, file)
    return art.md5
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Cleanup is fallible too (a directory at tmp throws EISDIR). A leaked temp file is inert;
      // a throw escaping this function would cost the chart its row.
    }
    return null
  }
}

/**
 * Delete cached art that no chart references any more, returning how many files went.
 *
 * Only files this module could have written are considered, so a stray file in the directory is
 * left alone rather than deleted on the assumption it is ours.
 */
export function sweepOrphanArt(artDir: string, keep: Set<string>): number {
  if (!existsSync(artDir)) return 0
  let removed = 0
  for (const entry of readdirSync(artDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jpg')) continue
    const md5 = entry.name.slice(0, -4)
    if (!MD5_RE.test(md5) || keep.has(md5)) continue
    try {
      rmSync(join(artDir, entry.name), { force: true })
      removed++
    } catch {
      // One undeletable file (open handle on Windows, permissions) must not strand the rest.
    }
  }
  return removed
}
