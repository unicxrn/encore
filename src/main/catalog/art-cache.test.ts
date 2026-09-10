import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artFilePath, sweepOrphanArt, writeAlbumArt } from './art-cache'
import { tmpDir } from '../../../test/helpers/tmp'

const dir = (): string => tmpDir('art')
const MD5 = 'a'.repeat(32)

/** Records every call so a test can prove the encode was skipped, and marks its output. */
function fakeEncoder(): ((data: Uint8Array) => Uint8Array) & { calls: number } {
  const fn = (data: Uint8Array): Uint8Array => {
    fn.calls++
    return new Uint8Array([0xff, ...data])
  }
  fn.calls = 0
  return fn as ((data: Uint8Array) => Uint8Array) & { calls: number }
}

describe('writeAlbumArt', () => {
  it('stores the re-encoded rendition, not the source bytes', () => {
    const d = dir()
    const encode = fakeEncoder()
    expect(writeAlbumArt(d, { md5: MD5, data: new Uint8Array([1, 2, 3]) }, encode)).toBe(MD5)
    expect(readFileSync(join(d, `${MD5}.jpg`))).toEqual(Buffer.from([0xff, 1, 2, 3]))
    expect(encode.calls).toBe(1)
  })

  it('skips the encode entirely when the cover is already cached', () => {
    // The expensive half is the decode/encode, not the write, so skipping it is the point of
    // keying the file on the source hash.
    const d = dir()
    const encode = fakeEncoder()
    writeAlbumArt(d, { md5: MD5, data: new Uint8Array([1, 2, 3]) }, encode)
    writeAlbumArt(d, { md5: MD5, data: new Uint8Array([1, 2, 3]) }, encode)
    expect(encode.calls).toBe(1)
  })

  it('returns null for a chart with no art', () => {
    const encode = fakeEncoder()
    expect(writeAlbumArt(dir(), null, encode)).toBeNull()
    expect(encode.calls).toBe(0)
  })

  it('drops art whose md5 cannot name a file instead of writing one', () => {
    // The md5 is untrusted: it reaches artFilePath from a URL in Task 4.
    const root = tmpDir('artroot')
    const d = join(root, 'cache')
    mkdirSync(d)
    expect(
      writeAlbumArt(d, { md5: '../escape', data: new Uint8Array([1]) }, fakeEncoder())
    ).toBeNull()
    // Asserting on the PARENT is what proves nothing escaped; listing the cache cannot.
    expect(readdirSync(root)).toEqual(['cache'])
  })

  it('loses only the art when the image cannot be encoded', () => {
    // The scanner wraps upsertChart in the same try/catch, so a throw here would cost the
    // chart its entire catalog row: a full disk would empty the library, not just covers.
    const d = dir()
    const boom = (): Uint8Array => {
      throw new Error('unreadable')
    }
    expect(writeAlbumArt(d, { md5: MD5, data: new Uint8Array([1]) }, boom)).toBeNull()
    expect(readdirSync(d)).toEqual([])
  })

  it('loses only the art when the write fails', () => {
    const d = dir()
    chmodSync(d, 0o500)
    try {
      expect(writeAlbumArt(d, { md5: MD5, data: new Uint8Array([1]) }, fakeEncoder())).toBeNull()
      expect(readdirSync(d)).toEqual([])
    } finally {
      chmodSync(d, 0o700)
    }
  })

  it('leaves no temp file behind after a successful write', () => {
    // The cover goes to a sibling temp and is renamed, so a partial write can never appear under
    // the real name. The rename must actually happen and the temp must not survive it.
    const d = dir()
    writeAlbumArt(d, { md5: MD5, data: new Uint8Array([1, 2, 3]) }, fakeEncoder())
    expect(readdirSync(d)).toEqual([`${MD5}.jpg`])
  })

  it('recovers from a temp file left behind by a killed process', () => {
    // The temp name is deterministic and opened `wx`, so a leaked one fails every later write
    // with EEXIST. That alone would only cost the cover, but by then the chart's folderHash
    // and scanVersion are current, so the NEXT scan skips it outright and the cover never
    // lands until the folder changes or SCAN_VERSION bumps.
    const d = dir()
    writeFileSync(join(d, `${MD5}.jpg.tmp`), Buffer.from([0xde, 0xad]))
    expect(writeAlbumArt(d, { md5: MD5, data: new Uint8Array([1, 2, 3]) }, fakeEncoder())).toBe(MD5)
    expect(readdirSync(d)).toEqual([`${MD5}.jpg`])
    expect(readFileSync(join(d, `${MD5}.jpg`))).toEqual(Buffer.from([0xff, 1, 2, 3]))
  })

  it('never throws when the temp path is occupied by a directory', () => {
    // Cleaning up the temp file is itself fallible: rmSync on a directory throws EISDIR. A throw
    // escaping here would cost the chart its whole row, which is what "never throws" protects.
    const d = dir()
    mkdirSync(join(d, `${MD5}.jpg.tmp`))
    expect(writeAlbumArt(d, { md5: MD5, data: new Uint8Array([1]) }, fakeEncoder())).toBeNull()
  })
})

describe('artFilePath', () => {
  it('rejects anything that is not a bare md5', () => {
    // The md5 arrives from a URL, so a traversal attempt must not resolve to a real path.
    expect(artFilePath('/cache', '../../etc/passwd')).toBeNull()
    expect(artFilePath('/cache', 'a/b')).toBeNull()
    expect(artFilePath('/cache', 'A'.repeat(32))).toBeNull() // uppercase is not what we write
    expect(artFilePath('/cache', '')).toBeNull()
  })
  it('accepts a bare lowercase md5', () => {
    expect(artFilePath('/cache', MD5)).toBe(join('/cache', `${MD5}.jpg`))
  })
})

describe('sweepOrphanArt', () => {
  it('deletes cached art no chart references and keeps the rest', () => {
    const d = dir()
    writeFileSync(join(d, `${MD5}.jpg`), 'keep')
    writeFileSync(join(d, `${'b'.repeat(32)}.jpg`), 'drop')
    writeFileSync(join(d, 'notes.txt'), 'untouched')
    // Both halves of the guard need their own fixture, or either can be deleted unnoticed.
    writeFileSync(join(d, 'whatever.jpg'), 'not an md5 stem')
    writeFileSync(join(d, `${'c'.repeat(32)}.txt`), 'md5 stem but not ours')
    expect(sweepOrphanArt(d, new Set([MD5]))).toBe(1)
    expect(readdirSync(d).sort()).toEqual(
      [`${MD5}.jpg`, 'notes.txt', 'whatever.jpg', `${'c'.repeat(32)}.txt`].sort()
    )
  })

  it('keeps sweeping after one entry fails to delete', () => {
    // A directory named like a cached cover, or a file held open on Windows, must not strand
    // every orphan behind it.
    const d = dir()
    mkdirSync(join(d, `${'d'.repeat(32)}.jpg`))
    writeFileSync(join(d, `${'e'.repeat(32)}.jpg`), 'drop')
    expect(sweepOrphanArt(d, new Set())).toBe(1)
    expect(existsSync(join(d, `${'e'.repeat(32)}.jpg`))).toBe(false)
  })
})
