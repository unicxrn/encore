import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpDir } from '../../../test/helpers/tmp'
import { describeScoreFolder } from '../../shared/score-folder'
import {
  inspectScoreFolder,
  resolveScoreDataPaths,
  scoreDataDirCandidates,
  scoreDataPaths,
  scoreFolderOverride,
  scoreStatsCandidates,
  scoreStatsPath,
  SCORES_EXT_BACKUP_FILE,
  SCORES_EXT_FILE,
  SCORE_DATA_BACKUP_FILE,
  SCORE_DATA_FILE,
  SCORE_STATS_FILE
} from './location'

// join() uses the separator of the platform the tests run on, not of the platform being probed.
// That is correct in production, where the two always match, and it is why the Windows
// expectations below are built with join() rather than with literal backslashes — the same
// reasoning detect-library.test.ts records.
const HOME = join('/home', 'u')
const never = (): boolean => false
const always = (): boolean => true

describe('scoreStatsCandidates', () => {
  it('probes the verified Linux location', () => {
    expect(scoreStatsCandidates(HOME, 'linux')).toEqual([
      join(HOME, '.clonehero', SCORE_STATS_FILE)
    ])
  })

  it('probes the v1 macOS user-data root, not the pre-v1 Application Support one', () => {
    // Three wiki pages and the official blog agree that v1.0 moved everything out of
    // ~/Library/Application Support/com.srylain.CloneHero. The one page that still says
    // otherwise is a 2023 revision describing a different file.
    expect(scoreStatsCandidates(HOME, 'darwin')).toEqual([
      join(HOME, 'Clone Hero', SCORE_STATS_FILE)
    ])
  })

  it('probes both live Windows locations, Documents first', () => {
    // Windows genuinely has two: Documents\Clone Hero holds settings, profiles and songs, while
    // AppData\LocalLow\srylain Inc_\Clone Hero holds "score saves and other hidden data". No
    // source says which receives scorestats.json, so both are tried.
    expect(scoreStatsCandidates(HOME, 'win32')).toEqual([
      join(HOME, 'Documents', 'Clone Hero', SCORE_STATS_FILE),
      join(HOME, 'AppData', 'LocalLow', 'srylain Inc_', 'Clone Hero', SCORE_STATS_FILE)
    ])
  })

  it('uses the resolved Documents folder on Windows, for OneDrive redirection', () => {
    const documents = join('/c', 'Users', 'u', 'OneDrive', 'Documents')
    expect(scoreStatsCandidates(HOME, 'win32', documents)[0]).toBe(
      join(documents, 'Clone Hero', SCORE_STATS_FILE)
    )
  })

  it('offers nothing for a platform it has no evidence about', () => {
    // A probe of an invented path finds nothing and leaves the user with no explanation of why.
    expect(scoreStatsCandidates(HOME, 'freebsd')).toEqual([])
    expect(scoreStatsCandidates(HOME, 'aix')).toEqual([])
  })
})

describe('scoreStatsPath', () => {
  it('is null only when the platform is unknown', () => {
    // Null must mean "we do not know where to look here", never "not installed": the two need
    // different wording and only one of them is anyone's problem to fix.
    expect(scoreStatsPath(HOME, 'freebsd', never)).toBeNull()
    expect(scoreStatsPath(HOME, 'linux', never)).not.toBeNull()
  })

  it('picks the first candidate that exists', () => {
    const localLow = join(
      HOME,
      'AppData',
      'LocalLow',
      'srylain Inc_',
      'Clone Hero',
      SCORE_STATS_FILE
    )
    expect(scoreStatsPath(HOME, 'win32', (p) => p === localLow)).toBe(localLow)
  })

  it('prefers Documents when both Windows locations exist', () => {
    expect(scoreStatsPath(HOME, 'win32', always)).toBe(
      join(HOME, 'Documents', 'Clone Hero', SCORE_STATS_FILE)
    )
  })

  it('falls back to the first candidate when none exists', () => {
    // The common case: no Clone Hero on this machine. The watcher still needs somewhere to
    // watch, so the file is picked up if it ever appears.
    expect(scoreStatsPath(HOME, 'win32', never)).toBe(
      join(HOME, 'Documents', 'Clone Hero', SCORE_STATS_FILE)
    )
    expect(scoreStatsPath(HOME, 'linux', never)).toBe(join(HOME, '.clonehero', SCORE_STATS_FILE))
  })
})

const UNITY_LINUX = join(HOME, '.config', 'unity3d', 'srylain Inc_', 'Clone Hero')

describe('scoreDataDirCandidates', () => {
  it('probes the verified Linux location, which is not where scorestats.json lives', () => {
    // The two files are in Unity's persistentDataPath, and scorestats.json is in Clone Hero's own
    // user-data root. A test that let them collapse into one directory would hide the whole
    // reason this resolver exists.
    expect(scoreDataDirCandidates(HOME, 'linux')).toEqual([UNITY_LINUX])
    expect(scoreDataDirCandidates(HOME, 'linux')[0]).not.toBe(join(HOME, '.clonehero'))
  })

  it('probes LocalLow on Windows, per Unity persistentDataPath', () => {
    // Not verified against a Windows install; see the module comment. LocalLow is where Unity
    // puts persistentDataPath there, and where the migration guide says score saves go.
    expect(scoreDataDirCandidates(HOME, 'win32')).toEqual([
      join(HOME, 'AppData', 'LocalLow', 'srylain Inc_', 'Clone Hero')
    ])
  })

  it('probes both macOS shapes, the current one first', () => {
    // Also unverified. Unity composes company and product folders now and used the bundle
    // identifier before that, and an install carried over may still be reading the older one.
    expect(scoreDataDirCandidates(HOME, 'darwin')).toEqual([
      join(HOME, 'Library', 'Application Support', 'srylain Inc_', 'Clone Hero'),
      join(HOME, 'Library', 'Application Support', 'com.srylain.CloneHero')
    ])
  })

  it('offers nothing for a platform it has no evidence about', () => {
    expect(scoreDataDirCandidates(HOME, 'freebsd')).toEqual([])
  })
})

describe('scoreDataPaths', () => {
  it('is null only when the platform is unknown', () => {
    expect(scoreDataPaths(HOME, 'freebsd', never)).toBeNull()
    expect(scoreDataPaths(HOME, 'linux', never)).not.toBeNull()
  })

  it('names the primaries and the backups in the same directory', () => {
    expect(scoreDataPaths(HOME, 'linux', always)).toEqual({
      scoreData: join(UNITY_LINUX, SCORE_DATA_FILE),
      scoresExt: join(UNITY_LINUX, SCORES_EXT_FILE),
      scoreDataBackup: join(UNITY_LINUX, SCORE_DATA_BACKUP_FILE),
      scoresExtBackup: join(UNITY_LINUX, SCORES_EXT_BACKUP_FILE)
    })
  })

  it('identifies a directory by a backup when the primaries are gone', () => {
    // The game renames a file it considers damaged out of the way, which can leave a directory
    // holding only backups. That is still the right directory, and on macOS, where there are two
    // candidates, taking it or not is the difference between the user's data and the wrong guess.
    const older = join(HOME, 'Library', 'Application Support', 'com.srylain.CloneHero')
    const backup = join(older, SCORES_EXT_BACKUP_FILE)
    expect(scoreDataPaths(HOME, 'darwin', (p) => p === backup)?.scoresExtBackup).toBe(backup)
  })

  it('picks a directory holding only one of the two', () => {
    // scoresext.bin is the newer file, so an install that has not written it yet still has the
    // right directory. Requiring both would send this to the fallback and, on macOS, to the
    // wrong one of two candidates.
    const older = join(HOME, 'Library', 'Application Support', 'com.srylain.CloneHero')
    const found = scoreDataPaths(HOME, 'darwin', (p) => p === join(older, SCORE_DATA_FILE))
    expect(found?.scoreData).toBe(join(older, SCORE_DATA_FILE))
    expect(found?.scoresExt).toBe(join(older, SCORES_EXT_FILE))
  })

  it('falls back to the first candidate when nothing exists', () => {
    // The common case: no Clone Hero on this machine. The watcher still needs a directory, so
    // the files are picked up if they ever appear.
    expect(scoreDataPaths(HOME, 'darwin', never)?.scoreData).toBe(
      join(HOME, 'Library', 'Application Support', 'srylain Inc_', 'Clone Hero', SCORE_DATA_FILE)
    )
  })
})

/**
 * The user's own answer, and what happens when it is wrong.
 *
 * The probe is verified on Linux and inferred everywhere else, so the setting is how a Windows,
 * macOS or portable install is reached at all. The requirement it exists to meet is not that a
 * chosen folder works; it is that a chosen folder which does NOT work says so.
 */
describe('scoreFolderOverride', () => {
  it('treats an empty or blank setting as no override', () => {
    // Empty is the default and is also what clearing the setting writes, so it is the one value
    // that has to mean "go back to probing".
    expect(scoreFolderOverride('')).toBeNull()
    expect(scoreFolderOverride('   ')).toBeNull()
    expect(scoreFolderOverride(undefined)).toBeNull()
    expect(scoreFolderOverride(null)).toBeNull()
  })

  it('keeps a real path, trimmed', () => {
    expect(scoreFolderOverride(' /mnt/games/CloneHero ')).toBe('/mnt/games/CloneHero')
  })
})

describe('resolveScoreDataPaths', () => {
  const chosen = join('/mnt', 'Slappe_Schijf', 'Games', 'CloneHero')

  it('reads the chosen folder instead of probing', () => {
    expect(resolveScoreDataPaths(chosen, HOME, 'linux', always)).toEqual({
      scoreData: join(chosen, SCORE_DATA_FILE),
      scoresExt: join(chosen, SCORES_EXT_FILE),
      scoreDataBackup: join(chosen, SCORE_DATA_BACKUP_FILE),
      scoresExtBackup: join(chosen, SCORES_EXT_BACKUP_FILE)
    })
  })

  it('keeps the chosen folder even when nothing is in it any more', () => {
    // A folder that has gone missing must keep resolving to itself. Sliding back to a probe
    // would quietly replace the user's answer with a guess, and they would have no way to tell.
    expect(resolveScoreDataPaths(chosen, HOME, 'linux', never)?.scoreData).toBe(
      join(chosen, SCORE_DATA_FILE)
    )
  })

  it('answers on a platform that has no probe at all', () => {
    // The whole point on an unrecognised platform: the probe has nothing and the user does.
    expect(resolveScoreDataPaths(chosen, HOME, 'freebsd', never)).not.toBeNull()
    expect(resolveScoreDataPaths('', HOME, 'freebsd', never)).toBeNull()
  })

  it('returns to the probe when the override is cleared', () => {
    expect(resolveScoreDataPaths('', HOME, 'linux', always)?.scoreData).toBe(
      join(UNITY_LINUX, SCORE_DATA_FILE)
    )
  })
})

describe('inspectScoreFolder', () => {
  const folderWith = (names: string[]): string => {
    const dir = join(tmpDir('score-folder'), 'Clone Hero')
    mkdirSync(dir, { recursive: true })
    for (const name of names) writeFileSync(join(dir, name), 'x')
    return dir
  }

  it('names what it found in a folder that has the files', () => {
    const dir = folderWith([SCORE_DATA_FILE, SCORES_EXT_FILE, 'settings.ini'])
    const report = inspectScoreFolder(dir)
    expect(report).toMatchObject({ exists: true, usable: true, quarantined: [] })
    expect(report.found).toEqual([SCORE_DATA_FILE, SCORES_EXT_FILE])
    expect(describeScoreFolder(report)).toBe(`Found scoredata.bin and scoresext.bin in ${dir}.`)
  })

  it('counts a folder with only a backup as usable', () => {
    // One readable file is enough to be worth pointing Encore at: the watcher decides what can
    // be merged, and a folder holding a backup holds scores.
    const report = inspectScoreFolder(folderWith([SCORE_DATA_BACKUP_FILE]))
    expect(report.usable).toBe(true)
    expect(report.found).toEqual([SCORE_DATA_BACKUP_FILE])
  })

  it('says what it looked for when a folder holds none of it', () => {
    // The failure this whole setting exists to prevent is a useless path stored in silence.
    const dir = folderWith(['settings.ini', 'songcache.bin'])
    const report = inspectScoreFolder(dir)
    expect(report).toMatchObject({ exists: true, usable: false, found: [], quarantined: [] })
    expect(describeScoreFolder(report)).toBe(
      `No score files in ${dir}. Encore looked for scoredata.bin, scoresext.bin, ` +
        'scoredata_backup.bin and scoresext_backup.bin, and found none of them.'
    )
  })

  it('explains a folder holding only what Clone Hero quarantined', () => {
    // Not the same as an empty folder, and a user told "nothing here" would go looking for a
    // different folder when what they have is a Clone Hero that threw its score files away.
    const dir = folderWith(['scoredata_corrupted_0.bin', 'scoresext_corrupted_12.bin'])
    const report = inspectScoreFolder(dir)
    expect(report.usable).toBe(false)
    expect(report.quarantined).toEqual(['scoredata_corrupted_0.bin', 'scoresext_corrupted_12.bin'])
    expect(describeScoreFolder(report)).toContain('found only scoredata_corrupted_0.bin')
    expect(describeScoreFolder(report)).toContain('cannot read it')
  })

  it('says so when there is no folder there at all', () => {
    const missing = join(tmpDir('score-folder'), 'not-here')
    const report = inspectScoreFolder(missing)
    expect(report).toMatchObject({ exists: false, usable: false })
    expect(describeScoreFolder(report)).toBe(`There is no folder at ${missing}.`)
  })

  it('matches the names case insensitively, and reports the spelling on disk', () => {
    // Windows and macOS filesystems usually fold case, and a Scoredata.bin the game reads fine
    // must not be reported as missing. The name in the message is the one the user can see.
    const report = inspectScoreFolder(folderWith(['ScoreData.BIN']))
    expect(report.usable).toBe(true)
    expect(report.found).toEqual(['ScoreData.BIN'])
  })

  it('has an answer for a platform with no location and no override', () => {
    const report = inspectScoreFolder(null)
    expect(report).toMatchObject({ folder: null, exists: false, usable: false })
    expect(describeScoreFolder(report)).toContain('Choose the folder yourself')
  })
})
