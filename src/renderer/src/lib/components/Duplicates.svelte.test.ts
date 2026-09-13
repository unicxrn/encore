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
  hasAlbumArt: false,
  hasVideo: false,
  hasBackground: false,
  hasLyrics: false,
  sizeBytes: null,
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

interface Stubs {
  reveal: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function stub(result: DuplicateReport, extra: Record<string, unknown> = {}): Stubs {
  const reveal = vi.fn(() => Promise.resolve())
  // Never the real channel, which would hand a path to shell.trashItem. What is pinned here is
  // what the view asks for and what it does with each answer; the trashing itself is covered in
  // main/catalog/remove-chart.test.ts.
  const remove = vi.fn((path: string) => Promise.resolve({ path, outcome: 'trashed' as const }))
  vi.stubGlobal('encore', {
    catalogDuplicates: (): Promise<DuplicateReport> => Promise.resolve(result),
    chartReveal: reveal,
    chartRemove: remove,
    saveTextFile: (): Promise<string | null> => Promise.resolve(null),
    ...extra
  })
  return { reveal, remove }
}

/** Renders and opens the panel, which is collapsed until something is found and shown. */
async function open(result: DuplicateReport): Promise<Stubs> {
  const stubs = stub(result)
  render(Duplicates)
  fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
  return stubs
}

/** Open the confirmation for one copy. Nothing is removed until the second press. */
async function confirmFor(path: string): Promise<void> {
  await fireEvent.click(screen.getByRole('button', { name: `Remove this copy: ${path}` }))
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

  it('says what a removal does before offering one', async () => {
    await open(report({ identical: [identical()] }))

    expect(screen.getByText(/A removal goes to your system Trash/)).toBeTruthy()
    expect(screen.getByText(/Nothing is chosen for you/)).toBeTruthy()
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

describe('Duplicates: removing one copy of an identical pair', () => {
  /**
   * The decision this view exists to inform, and the one it must not make.
   *
   * Two copies with one checksum are the same notes and can still differ in everything around
   * them, so the test that matters most is not that the button works: it is that the difference
   * is on screen before the button is pressed, and that Encore never points at one of the two.
   */
  const mixed = (): IdenticalGroup => ({
    checksum: 'a'.repeat(32),
    copies: [
      copy('/library/Rush - YYZ', { hasAlbumArt: true, hasVideo: true, sizeBytes: 42_000_000 }),
      copy('/library/Rush - YYZ (1)', { hasAlbumArt: true, sizeBytes: 3_000_000 })
    ]
  })

  it('shows what each copy holds and how big it is, before anything is removable', async () => {
    await open(report({ identical: [mixed()] }))

    expect(screen.getByText(/Holds album art and video/)).toBeTruthy()
    expect(screen.getByText(/The only copy here with video/)).toBeTruthy()
    expect(screen.getByText('40 MB')).toBeTruthy()
    expect(screen.getByText('2.9 MB')).toBeTruthy()
  })

  it('says so plainly when a copy holds none of the four', async () => {
    // An absent line and a line saying "nothing" look the same to a reader only if the absent
    // one is allowed, so it is not.
    await open(report({ identical: [identical()] }))

    expect(screen.getAllByText(/No album art, video, background or lyrics/)).toHaveLength(2)
  })

  it('preselects nothing and recommends nothing', async () => {
    await open(report({ identical: [mixed()] }))

    // Both copies are equally offered, in the order they arrived, and no wording nominates one.
    expect(
      screen.getByRole('button', { name: 'Remove this copy: /library/Rush - YYZ' })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Remove this copy: /library/Rush - YYZ (1)' })
    ).toBeTruthy()
    const panel = screen.getByText('The same chart, installed twice').closest('.tier')
    const text = panel?.textContent?.toLowerCase() ?? ''
    for (const word of ['recommend', 'we suggest', 'keep this one', 'safe to remove']) {
      expect(text).not.toContain(word)
    }
  })

  it('asks first, naming the chart, the path, the Trash and the play history', async () => {
    const { remove } = await open(report({ identical: [mixed()] }))

    await confirmFor('/library/Rush - YYZ (1)')

    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText(/Remove this copy of Rush - YYZ\?/)).toBeTruthy()
    // The panel says it for itself, rather than relying on the paragraph at the top of the
    // report that the user may have scrolled past.
    const panel = screen.getByText(/Remove this copy of Rush - YYZ\?/)
    expect(panel.textContent).toContain('goes to your system Trash')
    expect(panel.textContent).toContain('Your play history is kept')
    expect(screen.getAllByText('/library/Rush - YYZ (1)').length).toBeGreaterThan(1)
  })

  it('warns in the confirmation when this copy is the only one holding something', async () => {
    await open(report({ identical: [mixed()] }))

    await confirmFor('/library/Rush - YYZ')

    expect(
      screen.getByText(/the only copy in this set with video, and that goes with it/)
    ).toBeTruthy()
  })

  it('says the opposite when nothing would be lost', async () => {
    await open(report({ identical: [mixed()] }))

    await confirmFor('/library/Rush - YYZ (1)')

    expect(
      screen.getByText(/Everything this copy holds is held by another copy in this set as well/)
    ).toBeTruthy()
  })

  it('removes only the copy that was confirmed, and drops the group with it', async () => {
    const { remove } = await open(report({ identical: [mixed()] }))

    await confirmFor('/library/Rush - YYZ (1)')
    await fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))

    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('/library/Rush - YYZ (1)')
    expect(await screen.findByText('Moved Rush - YYZ to the Trash.')).toBeTruthy()
    // One copy left is not a duplicate of anything, so the set goes rather than sitting there
    // with a Remove button over the last copy of a chart.
    expect(screen.queryByText('/library/Rush - YYZ (1)')).toBeNull()
    expect(screen.queryByText(/SAME CHART FILE/)).toBeNull()
  })

  it('changes nothing on the way out of the confirmation', async () => {
    const { remove } = await open(report({ identical: [mixed()] }))

    await confirmFor('/library/Rush - YYZ (1)')
    await fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))

    expect(remove).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Move to Trash' })).toBeNull()
    expect(screen.getByText('/library/Rush - YYZ (1)')).toBeTruthy()
  })

  it('keeps the copy on screen and says it is still there when trashing fails', async () => {
    // The failure the whole design turns on. Nothing was deleted, so the row must not vanish and
    // the user must not be left thinking it did.
    stub(report({ identical: [mixed()] }), {
      chartRemove: vi.fn(() => Promise.reject(new Error('Failed to move item to trash')))
    })
    render(Duplicates)
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))

    await confirmFor('/library/Rush - YYZ (1)')
    await fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))

    expect(await screen.findByText(/Failed to move item to trash/)).toBeTruthy()
    expect(screen.getByText(/still on disk and still in your library/)).toBeTruthy()
    expect(screen.getByText('/library/Rush - YYZ (1)')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Remove this copy: /library/Rush - YYZ (1)' })
    ).toBeTruthy()
  })

  it('reports a chart that had already left the disk as the non-event it is', async () => {
    stub(report({ identical: [mixed()] }), {
      chartRemove: vi.fn((path: string) =>
        Promise.resolve({ path, outcome: 'already-gone' as const })
      )
    })
    render(Duplicates)
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))

    await confirmFor('/library/Rush - YYZ (1)')
    await fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))

    expect(
      await screen.findByText(
        'Rush - YYZ was no longer on disk, so only its catalog entry was removed.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/Could not move this copy/)).toBeNull()
  })

  it('says the size is unread rather than calling a copy empty', async () => {
    await open(
      report({
        identical: [
          {
            checksum: 'a'.repeat(32),
            copies: [copy('/library/Rush - YYZ'), copy('/library/Rush - YYZ (1)')]
          }
        ]
      })
    )

    expect(screen.getAllByText('SIZE UNREAD')).toHaveLength(2)
    expect(screen.queryByText('0 B')).toBeNull()
  })
})

describe('Duplicates: the two tiers that offer no removal', () => {
  it('offers nothing to remove on a version group', async () => {
    // Removing the old version of a chart orphans the scores set on it: they are recorded
    // against its checksum, not the new one's. That is a decision for a file manager, not a
    // button in a report.
    await open(report({ versions: [versions()] }))

    expect(screen.queryByRole('button', { name: /^Remove this copy/ })).toBeNull()
    expect(screen.queryByText(/Holds /)).toBeNull()
  })

  it('offers nothing to remove on an alternate-charters group', async () => {
    await open(report({ alternates: [alternates()] }))

    expect(screen.queryByRole('button', { name: /^Remove this copy/ })).toBeNull()
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
