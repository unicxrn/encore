import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makePng } from '../../../test/helpers/make-png'
import { makeSng } from '../../../test/helpers/make-sng'
import { tmpDir } from '../../../test/helpers/tmp'
import { pendingChartLockCount } from '../assets/write'
import { scanChartIssues, type ChartIssueRow } from '../catalog/issues'
import { extractSngEntries } from '../downloads/sng'
import { rewriteSngPlan, writeSngAsset } from '../assets/sng-asset'
import { readRepackPlan } from '../downloads/sng-repack'
import { listBackups } from './backup-store'
import { applyFix, type AlbumArtSquarer, type FixAction, type FixContext } from './fix'
import { assertRestoreChecksum, assertRestoreHash, restoreBackup } from './restore'

/**
 * Undo, end to end: repair a chart, put it back, and prove the file that came back is the file
 * that went in.
 *
 * The assertions are deliberately on BYTES rather than on "the issue row came back". A row
 * returning proves the chart looks unrepaired to scan-chart, which a zero-length `video.mp4` would
 * also achieve. `toEqual` over the two Uint8Arrays is the claim the feature actually makes.
 *
 * Every test here drives `applyFix` for the repair rather than calling an action directly, because
 * the backup is taken by the framework, and the interesting property (that what was copied aside
 * is what was replaced) only exists across the pair.
 */

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)

const NOTES = bytes(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
)

/**
 * Two of the seven keys `getChartHash` mixes in, both away from their defaults, plus a comment,
 * odd spacing and an unknown key.
 *
 * The hashed keys are what make the hash assertions mean anything. The formatting is what makes
 * the `extraValue` restore mean anything: an undo that rebuilt `song.ini` from parsed values
 * rather than restoring the file would come back tidied, and the byte comparison would catch it.
 */
const SONG_INI = bytes(
  [
    '; ripped from somewhere',
    '',
    '[song]',
    'name = Fixture',
    'artist=Tester',
    'charter = Tester',
    'diff_guitar = 3',
    'diff_bass=4',
    'unknown_key = keep me',
    'pro_drums = True',
    'hopo_frequency = 3',
    ''
  ].join('\n')
)

/** Bigger than the repacker's and the extractor's 1 MiB chunk, so both cross a boundary. */
const VIDEO = new Uint8Array(1_500_000).map((_, i) => (i * 29 + 7) % 256)

/** A size scan-chart rejects: it accepts exactly "500x500" and "512x512" and nothing else. */
const SMALL_ART = makePng(300, 300)

const DESKTOP_INI = bytes('[song]\nname = Explorer Junk\nhopo_frequency = 7\n')

const scratchDirs: string[] = []

function scratch(): string {
  const dir = tmpDir('restore')
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  // These fixtures are megabytes each and /tmp is not ours to fill.
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

interface Fixture {
  chartPath: string
  storeDir: string
  ctx: FixContext
}

const converter = {
  unavailableReason: async (): Promise<string | null> => null,
  convert: async ({ input, output }: { input: string; output: string }): Promise<void> => {
    writeFileSync(output, Buffer.concat([Buffer.from('WEBM:'), readFileSync(input)]))
  }
}

/** See fix.test.ts: `encodeSquareAlbumArt` needs Electron's nativeImage, which vitest has not got. */
const squareArt: AlbumArtSquarer = () => makePng(512, 512)

function folderChart(files: Record<string, Uint8Array> = {}): Fixture {
  const root = scratch()
  const chartPath = join(root, 'Tester - Fixture')
  mkdirSync(chartPath, { recursive: true })
  for (const [name, data] of Object.entries({
    'notes.chart': NOTES,
    'song.ini': SONG_INI,
    ...files
  })) {
    writeFileSync(join(chartPath, name), data)
  }
  return fixtureFor(chartPath, root)
}

function sngChart(
  files: Record<string, Uint8Array> = {},
  metadata: Record<string, string> = {}
): Fixture {
  const root = scratch()
  const chartPath = join(root, 'fixture.sng')
  writeFileSync(
    chartPath,
    makeSng(
      Object.entries({ 'notes.chart': NOTES, ...files }).map(([fileName, data]) => ({
        fileName,
        data
      })),
      {
        name: 'Fixture',
        artist: 'Tester',
        charter: 'Tester',
        diff_guitar: '3',
        pro_drums: 'True',
        hopo_frequency: '3',
        ...metadata
      }
    )
  )
  return fixtureFor(chartPath, root)
}

function fixtureFor(chartPath: string, root: string): Fixture {
  // The store lives outside the library folder, as it does in production: `userData`, never the
  // chart's own directory, where the scanner and the watcher would both find it.
  const storeDir = join(scratch(), 'fix-backups')
  return {
    chartPath,
    storeDir,
    ctx: {
      libraryFolders: [{ path: root }],
      backupDir: storeDir,
      video: converter,
      image: squareArt
    }
  }
}

function badVideoRow(chartPath: string, fileName = 'video.mp4'): ChartIssueRow {
  return {
    chartPath,
    kind: 'folder',
    code: 'badVideo',
    description: `"${fileName}" will not work on Linux and should be converted to .webm.`
  }
}

function albumArtRow(chartPath: string): ChartIssueRow {
  return {
    chartPath,
    kind: 'folder',
    code: 'albumArtSize',
    description: "This chart's album art is 300x300, and should be 512x512."
  }
}

function extraValueRow(chartPath: string): ChartIssueRow {
  return {
    chartPath,
    kind: 'metadata',
    code: 'extraValue',
    description: 'Metadata contains "diff_bass", but bass is not charted.'
  }
}

function invalidIniRow(chartPath: string): ChartIssueRow {
  return {
    chartPath,
    kind: 'folder',
    code: 'invalidIni',
    description: '"desktop.ini" is not named "song.ini".'
  }
}

async function entriesOf(sngPath: string): Promise<Map<string, Uint8Array>> {
  const entries = await extractSngEntries(new Uint8Array(readFileSync(sngPath)))
  return new Map(entries.map((entry) => [entry.fileName, entry.data]))
}

/** The single backup a repair just took. Fails loudly rather than restoring an unrelated one. */
function onlyBackupId(storeDir: string): string {
  const backups = listBackups(storeDir)
  expect(backups).toHaveLength(1)
  return backups[0].id
}

async function undo(fixture: Fixture): Promise<ChartIssueRow[]> {
  const { rows } = await restoreBackup(
    { storeDir: fixture.storeDir, libraryFolders: fixture.ctx.libraryFolders },
    onlyBackupId(fixture.storeDir)
  )
  return rows
}

describe('undoing a badVideo conversion', () => {
  it("puts a folder chart's original video back, byte for byte", async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    const before = await scanChartIssues(fixture.chartPath, 'folder')

    await applyFix(badVideoRow(fixture.chartPath), fixture.ctx)
    expect(existsSync(join(fixture.chartPath, 'video.mp4'))).toBe(false)

    const rows = await undo(fixture)

    // The claim, on bytes. A zero-length file would satisfy every other assertion here.
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'video.mp4')))).toEqual(VIDEO)
    // The conversion's output goes: leaving it would make the chart carry two backgrounds and
    // raise `multipleVideo`, which is a different problem the user did not ask for.
    expect(existsSync(join(fixture.chartPath, 'video.webm'))).toBe(false)
    expect(rows.map((r) => r.code)).toContain('badVideo')
    const after = await scanChartIssues(fixture.chartPath, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
  })

  it("puts a .sng chart's original video back, byte for byte, through a repack", async () => {
    const fixture = sngChart({ 'song.ini': SONG_INI, 'video.mp4': VIDEO })
    const before = await scanChartIssues(fixture.chartPath, 'sng')

    await applyFix(badVideoRow(fixture.chartPath), fixture.ctx)
    expect([...(await entriesOf(fixture.chartPath)).keys()]).toContain('video.webm')

    await undo(fixture)

    const entries = await entriesOf(fixture.chartPath)
    expect(entries.get('video.mp4')).toEqual(VIDEO)
    expect(entries.has('video.webm')).toBe(false)
    // Every other entry survived the two repacks unchanged. The undo rebuilt the archive, so
    // this is the check that it rebuilt all of it and not just the entry it came for.
    expect(entries.get('notes.chart')).toEqual(NOTES)
    expect(entries.get('song.ini')).toEqual(SONG_INI)
    const after = await scanChartIssues(fixture.chartPath, 'sng')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
  })

  it('restores the container the chart actually had, not video.mp4 by default', async () => {
    // A chart whose bad video is `video.avi` must get `video.avi` back. An undo hard-coded to the
    // commonest name would hand the user a file that is not what it says it is.
    const fixture = folderChart({ 'video.avi': VIDEO })

    await applyFix(badVideoRow(fixture.chartPath, 'video.avi'), fixture.ctx)
    await undo(fixture)

    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'video.avi')))).toEqual(VIDEO)
    expect(existsSync(join(fixture.chartPath, 'video.webm'))).toBe(false)
  })
})

describe('undoing an albumArtSize re-encode', () => {
  it("puts a folder chart's original cover back, byte for byte", async () => {
    const fixture = folderChart({ 'album.png': SMALL_ART })

    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'album.png')))).not.toEqual(
      SMALL_ART
    )

    await undo(fixture)

    // A re-encode is lossy, so this is the one repair whose original genuinely cannot be
    // reconstructed from its output at any quality. Keeping the bytes is the only undo there is.
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'album.png')))).toEqual(SMALL_ART)
  })

  it("puts a .sng chart's original cover back, byte for byte", async () => {
    const fixture = sngChart({ 'song.ini': SONG_INI, 'album.png': SMALL_ART })

    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)
    await undo(fixture)

    const entries = await entriesOf(fixture.chartPath)
    expect(entries.get('album.png')).toEqual(SMALL_ART)
    // Replaced in place, so nothing was added: a chart that came out of this with both a restored
    // cover and the resized one would raise `multipleAlbumArt`.
    expect([...entries.keys()].filter((name) => name.startsWith('album'))).toEqual(['album.png'])
  })
})

describe('undoing an extraValue removal', () => {
  it("puts a folder chart's song.ini back byte for byte, comments and spacing included", async () => {
    const fixture = folderChart()

    await applyFix(extraValueRow(fixture.chartPath), fixture.ctx)
    expect(readFileSync(join(fixture.chartPath, 'song.ini')).toString()).not.toContain('diff_bass')

    await undo(fixture)

    // Not "diff_bass is back": the whole file, unchanged. An undo that reinstated one line would
    // also have to reproduce this file's comment, its blank line, its `artist=Tester` with no
    // spaces and its unknown key, and would be judged on doing so by exactly this assertion.
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'song.ini')))).toEqual(SONG_INI)
  })

  it("puts a .sng chart's header rating back", async () => {
    // No packed song.ini: the ratings live in the archive header and the ini scan-chart reads is
    // synthesised from it, so the repair and the undo are both header edits.
    const fixture = sngChart({}, { diff_bass: '4' })

    await applyFix(extraValueRow(fixture.chartPath), fixture.ctx)
    expect((await readRepackPlan(fixture.chartPath)).metadata).not.toHaveProperty('diff_bass')

    await undo(fixture)

    expect((await readRepackPlan(fixture.chartPath)).metadata.diff_bass).toBe('4')
  })
})

describe('undoing a stray .ini removal', () => {
  it("puts a folder chart's deleted .ini back, byte for byte", async () => {
    const fixture = folderChart({ 'desktop.ini': DESKTOP_INI })

    await applyFix(invalidIniRow(fixture.chartPath), fixture.ctx)
    expect(existsSync(join(fixture.chartPath, 'desktop.ini'))).toBe(false)

    await undo(fixture)

    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'desktop.ini')))).toEqual(
      DESKTOP_INI
    )
    // The file the chart's metadata really comes from was never at risk, and still is not.
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'song.ini')))).toEqual(SONG_INI)
  })

  it("puts a .sng chart's deleted entry back, byte for byte", async () => {
    const fixture = sngChart({ 'desktop.ini': DESKTOP_INI })

    await applyFix(invalidIniRow(fixture.chartPath), fixture.ctx)
    await undo(fixture)

    expect((await entriesOf(fixture.chartPath)).get('desktop.ini')).toEqual(DESKTOP_INI)
  })

  it('restores every file a multipleIniFiles fix deleted', async () => {
    const fixture = folderChart({ 'desktop.ini': DESKTOP_INI, 'thumbs.ini': bytes('[x]\n') })

    await applyFix(
      {
        chartPath: fixture.chartPath,
        kind: 'folder',
        code: 'multipleIniFiles',
        description: 'This chart has multiple .ini files.'
      },
      fixture.ctx
    )
    expect(readdirSync(fixture.chartPath).filter((n) => n.endsWith('.ini'))).toEqual(['song.ini'])

    await undo(fixture)

    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'desktop.ini')))).toEqual(
      DESKTOP_INI
    )
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'thumbs.ini')))).toEqual(
      bytes('[x]\n')
    )
  })
})

describe('refusing to restore over a chart that changed', () => {
  it('refuses when the file the repair produced has been rewritten', async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    await applyFix(badVideoRow(fixture.chartPath), fixture.ctx)

    // The case this exists for: the user converted the video, disliked it, downloaded a better
    // one, and only then reached for Undo. Writing the original over that is a second loss.
    const better = bytes('a much better video')
    writeFileSync(join(fixture.chartPath, 'video.webm'), better)

    await expect(undo(fixture)).rejects.toThrow(/has been rewritten since this fix/)
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'video.webm')))).toEqual(better)
    expect(existsSync(join(fixture.chartPath, 'video.mp4'))).toBe(false)
    // Refused, not consumed: the undo is still there to be tried again once the user has moved
    // their new video out of the way.
    expect(listBackups(fixture.storeDir)).toHaveLength(1)
  })

  it('notices a rewrite that kept the same size', async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    await applyFix(badVideoRow(fixture.chartPath), fixture.ctx)

    const webm = join(fixture.chartPath, 'video.webm')
    const { size } = statSync(webm)
    writeFileSync(webm, Buffer.alloc(size, 0x41))

    await expect(undo(fixture)).rejects.toThrow(/has been rewritten since this fix/)
  })

  it('refuses when something has put back the file the repair removed', async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    await applyFix(badVideoRow(fixture.chartPath), fixture.ctx)

    const theirs = bytes('someone put their own video.mp4 here')
    writeFileSync(join(fixture.chartPath, 'video.mp4'), theirs)

    await expect(undo(fixture)).rejects.toThrow(/has gained a video\.mp4 since this fix/)
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'video.mp4')))).toEqual(theirs)
  })

  it('refuses when the entry it would put back has been rewritten inside the .sng', async () => {
    const fixture = sngChart({ 'song.ini': SONG_INI, 'album.png': SMALL_ART })
    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)

    // Somebody replaced the cover with one of their own: the `.sng` form of the case the whole
    // guard exists for. The archive's stamp has moved, so the narrow check runs and refuses.
    const theirs = makePng(500, 500)
    await writeSngAsset(fixture.chartPath, 'album.png', theirs, fixture.ctx.libraryFolders)

    await expect(undo(fixture)).rejects.toThrow(/has been rewritten since this fix/)
    expect((await entriesOf(fixture.chartPath)).get('album.png')).toEqual(theirs)
  })

  it('refuses when the header value it would put back has been changed', async () => {
    const fixture = sngChart({}, { diff_bass: '4' })
    await applyFix(extraValueRow(fixture.chartPath), fixture.ctx)

    // The repair removed `diff_bass`; something has since set it to a different value. Putting
    // the old one back would discard that.
    await rewriteSngPlan(
      fixture.chartPath,
      (plan) => ({ ...plan, metadata: { ...plan.metadata, diff_bass: '2' } }),
      fixture.ctx.libraryFolders
    )

    await expect(undo(fixture)).rejects.toThrow(/"diff_bass" value .* has been changed/)
    expect((await readRepackPlan(fixture.chartPath)).metadata.diff_bass).toBe('2')
  })

  it('still undoes the first of two repairs on one .sng', async () => {
    // The ordinary case a whole-archive stamp gets wrong. A chart carrying two repairable codes is
    // common (BABYMETAL - Rondo Of Nightmare in the reference library carries both of these), and
    // the second repair repacks the archive, moving its size and mtime. If that were the only
    // guard, running the second repair would make the first permanently un-undoable.
    const fixture = sngChart({ 'album.png': SMALL_ART }, { diff_bass: '4' })
    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)
    await applyFix(extraValueRow(fixture.chartPath), fixture.ctx)
    const art = listBackups(fixture.storeDir).find((b) => b.actionCode === 'albumArtSize')!

    await restoreBackup(
      { storeDir: fixture.storeDir, libraryFolders: fixture.ctx.libraryFolders },
      art.id
    )

    expect((await entriesOf(fixture.chartPath)).get('album.png')).toEqual(SMALL_ART)
    // And the repair that was NOT undone is still applied: an undo puts one thing back, not the
    // chart's whole history.
    expect((await readRepackPlan(fixture.chartPath)).metadata).not.toHaveProperty('diff_bass')
    expect(listBackups(fixture.storeDir).map((b) => b.actionCode)).toEqual(['extraValue'])
  })

  it('leaves an untouched .sng alone on the strong check, without reading its header', async () => {
    // The common path: nothing has written to the archive, so its own stamp settles it. The
    // narrow entry check exists for when that has moved and must not be what normally decides.
    const fixture = sngChart({ 'song.ini': SONG_INI, 'album.png': SMALL_ART })
    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)

    await undo(fixture)

    expect((await entriesOf(fixture.chartPath)).get('album.png')).toEqual(SMALL_ART)
  })

  it('refuses when the chart is no longer the shape it was repaired as', async () => {
    const fixture = folderChart({ 'desktop.ini': DESKTOP_INI })
    await applyFix(invalidIniRow(fixture.chartPath), fixture.ctx)

    rmSync(fixture.chartPath, { recursive: true, force: true })
    writeFileSync(fixture.chartPath, makeSng([{ fileName: 'notes.chart', data: NOTES }]))

    await expect(undo(fixture)).rejects.toThrow(/This is not the same chart/)
  })

  it('refuses when restoring would change which .ini Clone Hero reads', async () => {
    // The one restore that could genuinely break multiplayer. `desktop.ini` carries a different
    // `hopo_frequency`, and with `song.ini` gone it becomes the file `findIniData` returns, so
    // putting it back would hand the chart a different identity. The post-write hash assertion
    // would catch that too, with the file already on disk; this is what stops it getting there.
    const fixture = folderChart({ 'desktop.ini': DESKTOP_INI })
    await applyFix(invalidIniRow(fixture.chartPath), fixture.ctx)
    rmSync(join(fixture.chartPath, 'song.ini'))

    await expect(undo(fixture)).rejects.toThrow(/would change what this chart matches by/)
    expect(existsSync(join(fixture.chartPath, 'desktop.ini'))).toBe(false)
  })

  it("refuses when Encore's own copy no longer hashes to what it recorded", async () => {
    const fixture = folderChart({ 'album.png': SMALL_ART })
    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)

    // Same length, different bytes: a size check alone would pass this, which is why the blob is
    // hashed rather than measured.
    const id = onlyBackupId(fixture.storeDir)
    const blob = join(fixture.storeDir, id, '0.bin')
    writeFileSync(blob, Buffer.alloc(statSync(blob).size, 0x7a))

    await expect(undo(fixture)).rejects.toThrow(/is not the file it backed up/)
    // The chart still holds the repaired cover: nothing was half-written.
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'album.png')))).toEqual(
      makePng(512, 512)
    )
  })

  it('installs none of a multi-file undo when one of its copies is bad', async () => {
    // A folder chart has no build-then-rename, so the closest it can get to all-or-nothing is to
    // do everything fallible (the copies and their hashes) before installing any of them. Left
    // interleaved, this test would find `desktop.ini` back and `thumbs.ini` missing: a chart
    // halfway between two states, which its own guard then no longer describes.
    const fixture = folderChart({ 'desktop.ini': DESKTOP_INI, 'thumbs.ini': bytes('[x]\n') })
    await applyFix(
      {
        chartPath: fixture.chartPath,
        kind: 'folder',
        code: 'multipleIniFiles',
        description: 'This chart has multiple .ini files.'
      },
      fixture.ctx
    )

    const id = onlyBackupId(fixture.storeDir)
    const [, second] = listBackups(fixture.storeDir)[0].files
    const blob = join(fixture.storeDir, id, second.blob)
    writeFileSync(blob, Buffer.alloc(statSync(blob).size, 0x7a))

    await expect(undo(fixture)).rejects.toThrow(/is not the file it backed up/)

    expect(readdirSync(fixture.chartPath).filter((n) => n.endsWith('.ini'))).toEqual(['song.ini'])
  })

  it('refuses an id it did not issue', async () => {
    const fixture = folderChart()
    const ctx = { storeDir: fixture.storeDir, libraryFolders: fixture.ctx.libraryFolders }

    await expect(restoreBackup(ctx, '../../etc')).rejects.toThrow(/no undo with the id/)
    await expect(restoreBackup(ctx, 'kabcd-0011223344556677')).rejects.toThrow(
      /no undo with the id/
    )
  })
})

describe("the backup's lifecycle around a fix", () => {
  it('leaves nothing behind when the repair itself fails', async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    const failing: FixAction = {
      code: 'badVideo',
      appliesTo: (row) => row.code === 'badVideo',
      describe: () => 'stub',
      backup: async (row) => ({
        code: row.code,
        actionCode: 'badVideo',
        describe: 'stub',
        files: [
          {
            fileName: 'video.mp4',
            content: { kind: 'copyFile', path: join(row.chartPath, 'video.mp4') }
          }
        ]
      }),
      apply: async () => {
        throw new Error('conversion blew up')
      }
    }

    await expect(applyFix(badVideoRow(fixture.chartPath), fixture.ctx, [failing])).rejects.toThrow(
      /conversion blew up/
    )

    // Nothing was replaced, so there is nothing to undo, and a backup nobody can act on is still
    // 1.5 MB of the user's disk here and 159 MB of it in the real library.
    expect(listBackups(fixture.storeDir)).toEqual([])
    expect(existsSync(fixture.storeDir) ? readdirSync(fixture.storeDir) : []).toEqual([])
  })

  it('says the repair happened when it could not be recorded', async () => {
    // A backup whose manifest cannot be written leaves a repair that has really been applied and
    // really cannot be undone. Reporting only the filesystem error would send the user to re-run a
    // fix that has already run; reporting success would offer an undo that is not there.
    const fixture = folderChart({ 'album.png': SMALL_ART })
    const sealing: FixAction = {
      code: 'albumArtSize',
      appliesTo: (row) => row.code === 'albumArtSize',
      describe: () => 'stub',
      backup: async (row) => ({
        code: row.code,
        actionCode: 'albumArtSize',
        describe: 'stub',
        files: [
          {
            fileName: 'album.png',
            content: { kind: 'copyFile', path: join(row.chartPath, 'album.png') }
          }
        ]
      }),
      apply: async (row) => {
        writeFileSync(join(row.chartPath, 'album.png'), makePng(512, 512))
        // The blobs are already written; only the manifest is still to come. 0o500 is read and
        // traverse but not write, which is what a full disk or a read-only userData looks like
        // from inside `commit`.
        chmodSync(join(fixture.storeDir, readdirSync(fixture.storeDir)[0]), 0o500)
      }
    }

    await expect(applyFix(albumArtRow(fixture.chartPath), fixture.ctx, [sealing])).rejects.toThrow(
      /was fixed, but Encore could not save what the fix replaced/
    )

    chmodSync(join(fixture.storeDir, readdirSync(fixture.storeDir)[0]), 0o700)
    // No manifest, so nothing claims to be undoable. `clearBackups` is what reclaims the blobs.
    expect(listBackups(fixture.storeDir)).toEqual([])
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'album.png')))).toEqual(
      makePng(512, 512)
    )
  })

  it('KEEPS the backup when the repair moved the chart hash', async () => {
    // The case the undo matters most for, and the reason `commit` runs before the hash check.
    // `applyFix` reports the damage and refuses; without this the user would be told their chart
    // is broken and handed no way back.
    const fixture = folderChart({ 'video.mp4': VIDEO })
    const damaging: FixAction = {
      code: 'badVideo',
      appliesTo: (row) => row.code === 'badVideo',
      describe: () => 'stub',
      backup: async (row) => ({
        code: row.code,
        actionCode: 'extraValue',
        describe: 'stub',
        files: [
          {
            fileName: 'song.ini',
            content: { kind: 'copyFile', path: join(row.chartPath, 'song.ini') }
          }
        ]
      }),
      apply: async (row) => {
        // pro_drums is one of the seven keys getChartHash mixes in.
        writeFileSync(
          join(row.chartPath, 'song.ini'),
          Buffer.from(SONG_INI).toString().replace('pro_drums = True', 'pro_drums = False')
        )
      }
    }

    await expect(applyFix(badVideoRow(fixture.chartPath), fixture.ctx, [damaging])).rejects.toThrow(
      /changed the chart hash/
    )

    expect(listBackups(fixture.storeDir)).toHaveLength(1)
  })

  it('lets that damage be undone, hash and all', async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    const before = await scanChartIssues(fixture.chartPath, 'folder')
    const damaging: FixAction = {
      code: 'badVideo',
      appliesTo: (row) => row.code === 'badVideo',
      describe: () => 'stub',
      backup: async (row) => ({
        code: row.code,
        actionCode: 'extraValue',
        describe: 'stub',
        files: [
          {
            fileName: 'song.ini',
            content: { kind: 'copyFile', path: join(row.chartPath, 'song.ini') }
          }
        ]
      }),
      apply: async (row) => {
        writeFileSync(
          join(row.chartPath, 'song.ini'),
          Buffer.from(SONG_INI).toString().replace('pro_drums = True', 'pro_drums = False')
        )
      }
    }
    await expect(applyFix(badVideoRow(fixture.chartPath), fixture.ctx, [damaging])).rejects.toThrow(
      /changed the chart hash/
    )

    await undo(fixture)

    // The restore MOVED the hash, and was right to: it moved it back to what it was before the
    // repair. A restore held to "the hash must not change" would have refused this. See
    // `assertRestoreHash`.
    const after = await scanChartIssues(fixture.chartPath, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    // Unmoved throughout, since the damage was to song.ini and not to the chart file.
    expect(after.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'song.ini')))).toEqual(SONG_INI)
  })

  /**
   * The other damage, and the one Clone Hero's own checksum is the only witness to: a repair
   * that rewrote the chart file itself.
   *
   * This is the case the manifest's `cloneHeroChecksum` exists for. The repair is caught and
   * refused, the backup survives it, and the undo then has to move a number `applyFix` would
   * never have let it move — which `assertRestoreChecksum` permits only because the manifest
   * says this is the value the chart had before.
   */
  it('lets a repair that rewrote the chart file be undone, checksum and all', async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    const before = await scanChartIssues(fixture.chartPath, 'folder')
    const damaging: FixAction = {
      code: 'badVideo',
      appliesTo: (row) => row.code === 'badVideo',
      describe: () => 'stub',
      backup: async (row) => ({
        code: row.code,
        actionCode: 'badVideo',
        describe: 'stub',
        files: [
          {
            fileName: 'notes.chart',
            content: { kind: 'copyFile', path: join(row.chartPath, 'notes.chart') }
          }
        ]
      }),
      apply: async (row) => {
        appendFileSync(join(row.chartPath, 'notes.chart'), '\n')
      }
    }

    await expect(applyFix(badVideoRow(fixture.chartPath), fixture.ctx, [damaging])).rejects.toThrow(
      /changed the checksum Clone Hero records/
    )
    const damaged = await scanChartIssues(fixture.chartPath, 'folder')
    expect(damaged.cloneHeroChecksum).not.toBe(before.cloneHeroChecksum)

    await undo(fixture)

    const after = await scanChartIssues(fixture.chartPath, 'folder')
    expect(after.cloneHeroChecksum).toBe(before.cloneHeroChecksum)
    expect(after.chartHash).toBe(before.chartHash)
    expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'notes.chart')))).toEqual(NOTES)
  })

  /**
   * MUTATION: the restore's checksum assertion, provoked into firing on its own.
   *
   * Nothing a restore can do in the ordinary course moves Clone Hero's checksum without moving
   * `chartHash` with it, so a test that only watched the outcome would pass with
   * `assertRestoreChecksum` deleted. This makes the two disagree: the manifest keeps the correct
   * `chartHash`, so the hash assertion is satisfied by the restore landing on it, and carries a
   * checksum the chart has never had, which only the checksum assertion can see.
   *
   * The manifest is edited by hand here because there is no supported way to produce one; that
   * is the point. Delete the call from `restoreBackup` and this test goes green.
   */
  it('MUTATION: refuses an undo whose manifest records a checksum the chart never had', async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    const damaging: FixAction = {
      code: 'badVideo',
      appliesTo: (row) => row.code === 'badVideo',
      describe: () => 'stub',
      backup: async (row) => ({
        code: row.code,
        actionCode: 'badVideo',
        describe: 'stub',
        files: [
          {
            fileName: 'notes.chart',
            content: { kind: 'copyFile', path: join(row.chartPath, 'notes.chart') }
          }
        ]
      }),
      apply: async (row) => {
        appendFileSync(join(row.chartPath, 'notes.chart'), '\n')
      }
    }
    await expect(applyFix(badVideoRow(fixture.chartPath), fixture.ctx, [damaging])).rejects.toThrow(
      /changed the checksum Clone Hero records/
    )

    const id = onlyBackupId(fixture.storeDir)
    const manifest = join(fixture.storeDir, id, 'backup.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { cloneHeroChecksum: string }
    expect(parsed.cloneHeroChecksum).toMatch(/^[0-9a-f]{32}$/)
    writeFileSync(
      manifest,
      JSON.stringify({ ...parsed, cloneHeroChecksum: 'f'.repeat(32) }, null, 2)
    )

    await expect(undo(fixture)).rejects.toThrow(/checksum Clone Hero records/)
  })

  it('spends the backup: a chart cannot be un-undone', async () => {
    const fixture = folderChart({ 'album.png': SMALL_ART })
    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)
    const id = onlyBackupId(fixture.storeDir)
    const ctx = { storeDir: fixture.storeDir, libraryFolders: fixture.ctx.libraryFolders }

    await restoreBackup(ctx, id)

    expect(listBackups(fixture.storeDir)).toEqual([])
    await expect(restoreBackup(ctx, id)).rejects.toThrow(/no undo with the id/)
  })

  it('reports the undo as done even if the spent backup cannot be deleted', async () => {
    const fixture = folderChart({ 'album.png': SMALL_ART })
    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)
    // Readable and traversable but not writable, so the restore can read the manifest and the blob
    // and then fail to remove the directory: a read-only userData, or a store the user has
    // locked down.
    chmodSync(fixture.storeDir, 0o500)
    const id = onlyBackupId(fixture.storeDir)

    try {
      // Resolves. Reporting a failure over an undo that has already happened would send the user
      // to try it again on a chart that is already back.
      await restoreBackup(
        { storeDir: fixture.storeDir, libraryFolders: fixture.ctx.libraryFolders },
        id
      )

      expect(new Uint8Array(readFileSync(join(fixture.chartPath, 'album.png')))).toEqual(SMALL_ART)
      // Whatever survives the failed delete cannot be acted on twice: either the manifest went and
      // the entry is no longer listed, or it stayed and its guard describes a repaired chart that
      // no longer exists. Both refuse; neither writes.
      await expect(
        restoreBackup(
          { storeDir: fixture.storeDir, libraryFolders: fixture.ctx.libraryFolders },
          id
        )
      ).rejects.toThrow(/no undo with the id|has been rewritten since this fix/)
    } finally {
      chmodSync(fixture.storeDir, 0o700)
    }
  })

  it('records what the repair was, so the undo list can say what it would take back', async () => {
    const fixture = folderChart({ 'album.png': SMALL_ART })
    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)

    const [backup] = listBackups(fixture.storeDir)
    expect(backup.chartPath).toBe(fixture.chartPath)
    expect(backup.code).toBe('albumArtSize')
    expect(backup.actionCode).toBe('albumArtSize')
    expect(backup.describe).toMatch(/Re-encode this chart's album art to 512x512/)
    expect(backup.sizeBytes).toBe(SMALL_ART.length)
    expect(backup.chartHash).not.toBeNull()
    // Both identities are recorded, so an undo of a repair that moved either has something to
    // land back on. See `assertRestoreChecksum` for why this one may also be absent entirely.
    expect(backup.cloneHeroChecksum).not.toBeNull()
  })

  it("holds the chart's write lock across the whole restore", async () => {
    const fixture = folderChart({ 'album.png': SMALL_ART })
    await applyFix(albumArtRow(fixture.chartPath), fixture.ctx)
    let lockedDuringRestore = 0

    await restoreBackup(
      {
        storeDir: fixture.storeDir,
        libraryFolders: fixture.ctx.libraryFolders,
        // The lock is what stops a batch asset write landing between the guard and the write, or
        // between the write and the hash comparison.
        onProgress: () => (lockedDuringRestore = pendingChartLockCount())
      },
      onlyBackupId(fixture.storeDir)
    )

    expect(lockedDuringRestore).toBe(1)
    expect(pendingChartLockCount()).toBe(0)
  })

  it('leaves no staging directory behind in the chart', async () => {
    const fixture = folderChart({ 'video.mp4': VIDEO })
    await applyFix(badVideoRow(fixture.chartPath), fixture.ctx)

    await undo(fixture)

    // `.encore-tmp` holding a copy of a restored video would silently double the chart's size on
    // disk, and the scanner deliberately cannot see it to complain.
    expect(readdirSync(fixture.chartPath).sort()).toEqual(['notes.chart', 'song.ini', 'video.mp4'])
  })
})

describe('assertRestoreHash', () => {
  it('accepts a restore that left the hash alone', () => {
    expect(() => assertRestoreHash('/lib/c', 'aaa', 'aaa', 'aaa')).not.toThrow()
  })

  it('accepts a restore that put a moved hash back', () => {
    // before = the damaged chart's hash, after = the hash it had before the repair.
    expect(() => assertRestoreHash('/lib/c', 'bbb', 'aaa', 'aaa')).not.toThrow()
  })

  it('refuses a hash the chart has never had, naming all three', () => {
    expect(() => assertRestoreHash('/lib/c', 'bbb', 'ccc', 'aaa')).toThrow(
      /\/lib\/c.*bbb.*aaa.*ccc/s
    )
  })

  it('treats a chart that never had a hash as unchanged', () => {
    expect(() => assertRestoreHash('/lib/c', null, null, null)).not.toThrow()
    expect(() => assertRestoreHash('/lib/c', 'aaa', null, 'aaa')).toThrow(/none/)
  })
})

describe('assertRestoreChecksum', () => {
  it('accepts a restore that left the checksum alone', () => {
    expect(() => assertRestoreChecksum('/lib/c', 'aaa', 'aaa', 'aaa')).not.toThrow()
  })

  it('accepts a restore that put a moved checksum back', () => {
    expect(() => assertRestoreChecksum('/lib/c', 'bbb', 'aaa', 'aaa')).not.toThrow()
  })

  it('refuses a checksum the chart has never had, naming all three', () => {
    expect(() => assertRestoreChecksum('/lib/c', 'bbb', 'ccc', 'aaa')).toThrow(
      /\/lib\/c.*bbb.*aaa.*ccc/s
    )
  })

  it('treats a chart that never had a chart file as unchanged', () => {
    expect(() => assertRestoreChecksum('/lib/c', null, null, null)).not.toThrow()
    expect(() => assertRestoreChecksum('/lib/c', 'aaa', null, 'aaa')).toThrow(/none/)
  })

  /**
   * A manifest from before Encore recorded this. `undefined` is not `null`: the second target
   * does not exist rather than being "no chart file", so the rule tightens to "it did not move".
   */
  it('gives a manifest with no recorded checksum the stricter rule', () => {
    expect(() => assertRestoreChecksum('/lib/c', 'aaa', 'aaa', undefined)).not.toThrow()
    expect(() => assertRestoreChecksum('/lib/c', 'bbb', 'aaa', undefined)).toThrow(/not recorded/)
    // And `undefined` must not be read as a null the restore could land on.
    expect(() => assertRestoreChecksum('/lib/c', 'bbb', null, undefined)).toThrow(/not recorded/)
  })
})
