import { describe, expect, it } from 'vitest'
import { libraryGap } from './empty-state'

describe('libraryGap', () => {
  it('reports no-folder before anything else, even mid-scan', () => {
    expect(libraryGap({ folderCount: 0, libraryTotal: 0, scanFinished: true })).toBe('no-folder')
  })

  it('still reports no-folder when a stale catalog holds rows', () => {
    // Removing the last folder in Settings does not empty the catalog, so this combination is
    // reachable. The user cannot act on the rows; they can act on the missing folder.
    expect(libraryGap({ folderCount: 0, libraryTotal: 207, scanFinished: false })).toBe('no-folder')
  })

  it('blames the view, not the library, once the catalog holds charts', () => {
    expect(libraryGap({ folderCount: 1, libraryTotal: 207, scanFinished: false })).toBeNull()
    expect(libraryGap({ folderCount: 1, libraryTotal: 207, scanFinished: true })).toBeNull()
  })

  it('separates a configured-but-empty catalog from a scan that came back empty', () => {
    expect(libraryGap({ folderCount: 1, libraryTotal: 0, scanFinished: false })).toBe(
      'empty-catalog'
    )
    expect(libraryGap({ folderCount: 1, libraryTotal: 0, scanFinished: true })).toBe(
      'scan-found-nothing'
    )
  })
})
