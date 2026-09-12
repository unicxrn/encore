import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChartRecordSchema, type ChartRecord } from '../../shared/schemas'
import { tmpDir } from '../../../test/helpers/tmp'
import { openCatalog, type CatalogDb } from './db'
import { findDuplicates } from './duplicates'
import { upsertChart } from './queries'

/**
 * Every test here runs against a real SQLite file, not a stub.
 *
 * The whole of this module is SQL, including the parts that decide which tier a chart lands in,
 * so a fake database would test the shaping code and none of the thing being shipped. The file
 * comes from `tmpDir()` so the run's scratch is removed wholesale; see test/helpers/tmp.ts for
 * why `mkdtempSync` directly is not an option here.
 */
const chart = (
  path: string,
  fields: Partial<ChartRecord> & { name?: string | null; artist?: string | null }
): ChartRecord =>
  ChartRecordSchema.parse({
    path,
    chartType: path.endsWith('.sng') ? 'sng' : 'folder',
    folderHash: 'h',
    modifiedTime: 1,
    ...fields
  })

const md5 = (seed: string): string => seed.repeat(32).slice(0, 32)

describe('duplicate detection', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('dupes'), 'catalog.db'))
  })

  it('says no when a library holds no duplicates at all', () => {
    upsertChart(
      db,
      chart('/lib/a', { name: 'YYZ', artist: 'Rush', charter: 'Ann', cloneHeroChecksum: md5('a') })
    )
    upsertChart(
      db,
      chart('/lib/b', {
        name: 'Everlong',
        artist: 'Foo Fighters',
        charter: 'Bo',
        cloneHeroChecksum: md5('b')
      })
    )
    upsertChart(
      db,
      chart('/lib/c', {
        name: 'Painkiller',
        artist: 'Judas Priest',
        charter: 'Cy',
        cloneHeroChecksum: md5('c')
      })
    )

    const report = findDuplicates(db)
    expect(report.identical).toEqual([])
    expect(report.versions).toEqual([])
    expect(report.alternates).toEqual([])
    expect(report.totalCharts).toBe(3)
    expect(report.unidentifiedCharts).toBe(0)
  })

  it('says no on an empty catalog rather than throwing on the SUM over no rows', () => {
    const report = findDuplicates(db)
    expect(report.totalCharts).toBe(0)
    expect(report.unidentifiedCharts).toBe(0)
    expect(report.identical).toEqual([])
  })

  describe('tier 1: the same chart file installed twice', () => {
    it('groups two copies on the Clone Hero checksum', () => {
      upsertChart(
        db,
        chart('/lib/yyz', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/yyz copy', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )

      const report = findDuplicates(db)
      expect(report.identical).toHaveLength(1)
      expect(report.identical[0].checksum).toBe(md5('a'))
      expect(report.identical[0].copies.map((c) => c.path)).toEqual(['/lib/yyz', '/lib/yyz copy'])
      // One chart file under two names is not two versions of anything.
      expect(report.versions).toEqual([])
    })

    it('matches on the chart file even when the metadata around it was edited', () => {
      // The case metadata grouping cannot reach: one copy renamed and retagged on the way in.
      // The notes are the same bytes, so the game sees one chart twice.
      upsertChart(
        db,
        chart('/lib/one', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/two', {
          name: 'Y Y Z (live)',
          artist: 'RUSH',
          charter: 'anon',
          cloneHeroChecksum: md5('a')
        })
      )

      const report = findDuplicates(db)
      expect(report.identical).toHaveLength(1)
      expect(report.identical[0].copies).toHaveLength(2)
    })

    it('covers both chart shapes, a folder and a .sng, in one group', () => {
      upsertChart(
        db,
        chart('/lib/yyz', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/yyz.sng', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )

      const [group] = findDuplicates(db).identical
      expect(group.copies.map((c) => c.chartType).sort()).toEqual(['folder', 'sng'])
    })

    it('never groups two charts that simply have no checksum yet', () => {
      // Null is "not known", and treating two unknowns as equal would report a library scanned
      // before scan version 7 as one enormous pile of identical charts.
      upsertChart(db, chart('/lib/a', { name: 'YYZ', artist: 'Rush', charter: 'Ann' }))
      upsertChart(db, chart('/lib/b', { name: 'Tom Sawyer', artist: 'Rush', charter: 'Ann' }))

      const report = findDuplicates(db)
      expect(report.identical).toEqual([])
      expect(report.unidentifiedCharts).toBe(2)
    })

    it('puts the biggest group first', () => {
      for (const path of ['/lib/a1', '/lib/a2']) {
        upsertChart(
          db,
          chart(path, { name: 'A', artist: 'Band', charter: 'Ann', cloneHeroChecksum: md5('a') })
        )
      }
      for (const path of ['/lib/b1', '/lib/b2', '/lib/b3']) {
        upsertChart(
          db,
          chart(path, { name: 'B', artist: 'Band', charter: 'Ann', cloneHeroChecksum: md5('b') })
        )
      }

      expect(findDuplicates(db).identical.map((g) => g.copies.length)).toEqual([3, 2])
    })
  })

  describe('tier 2: different versions of one chart', () => {
    it('groups one charter two versions of a song, and keeps it out of tier 1', () => {
      upsertChart(
        db,
        chart('/lib/v1', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/v2', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('b')
        })
      )

      const report = findDuplicates(db)
      expect(report.identical).toEqual([])
      expect(report.versions).toHaveLength(1)
      expect(report.versions[0]).toMatchObject({
        artist: 'Rush',
        name: 'YYZ',
        charter: 'Ann',
        versionCount: 2,
        unknownCount: 0,
        identicalCopies: 0
      })
      // One charter is not two charters, so there is no alternate charts entry.
      expect(report.alternates).toEqual([])
    })

    it('matches the charter case-insensitively and through surrounding whitespace', () => {
      upsertChart(
        db,
        chart('/lib/v1', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/v2', {
          name: ' yyz ',
          artist: 'RUSH',
          charter: 'ANN ',
          cloneHeroChecksum: md5('b')
        })
      )

      const report = findDuplicates(db)
      expect(report.versions).toHaveLength(1)
      expect(report.versions[0].copies).toHaveLength(2)
      expect(report.alternates).toEqual([])
    })

    it('reports a copy it cannot compare as unknown rather than as a second version', () => {
      upsertChart(
        db,
        chart('/lib/v1', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(db, chart('/lib/v2', { name: 'YYZ', artist: 'Rush', charter: 'Ann' }))

      const [group] = findDuplicates(db).versions
      expect(group.versionCount).toBe(1)
      expect(group.unknownCount).toBe(1)
    })

    it('says how many of a version group are also byte-identical to each other', () => {
      // Three copies, two of them the same file. The pair belongs in both lists, and the version
      // group has to be able to say so rather than leaving the user to compare paths across two
      // sections of the report.
      upsertChart(
        db,
        chart('/lib/v1', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/v1 copy', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/v2', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('b')
        })
      )

      const report = findDuplicates(db)
      expect(report.identical).toHaveLength(1)
      expect(report.identical[0].copies).toHaveLength(2)
      expect(report.versions).toHaveLength(1)
      expect(report.versions[0]).toMatchObject({ versionCount: 2, identicalCopies: 2 })
      expect(report.versions[0].copies).toHaveLength(3)
    })

    it('does not claim two copies with no charter are one charter twice', () => {
      upsertChart(db, chart('/lib/a', { name: 'YYZ', artist: 'Rush', cloneHeroChecksum: md5('a') }))
      upsertChart(db, chart('/lib/b', { name: 'YYZ', artist: 'Rush', cloneHeroChecksum: md5('b') }))

      const report = findDuplicates(db)
      expect(report.versions).toEqual([])
      expect(report.alternates).toEqual([])
    })
  })

  describe('tier 3: the same song by different charters', () => {
    it('lists one entry per charter and reports nothing as waste', () => {
      upsertChart(
        db,
        chart('/lib/ann', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/bo', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Bo',
          cloneHeroChecksum: md5('b')
        })
      )

      const report = findDuplicates(db)
      expect(report.identical).toEqual([])
      // Two people charting one song is not one chart at two versions, and must never be filed
      // under a heading that says it is.
      expect(report.versions).toEqual([])
      expect(report.alternates).toHaveLength(1)
      expect(report.alternates[0].charters.map((c) => c.charter).sort()).toEqual(['Ann', 'Bo'])
    })

    it('holds a charter with two versions of their own chart inside the song entry', () => {
      upsertChart(
        db,
        chart('/lib/ann1', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/ann2', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('b')
        })
      )
      upsertChart(
        db,
        chart('/lib/bo', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Bo',
          cloneHeroChecksum: md5('c')
        })
      )

      const report = findDuplicates(db)
      expect(report.versions).toHaveLength(1)
      expect(report.versions[0].charter).toBe('Ann')
      expect(report.alternates).toHaveLength(1)
      const ann = report.alternates[0].charters.find((c) => c.charter === 'Ann')
      expect(ann?.copies).toHaveLength(2)
    })

    it('does not invent a second charter out of a copy that names none', () => {
      upsertChart(
        db,
        chart('/lib/ann', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/mystery', { name: 'YYZ', artist: 'Rush', cloneHeroChecksum: md5('b') })
      )

      expect(findDuplicates(db).alternates).toEqual([])
    })

    it('keeps two different songs apart even when one artist charted both', () => {
      upsertChart(
        db,
        chart('/lib/a', {
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          cloneHeroChecksum: md5('a')
        })
      )
      upsertChart(
        db,
        chart('/lib/b', {
          name: 'Tom Sawyer',
          artist: 'Rush',
          charter: 'Bo',
          cloneHeroChecksum: md5('b')
        })
      )

      expect(findDuplicates(db).alternates).toEqual([])
    })
  })

  describe('charts that carry no metadata to group on', () => {
    it('does not pile every untagged chart into one song group', () => {
      // The failure this guards: grouping on a null artist and a null title puts every chart
      // whose song.ini is empty into a single group and reports the lot as duplicates.
      for (const path of ['/lib/a', '/lib/b', '/lib/c']) {
        upsertChart(db, chart(path, { cloneHeroChecksum: md5(path.slice(-1)) }))
      }

      const report = findDuplicates(db)
      expect(report.versions).toEqual([])
      expect(report.alternates).toEqual([])
    })

    it('ignores a blank artist the same way it ignores a missing one', () => {
      upsertChart(
        db,
        chart('/lib/a', { name: 'YYZ', artist: '   ', charter: 'Ann', cloneHeroChecksum: md5('a') })
      )
      upsertChart(
        db,
        chart('/lib/b', { name: 'YYZ', artist: '', charter: 'Ann', cloneHeroChecksum: md5('b') })
      )

      expect(findDuplicates(db).versions).toEqual([])
    })
  })

  /**
   * The shape of the work, on a library the size of a real one.
   *
   * The bound is deliberately loose, because a timing assertion on a shared machine is a flaky
   * test waiting to happen. What it actually pins is the complexity: a pairwise implementation of
   * this over 20,000 rows is 200 million comparisons and cannot come in under a second, so this
   * fails long before it is merely slow. The measured figure on the development machine is in the
   * commit that added it, and is two orders of magnitude under this ceiling.
   */
  it('groups a 20,000 chart catalog in one pass', () => {
    const insert = db.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        upsertChart(
          db,
          chart(`/lib/chart-${i}`, {
            name: `Song ${i % 9_000}`,
            artist: `Artist ${i % 1_500}`,
            charter: `Charter ${i % 40}`,
            // A tenth of the library is a second copy of the chart before it.
            cloneHeroChecksum: (i % 10 === 0 && i > 0 ? i - 1 : i).toString(16).padStart(32, '0')
          })
        )
      }
    })
    insert()

    const started = performance.now()
    const report = findDuplicates(db)
    const elapsed = performance.now() - started

    expect(report.totalCharts).toBe(20_000)
    expect(report.identical.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(5_000)
  })
})
