import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSng } from '../../../../test/helpers/make-sng'
import { writeChartAsset } from '../../assets/write'
import { scanChartIssues, type ChartIssueRow } from '../../catalog/issues'
import { readRepackPlan } from '../../downloads/sng-repack'
import { applyFix, type FixAction, type FixContext } from '../fix'
import { extraValueAction, extraValueKey } from './extra-value'
import { tmpDir } from '../../../../test/helpers/tmp'

const encoder = new TextEncoder()
const bytes = (s: string): Uint8Array => encoder.encode(s)
const text = (data: Uint8Array): string => Buffer.from(data).toString('utf8')

/** Guitar and nothing else, so every other `diff_*` in song.ini is an `extraValue`. */
const NOTES = bytes(
  '[Song]\n{\n  Name = "Fixture"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
)

/**
 * A `song.ini` shaped like the ones this fix meets: a comment, blank lines, an unknown key, odd
 * spacing, and (critically) `pro_drums` and `hopo_frequency` set away from their defaults so
 * they really do feed `getChartHash`. Without those two the hash assertions below would be
 * comparing two hashes of the chart file alone and would pass however badly song.ini was mangled.
 */
const SONG_INI_TEXT = [
  '; ripped from somewhere',
  '',
  '[song]',
  'name = Fixture',
  'artist=Tester',
  'charter = Tester',
  'diff_guitar = 3',
  'diff_bass=4',
  '   diff_keys   =   2   ',
  'unknown_key = keep me',
  'pro_drums = True',
  'hopo_frequency = 3'
].join('\n')
const SONG_INI = bytes(`${SONG_INI_TEXT}\n`)

const scratchDirs: string[] = []

function scratch(): string {
  const dir = tmpDir('extravalue')
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
})

function folderChart(files: Record<string, Uint8Array> = {}): string {
  const dir = join(scratch(), 'Tester - Fixture')
  mkdirSync(dir, { recursive: true })
  const all = { 'notes.chart': NOTES, 'song.ini': SONG_INI, ...files }
  for (const [name, data] of Object.entries(all)) writeFileSync(join(dir, name), data)
  return dir
}

/**
 * A `.sng` with NO packed song.ini, which is how Chorus ships them: the ratings live in the
 * archive header and parse-sng synthesises the ini scan-chart reads. That is what makes the fix a
 * header edit rather than a file edit.
 */
function sngChart(metadata: Record<string, string> = {}): string {
  const path = join(scratch(), 'fixture.sng')
  writeFileSync(
    path,
    makeSng([{ fileName: 'notes.chart', data: NOTES }], {
      name: 'Fixture',
      artist: 'Tester',
      charter: 'Tester',
      diff_guitar: '3',
      diff_bass: '4',
      pro_drums: 'True',
      hopo_frequency: '3',
      ...metadata
    })
  )
  return path
}

/** scan-chart's own wording, verbatim from index.js:2739. */
function row(chartPath: string, key = 'diff_bass', instrument = 'bass'): ChartIssueRow {
  return {
    chartPath,
    kind: 'metadata',
    code: 'extraValue',
    description: `Metadata contains "${key}", but ${instrument} is not charted.`
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

describe('extraValueKey', () => {
  it('reads the key out of both wordings scan-chart uses', () => {
    expect(extraValueKey(row('/lib/c', 'diff_bass', 'bass'))).toBe('diff_bass')
    // The plural form is a separate literal in scan-chart's source (index.js:2756).
    expect(
      extraValueKey({
        chartPath: '/lib/c',
        kind: 'metadata',
        code: 'extraValue',
        description: 'Metadata contains "diff_vocals", but vocals are not charted.'
      })
    ).toBe('diff_vocals')
  })

  it.each([
    ['a description that only resembles the template', 'Metadata contains "diff_bass".'],
    ['a leading sentence', 'Note: Metadata contains "diff_bass", but bass is not charted.'],
    ['a trailing sentence', 'Metadata contains "diff_bass", but bass is not charted. Also this.'],
    [
      'a key scan-chart never raises this for',
      'Metadata contains "album", but bass is not charted.'
    ],
    [
      'a hashed key smuggled into the template',
      'Metadata contains "pro_drums", but bass is not charted.'
    ]
  ])('refuses to parse %s', (_label, description) => {
    // This action DELETES what it parses. A loose match (the first quoted word, say) would
    // happily pull a key out of any future wording and remove a line nobody asked about.
    const parsed = extraValueKey({
      chartPath: '/lib/c',
      kind: 'metadata',
      code: 'extraValue',
      description
    })
    expect(parsed).toBe(null)
  })

  it('offers no fix at all for a row it cannot parse', () => {
    expect(
      extraValueAction.appliesTo({
        chartPath: '/lib/c',
        kind: 'metadata',
        code: 'extraValue',
        description: 'Metadata contains "album", but bass is not charted.'
      })
    ).toBe(false)
  })

  it('only claims rows from the metadata issue array', () => {
    expect(extraValueAction.appliesTo(row('/lib/c'))).toBe(true)
    expect(extraValueAction.appliesTo({ ...row('/lib/c'), kind: 'folder' })).toBe(false)
  })
})

describe('extraValue on a folder chart', () => {
  it('clears the row and leaves the rest of song.ini byte-identical', async () => {
    const chart = folderChart()

    const after = await applyFix(row(chart), ctxFor(chart))

    expect(after.some((r) => r.code === 'extraValue' && r.description.includes('diff_bass'))).toBe(
      false
    )
    // The whole file, not a substring: the comment, the blank line, the unknown key, the odd
    // spacing around diff_keys, the CRLF-free line endings and the key ORDER all survive. A
    // parse-and-reserialise would have changed several of them, and one of those keys is hashed.
    expect(text(new Uint8Array(readFileSync(join(chart, 'song.ini'))))).toBe(
      `${SONG_INI_TEXT}\n`.replace('diff_bass=4\n', '')
    )
  })

  it('leaves the other extra rating alone: one row, one key', async () => {
    const chart = folderChart()

    const after = await applyFix(row(chart), ctxFor(chart))

    // diff_keys is also an extraValue on this chart. Fixing one row must not quietly fix the
    // other: the user acts on rows, and a fix that did more than its row said would be a fix
    // they cannot reason about.
    expect(after.filter((r) => r.code === 'extraValue').map((r) => r.description)).toEqual([
      'Metadata contains "diff_keys", but keys is not charted.'
    ])
  })

  it('leaves the multiplayer hash byte-identical', async () => {
    const chart = folderChart()
    const before = await scanChartIssues(chart, 'folder')

    await applyFix(row(chart), ctxFor(chart))

    const after = await scanChartIssues(chart, 'folder')
    expect(after.chartHash).toBe(before.chartHash)
    expect(after.chartHash).not.toBeNull()
  })

  it('MUTATION: an ini edit that touched a hashed key really would move the hash', async () => {
    // Without this, the test above proves only that THIS edit left the hash alone, not that
    // editing song.ini is something the check can see at all. Same write path, same re-scan, one
    // hashed key removed instead of a rating.
    const chart = folderChart()
    const mutating: FixAction = {
      ...extraValueAction,
      apply: async (row, ctx) => {
        const ini = new Uint8Array(readFileSync(join(row.chartPath, 'song.ini')))
        const edited = text(ini).replace('pro_drums = True\n', '')
        writeChartAsset(row.chartPath, 'song.ini', bytes(edited), ctx.libraryFolders)
      }
    }

    await expect(applyFix(row(chart), ctxFor(chart), [mutating])).rejects.toThrow(
      /changed the chart hash/
    )
  })

  it('fails loudly rather than reporting a fix that changed nothing', async () => {
    // scan-chart found the value, but the file this reads no longer has it. The chart changed
    // under a stale report. Returning normally would tell the user the rating is gone.
    const chart = folderChart({ 'song.ini': bytes('[song]\nname = Fixture\npro_drums = True\n') })

    await expect(applyFix(row(chart), ctxFor(chart))).rejects.toThrow(
      /could not find a "diff_bass" line/
    )
  })
})

describe('extraValue on a .sng chart', () => {
  it('edits the header metadata, clears the row and keeps the hash', async () => {
    const chart = sngChart()
    const before = await scanChartIssues(chart, 'sng')
    expect(before.rows.some((r) => r.code === 'extraValue')).toBe(true)

    const after = await applyFix(row(chart), ctxFor(chart))

    expect(after.some((r) => r.code === 'extraValue')).toBe(false)
    const rescan = await scanChartIssues(chart, 'sng')
    // A .sng has no song.ini file: the ratings are header metadata, so this went through a full
    // repack. verifyRepack compares the rebuild against the PLAN, so a deliberately removed key
    // verifies as correct; the hash is what proves nothing else moved with it.
    expect(rescan.chartHash).toBe(before.chartHash)
    expect(rescan.chartHash).not.toBeNull()
  })

  it('keeps every other header value across the repack', async () => {
    const chart = sngChart()

    await applyFix(row(chart), ctxFor(chart))

    const plan = await readRepackPlan(chart)
    expect(plan.metadata.diff_bass).toBeUndefined()
    expect(plan.metadata).toMatchObject({
      name: 'Fixture',
      artist: 'Tester',
      charter: 'Tester',
      diff_guitar: '3',
      pro_drums: 'True',
      hopo_frequency: '3'
    })
  })

  it('refuses an archive that packs its own song.ini rather than guessing which wins', async () => {
    const path = join(scratch(), 'packed.sng')
    writeFileSync(
      path,
      makeSng(
        [
          { fileName: 'notes.chart', data: NOTES },
          { fileName: 'song.ini', data: SONG_INI }
        ],
        { name: 'Fixture', artist: 'Tester', charter: 'Tester', diff_bass: '4' }
      )
    )

    // Two sources of truth for one value: scan-chart reads the packed file, Clone Hero's song
    // list reads the header. Editing either alone leaves the other saying the opposite.
    await expect(applyFix(row(path), ctxFor(path))).rejects.toThrow(/packs its own song.ini/)
  })
})

describe('the hashed-key refusal', () => {
  it('offers no fix, and changes nothing, for a row naming a hashed key', async () => {
    const chart = folderChart()
    const smuggled = {
      ...row(chart),
      description: 'Metadata contains "pro_drums", but bass is not charted.'
    }

    // Two independent guards, and the first one is enough: `pro_drums` is not one of the eleven
    // keys scan-chart raises this code for, so the row never resolves to an action at all.
    expect(extraValueAction.appliesTo(smuggled)).toBe(false)
    await expect(applyFix(smuggled, ctxFor(chart))).rejects.toThrow(/no fix for extraValue/)
    expect(text(new Uint8Array(readFileSync(join(chart, 'song.ini'))))).toContain(
      'pro_drums = True'
    )
  })

  it('still refuses inside apply, where the key list is the only thing left', async () => {
    // Not reachable through a real row. It exists so that a future caller which derives the key
    // from something less constrained than a fixed list cannot reach the filesystem with it.
    // See assertKeyIsNotHashed, and its own tests in issues/ini-edit.test.ts.
    const chart = folderChart()

    await expect(
      extraValueAction.apply(
        { ...row(chart), description: 'Metadata contains "hopofreq", but bass is not charted.' },
        ctxFor(chart)
      )
    ).rejects.toThrow(/does not recognize this issue's wording/)
  })
})
