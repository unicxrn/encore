import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sweepTmpDir } from './sweep'
import { tmpDir } from '../../../test/helpers/tmp'

describe('sweepTmpDir', () => {
  it('keeps fresh part files, deletes aged-out parts and junk', () => {
    const dir = tmpDir('sweep')
    const freshPart = join(dir, `${'a'.repeat(32)}.part`)
    const oldPart = join(dir, `${'b'.repeat(32)}.part`)
    const junkFile = join(dir, 'leftover.sng')
    const junkDir = join(dir, 'not-a-part-dir')
    writeFileSync(freshPart, 'fresh')
    writeFileSync(oldPart, 'old')
    writeFileSync(junkFile, 'junk')
    mkdirSync(junkDir)
    const eightDaysAgoSec = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(oldPart, eightDaysAgoSec, eightDaysAgoSec)

    sweepTmpDir(dir)

    expect(existsSync(freshPart)).toBe(true)
    expect(existsSync(oldPart)).toBe(false)
    expect(existsSync(junkFile)).toBe(false)
    expect(existsSync(junkDir)).toBe(false)
  })

  it('does not throw when the dir is missing', () => {
    expect(() => sweepTmpDir(join(tmpdir(), 'encore-sweep-does-not-exist'))).not.toThrow()
  })
})
