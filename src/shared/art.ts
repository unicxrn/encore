/**
 * Album art is served over a custom scheme rather than IPC or data: URLs.
 *
 * The renderer asks for an image by content hash and the main process streams the file, so a
 * list of a hundred rows costs a hundred cheap GETs the browser caches, instead of a hundred
 * IPC round trips or base64 blobs inflating every catalog query by ~35%.
 */
export const ART_SCHEME = 'encore-art'

/**
 * `null` when the chart has no art, so callers can use `{#if}` on the result directly.
 *
 * The md5 goes in the authority, not the path: the scheme is registered as standard, and only
 * standard schemes get a host component for the handler to read back.
 */
export function artUrl(md5: string | null | undefined): string | null {
  return md5 ? `${ART_SCHEME}://${md5}` : null
}
