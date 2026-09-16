import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmpDir } from '../../../test/helpers/tmp'
import { launchGame, type SpawnGameFn, type SpawnGameOptions } from './launch'

/**
 * What would have been run, without running a game.
 *
 * `launchGame` takes its spawn as a dependency for exactly this: every claim the module makes
 * about how the child is started (one unsplit argument, detached, no inherited stdio) is a
 * property of the call it makes, and a recorded call is the only way to assert on it without a
 * Clone Hero install on the machine running the suite.
 */
interface RecordedCall {
  command: string
  args: string[]
  options: SpawnGameOptions
  child: FakeChild
}

/**
 * A child that reports the outcome the test asked for, one tick later, as a real one does.
 *
 * An `EventEmitter` subclass rather than an object literal with an `on`: a real `ChildProcess` is
 * one, so the fake satisfies `SpawnedGame` by being the same shape rather than by a cast that
 * would let the interface drift away from what Node returns.
 */
class FakeChild extends EventEmitter {
  unreffed = false
  unref(): void {
    this.unreffed = true
  }
}

function fakeSpawn(outcome: 'spawn' | Error): { fn: SpawnGameFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fn: SpawnGameFn = (command, args, options) => {
    const child = new FakeChild()
    calls.push({ command, args, options, child })
    // A real child emits neither event synchronously: spawn() returns first and the outcome
    // arrives on a later tick, which is why launchGame is a promise rather than a throw.
    setTimeout(() => {
      if (outcome === 'spawn') child.emit('spawn')
      else child.emit('error', outcome)
    }, 0)
    return child
  }
  return { fn, calls }
}

/**
 * The assertion that matters, factored out so the mutation test below can prove it fires.
 *
 * These three lines together are the whole "a path is a path" argument. `command` byte-identical
 * to the chosen path means nothing was quoted, escaped or concatenated on the way; an empty
 * `args` means no part of the path leaked into the argument vector; and the absence of `shell`
 * means the operating system receives the string as one program name rather than handing it to
 * an interpreter that would split it on the space and expand the rest.
 *
 * Written against a loosely typed call on purpose: `SpawnGameOptions` has no `shell` field, so a
 * well-typed assertion could not even express the mutation it is meant to catch.
 */
interface SpawnLikeOptions {
  shell?: unknown
  detached?: unknown
  stdio?: unknown
  cwd?: unknown
}

function assertOneUnsplitArgument(
  call: { command: string; args: string[]; options: SpawnLikeOptions },
  path: string
): void {
  expect(call.options.shell ?? false).toBe(false)
  expect(call.command).toBe(path)
  expect(call.args).toEqual([])
}

/**
 * The path a real user can have and a shell would ruin.
 *
 * A space, a double quote and a `$` in one folder name. All three are legal on Linux and on
 * Windows the space alone is near universal, since the game's own installer writes
 * `Clone Hero` with one in it.
 */
const HOSTILE_PATH = '/home/u/Games/Clone Hero "beta" $HOME/CloneHero'

describe('launchGame', () => {
  it('runs the chosen path as the program, with no arguments', async () => {
    const { fn, calls } = fakeSpawn('spawn')
    await launchGame('/opt/clonehero/Clone Hero', { spawn: fn })

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('/opt/clonehero/Clone Hero')
    expect(calls[0].args).toEqual([])
  })

  it('detaches the child and inherits none of its stdio', async () => {
    const { fn, calls } = fakeSpawn('spawn')
    await launchGame('/opt/clonehero/Clone Hero', { spawn: fn })

    // Its own process group, so the signals that stop Encore do not reach the game.
    expect(calls[0].options.detached).toBe(true)
    // No pipe for Encore to hold open, and nothing accumulating in a buffer nothing reads.
    expect(calls[0].options.stdio).toBe('ignore')
    // Dropped from Encore's event loop, so quitting Encore does not wait on the game.
    expect(calls[0].child.unreffed).toBe(true)
  })

  it('starts the game in its own folder, because that is where it keeps its settings', async () => {
    const { fn, calls } = fakeSpawn('spawn')
    await launchGame('/opt/clonehero/Clone Hero', { spawn: fn })

    expect(calls[0].options.cwd).toBe('/opt/clonehero')
  })

  it('hands a path with a space and a quote across as ONE argument', async () => {
    const { fn, calls } = fakeSpawn('spawn')
    await launchGame(HOSTILE_PATH, { spawn: fn })

    assertOneUnsplitArgument(calls[0], HOSTILE_PATH)
  })

  /**
   * MUTATION: the launcher this module exists not to be.
   *
   * Building a command line and asking for a shell is the obvious way to write this, and it is
   * the one that turns a folder called `Clone Hero "beta" $HOME` into several shell words with
   * an expansion among them. Running the same assertion against that shape is what proves the
   * assertion above is doing work rather than passing on an argument that could never differ.
   */
  it('MUTATION: catches a launcher that builds a command line and asks for a shell', () => {
    const shellStyle = {
      command: `"${HOSTILE_PATH}"`,
      args: [],
      options: { detached: true, stdio: 'ignore', shell: true }
    }
    expect(() => assertOneUnsplitArgument(shellStyle, HOSTILE_PATH)).toThrow()
  })

  /** MUTATION: the other way the path leaks, as an argument to an interpreter rather than a program. */
  it('MUTATION: catches a launcher that passes the path as an argument to something else', () => {
    const viaInterpreter = {
      command: '/bin/sh',
      args: ['-c', HOSTILE_PATH],
      options: { detached: true, stdio: 'ignore' }
    }
    expect(() => assertOneUnsplitArgument(viaInterpreter, HOSTILE_PATH)).toThrow()
  })

  it('rejects with the spawn failure rather than resolving on a path that cannot run', async () => {
    const enoent = Object.assign(new Error('spawn /opt/gone ENOENT'), { code: 'ENOENT' })
    const { fn } = fakeSpawn(enoent)

    await expect(launchGame('/opt/gone', { spawn: fn })).rejects.toThrow('ENOENT')
  })

  it('unreferences the child even when the spawn failed', async () => {
    const { fn, calls } = fakeSpawn(new Error('nope'))
    await expect(launchGame('/opt/gone', { spawn: fn })).rejects.toThrow()

    expect(calls[0].child.unreffed).toBe(true)
  })
})

/**
 * The same claim against the real `child_process`, once.
 *
 * Everything above is a recorded call, which cannot be wrong about the code and cannot be right
 * about the operating system. This one starts a real program whose own path holds a space and a
 * double quote, and the program writes a file only if it was started with that path intact. A
 * shell in the middle would have split the name and the file would never appear.
 *
 * Deliberately not Clone Hero: it is a two-line shell script that writes one file and exits.
 * Skipped on Windows, where the script has no interpreter and the `.exe` rule applies instead.
 */
describe.skipIf(process.platform === 'win32')('launchGame against a real process', () => {
  it('starts a program whose path holds a space and a quote', async () => {
    const dir = tmpDir('game-launch')
    // The quote is the part a command line would need to escape and a shell would consume.
    const script = join(dir, 'Clone Hero "beta".sh')
    const marker = join(dir, 'started')
    writeFileSync(script, `#!/bin/sh\nprintf started > '${marker}'\n`)
    chmodSync(script, 0o755)

    await launchGame(script)

    for (let i = 0; i < 100 && !existsSync(marker); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(existsSync(marker)).toBe(true)
  })
})
