import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { readSngForRepack } from '../downloads/sng'
import {
  pendingChartLockCount,
  removeChartFiles,
  withChartLock,
  writeChartAsset,
  writeChartFile
} from './write'
import { tmpDir } from '../../../test/helpers/tmp'

// assertUnderLibrary's own tests live in library-guard.test.ts, alongside the module it moved to.

describe('writeChartAsset', () => {
  let root: string
  let library: string
  let chartDir: string

  beforeEach(() => {
    root = tmpDir('write')
    library = join(root, 'library')
    chartDir = join(library, 'Artist - Song (Charter)')
    mkdirSync(chartDir, { recursive: true })
  })

  const folders = (): { path: string }[] => [{ path: library }]

  it('writes the asset atomically and returns the final path', () => {
    const data = new Uint8Array([1, 2, 3, 4])
    const finalPath = writeChartAsset(chartDir, 'video.mp4', data, folders())
    expect(finalPath).toBe(join(chartDir, 'video.mp4'))
    expect(new Uint8Array(readFileSync(finalPath))).toEqual(data)
    // No stray tmp files left behind.
    expect(readdirSync(chartDir)).toEqual(['video.mp4'])
  })

  it('overwrites an existing asset', () => {
    writeChartAsset(chartDir, 'album.png', new Uint8Array([1]), folders())
    writeChartAsset(chartDir, 'album.png', new Uint8Array([9, 9]), folders())
    expect(new Uint8Array(readFileSync(join(chartDir, 'album.png')))).toEqual(
      new Uint8Array([9, 9])
    )
  })

  it('rejects a chartDir outside the library without writing', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    expect(() => writeChartAsset(outside, 'video.mp4', new Uint8Array([1]), folders())).toThrow(
      /library/i
    )
    expect(existsSync(join(outside, 'video.mp4'))).toBe(false)
  })

  it.each(['../evil.png', 'sub/evil.png', 'sub\\evil.png', '..', '.', ''])(
    'rejects non-bare file name %j',
    (name) => {
      expect(() => writeChartAsset(chartDir, name, new Uint8Array([1]), folders())).toThrow(
        /file name/i
      )
    }
  )
})

describe('writeChartFile', () => {
  const NOTES = {
    fileName: 'notes.chart',
    data: new TextEncoder().encode('[Song]\n{\n  Resolution = 192\n}\n')
  }
  const ART = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7])
  const BACKGROUND = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 8, 8])

  it('writes into a folder chart as a sibling file', async () => {
    const dir = tmpDir('dispatch')
    const chartDir = join(dir, 'Artist - Song')
    mkdirSync(chartDir)
    const written = await writeChartFile(chartDir, 'folder', 'album.png', ART, [{ path: dir }])
    expect(written).toBe(join(chartDir, 'album.png'))
    expect(new Uint8Array(readFileSync(written))).toEqual(ART)
  })

  it('writes into a .sng chart by repacking the archive', async () => {
    const dir = tmpDir('dispatch2')
    const sngPath = join(dir, 'Artist - Song.sng')
    writeFileSync(sngPath, makeSng([NOTES], { name: 'Song' }))
    const written = await writeChartFile(sngPath, 'sng', 'album.png', ART, [{ path: dir }])
    expect(written).toBe(sngPath)
    const back = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(back.entries.map((e) => e.fileName).sort()).toEqual(['album.png', 'notes.chart'])
    expect(back.entries.find((e) => e.fileName === 'album.png')?.data).toEqual(ART)
    expect(back.metadata.name).toBe('Song')
  })

  // The folder branch delegates to a synchronous writer; if the dispatcher ever stopped
  // returning a promise, `await` would silently paper over it here but not at the call sites
  // that chain .catch() onto the result.
  it('returns a promise for both chart types', () => {
    const dir = tmpDir('dispatch3')
    const chartDir = join(dir, 'Artist - Song')
    mkdirSync(chartDir)
    const pending = writeChartFile(chartDir, 'folder', 'album.png', ART, [{ path: dir }])
    expect(pending).toBeInstanceOf(Promise)
    return pending
  })

  it('rejects rather than throws synchronously when the folder write is refused', async () => {
    const dir = tmpDir('dispatch4')
    const chartDir = join(dir, 'Artist - Song')
    mkdirSync(chartDir)
    await expect(
      writeChartFile(chartDir, 'folder', '../evil.png', ART, [{ path: dir }])
    ).rejects.toThrow(/file name/i)
  })

  // A repack reads the whole archive, rebuilds it from that snapshot and renames the result over
  // the original. Two writers racing on one chart therefore both start from the SAME original,
  // and the later rename discards whatever the earlier one added, with both reporting success.
  // Reachable from two clicks in Asset Studio (the art picker has no busy guard), so it is a
  // lost update the user can hit, not a batch-only hazard.
  it('keeps both assets when two writes race on one .sng', async () => {
    const dir = tmpDir('race')
    const sngPath = join(dir, 'Artist - Song.sng')
    writeFileSync(sngPath, makeSng([NOTES], { name: 'Song' }))
    const folders = [{ path: dir }]

    const outcomes = await Promise.allSettled([
      writeChartFile(sngPath, 'sng', 'album.png', ART, folders),
      writeChartFile(sngPath, 'sng', 'background.png', BACKGROUND, folders)
    ])

    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled'])
    const back = await readSngForRepack(new Uint8Array(readFileSync(sngPath)))
    expect(back.entries.map((e) => e.fileName).sort()).toEqual([
      'album.png',
      'background.png',
      'notes.chart'
    ])
    expect(back.entries.find((e) => e.fileName === 'album.png')?.data).toEqual(ART)
    expect(back.entries.find((e) => e.fileName === 'background.png')?.data).toEqual(BACKGROUND)
  })
})

describe('withChartLock', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir('lock')
  })

  /** A task that reports when it started and only finishes when released. */
  function gated(log: string[], name: string): { run: () => Promise<string>; release: () => void } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    return {
      run: async () => {
        log.push(`start ${name}`)
        await gate
        log.push(`end ${name}`)
        return name
      },
      release
    }
  }

  it('holds the second write on one chart until the first finishes', async () => {
    const log: string[] = []
    const path = join(dir, 'Artist - Song.sng')
    const first = gated(log, 'a')
    const second = gated(log, 'b')

    const a = withChartLock(path, first.run)
    const b = withChartLock(path, second.run)
    // Let every microtask that could run without a release run.
    await new Promise((r) => setImmediate(r))
    expect(log).toEqual(['start a'])

    first.release()
    second.release()
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b'])
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  // The lock is per chart, not a global write mutex: a batch grinding through one large archive
  // must not stall an unrelated chart's write behind it.
  it('lets two different charts run at the same time', async () => {
    const log: string[] = []
    const first = gated(log, 'a')
    const second = gated(log, 'b')

    const a = withChartLock(join(dir, 'One.sng'), first.run)
    const b = withChartLock(join(dir, 'Two.sng'), second.run)
    // b runs to completion while a is still held open.
    second.release()
    await expect(b).resolves.toBe('b')
    expect(log).toEqual(['start a', 'start b', 'end b'])

    first.release()
    await expect(a).resolves.toBe('a')
  })

  // Two spellings of one chart must not take two locks, or the serialisation above is defeated
  // by a caller that happened to build its path differently.
  it('treats different spellings of one chart as the same lock', async () => {
    const log: string[] = []
    const first = gated(log, 'a')
    const second = gated(log, 'b')

    const a = withChartLock(join(dir, 'Artist - Song.sng'), first.run)
    const b = withChartLock(join(dir, 'sub', '..', '.', 'Artist - Song.sng'), second.run)
    await new Promise((r) => setImmediate(r))
    expect(log).toEqual(['start a'])

    first.release()
    second.release()
    await Promise.all([a, b])
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  // A failed repack must reject for ITS caller and leave the queue behind it intact: a chain
  // that propagated the rejection would fail every later write on that chart for the life of
  // the process.
  it('rejects for the failing caller without poisoning the next write', async () => {
    const path = join(dir, 'Artist - Song.sng')
    const boom = withChartLock(path, async () => {
      throw new Error('repack failed')
    })
    const after = withChartLock(path, async () => 'ok')

    await expect(boom).rejects.toThrow('repack failed')
    await expect(after).resolves.toBe('ok')
  })

  it('rejects rather than throws when the write throws synchronously', async () => {
    await expect(
      withChartLock(join(dir, 'Artist - Song.sng'), () => {
        throw new Error('sync boom')
      })
    ).rejects.toThrow('sync boom')
  })

  // The map is keyed on chart path, so an unbounded one would grow with every chart the app
  // ever writes to.
  it('drops a chart from the lock map once its writes settle', async () => {
    const before = pendingChartLockCount()
    const path = join(dir, 'Artist - Song.sng')

    const held = withChartLock(path, async () => 'first')
    const queued = withChartLock(path, async () => {
      throw new Error('second failed')
    })
    expect(pendingChartLockCount()).toBe(before + 1)

    await Promise.allSettled([held, queued])
    // The cleanup is queued on the chain settling, so it lands a microtask later.
    await new Promise((r) => setImmediate(r))
    expect(pendingChartLockCount()).toBe(before)
  })
})

describe('removeChartFiles', () => {
  let root: string
  let library: string
  let chartDir: string

  beforeEach(() => {
    root = tmpDir('remove')
    library = join(root, 'library')
    chartDir = join(library, 'Artist - Song (Charter)')
    mkdirSync(chartDir, { recursive: true })
    writeFileSync(join(chartDir, 'song.ini'), 'x')
    writeFileSync(join(chartDir, 'desktop.ini'), 'y')
  })

  const folders = (): { path: string }[] => [{ path: library }]

  it('removes the named files and nothing else', () => {
    removeChartFiles(chartDir, ['desktop.ini'], folders())

    expect(readdirSync(chartDir)).toEqual(['song.ini'])
  })

  it('refuses a chart outside the library', () => {
    const outside = join(root, 'elsewhere')
    mkdirSync(outside)
    writeFileSync(join(outside, 'desktop.ini'), 'y')

    expect(() => removeChartFiles(outside, ['desktop.ini'], folders())).toThrow()
    expect(existsSync(join(outside, 'desktop.ini'))).toBe(true)
  })

  it.each(['../song.ini', 'sub/song.ini', '..', '.', ''])(
    'refuses %s rather than letting a name walk out of the chart',
    (name) => {
      expect(() => removeChartFiles(chartDir, [name], folders())).toThrow(/bare name/)
      expect(readdirSync(chartDir).sort()).toEqual(['desktop.ini', 'song.ini'])
    }
  )

  it('validates every name before removing any of them', () => {
    // Otherwise a bad name at the end of the list leaves the caller with half the deletion done
    // and an error saying it failed.
    expect(() => removeChartFiles(chartDir, ['desktop.ini', '../x'], folders())).toThrow(
      /bare name/
    )
    expect(readdirSync(chartDir).sort()).toEqual(['desktop.ini', 'song.ini'])
  })

  it("refuses a directory sharing a file's name", () => {
    mkdirSync(join(chartDir, 'notes.ini'))

    expect(() => removeChartFiles(chartDir, ['notes.ini'], folders())).toThrow(/is a directory/)
    expect(existsSync(join(chartDir, 'notes.ini'))).toBe(true)
  })

  it('does not swallow a failure the way the stale-sibling sweep does', () => {
    // That sweep is cleanup after a write that already succeeded. Here the removal IS what the
    // caller asked for, so reporting success on a file that is still there would be a lie.
    expect(() => removeChartFiles(chartDir, ['not-here.ini'], folders())).toThrow()
  })
})
