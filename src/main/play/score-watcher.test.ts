import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpDir } from '../../../test/helpers/tmp'
import { buildScoreData, buildScoresExt, type ChartSpec } from '../../../test/helpers/score-files'
import {
  scoreDataPathsIn,
  SCORES_EXT_BACKUP_FILE,
  SCORES_EXT_FILE,
  SCORE_DATA_BACKUP_FILE,
  SCORE_DATA_FILE
} from './location'
import type { ChartBest } from './scoredata'
import type { ScoreImportResult } from './score-store'
import { ScoreFileWatcher } from './score-watcher'

/**
 * The watcher, over a scratch directory standing in for Unity's data directory.
 *
 * The store is an in-memory stand-in, as `watcher.test.ts` does for the plays table: what is
 * under test here is which reads happen, what each one decides, and that nothing is written back
 * to the files. The diff itself is tested against a real database in score-store.test.ts.
 */

const SKRTING = 'e54e9a0521444e81bd1fed4f3f3a3201'

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    checksum: SKRTING,
    playCount: 2,
    rows: [
      {
        variant: 0,
        difficulty: 3,
        percent: 51,
        isFullCombo: false,
        playbackSpeed: 100,
        stars: 2,
        variantFlag: 1,
        score: 40100,
        reportedScore: 40122
      }
    ],
    ...over
  }
}

interface Harness {
  dir: string
  watcher: ScoreFileWatcher
  imported: ChartBest[][]
  onImport: ReturnType<typeof vi.fn>
  write: (charts: ChartSpec[]) => void
  writeBackup: (charts: ChartSpec[]) => void
}

function harness(opts: { dirExists?: boolean } = {}): Harness {
  const root = tmpDir('score-watcher')
  const dir = join(root, 'Clone Hero')
  if (opts.dirExists !== false) mkdirSync(dir, { recursive: true })
  const imported: ChartBest[][] = []
  const onImport = vi.fn()
  // Stands in for the store's diff: the second import of the same records writes nothing.
  let stored = ''
  const importCharts = (charts: ChartBest[]): ScoreImportResult => {
    imported.push(charts)
    const next = JSON.stringify(charts)
    const wrote = next !== stored
    stored = next
    return {
      charts: charts.length,
      rows: charts.reduce((n, c) => n + c.rows.length, 0),
      added: wrote ? charts.length : 0,
      updated: 0,
      removed: 0,
      wrote
    }
  }
  const write = (charts: ChartSpec[]): void => {
    writeFileSync(join(dir, SCORE_DATA_FILE), buildScoreData(charts))
    writeFileSync(join(dir, SCORES_EXT_FILE), buildScoresExt(charts))
  }
  // What the game keeps a save behind, written on its own so a test can put the backups and the
  // primaries at different states, which is the only state any of this is about.
  const writeBackup = (charts: ChartSpec[]): void => {
    writeFileSync(join(dir, SCORE_DATA_BACKUP_FILE), buildScoreData(charts))
    writeFileSync(join(dir, SCORES_EXT_BACKUP_FILE), buildScoresExt(charts))
  }
  return {
    dir,
    watcher: new ScoreFileWatcher({ paths: scoreDataPathsIn(dir), importCharts, onImport }),
    imported,
    onImport,
    write,
    writeBackup
  }
}

const open: ScoreFileWatcher[] = []
afterEach(async () => {
  for (const w of open.splice(0)) await w.stop()
})

describe('ScoreFileWatcher.refresh', () => {
  it('imports what the pair of files holds', async () => {
    const h = harness()
    h.write([spec()])
    expect(await h.watcher.refresh()).toBe(true)
    expect(h.watcher.reason).toBe('ok')
    expect(h.imported).toHaveLength(1)
    expect(h.imported[0][0]).toMatchObject({ checksum: SKRTING, playCount: 2 })
    // scoresext's score, not scoredata's: the game reports 40122 and scoredata holds the figure
    // before the clean play bonus.
    expect(h.imported[0][0].rows[0]).toMatchObject({
      score: 40122,
      scoreWithoutCleanPlayBonus: 40100
    })
  })

  it('records nothing new when the files say what was already stored', async () => {
    // Every read after the first, for a whole session. The reason stays ok: the read succeeded,
    // there was simply nothing to write.
    const h = harness()
    h.write([spec()])
    await h.watcher.refresh()
    expect(await h.watcher.refresh()).toBe(false)
    expect(h.watcher.reason).toBe('ok')
    expect(h.onImport).toHaveBeenCalledTimes(1)
  })

  it('imports again once a play has moved the count', async () => {
    const h = harness()
    h.write([spec()])
    await h.watcher.refresh()
    h.write([spec({ playCount: 3 })])
    expect(await h.watcher.refresh()).toBe(true)
    expect(h.imported[1][0].playCount).toBe(3)
    expect(h.onImport).toHaveBeenCalledTimes(2)
  })

  it('reports an absent file as noFile, not as a fault', async () => {
    // The ordinary case: no Clone Hero on this machine, or one that has never written a score.
    const h = harness()
    expect(await h.watcher.refresh()).toBe(false)
    expect(h.watcher.reason).toBe('noFile')
    expect(h.imported).toEqual([])
  })

  it('reports a missing companion file as noFile too', async () => {
    // scoresext.bin is the newer of the two. A Clone Hero old enough to write only scoredata.bin
    // has nothing this can decode, and the pair is all or nothing.
    const h = harness()
    writeFileSync(join(h.dir, SCORE_DATA_FILE), buildScoreData([spec()]))
    expect(await h.watcher.refresh()).toBe(false)
    expect(h.watcher.reason).toBe('noFile')
  })

  it('imports nothing from a file that refuses to parse', async () => {
    // Trailing bytes: the parser refuses the whole file rather than returning the records it
    // walked, because a file that decoded into plausible numbers by accident is the failure to
    // avoid. Deliberately not noFile, which would send a user looking for an install they have.
    const h = harness()
    h.write([spec()])
    writeFileSync(
      join(h.dir, SCORE_DATA_FILE),
      Uint8Array.from([...buildScoreData([spec()]), 0, 0])
    )
    expect(await h.watcher.refresh()).toBe(false)
    expect(h.watcher.reason).toBe('unreadable')
    expect(h.imported).toEqual([])
  })

  it('imports nothing from a torn pair, and recovers on the next read', async () => {
    // The one hazard a two-file read has: the game writes both, and a read landing between the
    // writes gets one current file and one stale one. The merge refuses rather than pairing a
    // chart's score with its neighbour's.
    const h = harness()
    h.write([spec()])
    // scoredata.bin now knows a chart scoresext.bin has never heard of, which is what a read
    // landing between the game's two writes sees.
    writeFileSync(
      join(h.dir, SCORE_DATA_FILE),
      buildScoreData([spec(), spec({ checksum: '5c8056b089373b38fc272824180be26c', playCount: 1 })])
    )
    expect(await h.watcher.refresh()).toBe(false)
    expect(h.watcher.reason).toBe('unreadable')
    h.write([spec({ playCount: 3 })])
    expect(await h.watcher.refresh()).toBe(true)
  })

  it('ignores the backup while the primary pair reads', async () => {
    // A backup is older than its primary by definition. Preferring one, or merging the two, would
    // drop plays that are sitting in a file Encore can read perfectly well.
    const h = harness()
    h.write([spec({ playCount: 9 })])
    h.writeBackup([spec({ playCount: 1 })])
    expect(await h.watcher.refresh()).toBe(true)
    expect(h.imported[0][0].playCount).toBe(9)
    expect(h.watcher.usedBackup).toBe(false)
  })

  it('falls back to the backup when the primary refuses to parse', async () => {
    // Clone Hero keeps the backup for exactly this, and reporting nothing while it sits there
    // would be a choice rather than a limit. The numbers are a save behind, and say so.
    const h = harness()
    h.write([spec()])
    h.writeBackup([spec({ playCount: 1 })])
    writeFileSync(
      join(h.dir, SCORE_DATA_FILE),
      Uint8Array.from([...buildScoreData([spec()]), 0, 0])
    )
    expect(await h.watcher.refresh()).toBe(true)
    expect(h.watcher.reason).toBe('ok')
    expect(h.watcher.usedBackup).toBe(true)
    expect(h.imported[0][0].playCount).toBe(1)
  })

  it('pairs a live file with the other half of the backup when the merge accepts it', async () => {
    // The mixed pair. scoresext.bin is unreadable, its backup describes the same charts and the
    // same rows, and the merge is the judge: it either lines up or it refuses. Here it lines up,
    // and the score is the older one while the play count is the live one.
    const h = harness()
    h.write([spec({ playCount: 9 })])
    h.writeBackup([spec({ playCount: 1, rows: [{ ...spec().rows[0], reportedScore: 30000 }] })])
    writeFileSync(join(h.dir, SCORES_EXT_FILE), Uint8Array.from([1, 2, 3]))
    expect(await h.watcher.refresh()).toBe(true)
    expect(h.watcher.usedBackup).toBe(true)
    expect(h.imported[0][0].playCount).toBe(9)
    expect(h.imported[0][0].rows[0].score).toBe(30000)
  })

  it('refuses a mixed pair the merge does not accept', async () => {
    // The other half of the rule above, and the reason a mixed pair is safe to try at all: a
    // backup taken before a chart was ever played describes a different library, and pairing it
    // with the live file would attach one chart's score to another's.
    const h = harness()
    h.write([spec()])
    // Only the one backup exists, so there is no backup pair to fall through to: the mixed pair
    // is the last combination there is, and it has to be refused rather than half joined.
    writeFileSync(
      join(h.dir, SCORES_EXT_BACKUP_FILE),
      buildScoresExt([spec({ checksum: '5c8056b089373b38fc272824180be26c' })])
    )
    writeFileSync(join(h.dir, SCORES_EXT_FILE), Uint8Array.from([1, 2, 3]))
    expect(await h.watcher.refresh()).toBe(false)
    expect(h.watcher.reason).toBe('unreadable')
    expect(h.imported).toEqual([])
  })

  it('reports unreadable when the primary and its backup both refuse', async () => {
    const h = harness()
    h.write([spec()])
    h.writeBackup([spec()])
    writeFileSync(join(h.dir, SCORE_DATA_FILE), Uint8Array.from([9, 9, 9]))
    writeFileSync(join(h.dir, SCORE_DATA_BACKUP_FILE), Uint8Array.from([9, 9, 9]))
    expect(await h.watcher.refresh()).toBe(false)
    expect(h.watcher.reason).toBe('unreadable')
    expect(h.imported).toEqual([])
  })

  it('reads a backup whose primary is not there at all', async () => {
    // Not a hypothetical: the game renames a file it considers damaged out of the way, which
    // leaves the backup as the only copy of that half of the pair.
    const h = harness()
    h.write([spec()])
    h.writeBackup([spec({ playCount: 1 })])
    rmSync(join(h.dir, SCORE_DATA_FILE))
    expect(await h.watcher.refresh()).toBe(true)
    expect(h.watcher.usedBackup).toBe(true)
    expect(h.imported[0][0].playCount).toBe(1)
  })

  it('never reads a quarantined file, even one that would parse', async () => {
    // scoredata_corrupted_<n>.bin is what the game renames a file to when IT could not read the
    // file. Encore does not read them, and a folder holding nothing else is a folder with no
    // score data in it, whatever the bytes inside happen to say.
    const h = harness()
    h.write([spec()])
    rmSync(join(h.dir, SCORE_DATA_FILE))
    writeFileSync(join(h.dir, 'scoredata_corrupted_0.bin'), buildScoreData([spec()]))
    expect(await h.watcher.refresh()).toBe(false)
    expect(h.watcher.reason).toBe('noFile')
    expect(h.imported).toEqual([])
  })

  it('drops the backup flag as soon as a primary read succeeds again', async () => {
    // The flag describes the last successful read, not the session. A user who repairs their
    // install must stop being told the numbers are old.
    const h = harness()
    h.write([spec()])
    h.writeBackup([spec({ playCount: 1 })])
    writeFileSync(join(h.dir, SCORE_DATA_FILE), Uint8Array.from([9, 9, 9]))
    await h.watcher.refresh()
    expect(h.watcher.usedBackup).toBe(true)
    h.write([spec({ playCount: 12 })])
    expect(await h.watcher.refresh()).toBe(true)
    expect(h.watcher.usedBackup).toBe(false)
  })

  it('leaves the files exactly as it found them', async () => {
    // Import is a read. Nothing is ever written back to Clone Hero's own data.
    const h = harness()
    h.write([spec()])
    const before = [SCORE_DATA_FILE, SCORES_EXT_FILE].map((f) =>
      Buffer.from(readFileSync(join(h.dir, f)))
    )
    await h.watcher.refresh()
    const after = [SCORE_DATA_FILE, SCORES_EXT_FILE].map((f) =>
      Buffer.from(readFileSync(join(h.dir, f)))
    )
    expect(after[0].equals(before[0])).toBe(true)
    expect(after[1].equals(before[1])).toBe(true)
  })

  it('reports unknownPlatform and reads nothing when there are no paths', async () => {
    const watcher = new ScoreFileWatcher({
      paths: null,
      importCharts: () => {
        throw new Error('must not import')
      }
    })
    expect(await watcher.refresh()).toBe(false)
    expect(watcher.reason).toBe('unknownPlatform')
    expect(watcher.watchedPaths).toBeNull()
  })

  it('stamps the import time only once a read has succeeded', async () => {
    const h = harness()
    expect(h.watcher.lastImportAt).toBeNull()
    await h.watcher.refresh()
    expect(h.watcher.lastImportAt).toBeNull()
    h.write([spec()])
    await h.watcher.refresh()
    expect(h.watcher.lastImportAt).not.toBeNull()
  })
})

describe('ScoreFileWatcher.start', () => {
  it('imports before it watches, which is the only way old history is picked up', async () => {
    // The files change while Encore is closed, and that is the whole point of the feature. By
    // the time start() resolves the import has already run.
    const h = harness()
    open.push(h.watcher)
    h.write([spec({ playCount: 44 })])
    await h.watcher.start()
    expect(h.imported[0][0].playCount).toBe(44)
  })

  it('picks up a save made while it is running', async () => {
    const h = harness()
    open.push(h.watcher)
    h.write([spec()])
    await h.watcher.start()
    h.write([spec({ playCount: 5 })])
    await vi.waitFor(
      () => {
        expect(h.imported.at(-1)?.[0].playCount).toBe(5)
      },
      { timeout: 5000 }
    )
  })

  it('survives a directory that does not exist', async () => {
    // Most machines running Encore have no Clone Hero at all. Startup must not treat that as a
    // failure, and the watcher has to stay alive in case the directory appears.
    const h = harness({ dirExists: false })
    open.push(h.watcher)
    await expect(h.watcher.start()).resolves.toBeUndefined()
    expect(h.watcher.reason).toBe('noFile')
  })

  it('starts nothing at all when the platform has no location', async () => {
    const watcher = new ScoreFileWatcher({ paths: null, importCharts: () => IMPORT_NOTHING })
    open.push(watcher)
    await expect(watcher.start()).resolves.toBeUndefined()
    await expect(watcher.stop()).resolves.toBeUndefined()
  })
})

/**
 * Retargeting, which is what the score-folder setting does when it changes.
 *
 * The setting exists for users no probe can help. Making them restart to find out whether the
 * folder they picked worked would be most of the way back to failing silently, which is the
 * thing the setting is for.
 */
describe('ScoreFileWatcher.retarget', () => {
  it('reads the new folder and forgets the old one', async () => {
    const from = harness()
    const to = harness()
    from.write([spec({ playCount: 2 })])
    to.write([spec({ playCount: 40 })])
    await from.watcher.refresh()
    expect(from.imported.at(-1)?.[0].playCount).toBe(2)
    await from.watcher.retarget(scoreDataPathsIn(to.dir))
    expect(from.watcher.watchedFolder).toBe(to.dir)
    expect(from.imported.at(-1)?.[0].playCount).toBe(40)
  })

  it('goes back to reporting nothing when the folder is cleared to none', async () => {
    // What a cleared override looks like on a platform with no probe of its own.
    const h = harness()
    h.write([spec()])
    await h.watcher.refresh()
    expect(h.watcher.reason).toBe('ok')
    await h.watcher.retarget(null)
    expect(h.watcher.reason).toBe('unknownPlatform')
    expect(h.watcher.watchedPaths).toBeNull()
    expect(h.watcher.watchedFolder).toBeNull()
  })

  it('carries no state across the change of folder', async () => {
    // The backup flag describes the last read of the OLD folder. Carrying it would tell a user
    // their newly chosen folder is a save behind when nothing has been read from it yet.
    const h = harness()
    const to = harness()
    h.write([spec()])
    h.writeBackup([spec({ playCount: 1 })])
    writeFileSync(join(h.dir, SCORE_DATA_FILE), Uint8Array.from([9, 9, 9]))
    await h.watcher.refresh()
    expect(h.watcher.usedBackup).toBe(true)
    await h.watcher.retarget(scoreDataPathsIn(to.dir))
    expect(h.watcher.usedBackup).toBe(false)
    expect(h.watcher.reason).toBe('noFile')
  })

  it('keeps watching, in the new folder, when it was watching before', async () => {
    const h = harness()
    const to = harness()
    open.push(h.watcher)
    h.write([spec()])
    await h.watcher.start()
    await h.watcher.retarget(scoreDataPathsIn(to.dir))
    to.write([spec({ playCount: 7 })])
    await vi.waitFor(
      () => {
        expect(h.imported.at(-1)?.[0].playCount).toBe(7)
      },
      { timeout: 5000 }
    )
  })
})

const IMPORT_NOTHING: ScoreImportResult = {
  charts: 0,
  rows: 0,
  added: 0,
  updated: 0,
  removed: 0,
  wrote: false
}
