import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { ART_SCHEME } from '../shared/art'
import { artFilePath } from './catalog/art-cache'

/**
 * Answer one `encore-art://<md5>` request.
 *
 * Exported separately from registration so it can be tested without booting Electron. The
 * module does import electron (under vitest that resolves to a stub whose only export is the
 * binary's path as a string, leaving `protocol` undefined), so what makes this testable is that
 * nothing on this path reads `protocol`, not the absence of the import. Adding an electron call
 * at module scope, or to this function, would break the tests below.
 *
 * Always resolves to a Response; it never rejects.
 */
export async function handleArtRequest(artDir: string, url: string): Promise<Response> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    // Some hosts are unparseable rather than merely invalid ('[', a backslash, a NUL). Chromium
    // only hands protocol.handle URLs it has already parsed, so reaching this means a direct
    // caller, but the contract above is worth more than the shortcut.
    return new Response(null, { status: 400 })
  }
  // The md5 is the host component and the path is discarded, so a traversal has to get through
  // artFilePath's shape check to go anywhere, including a percent-encoded one, which survives
  // URL parsing intact where a literal ../ is collapsed away. That check also refuses an
  // uppercase hash rather than folding it; Chromium canonicalises the host to lowercase before
  // any real request arrives, so that branch is defence-in-depth for direct callers only.
  const file = artFilePath(artDir, host)
  if (file === null) return new Response(null, { status: 400 })
  try {
    const data = await readFile(file)
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        // Every cached file is a JPEG rendition regardless of the source image's format.
        'Content-Type': 'image/jpeg',
        // The md5 names a source image and ART_CACHE_VERSION segments the directory by encode
        // settings, so the bytes behind a given URL never change within one app version.
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    })
  } catch {
    // A chart row can outlive its art file (cache cleared, ART_CACHE_VERSION bumped, sweep
    // raced). A missing image is a placeholder in the UI, not an error dialog.
    return new Response(null, { status: 404 })
  }
}

/**
 * Must run BEFORE app.whenReady(), or the scheme is not treated as standard and the md5 never
 * reaches the host component that handleArtRequest reads.
 */
export function registerArtScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** Must run AFTER app.whenReady(), and before the first window loads. */
export function registerArtProtocol(artDir: string): void {
  protocol.handle(ART_SCHEME, (request) => handleArtRequest(artDir, request.url))
}
