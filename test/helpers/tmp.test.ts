import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { teardown, tmpDir } from './tmp'

/**
 * `teardown()` reads the parent to remove out of the environment, and these tests have to point it
 * at a throwaway directory rather than the real one. Deleting the live parent mid-run would take
 * every other test file's scratch space with it. Saved and restored around each case so the run's
 * own cleanup still happens normally at the end.
 */
const ROOT_ENV = 'ENCORE_TEST_TMP'
const realRoot = process.env[ROOT_ENV]

afterEach(() => {
  process.env[ROOT_ENV] = realRoot
})

/** Point `teardown()` at `dir` and run it, leaving the ambient parent untouched. */
function teardownOf(dir: string): void {
  process.env[ROOT_ENV] = dir
  teardown()
}

describe('tmpDir', () => {
  it('creates a distinct directory inside the run parent', () => {
    const a = tmpDir('probe')
    const b = tmpDir('probe')
    expect(a).not.toBe(b)
    expect(existsSync(a)).toBe(true)
    // Containment is the whole mechanism: a directory created outside the parent is one the
    // wholesale teardown cannot reach, which is the leak this helper exists to prevent.
    expect(a.startsWith(`${realRoot}/`)).toBe(true)
  })

  it('throws rather than falling back when the parent is not configured', () => {
    delete process.env[ROOT_ENV]
    // A silent fallback to the system temp is exactly the old leaking behaviour, so the failure
    // has to be loud enough that a misconfigured runner is fixed instead of quietly leaking.
    expect(() => tmpDir('probe')).toThrow(ROOT_ENV)
  })
})

describe('teardown', () => {
  it('removes the parent and everything under it', () => {
    const root = tmpDir('teardown-plain')
    mkdirSync(join(root, 'nested/deeper'), { recursive: true })
    writeFileSync(join(root, 'nested/deeper/file'), 'x')
    teardownOf(root)
    expect(existsSync(root)).toBe(false)
  })

  it('removes a parent containing a directory left unwritable by an interrupted test', () => {
    // art-cache.test.ts drops a directory to 0o500 to exercise a failed write and restores it in a
    // `finally`. A test killed between those two points leaves the mode behind, and a plain
    // recursive remove then fails with EACCES, which would turn this cleanup into a permanent
    // wedge, leaking every later run's parent instead of fixing the leak.
    const root = tmpDir('teardown-locked')
    const locked = join(root, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'trapped'), 'x')
    chmodSync(locked, 0o500)
    teardownOf(root)
    expect(existsSync(root)).toBe(false)
  })

  it('removes a parent containing a file chmodded to 0o000', () => {
    // issues.test.ts and scanner.test.ts both leave one of these behind. Unlinking depends on the
    // parent directory's mode rather than the file's, so this needs no repair pass. The case is
    // asserted here so that stays true if the removal logic is ever changed.
    const root = tmpDir('teardown-unreadable')
    const file = join(root, 'video.mp4.disabled')
    writeFileSync(file, 'x')
    chmodSync(file, 0o000)
    teardownOf(root)
    expect(existsSync(root)).toBe(false)
  })
})
