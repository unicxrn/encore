import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { readSngForRepack, type SngEntry } from '../downloads/sng'
import { putPlanEntry, readRepackPlan, repackSng } from '../downloads/sng-repack'
import { verifyRepack, writeSngAsset } from './sng-asset'
import { tmpDir } from '../../../test/helpers/tmp'

/**
 * The bad-rebuild tests need writeSngAsset to produce a bad temp without adding a test-only
 * branch to the production module: mocking the repacker it depends on keeps the verify/rename
 * ordering under test exactly as it ships.
 *
 * Two flavours of bad, because they prove different halves of the guard. `garbage` writes bytes
 * no reader could open, which only needs the parse check. `flip` runs the REAL repack and then
 * turns over one byte of the last entry, so the temp has the right entries, the right lengths,
 * the right metadata and the right mask (everything except its contents). Only the byte
 * comparison sees that one, and it is the failure mode a streamed rebuild can actually have.
 */
const writer = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'garbage' | 'flip' }))
vi.mock('../downloads/sng-repack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../downloads/sng-repack')>()
  return {
    ...actual,
    repackSng: async (...args: Parameters<typeof actual.repackSng>): Promise<void> => {
      const destPath = args[1]
      if (writer.mode === 'garbage') {
        writeFileSync(destPath, Buffer.from([1, 2, 3]))
        return
      }
      await actual.repackSng(...args)
      if (writer.mode === 'flip') {
        const bytes = readFileSync(destPath)
        bytes[bytes.length - 1] ^= 0xff
        writeFileSync(destPath, bytes)
      }
    }
  }
})

/** Runs `body` with the repacker misbehaving, and restores it however that ends. */
async function withWriter(mode: 'garbage' | 'flip', body: () => Promise<void>): Promise<void> {
  writer.mode = mode
  try {
    await body()
  } finally {
    writer.mode = 'ok'
  }
}

const encoder = new TextEncoder()
const NOTES = {
  fileName: 'notes.chart',
  data: encoder.encode('[Song]\n{\n  Resolution = 192\n}\n')
}
const ART = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function chart(): { dir: string; path: string } {
  const dir = tmpDir('sngasset')
  const path = join(dir, 'Artist - Song (Charter).sng')
  writeFileSync(path, makeSng([NOTES], { name: 'Song', artist: 'Artist' }))
  return { dir, path }
}

describe('writeSngAsset', () => {
  it('adds an entry and leaves everything else byte-identical', async () => {
    const { dir, path } = chart()
    await writeSngAsset(path, 'album.png', ART, [{ path: dir }])
    const back = await readSngForRepack(new Uint8Array(readFileSync(path)))
    expect(back.entries.map((e) => e.fileName).sort()).toEqual(['album.png', 'notes.chart'])
    expect(back.entries.find((e) => e.fileName === 'album.png')?.data).toEqual(ART)
    expect(back.entries.find((e) => e.fileName === 'notes.chart')?.data).toEqual(NOTES.data)
    expect(back.metadata.name).toBe('Song')
    expect(back.metadata.artist).toBe('Artist')
    expect(readdirSync(dir)).toEqual(['Artist - Song (Charter).sng'])
  })

  it('replaces an entry that already exists rather than duplicating it', async () => {
    const { dir, path } = chart()
    await writeSngAsset(path, 'album.png', ART, [{ path: dir }])
    await writeSngAsset(path, 'album.png', new Uint8Array([9, 9]), [{ path: dir }])
    const back = await readSngForRepack(new Uint8Array(readFileSync(path)))
    expect(back.entries.filter((e) => e.fileName === 'album.png')).toHaveLength(1)
    expect(back.entries.find((e) => e.fileName === 'album.png')?.data).toEqual(
      new Uint8Array([9, 9])
    )
  })

  it('drops entries matching removeMatching in the same rebuild that adds the new one', async () => {
    // One repack, so the archive never exists on disk in a state where the old cover is gone
    // and the new one has not arrived. A name that only differs in case from the incoming one
    // is kept: see isStaleSibling for why that rule cannot be case-sensitive.
    const { dir, path } = chart()
    writeFileSync(
      path,
      makeSng([NOTES, { fileName: 'album.jpg', data: ART }, { fileName: 'Album.PNG', data: ART }], {
        name: 'Song'
      })
    )
    await writeSngAsset(path, 'album.png', ART, [{ path: dir }], {
      removeMatching: /^album\.(png|jpe?g)$/i
    })
    const back = await readSngForRepack(new Uint8Array(readFileSync(path)))
    expect(back.entries.map((e) => e.fileName).sort()).toEqual([
      'Album.PNG',
      'album.png',
      'notes.chart'
    ])
    expect(readdirSync(dir)).toEqual([basename(path)])
  })

  it('leaves the original untouched when the rebuilt archive cannot be read back', async () => {
    // The whole safety argument: a repacker bug must cost a temp file, not the user's chart.
    const { dir, path } = chart()
    const before = readFileSync(path)
    await withWriter('garbage', async () => {
      await expect(writeSngAsset(path, 'album.png', ART, [{ path: dir }])).rejects.toThrow(/verif/i)
    })
    expect(readFileSync(path)).toEqual(before)
    expect(readdirSync(dir)).toEqual(['Artist - Song (Charter).sng'])
  })

  it('leaves the original untouched when one byte of the rebuilt archive is wrong', async () => {
    // The temp parses, holds every expected entry at every expected length, and carries the
    // right metadata and mask. Only comparing its bytes catches it, which is the point of
    // verifying at all now that the rebuild is copied through a buffer rather than assembled
    // from entries this process decoded.
    const { dir, path } = chart()
    const before = readFileSync(path)
    await withWriter('flip', async () => {
      await expect(writeSngAsset(path, 'album.png', ART, [{ path: dir }])).rejects.toThrow(
        /album\.png does not match/i
      )
    })
    expect(readFileSync(path)).toEqual(before)
    expect(readdirSync(dir)).toEqual(['Artist - Song (Charter).sng'])
  })

  it('keeps the chart file mode across the swap', async () => {
    // The rename installs a brand new inode, so a chart the user had locked down comes back
    // world-readable unless the mode is carried over deliberately.
    const { dir, path } = chart()
    chmodSync(path, 0o600)
    await writeSngAsset(path, 'album.png', ART, [{ path: dir }])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('reports why the repack failed even when the temp cannot be cleaned up', async () => {
    // A directory sitting on the temp path fails the write AND the rm that follows it. The
    // caller must be told about the write, not about the cleanup. EEXIST rather than EISDIR
    // because repackSng opens its destination `wx`, so it refuses a path that is already taken,
    // whatever is sitting there. Imported fresh so the per-call temp counter is back at 0 and
    // the blocking directory can be placed exactly.
    vi.resetModules()
    const fresh = await import('./sng-asset')
    const { dir, path } = chart()
    const before = readFileSync(path)
    mkdirSync(join(dir, `.${basename(path)}.${process.pid}.0.tmp`))
    await expect(fresh.writeSngAsset(path, 'album.png', ART, [{ path: dir }])).rejects.toThrow(
      /EEXIST.*open/
    )
    expect(readFileSync(path)).toEqual(before)
  })

  it('refuses to write outside the library folders', async () => {
    const { path } = chart()
    await expect(writeSngAsset(path, 'album.png', ART, [{ path: '/nowhere' }])).rejects.toThrow(
      /outside the library/i
    )
  })

  it('refuses a .sng inside the library that is a symlink to one outside it', async () => {
    // assertUnderLibrary canonicalizes the target, so the guard follows the link rather than
    // trusting the visible path: the bytes that would be rewritten live outside the library.
    const { dir, path } = chart()
    const link = join(dir, 'link.sng')
    const outside = tmpDir('sngoutside')
    const target = join(outside, 'Artist - Song.sng')
    writeFileSync(target, readFileSync(path))
    symlinkSync(target, link)
    await expect(writeSngAsset(link, 'album.png', ART, [{ path: dir }])).rejects.toThrow(
      /outside the library/i
    )
    expect(readFileSync(target)).toEqual(readFileSync(path))
  })

  it('rejects a file name that is not bare', async () => {
    const { dir, path } = chart()
    for (const name of ['../escape.png', 'a/b.png', '..']) {
      await expect(writeSngAsset(path, name, ART, [{ path: dir }])).rejects.toThrow(/bare name/i)
    }
  })

  it('weighs the incoming asset against the ceiling, and not the archive it goes into', async () => {
    const { dir, path } = chart()
    // The archive is comfortably over the ceiling used here; the asset is under it. The old
    // ceiling summed the two and would have refused this. Nothing about the archive's size is
    // resident any more, so nothing about it belongs in the bound.
    const archiveBytes = statSync(path).size
    expect(archiveBytes).toBeGreaterThan(ART.byteLength * 2)
    await writeSngAsset(path, 'album.png', ART, [{ path: dir }], {
      maxAssetBytes: archiveBytes - 1
    })
    const back = await readSngForRepack(new Uint8Array(readFileSync(path)))
    expect(back.entries.map((e: SngEntry) => e.fileName).sort()).toEqual([
      'album.png',
      'notes.chart'
    ])
  })

  it('refuses an asset over the ceiling before it repacks anything', async () => {
    const { dir, path } = chart()
    const before = readFileSync(path)
    await expect(
      writeSngAsset(path, 'video.webm', new Uint8Array(10), [{ path: dir }], { maxAssetBytes: 9 })
    ).rejects.toThrow(/too large/i)
    expect(readFileSync(path)).toEqual(before)
    expect(readdirSync(dir)).toEqual([basename(path)])
  })

  it('refuses when the volume cannot hold the archive and the asset at once', async () => {
    const { dir, path } = chart()
    const before = readFileSync(path)
    const needed = before.byteLength + ART.byteLength
    await expect(
      writeSngAsset(path, 'album.png', ART, [{ path: dir }], { freeBytes: needed - 1 })
    ).rejects.toThrow(/free space/i)
    expect(readFileSync(path)).toEqual(before)
    expect(readdirSync(dir)).toEqual([basename(path)])
  })

  it('proceeds when free space covers the archive and the asset exactly', async () => {
    const { dir, path } = chart()
    const needed = statSync(path).size + ART.byteLength
    await writeSngAsset(path, 'album.png', ART, [{ path: dir }], { freeBytes: needed })
    const back = await readSngForRepack(new Uint8Array(readFileSync(path)))
    expect(back.entries.map((e: SngEntry) => e.fileName).sort()).toEqual([
      'album.png',
      'notes.chart'
    ])
  })
})

describe('verifyRepack', () => {
  // Fed real archives that are wrong in one specific way each, so the guard's own checks are
  // proven rather than inferred from the write path's single all-garbage case above.
  //
  // Every fixture is written under MASK rather than sng-write's default, because the check that
  // matters most here is about the mask: a copied entry is never unmasked, so its bytes are only
  // meaningful under the mask the archive declares.
  const MASK = new Uint8Array(16).map((_, i) => (i * 53 + 11) % 256)
  const OTHER_MASK = new Uint8Array(16).map((_, i) => (i * 17 + 3) % 256)
  const META = { name: 'Song', artist: 'Artist' }
  /** Long enough, and deliberately not a multiple of 256, to run past any chunk boundary. */
  const BIG = { fileName: 'big.bin', data: new Uint8Array(9973).map((_, i) => (i * 31 + 7) % 256) }

  const scratch = (): string => tmpDir('verify')

  const archive = (
    dir: string,
    name: string,
    entries: SngEntry[],
    metadata: Record<string, string> = META
  ): string => {
    const path = join(dir, name)
    writeFileSync(path, makeSng(entries, metadata, MASK))
    return path
  }

  /** One byte of `data` turned over, so it differs without changing its length. */
  const tweak = (data: Uint8Array): Uint8Array => {
    const copy = new Uint8Array(data)
    copy[copy.length - 1] ^= 0xff
    return copy
  }

  it('accepts a faithful rebuild, across chunk boundaries', async () => {
    // chunkBytes is coprime with 256 on purpose: at any real (power-of-two) chunk size, a
    // comparison that restarted the mask index per chunk would agree with the writer anyway.
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES, BIG])
    const plan = putPlanEntry(await readRepackPlan(source), 'album.png', ART)
    const dest = join(dir, 'dest.sng')
    await repackSng(source, dest, plan, { chunkBytes: 101 })

    await expect(verifyRepack(source, dest, plan, { chunkBytes: 101 })).resolves.toBeUndefined()
  })

  it('rejects bytes that are not a readable archive', async () => {
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES])
    const dest = join(dir, 'dest.sng')
    writeFileSync(dest, Buffer.from([1, 2, 3]))

    await expect(verifyRepack(source, dest, await readRepackPlan(source))).rejects.toThrow(
      /could not be read back/i
    )
  })

  it('rejects an archive that lost an entry', async () => {
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES, BIG])
    const dest = archive(dir, 'dest.sng', [NOTES])

    await expect(verifyRepack(source, dest, await readRepackPlan(source))).rejects.toThrow(
      /expected 2 files, found 1/i
    )
  })

  it('rejects an archive where an expected entry is absent', async () => {
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES, BIG])
    const dest = archive(dir, 'dest.sng', [NOTES, { fileName: 'other.bin', data: BIG.data }])

    await expect(verifyRepack(source, dest, await readRepackPlan(source))).rejects.toThrow(
      /big\.bin is missing/i
    )
  })

  it("rejects an archive where a copied entry's bytes differ", async () => {
    // The entry the rebuild never decoded: proving it is right means comparing the destination's
    // range against the source's range, since nothing in this process holds either.
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES])
    const dest = archive(dir, 'dest.sng', [{ fileName: 'notes.chart', data: tweak(NOTES.data) }])

    await expect(verifyRepack(source, dest, await readRepackPlan(source))).rejects.toThrow(
      /notes\.chart does not match/i
    )
  })

  it("rejects an archive where the added entry's bytes differ", async () => {
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES])
    const plan = putPlanEntry(await readRepackPlan(source), 'album.png', ART)
    const dest = archive(dir, 'dest.sng', [NOTES, { fileName: 'album.png', data: tweak(ART) }])

    await expect(verifyRepack(source, dest, plan)).rejects.toThrow(/album\.png does not match/i)
  })

  it('rejects an archive where an entry is the wrong length', async () => {
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES])
    const dest = archive(dir, 'dest.sng', [
      { fileName: 'notes.chart', data: new Uint8Array(NOTES.data.length + 1) }
    ])

    await expect(verifyRepack(source, dest, await readRepackPlan(source))).rejects.toThrow(
      /notes\.chart is \d+ bytes, expected \d+/i
    )
  })

  it('rejects an archive whose header declares a mask its bytes were not written under', async () => {
    // The failure this milestone cannot afford, and the only one the byte comparison cannot see:
    // the data section here is byte-for-byte the correct rebuild, so every entry compares equal
    // against the source. Swapping the declared mask leaves the magic, both section lengths,
    // every contentsLen and every contentsIndex reading as perfectly correct while every byte a
    // reader unmasks comes back as noise.
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES, BIG])
    const plan = putPlanEntry(await readRepackPlan(source), 'album.png', ART)
    const dest = join(dir, 'dest.sng')
    await repackSng(source, dest, plan)
    const bytes = readFileSync(dest)
    bytes.set(OTHER_MASK, 10) // the header's mask field: 6 bytes of magic, 4 of version
    writeFileSync(dest, bytes)

    await expect(verifyRepack(source, dest, plan)).rejects.toThrow(/mask/i)
  })

  it('rejects an archive whose header metadata did not round-trip', async () => {
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES])
    const dest = archive(dir, 'dest.sng', [NOTES], { ...META, name: 'Wrong' })

    await expect(verifyRepack(source, dest, await readRepackPlan(source))).rejects.toThrow(
      /metadata name did not round-trip/i
    )
  })

  it('rejects an archive whose header metadata gained a key', async () => {
    // Header metadata is what Clone Hero shows for the song, so an invented field is a visible
    // edit to the user's chart; checking only that our keys survived would wave it through.
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES])
    const dest = archive(dir, 'dest.sng', [NOTES], { ...META, charter: 'Nobody' })

    await expect(verifyRepack(source, dest, await readRepackPlan(source))).rejects.toThrow(
      /metadata gained charter/i
    )
  })

  it('rejects an archive whose entries do not fill it exactly', async () => {
    // Each entry is compared at the offset the header declares, which is where the game seeks.
    // parse-sng, the scanner and every other reader in this app walk the data section start to
    // finish instead, so an archive that is a byte short or a byte long is one where those two
    // readings disagree. The old verification, which only ever read sequentially, could not
    // have produced the first reading at all.
    const dir = scratch()
    const source = archive(dir, 'source.sng', [NOTES, BIG])
    const plan = await readRepackPlan(source)

    const long = join(dir, 'long.sng')
    await repackSng(source, long, plan)
    writeFileSync(long, Buffer.concat([readFileSync(long), Buffer.from([0])]))
    await expect(verifyRepack(source, long, plan)).rejects.toThrow(/entries end at/i)

    const short = join(dir, 'short.sng')
    await repackSng(source, short, plan)
    truncateSync(short, statSync(short).size - 1)
    await expect(verifyRepack(source, short, plan)).rejects.toThrow(/entries end at/i)
  })

  it('accepts an archive that carries duplicate entry names faithfully', async () => {
    // Name lookup alone would pair both copies with the first match and reject a rebuild that
    // is in fact byte-perfect; matching one-to-one keeps a damaged-but-repackable chart usable.
    const dupes = [
      { fileName: 'dup.txt', data: new Uint8Array([1]) },
      { fileName: 'dup.txt', data: new Uint8Array([2]) }
    ]
    const dir = scratch()
    const source = archive(dir, 'source.sng', dupes)
    const plan = await readRepackPlan(source)
    const dest = join(dir, 'dest.sng')
    await repackSng(source, dest, plan)

    await expect(verifyRepack(source, dest, plan)).resolves.toBeUndefined()
  })
})
