/**
 * Why a view that lists local charts has nothing to show, in the cases where the answer is the
 * library itself rather than the view's own filters.
 *
 * Installed, Asset Studio and Home's library row all bottom out on the same catalog, and all
 * three used to answer an empty list with one sentence. That sentence was wrong in two
 * directions at once: it told a user with 207 charts and a filter typed in to go add a library
 * folder, and it told a user with no library at all that every chart they own already has its
 * assets. Deciding the reason in one place is what stops the two from being confused again.
 *
 * - `no-folder`: nothing is configured, and no scan can help until a folder is chosen.
 * - `empty-catalog`: a folder is configured but the catalog holds nothing. Deliberately does
 *   not claim the user never scanned: a scan that ran in an earlier session and found nothing
 *   is indistinguishable from one that never ran, because nothing about it is persisted.
 * - `scan-found-nothing`: a scan finished during this session and the catalog is still empty,
 *   which is the one case where the folder itself can be named as the problem.
 */
export type LibraryGap = 'no-folder' | 'empty-catalog' | 'scan-found-nothing'

/**
 * `null` means the library is fine and holds charts. In that case it is the view's own filter,
 * search or scope that emptied the list, and the view has to say so in its own words. Only
 * the view knows which of its controls to name.
 *
 * `libraryTotal` is the count with the view's filters removed, not the count on screen.
 */
export function libraryGap(input: {
  folderCount: number
  libraryTotal: number
  scanFinished: boolean
}): LibraryGap | null {
  // Ahead of everything else: a filter over a library that was never configured is still
  // answered by configuring one, and naming the filter would send the user to the wrong control.
  if (input.folderCount === 0) return 'no-folder'
  if (input.libraryTotal > 0) return null
  return input.scanFinished ? 'scan-found-nothing' : 'empty-catalog'
}
