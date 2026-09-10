import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { tmpDir } from '../../../test/helpers/tmp'
import { scanChartIssues } from '../catalog/issues'
import { readSngForRepack } from '../downloads/sng'
import { listBackups } from '../issues/backup-store'
import { restoreBackup } from '../issues/restore'
import { writeBackground } from './background'

/**
 * The background write keeps the `background.png` it overwrites, and the repairs' restore puts
 * it back. Asserted on bytes, as the art and repair round trips are.
 */

const NOTES = new TextEncoder().encode(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n}\n'
)
const OLD = new Uint8Array([137, 80, 78, 71, 1, 1, 1])
const NEW = new Uint8Array([137, 80, 78, 71, 2, 2, 2, 2])

describe('writeBackground', () => {
  let root: string
  let library: string
  let chartDir: string
  let store: string

  beforeEach(() => {
    root = tmpDir('background')
    library = join(root, 'library')
    chartDir = join(library, 'Artist - Song (Charter)')
    mkdirSync(chartDir, { recursive: true })
    writeFileSync(join(chartDir, 'notes.chart'), NOTES)
    store = join(root, 'fix-backups')
  })

  const folders = (): { path: string }[] => [{ path: library }]

  async function undo(): Promise<void> {
    const backups = listBackups(store)
    expect(backups).toHaveLength(1)
    await restoreBackup({ storeDir: store, libraryFolders: folders() }, backups[0].id)
  }

  function sngAt(files: { fileName: string; data: Uint8Array }[]): string {
    const sngPath = join(library, 'Artist - Song.sng')
    writeFileSync(sngPath, makeSng(files, { name: 'Song', artist: 'Artist' }))
    return sngPath
  }

  it('writes background.png into a folder chart', async () => {
    await writeBackground(chartDir, 'folder', NEW, folders(), null)
    expect(new Uint8Array(readFileSync(join(chartDir, 'background.png')))).toEqual(NEW)
    expect(existsSync(store)).toBe(false)
  })

  it("puts a folder chart's previous background back, byte for byte", async () => {
    writeFileSync(join(chartDir, 'background.png'), OLD)
    const before = await scanChartIssues(chartDir, 'folder')

    await writeBackground(chartDir, 'folder', NEW, folders(), store)
    expect(new Uint8Array(readFileSync(join(chartDir, 'background.png')))).toEqual(NEW)

    const [backup] = listBackups(store)
    expect(backup.describe).toBe('Background')
    expect(backup.code).toBe('background')
    expect(backup.remove).toEqual([])

    await undo()

    expect(new Uint8Array(readFileSync(join(chartDir, 'background.png')))).toEqual(OLD)
    expect((await scanChartIssues(chartDir, 'folder')).chartHash).toBe(before.chartHash)
    expect(listBackups(store)).toEqual([])
  })

  it('removes the background from a folder chart that had none', async () => {
    await writeBackground(chartDir, 'folder', NEW, folders(), store)
    expect(listBackups(store)[0].remove).toEqual(['background.png'])

    await undo()

    expect(readdirSync(chartDir)).toEqual(['notes.chart'])
  })

  it('leaves a background.jpg alone: it is not the name this writer produces', async () => {
    const JPG = new Uint8Array([0xff, 0xd8, 0xff])
    writeFileSync(join(chartDir, 'background.jpg'), JPG)

    await writeBackground(chartDir, 'folder', NEW, folders(), store)
    expect(readdirSync(chartDir).sort()).toEqual([
      'background.jpg',
      'background.png',
      'notes.chart'
    ])
    expect(listBackups(store)[0].files).toEqual([])

    await undo()

    expect(readdirSync(chartDir).sort()).toEqual(['background.jpg', 'notes.chart'])
    expect(new Uint8Array(readFileSync(join(chartDir, 'background.jpg')))).toEqual(JPG)
  })

  it("puts a .sng chart's previous background back, byte for byte, through a repack", async () => {
    const sngPath = sngAt([
      { fileName: 'notes.chart', data: NOTES },
      { fileName: 'background.png', data: OLD }
    ])
    const before = await scanChartIssues(sngPath, 'sng')

    await writeBackground(sngPath, 'sng', NEW, folders(), store)
    const written = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(written.entries.find((e) => e.fileName === 'background.png')?.data).toEqual(NEW)

    await undo()

    const back = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(back.entries.map((e) => e.fileName).sort()).toEqual(['background.png', 'notes.chart'])
    expect(back.entries.find((e) => e.fileName === 'background.png')?.data).toEqual(OLD)
    expect(back.entries.find((e) => e.fileName === 'notes.chart')?.data).toEqual(NOTES)
    expect((await scanChartIssues(sngPath, 'sng')).chartHash).toBe(before.chartHash)
  })

  it('removes the background from a .sng chart that had none', async () => {
    const sngPath = sngAt([{ fileName: 'notes.chart', data: NOTES }])

    await writeBackground(sngPath, 'sng', NEW, folders(), store)
    await undo()

    const back = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(back.entries.map((e) => e.fileName)).toEqual(['notes.chart'])
  })

  it('fails the write, with the chart untouched, when the backup cannot be taken', async () => {
    writeFileSync(join(chartDir, 'background.png'), OLD)
    writeFileSync(store, 'not a directory')

    await expect(writeBackground(chartDir, 'folder', NEW, folders(), store)).rejects.toThrow()

    expect(new Uint8Array(readFileSync(join(chartDir, 'background.png')))).toEqual(OLD)
  })

  it('refuses a chart outside the library before anything is written or kept', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    await expect(writeBackground(outside, 'folder', NEW, folders(), store)).rejects.toThrow(
      /library/i
    )
    expect(readdirSync(outside)).toEqual([])
    // Refused before the backup ran, so the chart was never read and the store never made.
    expect(existsSync(store)).toBe(false)
  })
})
