import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectChartLibraries } from './detect-library'
import { tmpDir } from '../../../test/helpers/tmp'

/** An `exists` probe that answers true for exactly the paths it was given. */
const existsOnly =
  (...paths: string[]): ((p: string) => boolean) =>
  (p) =>
    paths.includes(p)

const nothingExists = (): boolean => false

describe('detectChartLibraries', () => {
  it('finds the Linux Songs folder when it exists', () => {
    const songs = join('/home/ana', '.clonehero', 'Songs')
    expect(detectChartLibraries('/home/ana', 'linux', existsOnly(songs))).toEqual([
      { path: songs, chartCount: 0, countCapped: false }
    ])
  })

  it('returns nothing when the Linux Songs folder is absent', () => {
    expect(detectChartLibraries('/home/ana', 'linux', nothingExists)).toEqual([])
  })

  it('does not offer the Clone Hero folder when only it, and not Songs, exists', () => {
    // The data root holds settings and skins; without Songs there is no library to add.
    const root = join('/home/ana', '.clonehero')
    expect(detectChartLibraries('/home/ana', 'linux', existsOnly(root))).toEqual([])
  })

  it('finds the macOS Songs folder in the home folder, not in Application Support', () => {
    // ~/Clone Hero since v1.0. ~/Library/Application Support/com.srylain.CloneHero is the
    // pre-v1.0 location and is still where scores live, so probing it would find no songs.
    const songs = join('/Users/ana', 'Clone Hero', 'Songs')
    expect(detectChartLibraries('/Users/ana', 'darwin', existsOnly(songs))).toEqual([
      { path: songs, chartCount: 0, countCapped: false }
    ])
    const appSupport = join('/Users/ana', 'Library/Application Support/Clone Hero/Songs')
    expect(detectChartLibraries('/Users/ana', 'darwin', existsOnly(appSupport))).toEqual([])
  })

  it('finds the Windows Songs folder under Documents', () => {
    const songs = join('C:\\Users\\ana', 'Documents', 'Clone Hero', 'Songs')
    expect(detectChartLibraries('C:\\Users\\ana', 'win32', existsOnly(songs))).toEqual([
      { path: songs, chartCount: 0, countCapped: false }
    ])
  })

  it('uses the real Documents folder on Windows when it has been redirected', () => {
    // OneDrive redirects Documents on many consumer installs, and Clone Hero's own
    // troubleshooting page treats the redirected folder as the game's real directory.
    // Main passes Electron's resolved known folder; `home`/Documents is only the fallback.
    const redirected = join('C:\\Users\\ana', 'OneDrive - Contoso', 'Documents')
    const songs = join(redirected, 'Clone Hero', 'Songs')
    expect(detectChartLibraries('C:\\Users\\ana', 'win32', existsOnly(songs), redirected)).toEqual([
      { path: songs, chartCount: 0, countCapped: false }
    ])
  })

  it('offers nothing on a platform whose Clone Hero location is not established', () => {
    // Better to ask than to probe a guessed path that silently finds nothing.
    expect(detectChartLibraries('/home/ana', 'freebsd', () => true)).toEqual([])
  })

  it('reports an existing but empty folder differently from one holding charts', () => {
    const home = tmpDir('detect')
    const songs = join(home, '.clonehero', 'Songs')
    mkdirSync(songs, { recursive: true })

    const empty = detectChartLibraries(home, 'linux', existsOnly(songs))
    expect(empty).toEqual([{ path: songs, chartCount: 0, countCapped: false }])

    writeFileSync(join(songs, 'a.sng'), '')
    mkdirSync(join(songs, 'Pack/Deep Song'), { recursive: true })
    writeFileSync(join(songs, 'Pack/Deep Song/notes.chart'), '')

    expect(detectChartLibraries(home, 'linux', existsOnly(songs))).toEqual([
      { path: songs, chartCount: 2, countCapped: false }
    ])
  })
})
