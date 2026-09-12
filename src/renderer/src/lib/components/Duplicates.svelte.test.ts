import { fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DuplicateCopy,
  DuplicateReport,
  IdenticalGroup,
  VersionGroup,
  AlternateGroup
} from '../../../../shared/duplicates'
import {
  EIGHT_TAG_CHARTER,
  EIGHT_TAG_CHARTER_TEXT,
  TAGGED_CHARTER,
  TAGGED_CHARTER_TEXT
} from '../../../../../test/helpers/marked-up-names'
import Duplicates from './Duplicates.svelte'

/**
 * What these can and cannot show.
 *
 * jsdom applies no stylesheet and computes no layout, so nothing here says the alternate-charts
 * tier LOOKS calmer than the other two; that rests on the `calm` class and its rules, which are
 * pinned as present and not as rendered. What is pinnable, and what matters most in this view, is
 * the wording: which sentence appears over which list, and that the third tier is never called a
 * problem. Those are text assertions and they hold.
 */

const copy = (path: string, fields: Partial<DuplicateCopy> = {}): DuplicateCopy => ({
  path,
  chartType: path.endsWith('.sng') ? 'sng' : 'folder',
  name: 'YYZ',
  artist: 'Rush',
  charter: 'Ann',
  album: null,
  songLength: 300_000,
  modifiedTime: 1,
  cloneHeroChecksum: 'a'.repeat(32),
  ...fields
})

const report = (fields: Partial<DuplicateReport> = {}): DuplicateReport => ({
  identical: [],
  versions: [],
  alternates: [],
  totalCharts: 200,
  unidentifiedCharts: 0,
  ...fields
})

const identical = (): IdenticalGroup => ({
  checksum: 'a'.repeat(32),
  copies: [copy('/library/Rush - YYZ'), copy('/library/Rush - YYZ (1)')]
})

const versions = (): VersionGroup => ({
  artist: 'Rush',
  name: 'YYZ',
  charter: 'Ann',
  copies: [
    copy('/library/Rush - YYZ'),
    copy('/library/Rush - YYZ v2', { cloneHeroChecksum: 'b'.repeat(32) })
  ],
  versionCount: 2,
  unknownCount: 0,
  identicalCopies: 0
})

const alternates = (): AlternateGroup => ({
  artist: 'Rush',
  name: 'YYZ',
  charters: [
    { charter: 'Ann', copies: [copy('/library/Rush - YYZ (Ann)')] },
    { charter: 'Bo', copies: [copy('/library/Rush - YYZ (Bo).sng', { charter: 'Bo' })] }
  ]
})

function stub(
  result: DuplicateReport,
  extra: Record<string, unknown> = {}
): { reveal: ReturnType<typeof vi.fn> } {
  const reveal = vi.fn(() => Promise.resolve())
  vi.stubGlobal('encore', {
    catalogDuplicates: (): Promise<DuplicateReport> => Promise.resolve(result),
    chartReveal: reveal,
    saveTextFile: (): Promise<string | null> => Promise.resolve(null),
    ...extra
  })
  return { reveal }
}

/** Renders and opens the panel, which is collapsed until something is found and shown. */
async function open(result: DuplicateReport): Promise<{ reveal: ReturnType<typeof vi.fn> }> {
  const stubs = stub(result)
  render(Duplicates)
  fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
  return stubs
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Duplicates: a library with none', () => {
  it('says so in one line and offers nothing to open', async () => {
    stub(report())
    render(Duplicates)

    expect(await screen.findByText('Nothing in your library is installed twice.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  })

  it('reports a failed read rather than an empty library', async () => {
    // The two are different answers and must not look alike: "no duplicates" off a query that
    // never ran is the one wrong thing this view could say.
    vi.stubGlobal('encore', {
      catalogDuplicates: (): Promise<DuplicateReport> => Promise.reject(new Error('no ipc'))
    })
    render(Duplicates)

    expect(await screen.findByText(/ERROR: no ipc/)).toBeTruthy()
    expect(screen.queryByText(/Nothing in your library/)).toBeNull()
  })
})

describe('Duplicates: the same chart installed twice', () => {
  it('counts the spare copies in the summary and lists every path', async () => {
    await open(report({ identical: [identical()] }))

    expect(screen.getByText(/2 charts are the same chart file \(1 copy is spare\)/)).toBeTruthy()
    expect(screen.getByText('The same chart, installed twice')).toBeTruthy()
    expect(screen.getByText('/library/Rush - YYZ')).toBeTruthy()
    expect(screen.getByText('/library/Rush - YYZ (1)')).toBeTruthy()
  })

  it('never offers to delete anything, and says outright that it will not', async () => {
    await open(report({ identical: [identical()] }))

    expect(screen.getByText(/Encore never deletes a chart/)).toBeTruthy()
    for (const name of [/delete/i, /remove/i, /clean up/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('opens one copy in the file manager without touching the other', async () => {
    const { reveal } = await open(report({ identical: [identical()] }))

    await fireEvent.click(
      screen.getByRole('button', { name: 'Show in folder: /library/Rush - YYZ (1)' })
    )
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith('/library/Rush - YYZ (1)')
  })

  it('shows a refused reveal against the path that was refused', async () => {
    stub(report({ identical: [identical()] }), {
      chartReveal: vi.fn(() => Promise.reject(new Error('Refusing to open a path outside')))
    })
    render(Duplicates)
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))

    await fireEvent.click(
      screen.getByRole('button', { name: 'Show in folder: /library/Rush - YYZ' })
    )
    expect(await screen.findByText(/Refusing to open a path outside/)).toBeTruthy()
  })
})

describe('Duplicates: more than one version of one chart', () => {
  it('names the charter and how many versions, without calling either one spare', async () => {
    await open(report({ versions: [versions()] }))

    expect(screen.getByText('Different versions of one chart')).toBeTruthy()
    expect(screen.getByText('charted by Ann')).toBeTruthy()
    expect(screen.getByText(/2 VERSIONS/)).toBeTruthy()
    expect(screen.queryByText(/spare/)).toBeNull()
  })

  it('says which copies of a version group are also in the identical list', async () => {
    await open(
      report({
        identical: [identical()],
        versions: [
          {
            ...versions(),
            identicalCopies: 2,
            copies: [...versions().copies, copy('/library/Rush - YYZ (1)')]
          }
        ]
      })
    )

    expect(screen.getByText(/2 of these are the same chart file as each other/)).toBeTruthy()
  })

  it('says when a copy could not be compared rather than counting it as a version', async () => {
    await open(report({ versions: [{ ...versions(), versionCount: 1, unknownCount: 1 }] }))

    expect(screen.getByText(/1 NOT COMPARED/)).toBeTruthy()
  })
})

describe('Duplicates: the same song by different charters', () => {
  /**
   * The one outcome worse than not shipping this tier is shipping it as a fault. A user who keeps
   * four charts of a song on purpose must not be told their library has four problems.
   */
  it('is introduced by saying nothing is wrong, and counts songs rather than faults', async () => {
    await open(report({ alternates: [alternates()] }))

    expect(screen.getByText('The same song by different charters')).toBeTruthy()
    expect(screen.getByText(/Nothing is wrong here/)).toBeTruthy()
    // Counted in songs, not in faults, and singular when there is one of them.
    expect(screen.getByText('1 SONG')).toBeTruthy()
  })

  it('never describes an alternate chart as spare, extra, waste or a duplicate to remove', async () => {
    await open(report({ alternates: [alternates()] }))

    const tier = screen.getByText('The same song by different charters').closest('.tier')
    expect(tier).not.toBeNull()
    const text = tier?.textContent ?? ''
    for (const word of ['spare', 'waste', 'wasted', 'extra copies', 'delete', 'remove']) {
      expect(text.toLowerCase()).not.toContain(word)
    }
  })

  it('groups the copies under each charter, both chart shapes alike', async () => {
    await open(report({ alternates: [alternates()] }))

    expect(screen.getByText('Ann')).toBeTruthy()
    expect(screen.getByText('Bo')).toBeTruthy()
    expect(screen.getByText('FOLDER')).toBeTruthy()
    expect(screen.getByText('SNG')).toBeTruthy()
  })

  it('carries the class its calmer styling hangs off, which the other tiers do not', async () => {
    // jsdom applies no stylesheet, so this pins the hook and not the appearance: what the `calm`
    // rules actually look like is unverified here and was checked in the running app.
    await open(report({ identical: [identical()], alternates: [alternates()] }))

    const calm = screen.getByText('The same song by different charters').closest('.tier')
    const sharp = screen.getByText('The same chart, installed twice').closest('.tier')
    expect(calm?.classList.contains('calm')).toBe(true)
    expect(sharp?.classList.contains('calm')).toBe(false)
  })
})

describe('Duplicates: a report too long to draw whole', () => {
  it('draws the first 25 sets and folds the rest behind a button that names the total', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      checksum: String(i).padStart(32, '0'),
      copies: [copy(`/library/song-${i}`), copy(`/library/song-${i} (1)`)]
    }))
    await open(report({ identical: many }))

    expect(screen.getAllByText(/SAME CHART FILE/)).toHaveLength(25)
    await fireEvent.click(screen.getByRole('button', { name: 'Show all 40' }))
    expect(screen.getAllByText(/SAME CHART FILE/)).toHaveLength(40)
    // Reversible: the cap is a rendering budget, not a filter the user asked for, so going back
    // to it has to be possible without reloading the view.
    await fireEvent.click(screen.getByRole('button', { name: 'Show first 25' }))
    expect(screen.getAllByText(/SAME CHART FILE/)).toHaveLength(25)
  })
})

describe('Duplicates: charts the comparison cannot see', () => {
  it('says how many charts have no chart ID yet, above everything else', async () => {
    stub(report({ unidentifiedCharts: 12, totalCharts: 200 }))
    render(Duplicates)

    expect(await screen.findByText(/12 of your 200 charts carry no chart ID yet/)).toBeTruthy()
  })

  it('says nothing about it when every chart has one', async () => {
    stub(report({ identical: [identical()] }))
    render(Duplicates)

    expect(await screen.findByRole('button', { name: 'Show' })).toBeTruthy()
    expect(screen.queryByText(/carry no chart ID yet/)).toBeNull()
  })
})

describe('Duplicates: export', () => {
  it('writes one row per copy, tier first, for every tier', async () => {
    let written = ''
    stub(report({ identical: [identical()], versions: [versions()], alternates: [alternates()] }), {
      saveTextFile: (req: { content: string }): Promise<string | null> => {
        written = req.content
        return Promise.resolve('/tmp/encore-duplicates.csv')
      }
    })
    render(Duplicates)
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await screen.findByText(/SAVED/)
    const lines = written.trim().split('\r\n')
    expect(lines[0]).toBe('tier,group,artist,title,charter,chartType,path,cloneHeroChecksum')
    // Two identical copies, two versions, two alternates, plus the header.
    expect(lines).toHaveLength(7)
    expect(lines.filter((l) => l.startsWith('identical,'))).toHaveLength(2)
    expect(lines.filter((l) => l.startsWith('versions,'))).toHaveLength(2)
    expect(lines.filter((l) => l.startsWith('alternates,'))).toHaveLength(2)
  })
})

/**
 * The one place in this view where the two halves part company: a name is read as text on
 * screen, and goes out of the CSV exactly as the chart wrote it.
 */
describe('Duplicates names written in Clone Hero markup', () => {
  const markedVersions = (): VersionGroup => ({
    ...versions(),
    name: '<b>YYZ</b>',
    charter: EIGHT_TAG_CHARTER,
    copies: [copy('/library/Rush - YYZ', { name: '<b>YYZ</b>', charter: EIGHT_TAG_CHARTER })]
  })

  it('names a group, and the charter under it, as text', async () => {
    await open(report({ versions: [markedVersions()] }))
    expect(screen.getByText('Rush - YYZ')).toBeTruthy()
    expect(screen.getByText(`charted by ${EIGHT_TAG_CHARTER_TEXT}`)).toBeTruthy()
  })

  it('names an identical group from the copy it holds, as text', async () => {
    await open(
      report({
        identical: [
          {
            checksum: 'a'.repeat(32),
            copies: [
              copy('/library/one', { name: TAGGED_CHARTER }),
              copy('/library/two', { name: TAGGED_CHARTER })
            ]
          }
        ]
      })
    )
    expect(screen.getByText(`Rush - ${TAGGED_CHARTER_TEXT}`)).toBeTruthy()
  })

  it('exports the name the chart actually carries, markup and all', async () => {
    // Deliberately not stripped. This file sits next to each copy's path and Clone Hero
    // checksum so it can be joined against a library, and a name Encore had rewritten on the
    // way out would match neither the song.ini it came from nor the catalog. The stripper is
    // lossy, so nothing downstream could put the original back.
    let written = ''
    stub(report({ versions: [markedVersions()] }), {
      saveTextFile: (req: { content: string }): Promise<string | null> => {
        written = req.content
        return Promise.resolve('/tmp/encore-duplicates.csv')
      }
    })
    render(Duplicates)
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await screen.findByText(/SAVED/)
    expect(written).toContain(EIGHT_TAG_CHARTER)
    expect(written).not.toContain(`,${EIGHT_TAG_CHARTER_TEXT},`)
  })
})
