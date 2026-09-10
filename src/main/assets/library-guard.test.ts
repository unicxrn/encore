import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { assertUnderLibrary } from './library-guard'
import { tmpDir } from '../../../test/helpers/tmp'

describe('assertUnderLibrary', () => {
  let root: string
  let library: string
  let outside: string

  beforeEach(() => {
    root = tmpDir('guard')
    library = join(root, 'library')
    outside = join(root, 'outside')
    mkdirSync(library, { recursive: true })
    mkdirSync(outside, { recursive: true })
  })

  const folders = (): { path: string }[] => [{ path: library }]

  it('accepts a path directly inside a library folder', () => {
    expect(() => assertUnderLibrary(join(library, 'Chart'), folders())).not.toThrow()
  })

  it('accepts a nested path inside a library folder', () => {
    expect(() => assertUnderLibrary(join(library, 'a', 'b', 'Chart'), folders())).not.toThrow()
  })

  it('accepts the library folder itself', () => {
    expect(() => assertUnderLibrary(library, folders())).not.toThrow()
  })

  it('rejects an absolute path outside every library folder', () => {
    expect(() => assertUnderLibrary(outside, folders())).toThrow(/library/i)
    expect(() => assertUnderLibrary(join(outside, 'Chart'), folders())).toThrow(/library/i)
  })

  it('rejects a ..-escape that resolves outside the library', () => {
    expect(() => assertUnderLibrary(join(library, '..', 'outside'), folders())).toThrow(/library/i)
    expect(() =>
      assertUnderLibrary(join(library, 'Chart', '..', '..', 'outside', 'x'), folders())
    ).toThrow(/library/i)
  })

  it('rejects a sibling whose name merely shares the library prefix', () => {
    // /root/library-evil must not pass a startsWith('/root/library') check.
    const evil = join(root, 'library-evil')
    mkdirSync(evil)
    expect(() => assertUnderLibrary(evil, folders())).toThrow(/library/i)
  })

  it('rejects a symlink inside the library pointing outside it', () => {
    const link = join(library, 'sneaky')
    symlinkSync(outside, link)
    expect(() => assertUnderLibrary(join(link, 'Chart'), folders())).toThrow(/library/i)
  })

  it('rejects when no library folders are configured', () => {
    expect(() => assertUnderLibrary(join(library, 'Chart'), [])).toThrow(/library/i)
  })

  it('accepts when any of several library folders contains the path', () => {
    const second = join(root, 'second')
    mkdirSync(second)
    expect(() =>
      assertUnderLibrary(join(second, 'Chart'), [{ path: library }, { path: second }])
    ).not.toThrow()
  })
})
