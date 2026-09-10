import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { tmpDir } from '../../../test/helpers/tmp'
import {
  assertBackupSpace,
  backupBlobPath,
  backupDirPath,
  backupStoreBytes,
  beginBackup,
  clearBackups,
  deleteBackup,
  hashFile,
  isBackupId,
  listBackups,
  readBackup,
  stampChart,
  type BackupPlan,
  type FixBackup
} from './backup-store'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

const scratchDirs: string[] = []

function scratch(): string {
  const dir = tmpDir('backupstore')
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

function plan(over: Partial<BackupPlan> = {}): BackupPlan {
  return {
    code: 'albumArtSize',
    actionCode: 'albumArtSize',
    describe: "Re-encode this chart's album art to 512x512.",
    files: [
      { fileName: 'album.png', content: { kind: 'data', data: bytes('the original cover') } }
    ],
    ...over
  }
}

/** A chart that exists, because a committed backup stamps whatever is on disk at commit time. */
function folderChart(files: Record<string, Uint8Array> = {}): string {
  const dir = join(scratch(), 'Tester - Fixture')
  mkdirSync(dir, { recursive: true })
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data)
  return dir
}

async function commitOne(
  storeDir: string,
  chartPath: string,
  over: Partial<BackupPlan> = {}
): Promise<FixBackup> {
  const pending = await beginBackup(
    storeDir,
    { chartPath, chartType: 'folder', chartHash: 'abc123' },
    plan(over)
  )
  return await pending.commit()
}

describe('backup ids and the paths they resolve to', () => {
  it('refuses anything it did not issue', () => {
    // The id crosses IPC from the renderer, so the shape is validated rather than the path
    // escaped: a traversal attempt has nowhere to resolve to at all.
    for (const bad of [
      '',
      '..',
      '../../etc',
      'a/b',
      'kabcd-00112233445566',
      'KABCD-0011223344556677'
    ]) {
      expect(isBackupId(bad)).toBe(false)
      expect(backupDirPath('/store', bad)).toBe(null)
    }
  })

  it('resolves a blob only under an id it issued, and only under a name it writes', () => {
    const id = 'kabcd-0011223344556677'
    expect(isBackupId(id)).toBe(true)
    expect(backupBlobPath('/store', id, '0.bin')).toBe(`/store/${id}/0.bin`)
    for (const bad of ['../backup.json', 'backup.json', '0.bin.tmp', 'a.bin']) {
      expect(backupBlobPath('/store', id, bad)).toBe(null)
    }
  })
})

describe('beginBackup', () => {
  it('writes the bytes and records their hash, but nothing listable until commit', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart({ 'album.png': bytes('resized') })

    const pending = await beginBackup(
      store,
      { chartPath: chart, chartType: 'folder', chartHash: 'abc123' },
      plan()
    )

    // The blob is on disk (the repair is about to run and this is its safety net), but the
    // manifest is not, so a process that died here leaves an entry nothing will act on.
    expect(existsSync(join(store, pending.id, '0.bin'))).toBe(true)
    expect(listBackups(store)).toEqual([])

    const backup = await pending.commit()
    expect(listBackups(store).map((b) => b.id)).toEqual([backup.id])
    expect(backup.files[0].sha256).toBe(await hashFile(join(store, backup.id, '0.bin')))
    expect(readFileSync(join(store, backup.id, '0.bin'))).toEqual(Buffer.from('the original cover'))
  })

  it('copies a file and extracts a .sng entry as faithfully as it stores bytes', async () => {
    const store = join(scratch(), 'fix-backups')
    const root = scratch()
    const loose = join(root, 'video.mp4')
    const payload = new Uint8Array(1_200_000).map((_, i) => (i * 31 + 5) % 256)
    writeFileSync(loose, payload)
    const archive = join(root, 'fixture.sng')
    writeFileSync(
      archive,
      makeSng([{ fileName: 'desktop.ini', data: bytes('[song]\nname = J\n') }])
    )

    const pending = await beginBackup(
      store,
      { chartPath: root, chartType: 'folder', chartHash: null },
      plan({
        files: [
          { fileName: 'video.mp4', content: { kind: 'copyFile', path: loose } },
          { fileName: 'desktop.ini', content: { kind: 'sngEntry', sngPath: archive } }
        ]
      })
    )
    const backup = await pending.commit()

    // The `.sng` entry comes back DECRYPTED: the archive stores it XOR-masked, and a backup of
    // the masked bytes would restore into a folder chart as noise.
    expect(new Uint8Array(readFileSync(join(store, backup.id, '0.bin')))).toEqual(payload)
    expect(readFileSync(join(store, backup.id, '1.bin')).toString()).toBe('[song]\nname = J\n')
    expect(backup.sizeBytes).toBe(payload.length + '[song]\nname = J\n'.length)
  })

  it('leaves no half-written entry when a file it was told to copy is not there', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()

    await expect(
      beginBackup(
        store,
        { chartPath: chart, chartType: 'folder', chartHash: null },
        plan({
          files: [{ fileName: 'gone.png', content: { kind: 'copyFile', path: '/nope/gone' } }]
        })
      )
    ).rejects.toThrow()

    // Gone, not merely unlistable. A directory of orphaned blobs would be disk the user cannot
    // see and cannot reclaim except by clearing everything.
    expect(existsSync(store) ? readdirSync(store) : []).toEqual([])
  })

  it('names the missing entry when a .sng does not hold what it was asked to keep', async () => {
    const store = join(scratch(), 'fix-backups')
    const root = scratch()
    const archive = join(root, 'fixture.sng')
    writeFileSync(archive, makeSng([{ fileName: 'notes.chart', data: bytes('[Song]\n{\n}\n') }]))

    await expect(
      beginBackup(
        store,
        { chartPath: archive, chartType: 'sng', chartHash: null },
        plan({
          files: [{ fileName: 'video.mp4', content: { kind: 'sngEntry', sngPath: archive } }]
        })
      )
    ).rejects.toThrow(/has no entry named video\.mp4/)
  })

  it('discards on request', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()
    const pending = await beginBackup(
      store,
      { chartPath: chart, chartType: 'folder', chartHash: null },
      plan()
    )

    pending.discard()

    expect(existsSync(join(store, pending.id))).toBe(false)
  })
})

describe('the guard a commit stamps', () => {
  it('records what is there and what is absent, per file', async () => {
    const chart = folderChart({ 'video.webm': bytes('converted') })

    const guard = await stampChart(chart, 'folder', ['video.mp4', 'video.webm', 'video.webm'], [])

    expect(guard.chartType).toBe('folder')
    if (guard.chartType !== 'folder') throw new Error('unreachable')
    // Deduped: `files` and `remove` name the same file when a repair replaced one in place, and
    // two stamps of one name are two chances to disagree.
    expect(guard.files.map((f) => f.fileName)).toEqual(['video.mp4', 'video.webm'])
    // `null` is not "we did not look": it is the fact a badVideo restore depends on before it
    // writes a video.mp4 into the chart.
    expect(guard.files[0].stamp).toBe(null)
    expect(guard.files[1].stamp?.size).toBe('converted'.length)
  })

  it('stamps a .sng archive AND the parts an undo would touch', async () => {
    const root = scratch()
    const archive = join(root, 'fixture.sng')
    writeFileSync(
      archive,
      makeSng([{ fileName: 'album.png', data: bytes('cover bytes') }], { diff_bass: '4' })
    )

    const guard = await stampChart(
      archive,
      'sng',
      ['video.mp4', 'album.png'],
      ['diff_bass', 'diff_keys']
    )

    expect(guard.chartType).toBe('sng')
    if (guard.chartType !== 'sng') throw new Error('unreachable')
    // The strong check: an archive that has not moved proves nothing inside it has either.
    expect(guard.archive.size).toBeGreaterThan(0)
    // And the narrow one, for when it HAS moved, which happens the moment a second repair runs
    // on the same chart. Without it that second repair would strand the first undo forever.
    expect(guard.entries).toEqual([
      { fileName: 'video.mp4', byteLength: null },
      { fileName: 'album.png', byteLength: 'cover bytes'.length }
    ])
    expect(guard.metadata).toEqual([
      { key: 'diff_bass', value: '4' },
      { key: 'diff_keys', value: null }
    ])
  })

  it('refuses to stamp a .sng that is not there', async () => {
    await expect(stampChart('/nope/gone.sng', 'sng', [], [])).rejects.toThrow(
      /nothing to record an undo/
    )
  })
})

describe('listing, sizing and clearing the store', () => {
  it('is empty, and costs nothing, before anything has been repaired', () => {
    const store = join(scratch(), 'never-created')
    expect(listBackups(store)).toEqual([])
    expect(backupStoreBytes(store)).toBe(0)
  })

  it('returns the newest first and totals what they hold', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()

    const first = await commitOne(store, chart)
    const second = await commitOne(store, chart, {
      files: [{ fileName: 'song.ini', content: { kind: 'data', data: bytes('a longer original') } }]
    })

    const listed = listBackups(store)
    expect(listed).toHaveLength(2)
    // Newest first: the undo a user reaches for is almost always the repair they just ran.
    expect(listed[0].createdAt).toBeGreaterThanOrEqual(listed[1].createdAt)
    expect(new Set(listed.map((b) => b.id))).toEqual(new Set([first.id, second.id]))
    expect(backupStoreBytes(store)).toBe('the original cover'.length + 'a longer original'.length)
  })

  it("lists an asset writer's backup beside the repairs, with nothing but its code to tell them apart", async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart({ 'album.png': bytes('new cover') })

    // What `downloadArt` records: the cover it superseded, and the name it created.
    const pending = await beginBackup(
      store,
      { chartPath: chart, chartType: 'folder', chartHash: 'abc123' },
      {
        code: 'art',
        actionCode: 'art',
        describe: 'Album art',
        files: [{ fileName: 'album.jpg', content: { kind: 'data', data: bytes('old cover') } }],
        remove: ['album.png']
      }
    )
    const backup = await pending.commit()

    // The same manifest, read back by the same validator the repairs use. No second shape: the
    // undo list, Settings' total and the restore all work from this one.
    const [listed] = listBackups(store)
    expect(listed).toEqual(backup)
    expect(listed.code).toBe('art')
    expect(listed.actionCode).toBe('art')
    expect(listed.describe).toBe('Album art')
    expect(listed.remove).toEqual(['album.png'])
    expect(listed.guard).toEqual({
      chartType: 'folder',
      files: [
        { fileName: 'album.jpg', stamp: null },
        { fileName: 'album.png', stamp: expect.objectContaining({ size: 'new cover'.length }) }
      ]
    })
  })

  it('skips a directory whose manifest never landed, rather than refusing to list at all', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()
    const good = await commitOne(store, chart)
    // What a process killed mid-backup leaves: blobs, no manifest.
    mkdirSync(join(store, 'kabcd-0011223344556677'))
    writeFileSync(join(store, 'kabcd-0011223344556677', '0.bin'), 'orphan')
    // And something that is not ours at all.
    mkdirSync(join(store, 'not-a-backup'))

    // One bad entry must not take away every other undo the user has.
    expect(listBackups(store).map((b) => b.id)).toEqual([good.id])
  })

  it('skips a manifest missing a field the restore would have read as undefined', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()
    const backup = await commitOne(store, chart)
    const manifest = join(store, backup.id, 'backup.json')

    for (const broken of [
      '{ not json',
      JSON.stringify({ ...backup, guard: undefined }),
      JSON.stringify({ ...backup, files: [{ fileName: 'a', blob: '0.bin', byteLength: 1 }] }),
      JSON.stringify({ ...backup, files: [{ ...backup.files[0], blob: '../backup.json' }] }),
      JSON.stringify({ ...backup, chartType: 'archive' })
    ]) {
      writeFileSync(manifest, broken)
      expect(listBackups(store)).toEqual([])
      expect(readBackup(store, backup.id)).toBe(null)
    }
  })

  it('refuses a manifest that names a different backup than the one it sits in', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()
    const mine = await commitOne(store, chart)
    const theirs = await commitOne(store, chart, {
      files: [{ fileName: 'song.ini', content: { kind: 'data', data: bytes('someone else') } }]
    })

    // Everything downstream resolves blobs and deletes by `backup.id` rather than by the path the
    // manifest came from, so a manifest naming another entry would read that one's bytes and
    // delete that one's directory. The manifest is a file in userData a user can edit.
    writeFileSync(
      join(store, mine.id, 'backup.json'),
      JSON.stringify({ ...mine, id: theirs.id }, null, 2)
    )

    expect(readBackup(store, mine.id)).toBe(null)
    expect(listBackups(store).map((b) => b.id)).toEqual([theirs.id])
  })

  it('measures the disk it is really using, not the disk its manifests admit to', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()
    await commitOne(store, chart)
    // A backup cut short between its blobs and its manifest. The ones most likely to be cut
    // short are the large ones, because that is where the time goes. Summing manifests would tell
    // the user this store costs nothing while it held a video.
    mkdirSync(join(store, 'kabcd-0011223344556677'))
    writeFileSync(join(store, 'kabcd-0011223344556677', '0.bin'), Buffer.alloc(50_000))

    expect(listBackups(store)).toHaveLength(1)
    expect(backupStoreBytes(store)).toBe('the original cover'.length + 50_000)
  })

  it('deletes one entry, and only that one', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()
    const first = await commitOne(store, chart)
    const second = await commitOne(store, chart)

    deleteBackup(store, first.id)
    // An id that is not ours resolves to no path, so this cannot delete anything by mistake.
    deleteBackup(store, '../..')

    expect(listBackups(store).map((b) => b.id)).toEqual([second.id])
    expect(existsSync(join(store, first.id))).toBe(false)
  })

  it('clears everything, orphaned blobs included', async () => {
    const store = join(scratch(), 'fix-backups')
    const chart = folderChart()
    await commitOne(store, chart)
    mkdirSync(join(store, 'kabcd-0011223344556677'))
    // The blobs most likely to be orphaned are the big ones: a backup is interrupted while
    // copying a video, not while writing a song.ini. Clearing has to reclaim those too.
    writeFileSync(join(store, 'kabcd-0011223344556677', '0.bin'), 'orphan')

    clearBackups(store)

    expect(existsSync(store)).toBe(false)
    expect(listBackups(store)).toEqual([])
  })
})

describe('assertBackupSpace', () => {
  it('refuses a backup the volume cannot hold, naming both numbers', () => {
    expect(() => assertBackupSpace('/store', 200_000_000, 1_000)).toThrow(
      /200000000 bytes and 1000 bytes are free/
    )
    // And says what the user can do about it, since one of the two answers is inside Encore.
    expect(() => assertBackupSpace('/store', 200_000_000, 1_000)).toThrow(/clear.*undo history/i)
  })

  it('allows a backup that exactly fits', () => {
    expect(() => assertBackupSpace('/store', 1_000, 1_000)).not.toThrow()
  })

  it('does not refuse when the filesystem will not say', () => {
    // An unanswered question is not evidence of a full disk, and turning it into a blocked repair
    // would make Encore refuse to work somewhere it otherwise would.
    expect(() => assertBackupSpace('/store', 200_000_000, undefined)).not.toThrow()
  })
})
