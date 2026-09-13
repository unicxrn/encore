import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChartRecordSchema, type ChartRecord } from '../../shared/schemas'
import { tmpDir } from '../../../test/helpers/tmp'
import { openCatalog, type CatalogDb } from './db'
import { getChartByPath, upsertChart } from './queries'
import { removeChart } from './remove-chart'

/**
 * Real files in a real scratch library, with one thing stubbed: the trash.
 *
 * `shell.trashItem` is the only call here that must not run, because a test that passed would
 * leave fixtures in the machine's actual Trash, and a test that failed would leave them
 * somewhere nobody looks. The stub stands in for it and, in the failure test, throws the way
 * Electron does on a filesystem with no trash. Everything else (the chart on disk, the catalog
 * row, the containment check) is the real thing.
 */

const chart = (path: string): ChartRecord =>
  ChartRecordSchema.parse({
    path,
    chartType: path.endsWith('.sng') ? 'sng' : 'folder',
    folderHash: 'h',
    modifiedTime: 1,
    name: 'YYZ',
    artist: 'Rush',
    charter: 'Ann'
  })

describe('removeChart', () => {
  let db: CatalogDb
  let library: string

  beforeEach(() => {
    const root = tmpDir('remove-chart')
    library = join(root, 'library')
    mkdirSync(library, { recursive: true })
    db = openCatalog(join(root, 'catalog.db'))
  })

  /** A folder chart with a couple of files in it, registered in the catalog. */
  function folderChart(name = 'Rush - YYZ'): string {
    const path = join(library, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'song.ini'), '[song]\nname = YYZ\n')
    writeFileSync(join(path, 'notes.chart'), 'chart')
    upsertChart(db, chart(path))
    return path
  }

  function sngChart(name = 'Rush - YYZ.sng'): string {
    const path = join(library, name)
    writeFileSync(path, 'SNGPK')
    upsertChart(db, chart(path))
    return path
  }

  const folders = (): { path: string }[] => [{ path: library }]

  it('trashes a folder chart and then forgets its row', async () => {
    const path = folderChart()
    // The stub takes the place of the OS move, so it has to leave the disk as the real call
    // would: with the chart gone.
    const trash = vi.fn(async (target: string) => {
      rmSync(target, { recursive: true })
    })

    const result = await removeChart(db, path, folders(), { trash })

    expect(result).toEqual({ path, outcome: 'trashed' })
    expect(trash).toHaveBeenCalledWith(path)
    expect(existsSync(path)).toBe(false)
    expect(getChartByPath(db, path)).toBeNull()
  })

  it('trashes a .sng, which is one file rather than a directory', async () => {
    const path = sngChart()
    const trash = vi.fn(async (target: string) => {
      rmSync(target)
    })

    const result = await removeChart(db, path, folders(), { trash })

    expect(result).toEqual({ path, outcome: 'trashed' })
    expect(existsSync(path)).toBe(false)
    expect(getChartByPath(db, path)).toBeNull()
  })

  it('leaves both the chart and its row alone when the trash fails', async () => {
    // The case the whole design turns on. There is no unlink to fall back to, so a failure here
    // has to end with the library exactly as it started: the chart still on disk AND still in
    // the catalog, which is what keeps it visible in Installed and findable next time.
    const path = folderChart()
    const trash = vi.fn(() => Promise.reject(new Error('Failed to move item to trash')))

    await expect(removeChart(db, path, folders(), { trash })).rejects.toThrow(
      'Failed to move item to trash'
    )

    expect(existsSync(path)).toBe(true)
    expect(getChartByPath(db, path)?.path).toBe(path)
  })

  it('removes the row without a trash when the chart has already left the disk', async () => {
    const path = folderChart()
    rmSync(path, { recursive: true })
    const trash = vi.fn(() => Promise.resolve())

    const result = await removeChart(db, path, folders(), { trash })

    expect(result).toEqual({ path, outcome: 'already-gone' })
    // Nothing was asked of the trash, because there was nothing left to hand it. Reporting this
    // as a failure would put an error in front of a user with nothing to do about it.
    expect(trash).not.toHaveBeenCalled()
    expect(getChartByPath(db, path)).toBeNull()
  })

  it('refuses a path outside the library folders, and touches nothing', async () => {
    // The refusal that matters most: the path arrives from the renderer, and this is the only
    // thing standing between a bad one and a `shell.trashItem` call on it.
    const outside = join(tmpDir('remove-outside'), 'Not - Yours')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'song.ini'), 'x')
    upsertChart(db, chart(outside))
    const trash = vi.fn(() => Promise.resolve())

    await expect(removeChart(db, outside, folders(), { trash })).rejects.toThrow(
      /Refusing to remove a path outside the library folders/
    )

    expect(trash).not.toHaveBeenCalled()
    expect(existsSync(outside)).toBe(true)
    expect(getChartByPath(db, outside)?.path).toBe(outside)
  })

  it('refuses a chart reached by climbing out of a library folder', async () => {
    // `..` is the spelling a containment check has to survive, and the one a check written as a
    // string prefix would let through. isUnderLibrary resolves the path before comparing.
    const outsideRoot = tmpDir('remove-climb')
    const target = join(outsideRoot, 'Not - Yours')
    mkdirSync(target, { recursive: true })
    const climbed = join(library, '..', '..', ...target.split('/').slice(-2))
    const trash = vi.fn(() => Promise.resolve())

    await expect(removeChart(db, climbed, folders(), { trash })).rejects.toThrow(
      /Refusing to remove a path outside the library folders/
    )
    expect(trash).not.toHaveBeenCalled()
  })

  it('refuses a sibling folder whose name starts with a library folder name', async () => {
    // `/lib-evil` is not under `/lib`, and a check comparing raw prefixes would say it is.
    const sibling = `${library}-evil`
    mkdirSync(sibling, { recursive: true })
    const path = join(sibling, 'Rush - YYZ')
    mkdirSync(path, { recursive: true })
    const trash = vi.fn(() => Promise.resolve())

    await expect(removeChart(db, path, folders(), { trash })).rejects.toThrow(
      /Refusing to remove a path outside the library folders/
    )
    expect(trash).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(true)
  })

  it('does not touch the play history of the chart it removes', async () => {
    // Plays are keyed on the Clone Hero checksum, not on the path, and the Stats page
    // deliberately still names charts the library no longer holds. A removal that tidied them
    // away would be editing the record of what someone played.
    const path = folderChart()
    const checksum = 'a'.repeat(32)
    db.prepare(`INSERT INTO plays (checksum, playedAt, songName) VALUES (?, ?, ?)`).run(
      checksum,
      '2026-01-01T00:00:00.000Z',
      'YYZ'
    )
    const trash = vi.fn(async (target: string) => {
      rmSync(target, { recursive: true })
    })

    await removeChart(db, path, folders(), { trash })

    const plays = db.prepare(`SELECT COUNT(*) AS n FROM plays`).get() as { n: number }
    expect(plays.n).toBe(1)
  })
})
