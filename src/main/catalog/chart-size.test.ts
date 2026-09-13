import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tmpDir } from '../../../test/helpers/tmp'
import type { DuplicateCopy, DuplicateReport } from '../../shared/duplicates'
import { chartSizeOnDisk, withCopySizes } from './chart-size'

const copy = (path: string): DuplicateCopy => ({
  path,
  chartType: path.endsWith('.sng') ? 'sng' : 'folder',
  name: 'YYZ',
  artist: 'Rush',
  charter: 'Ann',
  album: null,
  songLength: null,
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
  totalCharts: 2,
  unidentifiedCharts: 0,
  ...fields
})

describe('chartSizeOnDisk', () => {
  it('sums a folder chart, subdirectories included', () => {
    const dir = join(tmpDir('size'), 'Rush - YYZ')
    mkdirSync(join(dir, 'extra'), { recursive: true })
    writeFileSync(join(dir, 'song.ini'), 'x'.repeat(40))
    writeFileSync(join(dir, 'notes.chart'), 'y'.repeat(60))
    writeFileSync(join(dir, 'extra', 'album.png'), 'z'.repeat(100))

    expect(chartSizeOnDisk(dir)).toBe(200)
  })

  it('reports a .sng as the size of the one file it is', () => {
    const path = join(tmpDir('size-sng'), 'Rush - YYZ.sng')
    writeFileSync(path, 'a'.repeat(512))

    expect(chartSizeOnDisk(path)).toBe(512)
  })

  it('does not follow a symlink out of the chart', () => {
    // A chart linking to something large elsewhere must not report those bytes as its own: the
    // number exists to be compared between two copies, and one that counted a link's target
    // would call a copy large that occupies nothing.
    const root = tmpDir('size-link')
    const big = join(root, 'elsewhere')
    mkdirSync(big, { recursive: true })
    writeFileSync(join(big, 'video.mp4'), 'v'.repeat(5000))
    const dir = join(root, 'Rush - YYZ')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'song.ini'), 'x'.repeat(10))
    symlinkSync(big, join(dir, 'linked'))

    expect(chartSizeOnDisk(dir)).toBe(10)
  })

  it('answers null for a chart that is not there', () => {
    // Null, never 0. Zero reads as "this copy is empty, take that one", which is a
    // recommendation, and about a path nothing could open it would be an invented one.
    expect(chartSizeOnDisk(join(tmpDir('size-missing'), 'gone'))).toBeNull()
  })
})

describe('withCopySizes', () => {
  it('sizes the identical tier and leaves the other two untouched', () => {
    // The cost argument, pinned: the report is two SQL statements, and a stat per chart in the
    // whole library behind it would put a filesystem walk under a query that answers in
    // milliseconds. Only the tier that offers a removal needs the number.
    const sizeOf = vi.fn(() => 1234)
    const before = report({
      identical: [{ checksum: 'a'.repeat(32), copies: [copy('/lib/a'), copy('/lib/b')] }],
      versions: [
        {
          artist: 'Rush',
          name: 'YYZ',
          charter: 'Ann',
          copies: [copy('/lib/c')],
          versionCount: 2,
          unknownCount: 0,
          identicalCopies: 0
        }
      ],
      alternates: [
        { artist: 'Rush', name: 'YYZ', charters: [{ charter: 'Bo', copies: [copy('/lib/d')] }] }
      ]
    })

    const after = withCopySizes(before, sizeOf)

    expect(after.identical[0].copies.map((c) => c.sizeBytes)).toEqual([1234, 1234])
    expect(after.versions[0].copies[0].sizeBytes).toBeNull()
    expect(after.alternates[0].charters[0].copies[0].sizeBytes).toBeNull()
    expect(sizeOf.mock.calls).toEqual([['/lib/a'], ['/lib/b']])
  })
})
