import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeGameExecutable } from '../../shared/game-launch'
import { tmpDir } from '../../../test/helpers/tmp'
import {
  EXECUTE_BITS,
  gameLaunchSupported,
  inspectGameExecutable,
  type PathFacts
} from './executable'

/**
 * What a path is, per platform, and what the user is told about it.
 *
 * The stat is injected for most of these, so every state can be described without a Clone Hero
 * install and without a Windows machine: a missing path, a directory, an AppImage nobody has run
 * `chmod +x` on, a `.exe`, a `.bat`. The last two tests use real files, because "does this agree
 * with the filesystem" is the one question a fake stat cannot answer.
 */

const facts = (over: Partial<PathFacts> = {}): PathFacts => ({
  isFile: () => true,
  isDirectory: () => false,
  mode: 0o644,
  ...over
})

const missing = (): null => null

describe('gameLaunchSupported', () => {
  it('covers the two platforms Encore itself ships for', () => {
    expect(gameLaunchSupported('linux')).toBe(true)
    expect(gameLaunchSupported('win32')).toBe(true)
  })

  // Not an oversight and not a gap to fill in later: a Mac app is a bundle, `open -a` is a
  // different mechanism, and the owner has no Mac to check either on.
  it('says no to macOS rather than guessing at a bundle', () => {
    expect(gameLaunchSupported('darwin')).toBe(false)
    const report = inspectGameExecutable('/Applications/Clone Hero.app', 'darwin', () => {
      throw new Error('nothing should be stat-ed on an unsupported platform')
    })
    expect(report.supported).toBe(false)
    expect(report.usable).toBe(false)
    expect(describeGameExecutable(report)).toContain('does not launch Clone Hero on macOS')
  })

  it('says no to a platform it has never heard of, by name', () => {
    const report = inspectGameExecutable('/opt/clonehero', 'freebsd', () => facts())
    expect(report.usable).toBe(false)
    expect(describeGameExecutable(report)).toBe(
      'Encore does not know how to launch Clone Hero on freebsd.'
    )
  })
})

describe('inspectGameExecutable: Linux', () => {
  it('accepts a file with an execute bit, which is what an AppImage is once it can run', () => {
    const report = inspectGameExecutable('/home/u/Clone Hero.AppImage', 'linux', () =>
      facts({ mode: 0o755 })
    )
    expect(report).toMatchObject({ kind: 'file', executable: true, usable: true })
    expect(describeGameExecutable(report)).toBe(
      'Encore starts Clone Hero with /home/u/Clone Hero.AppImage.'
    )
  })

  /**
   * The case worth refusing out loud. A browser saves an AppImage without the execute bit, so
   * this is the state most Linux users' first pick is really in; storing it would turn Launch
   * into a button that never works and never says why.
   */
  it('refuses a file nothing can start, and says what to do about it', () => {
    const report = inspectGameExecutable('/home/u/CloneHero.AppImage', 'linux', () =>
      facts({ mode: 0o644 })
    )
    expect(report).toMatchObject({ kind: 'file', executable: false, usable: false })
    expect(describeGameExecutable(report)).toContain('chmod +x')
  })

  it('refuses the folder the program lives in, rather than the program', () => {
    const report = inspectGameExecutable('/opt/clonehero', 'linux', () =>
      facts({ isFile: () => false, isDirectory: () => true, mode: 0o755 })
    )
    expect(report).toMatchObject({ kind: 'directory', usable: false })
    expect(describeGameExecutable(report)).toBe(
      '/opt/clonehero is a folder. Choose the program inside it, not the folder itself.'
    )
  })

  it('refuses a path with nothing at it', () => {
    const report = inspectGameExecutable('/opt/gone', 'linux', missing)
    expect(report).toMatchObject({ kind: 'missing', usable: false })
    expect(describeGameExecutable(report)).toBe('There is nothing at /opt/gone.')
  })

  it('treats an unanswered setting as unanswered rather than as a missing file', () => {
    const report = inspectGameExecutable('', 'linux', () => {
      throw new Error('an empty setting names no path to stat')
    })
    expect(report.usable).toBe(false)
    expect(describeGameExecutable(report)).toContain('No Clone Hero chosen yet')
  })
})

describe('inspectGameExecutable: Windows', () => {
  it('accepts a .exe whatever its mode bits say, because NTFS has none', () => {
    const report = inspectGameExecutable('C:\\Games\\Clone Hero\\Clone Hero.exe', 'win32', () =>
      facts({ mode: 0o644 })
    )
    expect(report.usable).toBe(true)
    expect(report.executable).toBe(false)
  })

  // A .bat is a file the command interpreter reads, which is the one shape of "executable" that
  // would put a user-chosen path in front of a shell. Node will not spawn one without
  // `shell: true` either, and `shell: true` is what game/launch.ts exists to never do.
  it('refuses a .bat and a .cmd', () => {
    for (const path of ['C:\\Games\\play.bat', 'C:\\Games\\play.cmd']) {
      const report = inspectGameExecutable(path, 'win32', () => facts())
      expect(report.usable).toBe(false)
      expect(describeGameExecutable(report)).toContain('is not a .exe')
    }
  })

  it('refuses the install folder, and names the thing to pick instead', () => {
    const report = inspectGameExecutable('C:\\Games\\Clone Hero', 'win32', () =>
      facts({ isFile: () => false, isDirectory: () => true })
    )
    expect(describeGameExecutable(report)).toBe(
      'C:\\Games\\Clone Hero is a folder. Choose the .exe inside it.'
    )
  })
})

/**
 * The default stat, against the real filesystem.
 *
 * Everything above describes a file rather than creating one, which is what makes the platform
 * matrix testable at all. These two are the counterweight: they check that the injected seam and
 * the real `statSync` agree about the same two states, so the matrix is not describing a
 * filesystem nobody has.
 */
describe('inspectGameExecutable: against a real directory', () => {
  it('reads the execute bit off a file on disk', () => {
    const dir = tmpDir('game-exec')
    const path = join(dir, 'Clone Hero.AppImage')
    writeFileSync(path, 'not really an AppImage')
    chmodSync(path, 0o644)
    expect(inspectGameExecutable(path, 'linux').usable).toBe(false)
    chmodSync(path, 0o755)
    expect(inspectGameExecutable(path, 'linux')).toMatchObject({
      kind: 'file',
      executable: true,
      usable: true
    })
  })

  it('reads a directory as a directory', () => {
    const dir = tmpDir('game-exec-dir')
    const path = join(dir, 'Clone Hero')
    mkdirSync(path)
    expect(inspectGameExecutable(path, 'linux').kind).toBe('directory')
  })
})

describe('EXECUTE_BITS', () => {
  // One bit is enough: a file the user can start has at least the one their own shell uses, and
  // a game installed by a package manager is commonly 0o755 rather than 0o777.
  it('is any of the three, not all of them', () => {
    expect(0o700 & EXECUTE_BITS).not.toBe(0)
    expect(0o010 & EXECUTE_BITS).not.toBe(0)
    expect(0o001 & EXECUTE_BITS).not.toBe(0)
    expect(0o666 & EXECUTE_BITS).toBe(0)
  })
})
