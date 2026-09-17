import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../test/helpers/make-sng'
import { tmpDir } from '../../../test/helpers/tmp'
import { writeChartAsset } from '../assets/write'
import { scanChartIssues } from '../catalog/issues'
import { readRepackPlan } from '../downloads/sng-repack'
import { assertChartHashUnchanged, assertCloneHeroChecksumUnchanged } from '../issues/fix'
import { assertFieldsLanded, readChartMetadata, writeChartMetadata } from './edit'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)
const text = (data: Uint8Array): string => Buffer.from(data).toString('utf8')

/** Guitar and nothing else, so the chart file's bytes are stable across every edit below. */
const NOTES = bytes(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
)

/**
 * A `song.ini` shaped like the ones this editor meets: a comment, a blank line, an unknown key,
 * odd spacing, a missing album and year (which is the `missingValue` row that brings someone
 * here), and `pro_drums` and `hopo_frequency` set AWAY from their defaults.
 *
 * Those last two are what make the hash assertions in this file mean anything. `getChartHash`
 * only mixes in a gameplay key that differs from its default, so without them every assertion
 * below would be comparing two hashes of the chart file alone and would pass however badly
 * song.ini was mangled.
 */
const SONG_INI_TEXT = [
  '; ripped from somewhere',
  '',
  '[song]',
  'name = Fixture',
  'artist=Tester',
  '   charter   =   Tester   ',
  'genre = Rock',
  'unknown_key = keep me',
  'pro_drums = True',
  'hopo_frequency = 3'
].join('\n')
const SONG_INI = bytes(`${SONG_INI_TEXT}\n`)

const scratchDirs: string[] = []

function scratch(): string {
  const dir = tmpDir('metaedit')
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()!
    // A test below drops a chart folder to 0o500 to force a write failure and restores it, but a
    // test that threw before its restore would otherwise wedge the run's own cleanup.
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function folderChart(files: Record<string, Uint8Array> = {}): string {
  const dir = join(scratch(), 'Tester - Fixture')
  mkdirSync(dir, { recursive: true })
  const all = { 'notes.chart': NOTES, 'song.ini': SONG_INI, ...files }
  for (const [name, data] of Object.entries(all)) writeFileSync(join(dir, name), data)
  return dir
}

/**
 * A `.sng` with NO packed `song.ini`, which is how Chorus ships them: every field lives in the
 * archive header and parse-sng synthesises the ini scan-chart reads. That is what makes an edit
 * to one of these a header change and a full repack rather than a file write.
 */
function sngChart(metadata: Record<string, string> = {}): string {
  const path = join(scratch(), 'fixture.sng')
  writeFileSync(
    path,
    makeSng([{ fileName: 'notes.chart', data: NOTES }], {
      name: 'Fixture',
      artist: 'Tester',
      charter: 'Tester',
      genre: 'Rock',
      pro_drums: 'True',
      hopo_frequency: '3',
      ...metadata
    })
  )
  return path
}

/** The write guard's allow-list, scoped to the one scratch directory a fixture lives in. */
function folders(chartPath: string): { path: string }[] {
  return [{ path: join(chartPath, '..') }]
}

const iniOf = (chart: string): string => text(new Uint8Array(readFileSync(join(chart, 'song.ini'))))

describe('readChartMetadata', () => {
  it("reads a folder chart's raw values, not scan-chart's reading of them", async () => {
    const read = await readChartMetadata(folderChart(), 'folder')

    expect(read.fields).toEqual({
      name: 'Fixture',
      artist: 'Tester',
      // The odd spacing is trimmed the way `parseIni` trims it, and nothing else about the line
      // is interpreted.
      charter: 'Tester',
      genre: 'Rock',
      album: '',
      year: ''
    })
    // Not "Unknown Album" and "Unknown Year", which is what a scan would have said. Writing
    // those back is exactly the failure this read exists to avoid.
    expect(read.refusal).toBeNull()
    expect(read.iniName).toBe('song.ini')
    expect(read.synthetic).toBe(false)
  })

  it('reports the gameplay keys the chart sets, so the form can show what it will not edit', async () => {
    const read = await readChartMetadata(folderChart(), 'folder')

    expect(read.gameplay).toEqual([
      { key: 'hopo_frequency', value: '3' },
      { key: 'pro_drums', value: 'True' }
    ])
  })

  it("reads a .sng's values from the header rather than the generated ini", async () => {
    // The generated ini omits every key holding its default, so a chart that really does set
    // `album_track = 16000` would read back empty through it. The header is also what a save
    // writes to, so reading anywhere else would let the two disagree.
    const read = await readChartMetadata(sngChart({ album: 'Header Album' }), 'sng')

    expect(read.synthetic).toBe(true)
    expect(read.fields.album).toBe('Header Album')
    expect(read.fields.year).toBe('')
    expect(read.gameplay).toEqual([
      { key: 'hopo_frequency', value: '3' },
      { key: 'pro_drums', value: 'True' }
    ])
  })

  it('refuses a chart with no song.ini, in words the form can show', async () => {
    const chart = folderChart()
    rmSync(join(chart, 'song.ini'))

    const read = await readChartMetadata(chart, 'folder')

    expect(read.refusal).toMatch(/no song\.ini/)
    expect(read.fields.artist).toBe('')
  })

  it('refuses a .sng that packs its own song.ini as well as header metadata', async () => {
    // Two answers to "what is this chart's album": the packed file, which scan-chart reads, and
    // the header, which Clone Hero's song list reads. Editing either would leave the other
    // contradicting it.
    const path = join(scratch(), 'packed.sng')
    writeFileSync(
      path,
      makeSng(
        [
          { fileName: 'notes.chart', data: NOTES },
          { fileName: 'song.ini', data: SONG_INI }
        ],
        { name: 'Fixture', artist: 'Tester' }
      )
    )

    const read = await readChartMetadata(path, 'sng')

    expect(read.refusal).toMatch(/packs its own song\.ini/)
  })
})

describe('writeChartMetadata on a folder chart', () => {
  it('fills in the missing fields and leaves every other byte of song.ini alone', async () => {
    const chart = folderChart()

    const result = await writeChartMetadata(
      chart,
      { album: 'Moving Pictures', year: '1981' },
      folders(chart)
    )

    expect(result.changed).toEqual(['album', 'year'])
    // Byte-for-byte. The comment, the blank line, the unknown key, the padding around `charter`
    // and the key ORDER all survive, and the two new keys land at the end of the section. A
    // parse-and-reserialise would have changed several of those, and one of the keys it would
    // have rewritten is hashed.
    expect(iniOf(chart)).toBe(`${SONG_INI_TEXT}\nalbum = Moving Pictures\nyear = 1981\n`)
  })

  it('replaces a value in place without moving its line', async () => {
    const chart = folderChart()

    await writeChartMetadata(chart, { artist: 'Rush' }, folders(chart))

    expect(iniOf(chart)).toBe(`${SONG_INI_TEXT}\n`.replace('artist=Tester', 'artist=Rush'))
  })

  it('clears a field to empty by removing the key', async () => {
    const chart = folderChart()

    const result = await writeChartMetadata(chart, { genre: '' }, folders(chart))

    expect(result.changed).toEqual(['genre'])
    expect(iniOf(chart)).toBe(`${SONG_INI_TEXT}\n`.replace('genre = Rock\n', ''))
    // And the chart now reports the missingValue row it did not have before, which is the honest
    // consequence of clearing a required field rather than a bug.
    const read = await readChartMetadata(chart, 'folder')
    expect(read.fields.genre).toBe('')
  })

  it('writes non-ASCII as UTF-8 and reads it back unchanged', async () => {
    const chart = folderChart()

    await writeChartMetadata(
      chart,
      { artist: 'Motörhead', album: '涅槃', name: 'Ace of Spades \u{1F3B8}' },
      folders(chart)
    )

    const read = await readChartMetadata(chart, 'folder')
    expect(read.fields.artist).toBe('Motörhead')
    expect(read.fields.album).toBe('涅槃')
    // An astral-plane codepoint: four bytes in UTF-8 and a surrogate pair in UTF-16, which is
    // where a length-based byte walk would come apart.
    expect(read.fields.name).toBe('Ace of Spades \u{1F3B8}')
  })

  it('writes nothing at all when the form matches the file', async () => {
    const chart = folderChart()
    const before = readFileSync(join(chart, 'song.ini'))

    const result = await writeChartMetadata(chart, { artist: 'Tester' }, folders(chart))

    expect(result.changed).toEqual([])
    // Not merely "the same text": the same bytes, and, for a .sng, a whole archive not copied.
    expect(readFileSync(join(chart, 'song.ini'))).toEqual(before)
  })

  it('leaves both multiplayer identities byte-identical', async () => {
    const chart = folderChart()
    const before = await scanChartIssues(chart, 'folder')

    await writeChartMetadata(chart, { album: 'Moving Pictures', year: '1981' }, folders(chart))

    const after = await scanChartIssues(chart, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.chartHash).not.toBeNull()
    expect(after.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
    expect(after.cloneHeroChecksum).not.toBeNull()
  })

  it('refuses a year the catalog could not store', async () => {
    const chart = folderChart()

    await expect(
      writeChartMetadata(chart, { year: 'late nineties' }, folders(chart))
    ).rejects.toThrow(/four digits/)
    expect(iniOf(chart)).toBe(`${SONG_INI_TEXT}\n`)
  })

  it.each([
    ['a key Clone Hero matches charts by', 'pro_drums', /matches charts between players/],
    ['a key the editor does not offer', 'loading_phrase', /does not edit/]
  ])('refuses %s before it opens the chart', async (_label, key, message) => {
    const chart = folderChart()

    await expect(
      writeChartMetadata(chart, { [key]: 'x' } as never, folders(chart))
    ).rejects.toThrow(message)
    expect(iniOf(chart)).toBe(`${SONG_INI_TEXT}\n`)
  })

  it('refuses a chart outside the library folders', async () => {
    const chart = folderChart()

    await expect(
      writeChartMetadata(chart, { album: 'X' }, [{ path: join(scratch(), 'elsewhere') }])
    ).rejects.toThrow()
    expect(iniOf(chart)).toBe(`${SONG_INI_TEXT}\n`)
  })

  it('reports a failed write rather than a save that did not happen', async () => {
    const chart = folderChart()
    // The temp file `writeChartAsset` renames from lives inside the chart folder, so a folder the
    // process cannot write to fails at the first byte, with the original still in place.
    chmodSync(chart, 0o500)
    try {
      await expect(writeChartMetadata(chart, { album: 'X' }, folders(chart))).rejects.toThrow()
    } finally {
      chmodSync(chart, 0o700)
    }

    expect(iniOf(chart)).toBe(`${SONG_INI_TEXT}\n`)
  })

  it('names the chart when it has gone between the read and the save', async () => {
    // The realistic shape of this: the form is open, a scan or a file manager moves the chart,
    // and Save is pressed against a path that is no longer there.
    const chart = folderChart()
    const read = await readChartMetadata(chart, 'folder')
    expect(read.refusal).toBeNull()
    rmSync(chart, { recursive: true, force: true })

    await expect(writeChartMetadata(chart, { album: 'X' }, folders(chart))).rejects.toThrow(
      /is not there any more/
    )
  })

  it('refuses a chart whose song.ini was deleted after the form was opened', async () => {
    const chart = folderChart()
    rmSync(join(chart, 'song.ini'))

    await expect(writeChartMetadata(chart, { album: 'X' }, folders(chart))).rejects.toThrow(
      /no song\.ini to edit/
    )
  })

  it('edits the .ini scan-chart reads, even when that is not called song.ini', async () => {
    // `findIniData` falls back to the LAST `.ini` of any name, so a chart holding only
    // `desktop.ini` really is read from it. Writing `song.ini` instead would leave the value
    // scan-chart reads exactly where it was while reporting the save as done.
    const dir = join(scratch(), 'Tester - Oddity')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.chart'), NOTES)
    writeFileSync(join(dir, 'desktop.ini'), SONG_INI)

    await writeChartMetadata(dir, { album: 'Moving Pictures' }, folders(dir))

    expect(text(new Uint8Array(readFileSync(join(dir, 'desktop.ini'))))).toContain(
      'album = Moving Pictures'
    )
    // And no `song.ini` was invented beside it, which is what a writer that assumed the name
    // would have produced: a file scan-chart would then have read instead.
    expect(readdirSync(dir).sort()).toEqual(['desktop.ini', 'notes.chart'])
  })
})

describe('writeChartMetadata on a .sng chart', () => {
  it('edits the header and keeps both identities', async () => {
    const chart = sngChart()
    const before = await scanChartIssues(chart, 'sng')

    const result = await writeChartMetadata(
      chart,
      { album: 'Moving Pictures', year: '1981' },
      folders(chart)
    )

    expect(result.changed).toEqual(['album', 'year'])
    const plan = await readRepackPlan(chart)
    expect(plan.metadata.album).toBe('Moving Pictures')
    expect(plan.metadata.year).toBe('1981')
    // Every other header value survived the repack, including the two hashed ones.
    expect(plan.metadata.name).toBe('Fixture')
    expect(plan.metadata.pro_drums).toBe('True')
    expect(plan.metadata.hopo_frequency).toBe('3')

    const after = await scanChartIssues(chart, 'sng')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.chartHash).not.toBeNull()
    expect(after.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
    expect(after.cloneHeroChecksum).not.toBeNull()
  })

  it('deletes the header key when a field is cleared to empty', async () => {
    // Rather than writing an empty value. `generateSongIniText` omits an empty key, so the two
    // are the same to every reader, and one of them leaves the header carrying a field that
    // means "unset" where there should be no field at all.
    const chart = sngChart({ album: 'Header Album' })

    const result = await writeChartMetadata(chart, { album: '' }, folders(chart))

    expect(result.changed).toEqual(['album'])
    expect(Object.hasOwn((await readRepackPlan(chart)).metadata, 'album')).toBe(false)
  })

  it('writes non-ASCII into the header and reads it back unchanged', async () => {
    const chart = sngChart()

    await writeChartMetadata(chart, { artist: 'Motörhead', album: '涅槃' }, folders(chart))

    const read = await readChartMetadata(chart, 'sng')
    expect(read.fields.artist).toBe('Motörhead')
    expect(read.fields.album).toBe('涅槃')
  })

  it('does not repack when the form matches the header', async () => {
    const chart = sngChart()
    const before = readFileSync(chart)

    const result = await writeChartMetadata(chart, { artist: 'Tester' }, folders(chart))

    expect(result.changed).toEqual([])
    // Byte-identical, which for an archive is the difference between a no-op and copying every
    // entry the chart has.
    expect(readFileSync(chart)).toEqual(before)
  })

  it('refuses a .sng that packs its own song.ini', async () => {
    const path = join(scratch(), 'packed.sng')
    writeFileSync(
      path,
      makeSng(
        [
          { fileName: 'notes.chart', data: NOTES },
          { fileName: 'song.ini', data: SONG_INI }
        ],
        { name: 'Fixture', artist: 'Tester' }
      )
    )
    const before = readFileSync(path)

    await expect(writeChartMetadata(path, { album: 'X' }, folders(path))).rejects.toThrow(
      /packs its own song\.ini/
    )
    expect(readFileSync(path)).toEqual(before)
  })

  it('names the archive when it has gone between the read and the save', async () => {
    const chart = sngChart()
    await readChartMetadata(chart, 'sng')
    rmSync(chart)

    await expect(writeChartMetadata(chart, { album: 'X' }, folders(chart))).rejects.toThrow(
      /is not there any more/
    )
  })
})

/**
 * The three checks, proved able to fire.
 *
 * An assertion on a number that never moves proves nothing, and on a well-behaved metadata edit
 * neither identity CAN move: `getChartHash` covers the chart file's bytes plus seven gameplay
 * keys, none of which this module writes, and `cloneHeroChecksum` covers the chart file's bytes
 * alone. That is the argument for editing these six fields at all, and it is also what would
 * make a test that only saved an album and compared two hashes worthless. So each check is driven
 * here by real damage on the real write path, and the assertion the save calls is the one
 * asserted to throw.
 */
describe('MUTATION: the checks that stand between a bad write and a reported success', () => {
  it('a song.ini edit that took a hashed key with it fires the chart-hash assertion', async () => {
    // What a line editor that ran off the end of the line it meant to edit would do, and the one
    // failure of THIS module that only `chartHash` can see: the chart file is untouched, so the
    // number Clone Hero itself records does not move at all. Same write path, same re-scan, one
    // hashed key removed instead of an album added.
    const chart = folderChart()
    const before = await scanChartIssues(chart, 'folder')

    writeChartAsset(
      chart,
      'song.ini',
      bytes(`${SONG_INI_TEXT}\n`.replace('pro_drums = True\n', '')),
      folders(chart)
    )
    const after = await scanChartIssues(chart, 'folder')

    expect(after.chartHash).not.toBe(before.chartHash)
    expect(() => assertChartHashUnchanged(chart, before.chartHash, after.chartHash)).toThrow(
      /changed the chart hash/
    )
    // And the other assertion is silent on it, which is why both are called rather than one.
    expect(after.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
    expect(() =>
      assertCloneHeroChecksumUnchanged(chart, before.cloneHeroChecksum, after.cloneHeroChecksum)
    ).not.toThrow()
  })

  it('a write that reached the chart file fires the Clone Hero checksum assertion', async () => {
    // The other half of the partition, and the one the game itself would notice. A metadata edit
    // must never touch `notes.chart`; this is what says the guard could tell if it did.
    const chart = folderChart()
    const before = await scanChartIssues(chart, 'folder')

    writeChartAsset(chart, 'notes.chart', bytes(`${text(NOTES)}\n`), folders(chart))
    const after = await scanChartIssues(chart, 'folder')

    expect(after.cloneHeroChecksum).not.toBe(before.cloneHeroChecksum)
    expect(() =>
      assertCloneHeroChecksumUnchanged(chart, before.cloneHeroChecksum, after.cloneHeroChecksum)
    ).toThrow(/changed the checksum Clone Hero records/)
    expect(() => assertChartHashUnchanged(chart, before.chartHash, after.chartHash)).toThrow(
      /changed the chart hash/
    )
  })

  it('a chart that does not say what was asked for fires the landed-fields check', async () => {
    // Neither identity looks at the six keys this module writes, which is the whole reason those
    // keys are safe to edit and the whole reason this third check exists. Driven directly,
    // against a chart whose album is not the one the caller asked for.
    const chart = folderChart()

    await expect(assertFieldsLanded(chart, 'folder', { album: 'Moving Pictures' })).rejects.toThrow(
      /does not read back as asked/
    )

    await writeChartMetadata(chart, { album: 'Moving Pictures' }, folders(chart))
    await expect(
      assertFieldsLanded(chart, 'folder', { album: 'Moving Pictures' })
    ).resolves.toBeUndefined()
  })

  it('leaves a hashed key on the last line of a terminator-less file intact', async () => {
    // The insertion path's sharpest edge: the section ends on `pro_drums = True` with no newline
    // after it, so a writer that appended without one would produce `pro_drums = Truealbum = X`
    // and move the hash. The assertion inside the save is what would catch it; this shows it
    // never gets the chance.
    const chart = folderChart({
      'song.ini': bytes(`${SONG_INI_TEXT}`.replace(/\nhopo_frequency = 3$/, ''))
    })
    const before = await scanChartIssues(chart, 'folder')

    await writeChartMetadata(chart, { album: 'Moving Pictures' }, folders(chart))

    const after = await scanChartIssues(chart, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    expect(iniOf(chart)).toContain('pro_drums = True\nalbum = Moving Pictures')
  })
})
