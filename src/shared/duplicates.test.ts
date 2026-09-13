import { describe, expect, it } from 'vitest'
import { assetsHeld, assetsOnlyHere, DUPLICATE_TIERS, type DuplicateCopy } from './duplicates'

const copy = (path: string, fields: Partial<DuplicateCopy> = {}): DuplicateCopy => ({
  path,
  chartType: 'folder',
  name: 'YYZ',
  artist: 'Rush',
  charter: 'Ann',
  album: null,
  songLength: null,
  modifiedTime: 1,
  cloneHeroChecksum: 'a'.repeat(32),
  hasAlbumArt: false,
  hasVideo: false,
  hasBackground: false,
  hasLyrics: false,
  sizeBytes: null,
  ...fields
})

describe('what a copy holds', () => {
  it('lists the four in a fixed order, whatever order they were set in', () => {
    const held = assetsHeld(copy('/lib/a', { hasLyrics: true, hasAlbumArt: true }))
    expect(held).toEqual(['album art', 'lyrics'])
  })

  it('says nothing about a copy that holds none of them', () => {
    expect(assetsHeld(copy('/lib/a'))).toEqual([])
  })
})

describe('what a removal would lose', () => {
  it('names what this copy has and the other does not', () => {
    // The pair case, which is the one the whole feature exists for: two charts the checksum
    // calls identical, one of which is the only one with a video.
    const rich = copy('/lib/a', { hasVideo: true, hasAlbumArt: true })
    const plain = copy('/lib/b', { hasAlbumArt: true })
    const group = [rich, plain]

    expect(assetsOnlyHere(rich, group)).toEqual(['video'])
    expect(assetsOnlyHere(plain, group)).toEqual([])
  })

  it('does not call an asset unique when a third copy also has it', () => {
    // The reason this asks about the whole group rather than about the copy next to it: art
    // held by two of three survives either of those two being removed, and saying "only copy
    // with album art" over both of them would be false over both.
    // The copy that also has the art is deliberately LAST, so a check that only looked at the
    // copy next to this one would call the first one unique and be wrong about it.
    const a = copy('/lib/a', { hasAlbumArt: true })
    const b = copy('/lib/b', { hasLyrics: true })
    const c = copy('/lib/c', { hasAlbumArt: true })
    const group = [a, b, c]

    expect(assetsOnlyHere(a, group)).toEqual([])
    expect(assetsOnlyHere(b, group)).toEqual(['lyrics'])
    expect(assetsOnlyHere(c, group)).toEqual([])
  })

  it('matches the copy against the group by path, not by identity', () => {
    // The renderer hands these round as plain objects and rebuilds them after a removal, so an
    // identity comparison would report a copy as lacking everything it holds.
    const a = copy('/lib/a', { hasVideo: true })
    const group = [copy('/lib/a', { hasVideo: true }), copy('/lib/b')]

    expect(assetsOnlyHere(a, group)).toEqual(['video'])
  })
})

describe('tier wording', () => {
  it('keeps tier 3 free of any suggestion that something should be removed', () => {
    const alternates = DUPLICATE_TIERS.find((t) => t.id === 'alternates')
    expect(alternates?.blurb).toContain('Nothing is wrong here')
    expect(alternates?.blurb.toLowerCase()).not.toContain('remove')
    expect(alternates?.blurb.toLowerCase()).not.toContain('delete')
  })

  it('has tier 1 say that the copies can still differ, and that nothing is chosen', () => {
    const identical = DUPLICATE_TIERS.find((t) => t.id === 'identical')
    expect(identical?.blurb).toContain('nothing is chosen for you')
  })
})
