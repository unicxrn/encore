import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { tmpDir } from '../../../test/helpers/tmp'
import { listBackups } from '../issues/backup-store'
import { chartFileNames, replacementOf, writeWithUndo, type UndoableChart } from './undoable-write'
import { pendingChartLockCount } from './write'

/**
 * The framework the three asset writers share, tested on its own terms: the ORDER of backup and
 * write, and what each failure leaves behind. The writers' own tests (art, background, lyrics)
 * prove the round trip on bytes; these prove the promise that makes the round trip possible:
 * a write that cannot be backed up does not happen.
 */

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

const NOTES = bytes(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n}\n'
)

function folderChart(files: Record<string, Uint8Array> = {}): UndoableChart & { store: string } {
  const root = tmpDir('undoable')
  const chartPath = join(root, 'Tester - Fixture')
  mkdirSync(chartPath)
  for (const [name, data] of Object.entries({ 'notes.chart': NOTES, ...files })) {
    writeFileSync(join(chartPath, name), data)
  }
  const store = join(root, 'fix-backups')
  return { chartPath, chartType: 'folder', backupDir: store, store }
}

function sngChart(files: Record<string, Uint8Array> = {}): UndoableChart & { store: string } {
  const root = tmpDir('undoable-sng')
  const chartPath = join(root, 'fixture.sng')
  writeFileSync(
    chartPath,
    makeSng(
      Object.entries({ 'notes.chart': NOTES, ...files }).map(([fileName, data]) => ({
        fileName,
        data
      })),
      { name: 'Fixture' }
    )
  )
  const store = join(root, 'fix-backups')
  return { chartPath, chartType: 'sng', backupDir: store, store }
}

describe('writeWithUndo', () => {
  it("backs up before writing, and lists the backup under the kind's noun", async () => {
    const chart = folderChart({ 'background.png': bytes('old') })
    const order: string[] = []

    await writeWithUndo(chart, 'background', async () => ({
      files: [
        {
          fileName: 'background.png',
          content: { kind: 'copyFile', path: join(chart.chartPath, 'background.png') }
        }
      ],
      write: async () => {
        // By the time the write runs, the original is already in the store.
        order.push(readdirSync(chart.store).length > 0 ? 'backup-first' : 'write-first')
        writeFileSync(join(chart.chartPath, 'background.png'), bytes('new'))
      }
    }))

    expect(order).toEqual(['backup-first'])
    const [backup] = listBackups(chart.store)
    expect(backup.code).toBe('background')
    expect(backup.actionCode).toBe('background')
    expect(backup.describe).toBe('Background')
    expect(backup.chartHash).not.toBeNull()
    expect(readFileSync(join(chart.store, backup.id, backup.files[0].blob), 'utf8')).toBe('old')
  })

  it('fails the write, with the chart untouched, when the backup cannot be taken', async () => {
    const chart = folderChart({ 'background.png': bytes('old') })
    // A file where the store should be: `mkdirSync` cannot make a directory of it.
    writeFileSync(chart.store, 'not a directory')
    let wrote = false

    await expect(
      writeWithUndo(chart, 'background', async () => ({
        files: [
          {
            fileName: 'background.png',
            content: { kind: 'copyFile', path: join(chart.chartPath, 'background.png') }
          }
        ],
        write: async () => {
          wrote = true
        }
      }))
    ).rejects.toThrow()

    expect(wrote).toBe(false)
    expect(readFileSync(join(chart.chartPath, 'background.png'), 'utf8')).toBe('old')
  })

  it('fails the write when a file it claims to replace is not there to back up', async () => {
    // The caller listed a name the chart does not hold. Copying it is what fails, and it fails
    // before the write: a backup that claims to hold a file it never copied is not a backup.
    const chart = folderChart()
    let wrote = false

    await expect(
      writeWithUndo(chart, 'art', async () => ({
        files: [
          {
            fileName: 'album.png',
            content: { kind: 'copyFile', path: join(chart.chartPath, 'album.png') }
          }
        ],
        write: async () => {
          wrote = true
        }
      }))
    ).rejects.toThrow(/ENOENT/)

    expect(wrote).toBe(false)
    expect(existsSync(chart.store) ? listBackups(chart.store) : []).toEqual([])
  })

  it("discards the backup when the write itself fails, and rethrows the write's error", async () => {
    const chart = folderChart({ 'background.png': bytes('old') })

    await expect(
      writeWithUndo(chart, 'background', async () => ({
        files: [
          {
            fileName: 'background.png',
            content: { kind: 'copyFile', path: join(chart.chartPath, 'background.png') }
          }
        ],
        write: async () => {
          throw new Error('disk on fire')
        }
      }))
    ).rejects.toThrow('disk on fire')

    // Nothing to undo, so nothing kept: not even the blobs of an uncommitted backup.
    expect(readdirSync(chart.store)).toEqual([])
    expect(readFileSync(join(chart.chartPath, 'background.png'), 'utf8')).toBe('old')
  })

  it('reports both halves when the write landed but the manifest could not', async () => {
    const chart = folderChart({ 'background.png': bytes('old') })
    let backupDir: string | undefined

    await expect(
      writeWithUndo(chart, 'background', async () => ({
        files: [
          {
            fileName: 'background.png',
            content: { kind: 'copyFile', path: join(chart.chartPath, 'background.png') }
          }
        ],
        write: async () => {
          writeFileSync(join(chart.chartPath, 'background.png'), bytes('new'))
          // The backup's own directory, made read-only so the manifest cannot be written into it.
          backupDir = join(chart.store, readdirSync(chart.store)[0])
          chmodSync(backupDir, 0o500)
        }
      }))
    ).rejects.toThrow(/was written, but Encore could not save what the write replaced/)

    if (backupDir !== undefined) chmodSync(backupDir, 0o700)
    // The write is not rolled back (it happened), and the incomplete backup is invisible.
    expect(readFileSync(join(chart.chartPath, 'background.png'), 'utf8')).toBe('new')
    expect(listBackups(chart.store)).toEqual([])
  })

  it('writes without a store when backupDir is null, and creates none', async () => {
    const chart = folderChart({ 'background.png': bytes('old') })

    await writeWithUndo({ ...chart, backupDir: null }, 'background', async () => ({
      files: [
        {
          fileName: 'background.png',
          content: { kind: 'copyFile', path: join(chart.chartPath, 'background.png') }
        }
      ],
      write: async () => {
        writeFileSync(join(chart.chartPath, 'background.png'), bytes('new'))
      }
    }))

    expect(readFileSync(join(chart.chartPath, 'background.png'), 'utf8')).toBe('new')
    expect(existsSync(chart.store)).toBe(false)
  })

  it("holds the chart's write lock across the backup and the write", async () => {
    const chart = folderChart()
    let lockedDuringWrite = 0

    await writeWithUndo({ ...chart, backupDir: null }, 'background', async () => ({
      files: [],
      write: async () => {
        lockedDuringWrite = pendingChartLockCount()
      }
    }))

    expect(lockedDuringWrite).toBe(1)
    expect(pendingChartLockCount()).toBe(0)
  })
})

describe('replacementOf', () => {
  it('keeps the file under the exact name, and marks nothing for removal', async () => {
    const chart = folderChart({ 'background.png': bytes('old') })
    const plan = await replacementOf(chart, 'background.png')
    expect(plan.files.map((f) => f.fileName)).toEqual(['background.png'])
    expect(plan.remove).toEqual([])
  })

  it('keeps nothing and marks the new name for removal when the chart has no such file', async () => {
    const chart = folderChart()
    const plan = await replacementOf(chart, 'background.png')
    expect(plan.files).toEqual([])
    expect(plan.remove).toEqual(['background.png'])
  })

  it('keeps the names the write supersedes, under their own names', async () => {
    const chart = folderChart({ 'album.jpg': bytes('jpg'), 'Album.jpeg': bytes('jpeg') })
    const plan = await replacementOf(chart, 'album.png', /^album\.(png|jpe?g)$/i)
    expect(plan.files.map((f) => f.fileName).sort()).toEqual(['Album.jpeg', 'album.jpg'])
    expect(plan.remove).toEqual(['album.png'])
  })

  it('keeps a case-variant of the incoming name in a folder chart, and asks the filesystem whether the name exists', async () => {
    // `Album.PNG` is the file `album.png` renames over on Windows, and a separate file here.
    // Kept either way; whether the write creates a new name is the filesystem's answer, which on
    // Linux is yes.
    const chart = folderChart({ 'Album.PNG': bytes('variant') })
    const plan = await replacementOf(chart, 'album.png', /^album\.(png|jpe?g)$/i)
    expect(plan.files.map((f) => f.fileName)).toEqual(['Album.PNG'])
    expect(plan.remove).toEqual(['album.png'])
  })

  it('matches .sng entry names exactly, as the repacker does', async () => {
    const chart = sngChart({ 'Album.PNG': bytes('variant'), 'album.jpg': bytes('jpg') })
    const plan = await replacementOf(chart, 'album.png', /^album\.(png|jpe?g)$/i)
    // The variant is neither replaced nor swept by the repacker, so it is not kept either.
    expect(plan.files.map((f) => f.fileName)).toEqual(['album.jpg'])
    expect(plan.files[0].content).toEqual({ kind: 'sngEntry', sngPath: chart.chartPath })
    expect(plan.remove).toEqual(['album.png'])
  })

  it('does not treat a directory as a file to keep, but does treat it as the name being taken', async () => {
    const chart = folderChart()
    mkdirSync(join(chart.chartPath, 'album.png'))
    const plan = await replacementOf(chart, 'album.png')
    expect(plan.files).toEqual([])
    // The write onto it is going to fail; what matters is that a backup taken first does not
    // then promise to delete a directory it never created.
    expect(plan.remove).toEqual([])
  })
})

describe('chartFileNames', () => {
  it("lists a folder chart's files and not its directories", async () => {
    const chart = folderChart({ 'album.png': bytes('png') })
    mkdirSync(join(chart.chartPath, 'stems'))
    expect((await chartFileNames(chart)).sort()).toEqual(['album.png', 'notes.chart'])
  })

  it("lists a .sng chart's entries", async () => {
    const chart = sngChart({ 'album.png': bytes('png') })
    expect((await chartFileNames(chart)).sort()).toEqual(['album.png', 'notes.chart'])
  })
})
