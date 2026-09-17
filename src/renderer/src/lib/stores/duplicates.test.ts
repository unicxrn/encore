import { get, writable } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DuplicateCopy, DuplicateReport } from '../../../../shared/duplicates'
import type { JobProgress } from '../../../../shared/schemas'
import { scanProgress } from './scan'
import {
  dropDuplicateCopy,
  duplicates,
  duplicatesError,
  initDuplicates,
  loadDuplicates,
  spareCopies
} from './duplicates'

const copy = (path: string): DuplicateCopy => ({
  path,
  chartType: 'folder',
  name: 'YYZ',
  artist: 'Rush',
  charter: 'Ann',
  album: null,
  songLength: 300_000,
  modifiedTime: 1,
  cloneHeroChecksum: 'a'.repeat(32),
  hasAlbumArt: false,
  hasVideo: false,
  hasBackground: false,
  hasLyrics: false,
  sizeBytes: null
})

const report = (fields: Partial<DuplicateReport> = {}): DuplicateReport => ({
  identical: [],
  versions: [],
  alternates: [],
  totalCharts: 200,
  unidentifiedCharts: 0,
  ...fields
})

/** Two spare copies across two sets, which is three copies of two charts. */
const twoSets = (): DuplicateReport =>
  report({
    identical: [
      { checksum: 'a'.repeat(32), copies: [copy('/a'), copy('/a (1)'), copy('/a (2)')] },
      { checksum: 'b'.repeat(32), copies: [copy('/b'), copy('/b (1)')] }
    ]
  })

const job = (status: JobProgress['status'], percent: number): JobProgress => ({
  jobId: 'scan-1',
  kind: 'scan',
  phase: 'scanning',
  percent,
  message: null,
  status
})

/**
 * The bridge as this store sees it. Assigned onto `globalThis.window` the way app-update's tests
 * do it: this project runs under node, where there is no window for a bare `encore` global to
 * hang off and `bridge.ts` reads `window.encore`.
 */
function stub(answer: () => Promise<unknown>): ReturnType<typeof vi.fn> {
  const catalogDuplicates = vi.fn(answer)
  ;(globalThis as Record<string, unknown>).window = { encore: { catalogDuplicates } }
  return catalogDuplicates
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  duplicates.set(null)
  duplicatesError.set(null)
  scanProgress.set(null)
})

describe('the duplicate report store', () => {
  it('holds nothing until a read answers, which is not the same as holding nothing found', () => {
    expect(get(duplicates)).toBeNull()
    expect(get(spareCopies)).toBeNull()
  })

  it('counts every copy past the first in each byte-identical set', async () => {
    stub(() => Promise.resolve(twoSets()))
    await loadDuplicates()

    expect(get(spareCopies)).toBe(3)
  })

  /**
   * The count the sidebar draws is about spare copies and nothing else.
   *
   * Two charts of one song by two charters is not a fault, and a version group is two different
   * charts. Either one added into this number would put a badge on the sidebar that the view
   * itself refuses to call spare.
   */
  it('counts neither alternate charters nor separate versions', async () => {
    stub(() =>
      Promise.resolve(
        report({
          versions: [
            {
              artist: 'Rush',
              name: 'YYZ',
              charter: 'Ann',
              copies: [copy('/v1'), copy('/v2')],
              versionCount: 2,
              unknownCount: 0,
              identicalCopies: 0
            }
          ],
          alternates: [
            {
              artist: 'Rush',
              name: 'YYZ',
              charters: [
                { charter: 'Ann', copies: [copy('/ann')] },
                { charter: 'Bo', copies: [copy('/bo')] }
              ]
            }
          ]
        })
      )
    )
    await loadDuplicates()

    expect(get(spareCopies)).toBe(0)
  })

  it('leaves the last good report alone when a read fails, and says why', async () => {
    stub(() => Promise.resolve(twoSets()))
    await loadDuplicates()

    stub(() => Promise.reject(new Error('no ipc')))
    await loadDuplicates()

    expect(get(duplicatesError)).toBe('no ipc')
    expect(get(spareCopies)).toBe(3)
  })

  it('clears an earlier failure once a read answers', async () => {
    stub(() => Promise.reject(new Error('no ipc')))
    await loadDuplicates()
    stub(() => Promise.resolve(twoSets()))
    await loadDuplicates()

    expect(get(duplicatesError)).toBeNull()
  })
})

/**
 * An answer that is not a report.
 *
 * `spareCopies` reads three fields off whatever this store holds, and it reads them inside a
 * store notification. svelte/store's notification queue is module-global, so an exception
 * escaping one leaves it non-empty and every `set` in the renderer afterwards notifies nobody:
 * the app keeps running and stops redrawing. This read happens at launch, so the window would be
 * frozen before the user pressed anything. The canary at the end of each case is the whole point.
 */
describe('a duplicate read answered with something that is not a report', () => {
  const badAnswers: [string, unknown][] = [
    ['nothing at all', undefined],
    ['no identical list', { versions: [], alternates: [], totalCharts: 0 }],
    ['identical not a list', { identical: null, versions: [], alternates: [] }],
    ['a set with no copies', { identical: [{ checksum: 'a' }], versions: [], alternates: [] }]
  ]
  for (const [what, answer] of badAnswers) {
    it(`reports ${what} as a failed read and leaves the last report alone`, async () => {
      stub(() => Promise.resolve(twoSets()))
      await loadDuplicates()
      // The sidebar holds this subscription for the life of the launch, which is what makes the
      // count run inside the notification rather than on the next read.
      const stop = spareCopies.subscribe(() => {})

      stub(() => Promise.resolve(answer))
      await loadDuplicates()

      expect(get(duplicatesError)).toContain('invalid answer')
      expect(get(spareCopies)).toBe(3)
      stop()

      // One throw inside a notification stops every store in the renderer, this one included.
      const canary = writable(0)
      let heard = 0
      const stopCanary = canary.subscribe((v) => (heard = v))
      canary.set(7)
      stopCanary()
      expect(heard).toBe(7)
    })
  }
})

describe('dropping a copy that was removed', () => {
  it('takes the copy out and the set with it once one copy is left', async () => {
    stub(() => Promise.resolve(twoSets()))
    await loadDuplicates()

    dropDuplicateCopy('/b (1)')

    // The three-copy set keeps two spares; the pair is no longer a duplicate of anything.
    expect(get(duplicates)?.identical.map((g) => g.copies.length)).toEqual([3])
    expect(get(spareCopies)).toBe(2)
    expect(get(duplicates)?.totalCharts).toBe(199)
  })

  it('does nothing at all before a report has arrived', () => {
    dropDuplicateCopy('/b (1)')
    expect(get(duplicates)).toBeNull()
  })
})

describe('when the report is re-read', () => {
  it('reads once on init and again when a scan stops, not while one runs', async () => {
    const ask = stub(() => Promise.resolve(twoSets()))
    const off = initDuplicates()
    await Promise.resolve()
    expect(ask).toHaveBeenCalledTimes(1)

    scanProgress.set(job('running', 10))
    expect(ask).toHaveBeenCalledTimes(1)

    scanProgress.set(job('done', 100))
    expect(ask).toHaveBeenCalledTimes(2)

    off()
  })

  // A cancelled scan keeps every row it wrote, so the catalog really has moved.
  it('re-reads after a cancelled scan too', async () => {
    const ask = stub(() => Promise.resolve(twoSets()))
    const off = initDuplicates()
    await Promise.resolve()

    scanProgress.set(job('canceled', 40))
    expect(ask).toHaveBeenCalledTimes(2)

    off()
  })

  it('stops re-reading once the subscription is dropped', async () => {
    const ask = stub(() => Promise.resolve(twoSets()))
    initDuplicates()()
    await Promise.resolve()

    scanProgress.set(job('done', 100))
    expect(ask).toHaveBeenCalledTimes(1)
  })
})
