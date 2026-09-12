import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  scoreDataDirCandidates,
  scoreDataPaths,
  scoreStatsCandidates,
  scoreStatsPath,
  SCORES_EXT_FILE,
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

  it('names both files in the same directory', () => {
    expect(scoreDataPaths(HOME, 'linux', always)).toEqual({
      scoreData: join(UNITY_LINUX, SCORE_DATA_FILE),
      scoresExt: join(UNITY_LINUX, SCORES_EXT_FILE)
    })
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
