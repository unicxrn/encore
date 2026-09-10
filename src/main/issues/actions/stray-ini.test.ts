import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../../test/helpers/make-sng'
import { removeChartFiles } from '../../assets/write'
import { scanChartIssues, type ChartIssueRow } from '../../catalog/issues'
import { readSngEntriesForScan } from '../../downloads/sng-read-selective'
import { iniFileScanChartReads } from '../chart-ini'
import { applyFix, type FixAction, type FixContext } from '../fix'
import { invalidIniName, strayIniAction } from './stray-ini'
import { tmpDir } from '../../../../test/helpers/tmp'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

const NOTES = bytes(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
)

/**
 * The two ini files carry DIFFERENT `hopo_frequency` values, and that is the whole point of this
 * fixture.
 *
 * `hopo_frequency` is one of the seven keys `getChartHash` mixes into a chart's multiplayer
 * identity. With both files agreeing, every test below would pass whichever file the fix
 * deleted, because the hash would be the same either way and the safety property would be
 * untested. With them disagreeing, deleting the wrong one moves the hash, which is exactly the
 * failure this action exists to avoid and the mutation test below provokes on purpose.
 */
const SONG_INI = bytes(
  '[song]\nname = Fixture\nartist = Tester\ncharter = Tester\ndiff_guitar = 3\npro_drums = True\nhopo_frequency = 3\n'
)
const DESKTOP_INI = bytes('[song]\nname = Explorer Junk\nhopo_frequency = 7\n')

const scratchDirs: string[] = []

function scratch(): string {
  const dir = tmpDir('strayini')
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

function folderChart(files: Record<string, Uint8Array> = {}): string {
  const dir = join(scratch(), 'Tester - Fixture')
  mkdirSync(dir, { recursive: true })
  const all = {
    'notes.chart': NOTES,
    'song.ini': SONG_INI,
    'desktop.ini': DESKTOP_INI,
    ...files
  }
  for (const [name, data] of Object.entries(all)) writeFileSync(join(dir, name), data)
  return dir
}

/**
 * A `.sng` shaped like the one real chart in the reference library that carries this: no packed
 * `song.ini` (the metadata is header metadata, and the reader synthesises the ini scan-chart
 * parses) plus a `desktop.ini` Windows Explorer left behind.
 */
function sngChart(): string {
  const path = join(scratch(), 'fixture.sng')
  writeFileSync(
    path,
    makeSng(
      [
        { fileName: 'notes.chart', data: NOTES },
        { fileName: 'desktop.ini', data: DESKTOP_INI }
      ],
      {
        name: 'Fixture',
        artist: 'Tester',
        charter: 'Tester',
        pro_drums: 'True',
        hopo_frequency: '3'
      }
    )
  )
  return path
}

/** scan-chart's own wordings, verbatim from index.js:357 and :364. */
function invalidIniRow(chartPath: string, fileName = 'desktop.ini'): ChartIssueRow {
  return {
    chartPath,
    kind: 'folder',
    code: 'invalidIni',
    description: `"${fileName}" is not named "song.ini".`
  }
}

function multipleIniRow(chartPath: string): ChartIssueRow {
  return {
    chartPath,
    kind: 'folder',
    code: 'multipleIniFiles',
    description: 'This chart has multiple .ini files.'
  }
}

function ctxFor(chartPath: string, over: Partial<FixContext> = {}): FixContext {
  return {
    libraryFolders: [{ path: join(chartPath, '..') }],
    // A real store, so every repair below also proves its backup is taken. See album-art-size.
    backupDir: join(scratch(), 'fix-backups'),
    ...over
  }
}

describe('iniFileScanChartReads', () => {
  it('keeps the last file named exactly song.ini', () => {
    expect(iniFileScanChartReads(['desktop.ini', 'song.ini', 'thumbs.ini'])).toBe('song.ini')
  })

  it('falls back to the LAST .ini when nothing is named song.ini', () => {
    // The case that makes "keep the one called song.ini" wrong. A chart holding only misnamed
    // inis is still read from one of them, so it still supplies the hashed keys.
    expect(iniFileScanChartReads(['first.ini', 'desktop.ini'])).toBe('desktop.ini')
  })

  it('matches song.ini case-sensitively, as hasIniName does', () => {
    expect(iniFileScanChartReads(['Song.INI'])).toBe('Song.INI')
    expect(iniFileScanChartReads(['Song.INI', 'song.ini'])).toBe('song.ini')
    // ...but the EXTENSION is matched case-insensitively, as hasIniExtension does.
    expect(iniFileScanChartReads(['notes.chart', 'a.INI'])).toBe('a.INI')
  })

  it('is null for a chart with no .ini at all', () => {
    expect(iniFileScanChartReads(['notes.chart', 'song.ogg'])).toBe(null)
  })
})

describe('invalidIniName', () => {
  it("reads the file out of scan-chart's wording", () => {
    expect(invalidIniName(invalidIniRow('/lib/c'))).toBe('desktop.ini')
  })

  it.each([
    'desktop.ini is not named "song.ini".',
    'Note: "desktop.ini" is not named "song.ini".',
    '"desktop.ini" is not named "song.ini". And more.'
  ])('refuses to parse %s, and offers no fix', (description) => {
    // This action DELETES what it parses, so the template is anchored at both ends.
    const row = { ...invalidIniRow('/lib/c'), description }
    expect(invalidIniName(row)).toBe(null)
    expect(strayIniAction.appliesTo(row)).toBe(false)
  })

  it('claims both codes, from the folder issue array only', () => {
    expect(strayIniAction.appliesTo(invalidIniRow('/lib/c'))).toBe(true)
    expect(strayIniAction.appliesTo(multipleIniRow('/lib/c'))).toBe(true)
    expect(strayIniAction.appliesTo({ ...multipleIniRow('/lib/c'), kind: 'metadata' })).toBe(false)
  })
})

describe('stray .ini removal on a folder chart', () => {
  it('removes the named file, keeps the one scan-chart reads, and clears both rows', async () => {
    const chart = folderChart()
    const before = await scanChartIssues(chart, 'folder')
    expect(before.rows.map((r) => r.code)).toEqual(
      expect.arrayContaining(['invalidIni', 'multipleIniFiles'])
    )

    const after = await applyFix(invalidIniRow(chart), ctxFor(chart))

    expect(after.map((r) => r.code)).not.toContain('invalidIni')
    // One removal clears both rows, because they are two views of one state.
    expect(after.map((r) => r.code)).not.toContain('multipleIniFiles')
    expect(existsSync(join(chart, 'desktop.ini'))).toBe(false)
    expect(existsSync(join(chart, 'song.ini'))).toBe(true)
  })

  it('leaves the multiplayer hash byte-identical', async () => {
    const chart = folderChart()
    const before = await scanChartIssues(chart, 'folder')

    await applyFix(invalidIniRow(chart), ctxFor(chart))

    const after = await scanChartIssues(chart, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.chartHash).not.toBeNull()
  })

  it('MUTATION: deleting the file scan-chart reads really does move the hash', async () => {
    // Without this, the test above proves only that deleting SOMETHING left the hash alone. The
    // two ini files carry different hopo_frequency values, so removing the survivor hands the
    // chart the stray file's value: a different chart to Clone Hero, and the exact damage this
    // action is arranged to avoid. applyFix catches it; the point here is that there is something
    // to catch.
    const chart = folderChart()
    const backwards: FixAction = {
      ...strayIniAction,
      apply: async (row, ctx) => removeChartFiles(row.chartPath, ['song.ini'], ctx.libraryFolders)
    }

    await expect(applyFix(invalidIniRow(chart), ctxFor(chart), [backwards])).rejects.toThrow(
      /changed the chart hash/
    )
  })

  it('refuses when the misnamed file is the one scan-chart reads', async () => {
    // No song.ini, so `findIniData` falls back to the last .ini of any name, which is this one.
    // Deleting it would leave the chart with no metadata at all and change what Clone Hero
    // matches it by.
    const chart = folderChart()
    rmSync(join(chart, 'song.ini'))

    await expect(applyFix(invalidIniRow(chart), ctxFor(chart))).rejects.toThrow(
      /it is also the file scan-chart reads/
    )
    expect(existsSync(join(chart, 'desktop.ini'))).toBe(true)
  })

  it('refuses a file the chart no longer has', async () => {
    const chart = folderChart()

    await expect(applyFix(invalidIniRow(chart, 'thumbs.ini'), ctxFor(chart))).rejects.toThrow(
      /no longer contains thumbs\.ini/
    )
    expect(existsSync(join(chart, 'desktop.ini'))).toBe(true)
  })

  it('a multipleIniFiles row removes every stray at once', async () => {
    const chart = folderChart({ 'thumbs.ini': bytes('[song]\nhopo_frequency = 9\n') })

    const after = await applyFix(multipleIniRow(chart), ctxFor(chart))

    expect(readdirSync(chart).filter((n) => n.endsWith('.ini'))).toEqual(['song.ini'])
    expect(after.map((r) => r.code)).not.toContain('multipleIniFiles')
    expect(after.map((r) => r.code)).not.toContain('invalidIni')
  })

  it('keeps the right file when NOTHING is named song.ini', async () => {
    // The branch where "keep the one called song.ini" has no answer and the survivor is decided
    // purely by order. It is also the branch where getting it wrong changes the hash, because
    // the two files set different hopo_frequency values. readdir order is the filesystem's to
    // choose, so the expectation is computed from the same call the scan makes rather than
    // hardcoded.
    const chart = folderChart({ 'aaa.ini': SONG_INI })
    rmSync(join(chart, 'song.ini'))
    const survivor = iniFileScanChartReads(readdirSync(chart))
    const before = await scanChartIssues(chart, 'folder')

    await applyFix(multipleIniRow(chart), ctxFor(chart))

    expect(readdirSync(chart).filter((n) => n.endsWith('.ini'))).toEqual([survivor])
    const after = await scanChartIssues(chart, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.chartHash).not.toBeNull()
  })

  it('refuses a multipleIniFiles row on a chart that now has only one', async () => {
    const chart = folderChart()
    rmSync(join(chart, 'desktop.ini'))

    await expect(applyFix(multipleIniRow(chart), ctxFor(chart))).rejects.toThrow(
      /only one \.ini file left/
    )
  })
})

describe('stray .ini removal on a .sng chart', () => {
  it('drops the entry through a repack, keeps the hash, and keeps everything else', async () => {
    const chart = sngChart()
    const before = await scanChartIssues(chart, 'sng')
    expect(before.rows.map((r) => r.code)).toEqual(
      expect.arrayContaining(['invalidIni', 'multipleIniFiles'])
    )

    const after = await applyFix(invalidIniRow(chart), ctxFor(chart))

    expect(after.map((r) => r.code)).not.toContain('invalidIni')
    expect(after.map((r) => r.code)).not.toContain('multipleIniFiles')
    const rescan = await scanChartIssues(chart, 'sng')
    expect(rescan.chartHash).toBe(before.chartHash)
    expect(rescan.chartHash).not.toBeNull()
  })

  it('never targets the song.ini the reader synthesised, because it is not a file', async () => {
    const chart = sngChart()

    await applyFix(multipleIniRow(chart), ctxFor(chart))

    // The scan list still shows a song.ini afterwards, generated from the header, as it always
    // was. What went is the one entry the archive really held.
    const { entries } = await readSngEntriesForScan(chart)
    expect(entries.map((e) => e.fileName).sort()).toEqual(['notes.chart', 'song.ini'])
  })
})
