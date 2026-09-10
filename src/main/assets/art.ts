import { ALBUM_ART_RE } from '../catalog/media-re'
import { assertUnderLibrary } from './library-guard'
import { writeSngAsset } from './sng-asset'
import { replacementOf, writeWithUndo } from './undoable-write'
import { writeChartAsset } from './write'

export interface AlbumArtResult {
  artist: string
  album: string
  thumbUrl: string
  fullUrl: string
}

/**
 * Search the iTunes Search API for album art candidates.
 * Returns up to 8 results. Entries missing artworkUrl100 are silently skipped.
 * Throws on non-200 responses or invalid JSON.
 */
export async function searchAlbumArt(
  term: string,
  fetchFn: typeof fetch = fetch
): Promise<AlbumArtResult[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=8`
  const response = await fetchFn(url)
  if (!response.ok) {
    throw new Error(`iTunes Search API returned ${response.status}: ${response.statusText}`)
  }
  let json: unknown
  try {
    json = await response.json()
  } catch (err) {
    throw new Error(
      `iTunes Search API returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const data = json as { results?: unknown[] }
  const results = Array.isArray(data?.results) ? data.results : []
  const out: AlbumArtResult[] = []
  for (const item of results) {
    const r = item as Record<string, unknown>
    const thumbUrl = typeof r['artworkUrl100'] === 'string' ? r['artworkUrl100'] : null
    if (!thumbUrl) continue
    out.push({
      artist: typeof r['artistName'] === 'string' ? r['artistName'] : '',
      album: typeof r['collectionName'] === 'string' ? r['collectionName'] : '',
      thumbUrl,
      fullUrl: thumbUrl.replace('100x100', '600x600')
    })
  }
  return out
}

/**
 * Download album art from an mzstatic.com URL and write it into the chart. The URL is
 * validated to be HTTPS and on the mzstatic.com domain before any fetch is performed, because
 * renderer-supplied URLs must not become an arbitrary fetch-and-write primitive.
 *
 * `chartPath` is the catalog path: a folder for a folder chart, the archive file for a `.sng`.
 * `chartType` says which, and comes from the chart's catalog row rather than the path's suffix.
 *
 * `backupDir` is where the cover this supersedes is kept so the download can be undone, or
 * `null` for no undo; see `writeWithUndo` for why it cannot be left out.
 *
 * Returns the final path written: the asset file for a folder chart, the archive itself for
 * a `.sng`.
 */
export async function downloadArt(
  url: string,
  chartPath: string,
  chartType: 'folder' | 'sng',
  libraryFolders: { path: string }[],
  backupDir: string | null,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  // Defense: renderer-supplied URL must be HTTPS and on mzstatic.com.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid album art URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Album art URL must use HTTPS: ${url}`)
  }
  if (!parsed.hostname.endsWith('.mzstatic.com')) {
    throw new Error(`Album art URL hostname must end with .mzstatic.com: ${parsed.hostname}`)
  }

  const response = await fetchFn(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch album art: ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  let fileName: string
  if (contentType.includes('image/png')) {
    fileName = 'album.png'
  } else if (contentType.includes('image/jpeg')) {
    fileName = 'album.jpg'
  } else {
    throw new Error(`Unsupported album art content-type: ${contentType}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const data = new Uint8Array(arrayBuffer)
  // Before the chart is read, not only before it is written. The writers below re-assert this,
  // but the backup lists and hashes the chart first, and a renderer-supplied path must not be
  // read from outside the library any more than written to.
  assertUnderLibrary(chartPath, libraryFolders)
  // The cover the chart already had goes with the same write. Whether art arrives as PNG or JPEG
  // is the server's choice, not the chart's, so without this a chart that had album.jpg and is
  // sent a PNG keeps both files and the Issue Scanner reports multipleAlbumArt, seen on real
  // charts during M6's verification. Ordering is the writer's job: the removal only happens once
  // the new cover is in place, so a failed download cannot leave a chart with no cover at all.
  //
  // And before any of that, the cover being superseded is copied aside. The download used to be
  // the one write in the app that DELETED something of the user's with no way back: replacing a
  // cover with a worse one from iTunes was permanent. Now it is one undo away, from the Issues
  // tab, like the repairs.
  const chart = { chartPath, chartType, backupDir }
  return writeWithUndo(chart, 'art', async () => {
    // The names the write is about to replace or sweep, under the same pattern the sweep uses,
    // so what is kept is exactly what goes. See `replacementOf` for the one name that is kept
    // without going on Linux, and why.
    return {
      ...(await replacementOf(chart, fileName, ALBUM_ART_RE)),
      // The two writers directly rather than `writeChartFile`: that takes the chart's lock, and
      // `writeWithUndo` already holds it.
      write: async () =>
        chartType === 'sng'
          ? writeSngAsset(chartPath, fileName, data, libraryFolders, {
              removeMatching: ALBUM_ART_RE
            })
          : writeChartAsset(chartPath, fileName, data, libraryFolders, {
              removeMatching: ALBUM_ART_RE
            })
    }
  })
}
