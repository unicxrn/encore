import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { assertUnderLibrary, isUnderLibrary } from './library-guard'
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

/**
 * The same containment question, asked by a caller that is not a write.
 *
 * `chart:reveal` hands a path to the desktop's file manager, so it has to refuse exactly what
 * the writers refuse while saying so in words that are true of it. These pin that the two agree,
 * which is the only reason the predicate was split out in the first place.
 */
describe('isUnderLibrary', () => {
  let root: string
  let library: string
  let outside: string

  beforeEach(() => {
    root = tmpDir('reveal-guard')
    library = join(root, 'library')
    outside = join(root, 'outside')
    mkdirSync(library, { recursive: true })
    mkdirSync(outside, { recursive: true })
  })

  const folders = (): { path: string }[] => [{ path: library }]

  it('agrees with assertUnderLibrary on a chart inside the library', () => {
    const chart = join(library, 'Rush - YYZ')
    expect(isUnderLibrary(chart, folders())).toBe(true)
    expect(() => assertUnderLibrary(chart, folders())).not.toThrow()
  })

  it('agrees with assertUnderLibrary on a path outside it', () => {
    expect(isUnderLibrary(outside, folders())).toBe(false)
    expect(() => assertUnderLibrary(outside, folders())).toThrow()
  })

  it('refuses a ..-escape, and a sibling whose name starts with the library folder', () => {
    expect(isUnderLibrary(join(library, '..', 'outside', 'Chart'), folders())).toBe(false)
    expect(isUnderLibrary(`${library}-evil`, folders())).toBe(false)
  })

  it('refuses everything when no library folder is configured', () => {
    expect(isUnderLibrary(join(library, 'Rush - YYZ'), [])).toBe(false)
  })
})
