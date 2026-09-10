import { describe, expect, it } from 'vitest'
import { ART_SCHEME, artUrl } from './art'

describe('artUrl', () => {
  it('builds a protocol URL from an md5', () => {
    expect(artUrl('a'.repeat(32))).toBe(`${ART_SCHEME}://${'a'.repeat(32)}`)
  })

  it('returns null when a chart has no art', () => {
    expect(artUrl(null)).toBeNull()
    expect(artUrl(undefined)).toBeNull()
  })

  it('puts the md5 in the host component, where handleArtRequest reads it', () => {
    const md5 = 'b'.repeat(32)
    expect(new URL(artUrl(md5) as string).hostname).toBe(md5)
  })
})
