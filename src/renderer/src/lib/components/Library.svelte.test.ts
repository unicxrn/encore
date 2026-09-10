import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  ChartRecordSchema,
  defaultSettings,
  type CatalogFilter,
  type ChartRecord,
  type JobProgress
} from '../../../../shared/schemas'
import type { ChartVerdict } from '../../../../shared/updates'
import { scanProgress } from '../stores/scan'
import { settings } from '../stores/settings'
import { verdicts } from '../stores/updates'
import Library from './Library.svelte'
// Vite's ?raw hands back the component's own bytes, untransformed, which is the only way this
// test can see a stylesheet jsdom never applies. See declaredRowTracks().
import librarySource from './Library.svelte?raw'

/**
 * Fixtures go through the real schema so every field the component reads is the field the
 * catalog would actually hand it. A renamed or re-typed column breaks these tests instead of
 * letting a hand-written literal drift away from the row shape in the database.
 */
function chart(overrides: Partial<ChartRecord> & { path: string }): ChartRecord {
  return ChartRecordSchema.parse({
    chartType: 'folder',
    folderHash: overrides.path,
    modifiedTime: 0,
    songLength: 273_000,
    ...overrides
  })
}

/**
 * `encore()` reads `window.encore`, and under jsdom `globalThis` *is* `window`, so
 * `vi.stubGlobal('encore', …)` puts the fake exactly where the bridge looks for it.
 * Only the two methods `load()` calls are stubbed.
 */
function renderLibrary(
  rows: ChartRecord[],
  verdicts: ChartVerdict[] = []
): { updatesCheck: ReturnType<typeof vi.fn>; updatesLast: ReturnType<typeof vi.fn> } {
  // `updatesLast` replays what main already holds for the session; `updatesCheck` is the one
  // that costs a Chorus request, and this view must never be the caller.
  const updatesCheck = vi.fn()
  const updatesLast = vi.fn(() => Promise.resolve(verdicts))
  vi.stubGlobal('encore', {
    catalogQuery: (): Promise<ChartRecord[]> => Promise.resolve(rows),
    catalogCount: (): Promise<number> => Promise.resolve(rows.length),
    updatesCheck,
    updatesLast
  })
  render(Library, { onOpenChart: () => {} })
  return { updatesCheck, updatesLast }
}

const identity = (path: string): ChartVerdict['local'] => ({
  path,
  name: null,
  artist: null,
  charter: null,
  chartHash: null,
  tempoMapHash: null
})

const alternate = (path: string): ChartVerdict => ({
  kind: 'alternate',
  local: identity(path),
  alternates: []
})

const current = (path: string): ChartVerdict => ({ kind: 'current', local: identity(path) })

afterEach(() => {
  vi.unstubAllGlobals()
  // `settings` is a module-level writable shared by every test in this file; the setup file
  // knows nothing about it.
  settings.set(defaultSettings())
  // Same story: the verdict map is module-level so a failed replay can keep the last good one,
  // which is exactly what would let one test's badge show up in the next.
  verdicts.set(new Map())
})

/** `onMount` fetches the list on a microtask, so the first paint has no rows in it. */
async function rowTitled(title: string): Promise<HTMLElement> {
  const row = (await screen.findByText(title)).closest('button')
  if (!row) throw new Error(`no row button around the title "${title}"`)
  return row
}

/**
 * The rendered text of a row's difficulty cells, in order.
 *
 * These are bare `<span>`s with no role, label or otherwise unique text, so a selector is the
 * only way to get hold of them; what is asserted is still their text, and the whole list of it,
 * so an instrument that renders when it should not fails the comparison.
 */
function diffCells(row: HTMLElement): string[] {
  return [...row.querySelectorAll('.diffs .d')].map((cell) => cell.textContent ?? '')
}

// U+2013. diffDisplay() renders it for "charted, but the charter left no rating".
const DASH = '–'

describe('Library: the difficulty column', () => {
  // Charters copy song.ini between projects, so a bass rating on a chart with no bass track is
  // ordinary rather than exotic. The note data has to win: a "B3" here tells the user to expect
  // a bass part that does not exist.
  it('renders no cell for an instrument the note data says is not charted', async () => {
    renderLibrary([
      chart({
        path: '/library/Rush - YYZ',
        name: 'YYZ',
        instruments: ['guitar'],
        diffGuitar: 4,
        diffBass: 3,
        diffDrums: 2
      })
    ])

    expect(diffCells(await rowTitled('YYZ'))).toEqual(['G4'])
  })

  // An empty `instruments` means "this row predates the note-count columns", not "this chart is
  // empty". Treating it as the latter blanks every difficulty column on every un-rescanned row,
  // which reads as catastrophic data loss to a user who has no idea a rescan is owed.
  it('falls back to the song.ini ratings when a row has no stored instruments', async () => {
    renderLibrary([
      chart({
        path: '/library/Rush - Limelight',
        name: 'Limelight',
        instruments: [],
        diffGuitar: 4,
        diffBass: 3,
        diffDrums: null
      })
    ])

    expect(diffCells(await rowTitled('Limelight'))).toEqual(['G4', 'B3', `D${DASH}`])
  })

  // The third state, and the reason a dash and an absent cell must not look alike: this chart
  // does have a guitar track, the charter just never rated it.
  it('shows a dash for a charted instrument with no rating', async () => {
    renderLibrary([
      chart({
        path: '/library/Rush - Subdivisions',
        name: 'Subdivisions',
        instruments: ['guitar', 'drums'],
        diffGuitar: null,
        diffBass: 3,
        diffDrums: 5
      })
    ])

    expect(diffCells(await rowTitled('Subdivisions'))).toEqual([`G${DASH}`, 'D5'])
  })
})

describe('Library: the chart title', () => {
  // A chart with no parsed title used to show its full path, which is unreadable forty rows deep
  // and tells the user nothing the folder name does not. The path stays on the title attribute.
  it('shows the folder or file name when a chart has no parsed title', async () => {
    renderLibrary([
      chart({ path: '/home/u/.clonehero/Songs/Rush - YYZ (Charter)', name: null }),
      chart({ path: '/home/u/.clonehero/Songs/Rush - Red Barchetta.sng', name: null })
    ])

    expect(await screen.findByText('Rush - YYZ (Charter)')).toBeTruthy()
    expect(screen.getByText('Rush - Red Barchetta')).toBeTruthy()
    expect(screen.queryByText('/home/u/.clonehero/Songs/Rush - YYZ (Charter)')).toBeNull()
  })

  it('shows the parsed title when there is one', async () => {
    renderLibrary([chart({ path: '/home/u/.clonehero/Songs/rush_yyz_v3', name: 'YYZ' })])

    expect(await screen.findByText('YYZ')).toBeTruthy()
    expect(screen.queryByText('rush_yyz_v3')).toBeNull()
  })
})

/**
 * The `.row` rule's declared track count, read out of the component source.
 *
 * jsdom applies no CSS, so `getComputedStyle` cannot answer this and a hardcoded constant would
 * only restate one half of the pair. Parsing the stylesheet is the only way to make the test
 * fail when either half moves, which is the point, since the two are edited independently and
 * a mismatch is invisible to typecheck, lint and build.
 *
 * Throws rather than guesses if the declaration is not a plain space-separated track list, so a
 * rewrite to `repeat()` surfaces as "update this parser" instead of a silent pass.
 */
function declaredRowTracks(): number {
  const rule = /^\s*\.row\s*\{([^}]*)\}/m.exec(librarySource)
  if (!rule) throw new Error('no `.row {…}` rule in Library.svelte')
  const declaration = /grid-template-columns:\s*([^;]+);/.exec(rule[1])
  if (!declaration) throw new Error('`.row` declares no grid-template-columns')
  const tracks = declaration[1].trim()
  if (/[(),]/.test(tracks)) throw new Error(`cannot count tracks in \`${tracks}\` by splitting`)
  return tracks.split(/\s+/).length
}

/**
 * A catalog holding `rows`, in which any filter text matches nothing. That is the shape the
 * empty state has to read: two counts from the same table, one narrowed by the filter box and
 * one not.
 */
function renderCatalog(rows: ChartRecord[]): void {
  vi.stubGlobal('encore', {
    catalogQuery: (f: CatalogFilter): Promise<ChartRecord[]> =>
      Promise.resolve(f.search ? [] : rows),
    catalogCount: (f: CatalogFilter): Promise<number> => Promise.resolve(f.search ? 0 : rows.length)
  })
  render(Library, { onOpenChart: () => {} })
}

/**
 * The empty state's text, whitespace-collapsed.
 *
 * Located by class because it is a bare `<p>` with no role or accessible name, the same
 * escape hatch `diffCells` uses above. Nothing here asserts on the class itself.
 */
async function emptyText(): Promise<string> {
  const paragraph = await waitFor(() => {
    const found = document.querySelector('.empty')
    if (!found) throw new Error('no empty state rendered')
    return found
  })
  return (paragraph.textContent ?? '').replace(/\s+/g, ' ').trim()
}

const LIBRARY = [
  chart({ path: '/library/Rush - YYZ', name: 'YYZ' }),
  chart({ path: '/library/Rush - Limelight', name: 'Limelight' })
]

/**
 * Which of the three the user is in decides which control they should reach for, and the view
 * used to answer all three with "add a library folder in Settings", telling a user with a
 * library and a filter typed in to go configure something they configured months ago.
 */
describe('Library: why the list is empty', () => {
  it('blames the filter, not the configuration, when the catalog holds charts', async () => {
    settings.set({ ...get(settings), libraryFolders: [{ path: '/songs', isDefault: true }] })
    renderCatalog(LIBRARY)
    await screen.findByText('YYZ')

    await fireEvent.input(screen.getByPlaceholderText('Filter library…'), {
      target: { value: 'zzz' }
    })

    const text = await emptyText()
    // The unfiltered count has to reach the message: it is the whole difference between this
    // branch and the two below, and the only proof the second query was made at all.
    expect(text).toContain(String(LIBRARY.length))
    expect(text).not.toMatch(/Settings/)
  })

  it('sends a user with no library folder to Settings, not to the scan button', async () => {
    renderCatalog([])

    const text = await emptyText()
    expect(text).toMatch(/Settings/)
  })

  it('offers the scan instead once a folder is configured but the catalog is empty', async () => {
    settings.set({ ...get(settings), libraryFolders: [{ path: '/songs', isDefault: true }] })
    renderCatalog([])

    const text = await emptyText()
    expect(text).toMatch(/Scan library/)
    expect(text).not.toMatch(/Settings/)
  })
})

/**
 * The library scan is the one long job the user could not previously stop. What matters in this
 * view is that a cancel is reachable while it runs, that it says so afterwards, and (because
 * cancelled scans keep the rows they wrote) that the list catches up with the partial catalog
 * instead of showing whatever it had before the scan.
 */
describe('Library: cancelling a scan', () => {
  const running = (percent: number): JobProgress => ({
    jobId: 'scan',
    kind: 'scan',
    phase: 'scanning',
    percent,
    message: null,
    status: 'running'
  })

  const canceled = (percent: number): JobProgress => ({
    jobId: 'scan',
    kind: 'scan',
    phase: 'canceled',
    percent,
    message: null,
    status: 'canceled'
  })

  afterEach(() => scanProgress.set(null))

  it('offers no cancel until a scan is actually running', async () => {
    renderLibrary([])
    await screen.findByText('Scan library')
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('asks main to stop the scan when the cancel is pressed', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('encore', {
      catalogQuery: (): Promise<ChartRecord[]> => Promise.resolve([]),
      catalogCount: (): Promise<number> => Promise.resolve(0),
      catalogScanCancel: cancel
    })
    render(Library, { onOpenChart: () => {} })
    scanProgress.set(running(40))

    await fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('says the scan was stopped, rather than leaving the last percent on screen', async () => {
    renderLibrary([])
    await screen.findByText('Scan library')
    scanProgress.set(canceled(42))

    // 'done' and 'canceled' both end a scan, and the view used to have only one word for that.
    expect(await screen.findByText(/stopped|canceled|cancelled/i)).toBeTruthy()
    // Not the error banner: the user asked for this.
    expect(screen.queryByText(/Scan failed/)).toBeNull()
  })

  it('reloads the list after a cancel, because the rows it wrote were kept', async () => {
    // The catalog is genuinely bigger than it was when this view last queried it, since a cancelled
    // scan keeps every row it managed to write. Refreshing only on 'done' would leave the user
    // looking at a list that is stale in a way nothing on screen explains.
    let rows: ChartRecord[] = []
    const query = vi.fn(() => Promise.resolve(rows))
    vi.stubGlobal('encore', {
      catalogQuery: query,
      catalogCount: () => Promise.resolve(rows.length)
    })
    render(Library, { onOpenChart: () => {} })
    await waitFor(() => expect(query).toHaveBeenCalled())

    rows = [chart({ path: '/library/Rush - YYZ', name: 'YYZ' })]
    scanProgress.set(canceled(42))

    expect(await screen.findByText('YYZ')).toBeTruthy()
  })

  it('does not let a cancelled scan speak for the whole library in the empty state', async () => {
    // 'scan-found-nothing' means a completed walk found no charts. A cancelled scan never
    // finished looking, so it cannot make that claim.
    settings.set({ ...get(settings), libraryFolders: [{ path: '/songs', isDefault: true }] })
    renderCatalog([])
    await emptyText()
    scanProgress.set(canceled(42))

    const text = await emptyText()
    expect(text).not.toMatch(/found no charts/i)
    expect(text).toMatch(/Scan library/)
  })
})

describe('Library: the row grid', () => {
  /**
   * Adding a column to the row markup without adding a track pushes the last column silently
   * onto a second line; the album-art thumbnail nearly shipped that way. This checks the count
   * relationship only. It does not, and under jsdom cannot, check that the stylesheet applies,
   * that the tracks are wide enough, or that nothing wrapped; if a later rule takes one of these
   * children out of flow or gives it `display: contents`, the two numbers stop corresponding and
   * this test will not notice. Running the app stays the check for layout.
   */
  it('gives a row exactly as many element children as .row declares grid tracks', async () => {
    // The thumbnail renders as an <img> or as a placeholder <span>, one element either way, so
    // both branches have to land on the same count; the placeholder is what holds the column
    // open for a chart whose art is not cached.
    // The version badge is a third branch: it renders inside the song column, so a badged row
    // must not gain a child either.
    renderLibrary(
      [
        chart({ path: '/library/Rush - YYZ', name: 'YYZ', albumArtMd5: 'a'.repeat(32) }),
        chart({ path: '/library/Rush - Limelight', name: 'Limelight', albumArtMd5: null }),
        chart({ path: '/library/Rush - Xanadu', name: 'Xanadu', albumArtMd5: null })
      ],
      [alternate('/library/Rush - Xanadu')]
    )

    const tracks = declaredRowTracks()
    expect((await rowTitled('YYZ')).children).toHaveLength(tracks)
    expect((await rowTitled('Limelight')).children).toHaveLength(tracks)
    const badged = await rowTitled('Xanadu')
    expect(badged.querySelector('.badge')).not.toBeNull()
    expect(badged.children).toHaveLength(tracks)
  })
})

/**
 * The verdict a check produced used to live only on the Detail page of the one chart it was run
 * for. This surfaces it where the user actually looks, at the cost of one IPC replay: main keeps
 * every verdict of the session, and `updatesLast` hands them back without a Chorus request.
 */
describe('Library: the version badge', () => {
  /** The badge is a bare `<span>` inside the song column; the class is the only handle. */
  function badgeOf(row: HTMLElement): string | null {
    return row.querySelector('.badge')?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  }

  it('marks a chart with a cached alternate, and nothing else', async () => {
    renderLibrary(
      [
        chart({ path: '/library/Rush - YYZ', name: 'YYZ' }),
        chart({ path: '/library/Rush - Limelight', name: 'Limelight' }),
        chart({ path: '/library/Rush - Xanadu', name: 'Xanadu' })
      ],
      [alternate('/library/Rush - YYZ'), current('/library/Rush - Limelight')]
    )

    await waitFor(async () => expect(badgeOf(await rowTitled('YYZ'))).not.toBeNull())
    // A `current` verdict is a fact worth no ink in a list, and a chart nobody has checked must
    // not be made to look checked.
    expect(badgeOf(await rowTitled('Limelight'))).toBeNull()
    expect(badgeOf(await rowTitled('Xanadu'))).toBeNull()
  })

  it('costs no Chorus request: the list replays main, it never runs the check', async () => {
    const { updatesCheck, updatesLast } = renderLibrary(
      [chart({ path: '/library/Rush - YYZ', name: 'YYZ' })],
      [alternate('/library/Rush - YYZ')]
    )

    await waitFor(async () => expect(badgeOf(await rowTitled('YYZ'))).not.toBeNull())
    expect(updatesLast).toHaveBeenCalled()
    expect(updatesCheck).not.toHaveBeenCalled()
  })

  it('says "different version", the same claim Detail makes, and never "newer"', async () => {
    renderLibrary(
      [chart({ path: '/library/Rush - YYZ', name: 'YYZ' })],
      [alternate('/library/Rush - YYZ')]
    )

    const text = await waitFor(async () => {
      const found = badgeOf(await rowTitled('YYZ'))
      if (found === null) throw new Error('no badge yet')
      return found
    })
    // Chorus exposes nothing that orders two uploads of a chart, so "newer" would be a claim the
    // data cannot back. Same guard Detail's card has; the badge must not drift on its own.
    expect(text).toMatch(/different version/i)
    expect(text).not.toMatch(/newer|out of date|outdated|update/i)
  })

  it('keeps its accent colour against the .mono rule it shares the element with', () => {
    // Found on screen, not in jsdom: `.badge` and `.mono` sit on the same span, and the `.mono`
    // rule, declared later, set --text-3 over the badge's --accent-text at equal specificity.
    // The badge rendered grey while its own comment promised the accent. Pinned on the raw
    // stylesheet, the only place a test can see a rule jsdom never applies: the colour has to
    // come from a selector that outranks a lone class.
    const rule = /^\s*\.badge\.mono\s*\{([^}]*)\}/m.exec(librarySource)
    if (!rule) throw new Error('no `.badge.mono {…}` rule in Library.svelte')
    expect(rule[1]).toMatch(/color:\s*var\(--accent-text\)/)
    expect(/^\s*\.badge\s*\{/m.test(librarySource)).toBe(false)
  })

  it('shows no badge when the replay itself fails, rather than failing the list', async () => {
    vi.stubGlobal('encore', {
      catalogQuery: (): Promise<ChartRecord[]> =>
        Promise.resolve([chart({ path: '/library/Rush - YYZ', name: 'YYZ' })]),
      catalogCount: (): Promise<number> => Promise.resolve(1),
      updatesLast: () => Promise.reject(new Error('ipc gone'))
    })
    render(Library, { onOpenChart: () => {} })

    const row = await rowTitled('YYZ')
    expect(badgeOf(row)).toBeNull()
  })
})
