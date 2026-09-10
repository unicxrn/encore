import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ART_SCHEME } from '../shared/art'
import { handleArtRequest } from './art-protocol'
import { tmpDir } from '../../test/helpers/tmp'

const MD5 = 'a'.repeat(32)

const tmp = (): string => tmpDir('proto')

describe('handleArtRequest', () => {
  it('serves a cached jpeg', async () => {
    const dir = tmp()
    writeFileSync(join(dir, `${MD5}.jpg`), Buffer.from([0xff, 0xd8, 0xff]))
    const res = await handleArtRequest(dir, `${ART_SCHEME}://${MD5}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]))
  })

  it('404s for art that is not cached', async () => {
    const res = await handleArtRequest(tmp(), `${ART_SCHEME}://${MD5}`)
    expect(res.status).toBe(404)
  })

  it('400s on anything that is not a bare md5', async () => {
    const dir = tmp()
    // '' is an empty authority; 'a/b' would make the md5 a prefix of a path. The uppercase case
    // only covers direct callers, since Chromium lowercases the host before the app ever sees it.
    for (const host of ['..', 'not-a-hash', '', MD5.toUpperCase(), 'a/b']) {
      expect((await handleArtRequest(dir, `${ART_SCHEME}://${host}`)).status).toBe(400)
    }
  })

  it('400s rather than rejecting on a URL that will not parse', async () => {
    const dir = tmp()
    for (const url of [`${ART_SCHEME}://[`, `${ART_SCHEME}://\\\\${MD5}`, 'not a url at all']) {
      expect((await handleArtRequest(dir, url)).status).toBe(400)
    }
  })

  it('cannot be escaped by an encoded traversal in the path component', async () => {
    // The art dir is nested so that a handler which did join the path under it would land on a
    // real file two levels up. An unreachable plant would make this test pass vacuously.
    const root = tmp()
    writeFileSync(join(root, 'secret.jpg'), Buffer.from([0x00]))
    const artDir = join(root, 'art', 'v1')
    mkdirSync(artDir, { recursive: true })
    // Percent-encoded, because new URL() collapses a literal ../ during parsing: this is the
    // only shape that still carries a traversal when the handler sees it, and it is what
    // Chromium forwards.
    const url = `${ART_SCHEME}://${MD5}/%2e%2e%2f%2e%2e%2fsecret.jpg`
    expect((await handleArtRequest(artDir, url)).status).toBe(404)
  })
})
