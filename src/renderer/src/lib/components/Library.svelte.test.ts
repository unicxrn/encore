import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  ChartRecordSchema,
  defaultSettings,
  type CatalogFilter,
  type ChartRecord,
  type JobProgress
} from '../../../../shared/schemas'
import type {
  ChartLifetime,
  ChartPlaySummary,
  LifetimeScores,
  PlayDataStatus
} from '../../../../shared/play'
import type { ChartVerdict } from '../../../../shared/updates'
import { scanProgress } from '../stores/scan'
import { EMPTY_LIBRARY_FILTER, libraryFilter } from '../stores/library-filter'
import { settings } from '../stores/settings'
import { verdicts } from '../stores/updates'
import {
  EIGHT_TAG_CHARTER,
  EIGHT_TAG_CHARTER_TEXT,
  TAGGED_CHARTER,
  TAGGED_CHARTER_TEXT
} from '../../../../../test/helpers/marked-up-names'
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
  // And the filter bar, which is module-scoped for the same reason Explore's search store is.
  // Without this, a test that types in the filter box narrows every test after it.
  libraryFilter.set({ ...EMPTY_LIBRARY_FILTER })
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

/**
 * The filter bar, the sort beside it, and what the row has to show for them to mean anything.
 *
 * Every assertion here is about the filter that reaches the catalog, never about what the list
 * came back with: the query is paged, so what these controls are worth depends entirely on the
 * database being asked the right question. The ordering itself is proved in
 * main/catalog/queries.test.ts, against a real SQLite catalog and across page boundaries.
 *
 * NOT COVERED, AND NOT COVERABLE HERE: jsdom computes no layout. Nothing below can tell you that
 * the bar fits on one line, where it wraps, that the year column is wide enough for four digits,
 * or that the row is still 48.8px tall. Those need the running app.
 */
describe('Library: the filter bar', () => {
  const FACETS = {
    artists: ['Iron Maiden', 'Rush'],
    genres: ['Metal', 'Rock'],
    charters: ['Metalhead', 'Skyline'],
    years: [1990, 1981]
  }

  /**
   * Renders the view and hands back every filter the catalog was queried with, in order.
   *
   * Both `catalogQuery` and `catalogCount` are asked the same question, so only the query's is
   * recorded; `lastFilter` is what the controls under test actually produced.
   */
  function renderWithFilters(
    rows: ChartRecord[] = [],
    facets: typeof FACETS | null = FACETS
  ): { filters: CatalogFilter[]; lastFilter: () => CatalogFilter } {
    const filters: CatalogFilter[] = []
    vi.stubGlobal('encore', {
      catalogQuery: (f: CatalogFilter): Promise<ChartRecord[]> => {
        filters.push(f)
        return Promise.resolve(rows)
      },
      catalogCount: (): Promise<number> => Promise.resolve(rows.length),
      catalogFacets: (): Promise<typeof FACETS> =>
        facets ? Promise.resolve(facets) : Promise.reject(new Error('ipc gone')),
      updatesLast: () => Promise.resolve([])
    })
    render(Library, { onOpenChart: () => {} })
    return { filters, lastFilter: () => filters[filters.length - 1] }
  }

  /** Waits until a filter matching `match` has been sent, and returns it. */
  async function sentFilter(
    filters: CatalogFilter[],
    match: (f: CatalogFilter) => boolean
  ): Promise<CatalogFilter> {
    return waitFor(() => {
      const hit = [...filters].reverse().find(match)
      if (!hit) throw new Error(`no filter sent matching that predicate`)
      return hit
    })
  }

  const picker = (label: string): HTMLSelectElement =>
    screen.getByLabelText(label) as HTMLSelectElement

  it('offers only values the catalog holds, plus an "any" option', async () => {
    renderWithFilters()
    await waitFor(() =>
      expect([...picker('Filter by artist').options].map((o) => o.textContent?.trim())).toEqual([
        'Any artist',
        'Iron Maiden',
        'Rush'
      ])
    )
    expect([...picker('Filter by genre').options].map((o) => o.value)).toEqual([
      '',
      'Metal',
      'Rock'
    ])
    expect([...picker('Filter by charter').options].map((o) => o.value)).toEqual([
      '',
      'Metalhead',
      'Skyline'
    ])
    // Newest first: someone scanning for a decade is reading down from the present.
    expect([...picker('Earliest year').options].map((o) => o.value)).toEqual(['', '1990', '1981'])
  })

  // Album has no picker on purpose. At 154 distinct albums across 222 charts, a dropdown of them
  // is a dropdown of the library.
  it('gives album a text box rather than a picker', () => {
    renderWithFilters()
    expect(screen.getByLabelText('Filter by album').tagName).toBe('INPUT')
    expect(screen.queryByLabelText('Any album')).toBeNull()
  })

  it('asks the catalog for the picked artist, genre and charter', async () => {
    const { filters } = renderWithFilters()
    await waitFor(() => expect(picker('Filter by artist').options).toHaveLength(3))

    await fireEvent.change(picker('Filter by artist'), { target: { value: 'Rush' } })
    expect((await sentFilter(filters, (f) => f.artist === 'Rush')).artist).toBe('Rush')

    await fireEvent.change(picker('Filter by genre'), { target: { value: 'Rock' } })
    const both = await sentFilter(filters, (f) => f.genre === 'Rock')
    // The picks accumulate rather than replacing each other.
    expect(both.artist).toBe('Rush')
  })

  it('sends the album as typed, and the length range in milliseconds', async () => {
    const { filters } = renderWithFilters()
    await fireEvent.input(screen.getByLabelText('Filter by album'), {
      target: { value: 'Moving' }
    })
    expect((await sentFilter(filters, (f) => f.album === 'Moving')).album).toBe('Moving')

    await fireEvent.input(screen.getByLabelText('Shortest length, in minutes'), {
      target: { value: '3' }
    })
    await fireEvent.input(screen.getByLabelText('Longest length, in minutes'), {
      target: { value: '6' }
    })
    const ranged = await sentFilter(filters, (f) => f.lengthMaxMs === 360_000)
    expect(ranged.lengthMinMs).toBe(180_000)
  })

  it('sends a year range from the two pickers', async () => {
    const { filters } = renderWithFilters()
    await waitFor(() => expect(picker('Earliest year').options).toHaveLength(3))
    await fireEvent.change(picker('Earliest year'), { target: { value: '1981' } })
    await fireEvent.change(picker('Latest year'), { target: { value: '1990' } })
    const ranged = await sentFilter(filters, (f) => f.yearMax === 1990)
    expect(ranged.yearMin).toBe(1981)
  })

  it('sends a sort and a direction, which is what makes it a sort of the library', async () => {
    const { filters } = renderWithFilters()
    await fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'length' } })
    const sorted = await sentFilter(filters, (f) => f.sort === 'length')
    // Ascending until the user says otherwise, and the direction only travels with a sort.
    expect(sorted.direction).toBe('asc')

    await fireEvent.click(screen.getByRole('button', { name: 'Longest first' }))
    expect((await sentFilter(filters, (f) => f.direction === 'desc')).sort).toBe('length')
  })

  it('names both directions in the words of the column being sorted', async () => {
    renderWithFilters()
    // No sort chosen means no direction to state, so the pair is not there to be pressed.
    expect(screen.queryByRole('group', { name: 'Sort direction' })).toBeNull()

    await fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'year' } })
    expect(screen.getByRole('button', { name: 'Oldest first' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Newest first' })).toBeTruthy()

    await fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'title' } })
    expect(screen.getByRole('button', { name: 'A to Z' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Oldest first' })).toBeNull()
  })

  it('offers every sort the view claims to, in both directions', async () => {
    renderWithFilters()
    const options = [...(screen.getByLabelText('Sort by') as HTMLSelectElement).options].map(
      (o) => o.value
    )
    expect(options).toEqual(['', 'title', 'artist', 'album', 'charter', 'year', 'length'])
  })

  it('offers nothing to clear until something is set, then clears all of it', async () => {
    const { filters } = renderWithFilters()
    expect(screen.queryByRole('button', { name: /clear filters/i })).toBeNull()

    await fireEvent.input(screen.getByLabelText('Filter by album'), { target: { value: 'Live' } })
    await fireEvent.click(screen.getByRole('button', { name: 'No plays recorded' }))
    const clear = await screen.findByRole('button', { name: /clear filters/i })
    // The count says how much is about to be undone, so pressing it is not a guess.
    expect(clear.textContent).toContain('2')

    await fireEvent.click(clear)
    const cleared = await sentFilter(filters, (f) => f.album === undefined && !f.neverPlayed)
    expect(cleared.search).toBe('')
    expect(screen.queryByRole('button', { name: /clear filters/i })).toBeNull()
  })

  // A sort hides nothing, so clearing the filters must not throw it away as well.
  it('leaves the sort alone when the filters are cleared', async () => {
    const { filters } = renderWithFilters()
    await fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'year' } })
    await fireEvent.input(screen.getByLabelText('Filter by album'), { target: { value: 'Live' } })
    await fireEvent.click(await screen.findByRole('button', { name: /clear filters/i }))

    const cleared = await sentFilter(filters, (f) => f.album === undefined && f.sort === 'year')
    expect(cleared.sort).toBe('year')
  })

  it('counts the matches against the whole catalog once something is filtering', async () => {
    vi.stubGlobal('encore', {
      catalogQuery: (f: CatalogFilter): Promise<ChartRecord[]> =>
        Promise.resolve(f.album ? [] : []),
      catalogCount: (f: CatalogFilter): Promise<number> => Promise.resolve(f.album ? 3 : 222),
      catalogFacets: () => Promise.resolve(FACETS),
      updatesLast: () => Promise.resolve([])
    })
    render(Library, { onOpenChart: () => {} })
    // Unfiltered, a ratio of the library to itself says nothing.
    expect(await screen.findByText(/^222 CHARTS$/)).toBeTruthy()

    await fireEvent.input(screen.getByLabelText('Filter by album'), { target: { value: 'Live' } })
    expect(await screen.findByText(/3 OF 222 CHARTS/)).toBeTruthy()
  })

  /**
   * The play history only covers the time Encore has been watching Clone Hero, which the schema's
   * own comment asks any UI offering this filter to say out loud.
   */
  it('does not claim a chart was never played, only that no play was recorded', async () => {
    renderWithFilters()
    const toggle = screen.getByRole('button', { name: 'No plays recorded' })
    expect(toggle.textContent).not.toMatch(/never/i)

    // The caveat is not hidden in a tooltip: a user reading a short list has drawn a conclusion
    // before they would hover anything.
    expect(document.querySelector('.caveat')).toBeNull()
    await fireEvent.click(toggle)
    const caveat = await waitFor(() => {
      const found = document.querySelector('.caveat')
      if (!found) throw new Error('no caveat shown')
      return found
    })
    expect(caveat.textContent).toMatch(/score files/i)
  })

  it('asks for neverPlayed only while the toggle is pressed', async () => {
    const { filters } = renderWithFilters()
    const toggle = screen.getByRole('button', { name: 'No plays recorded' })
    await fireEvent.click(toggle)
    await sentFilter(filters, (f) => f.neverPlayed === true)
    await fireEvent.click(toggle)
    await sentFilter(filters, (f) => f.neverPlayed === undefined)
  })

  // Best effort, like the version badges: a bar that cannot be populated must not take the list
  // down with it, and the typed filters still work without any facets at all.
  it('still renders the list and the typed filters when the facets call fails', async () => {
    const { filters } = renderWithFilters([chart({ path: '/library/YYZ', name: 'YYZ' })], null)
    expect(await screen.findByText('YYZ')).toBeTruthy()
    await waitFor(() => expect(picker('Filter by artist').options).toHaveLength(1))

    await fireEvent.input(screen.getByLabelText('Filter by album'), { target: { value: 'Moving' } })
    expect((await sentFilter(filters, (f) => f.album === 'Moving')).album).toBe('Moving')
  })

  /**
   * Opening a chart destroys this view, the way every navigation does. Explore's search store
   * solves exactly this and for the same reason; the filter bar is worth more than a query, since
   * losing it costs the user the set of charts they had narrowed to with nothing saying why.
   */
  it('keeps the filters and the sort across a Detail round trip', async () => {
    const first = renderWithFilters()
    await waitFor(() => expect(picker('Filter by artist').options).toHaveLength(3))
    await fireEvent.change(picker('Filter by artist'), { target: { value: 'Rush' } })
    await fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'year' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Newest first' }))
    await sentFilter(first.filters, (f) => f.direction === 'desc')

    cleanup()
    const second = renderWithFilters()

    // The controls come back set, and immediately: the restored value is kept among the options
    // even before the facets have been fetched, so the bar never reads "any artist" while the
    // list is narrowed to one.
    expect(picker('Filter by artist').value).toBe('Rush')
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('year')
    expect(screen.getByRole('button', { name: 'Newest first' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    // ...and the first query after the remount asks for them, rather than for the whole library.
    const reload = await waitFor(() => {
      if (!second.filters.length) throw new Error('no query yet')
      return second.filters[0]
    })
    expect(reload).toMatchObject({ artist: 'Rush', sort: 'year', direction: 'desc', offset: 0 })
  })
})

/**
 * A filter on something the row does not show is a filter on something the user cannot see, and
 * a sort by a column that is not on screen is a list in an order nobody can check.
 */
describe('Library: the filterable fields on a row', () => {
  it('shows the artist, album and genre it filters on, and the year it sorts by', async () => {
    renderLibrary([
      chart({
        path: '/library/Rush - YYZ',
        name: 'YYZ',
        artist: 'Rush',
        album: 'Moving Pictures',
        genre: 'Rock',
        year: 1981,
        charter: 'Skyline',
        songLength: 265_000
      })
    ])

    const row = await rowTitled('YYZ')
    const text = (row.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Rush · Moving Pictures · Rock')
    expect(text).toContain('1981')
    expect(text).toContain('Skyline')
    // 265 seconds. Length was already on the row before the sort existed; this pins it there.
    expect(text).toContain('4:25')
  })

  it('drops an absent field and its separator instead of leaving a gap', async () => {
    renderLibrary([
      chart({ path: '/library/x', name: 'Unknown', artist: 'Rush', album: null, genre: null })
    ])

    const meta = (await rowTitled('Unknown')).querySelector('.meta')
    expect(meta?.textContent?.trim()).toBe('Rush')
  })

  // The length cell beside it already spends a placeholder glyph; two in a row reads as an error.
  it('leaves the year cell empty for a chart with no year', async () => {
    renderLibrary([chart({ path: '/library/y', name: 'Undated', year: null })])

    expect((await rowTitled('Undated')).querySelector('.year')?.textContent?.trim()).toBe('')
  })
})

/**
 * Play counts on the rows.
 *
 * Two things are worth pinning and one is not. The two: that the whole page's badges cost ONE
 * `playSummaries` call rather than one per row, and that a row with no record grows no badge,
 * because a zero here would read as "you have never played this" when the truth is "Encore was
 * not watching". The one that is not: how the badge looks beside the version badge, which jsdom
 * cannot see.
 */
describe('Library: play counts', () => {
  const CHECKSUM_A = 'a'.repeat(32)
  const CHECKSUM_B = 'b'.repeat(32)

  const summary = (over: Partial<ChartPlaySummary> & { checksum: string }): ChartPlaySummary => ({
    timesPlayed: 1,
    bestScore: null,
    bestStars: null,
    bestAccuracy: null,
    everFc: false,
    lastPlayedAt: null,
    ...over
  })

  const watching = (over: Partial<PlayDataStatus> = {}): PlayDataStatus => ({
    available: true,
    reason: 'ok',
    path: '/home/player/.clonehero/scorestats.json',
    playCount: 9,
    ...over
  })

  /**
   * A catalog that pages, so "once per page" is a question this file can ask.
   *
   * `pages` is served in order: the first `load()` gets the first entry, each "Load more" the
   * next. `total` is the sum, which is what keeps the Load more button on screen.
   */
  function renderPaged(
    pages: ChartRecord[][],
    summaries: ChartPlaySummary[],
    status: PlayDataStatus = watching(),
    // Null leaves `playLifetime` off the bridge entirely, which is the shape every test written
    // before the score files were read gives it. Those tests are the regression guard for the
    // fallback: with no lifetime channel a row's badge is still Encore's own count.
    lifetimeCharts: ChartLifetime[] | null = null
  ): {
    playSummaries: ReturnType<typeof vi.fn>
    playStatus: ReturnType<typeof vi.fn>
    playLifetime: ReturnType<typeof vi.fn>
  } {
    const total = pages.reduce((n, page) => n + page.length, 0)
    const playSummaries = vi.fn((checksums: string[]) =>
      Promise.resolve(summaries.filter((s) => checksums.includes(s.checksum)))
    )
    const playStatus = vi.fn(() => Promise.resolve(status))
    const playLifetime = vi.fn((checksums: string[]): Promise<LifetimeScores> =>
      Promise.resolve(scores(lifetimeCharts ?? [], checksums))
    )
    vi.stubGlobal('encore', {
      catalogQuery: (f: CatalogFilter): Promise<ChartRecord[]> => {
        // The view asks by offset; the page index is the offset over the page size it used.
        const index = pages.findIndex(
          (_page, i) => f.offset === pages.slice(0, i).reduce((n, p) => n + p.length, 0)
        )
        return Promise.resolve(index === -1 ? [] : pages[index])
      },
      catalogCount: (): Promise<number> => Promise.resolve(total),
      updatesLast: () => Promise.resolve([]),
      playStatus,
      playSummaries,
      ...(lifetimeCharts === null ? {} : { playLifetime })
    })
    render(Library, { onOpenChart: () => {} })
    return { playSummaries, playStatus, playLifetime }
  }

  /** One chart as Clone Hero's own table holds it. */
  const lifetimeChart = (over: Partial<ChartLifetime> & { checksum: string }): ChartLifetime => ({
    lifetimePlays: 1,
    observedPlays: 0,
    everPlayed: true,
    best: null,
    unconfirmedRows: 0,
    ...over
  })

  const lifetimeBest = (score: number, percent: number): ChartLifetime['best'] => ({
    variant: 2,
    difficulty: 3,
    difficultyName: 'Expert',
    percent,
    stars: 5,
    isFullCombo: false,
    playbackSpeed: 100,
    score,
    scoreWithoutCleanPlayBonus: score - 1000
  })

  /** The channel's answer: rows narrowed to the request, totals always over everything. */
  const scores = (rows: ChartLifetime[], checksums: string[]): LifetimeScores => ({
    status: {
      available: rows.length > 0,
      reason: rows.length > 0 ? 'ok' : 'noFile',
      scoreDataPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoredata.bin',
      scoresExtPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoresext.bin',
      lastImportAt: rows.length > 0 ? '2026-09-12T10:00:00.000Z' : null
    },
    totals: {
      charts: rows.length,
      lifetimePlays: rows.reduce((n, r) => n + r.lifetimePlays, 0),
      chartsInLibrary: rows.length,
      chartsNotInLibrary: 0,
      chartsWithUnconfirmedRows: rows.filter((r) => r.unconfirmedRows > 0).length,
      bestScore: null,
      observedPlays: rows.reduce((n, r) => n + r.observedPlays, 0),
      observedCharts: rows.filter((r) => r.observedPlays > 0).length
    },
    charts: rows.filter((r) => checksums.includes(r.checksum))
  })

  function badgesOf(row: HTMLElement): string[] {
    return [...row.querySelectorAll('.badge')].map((b) =>
      (b.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
  }

  it('asks once for the whole page, not once per row', async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      chart({
        path: `/library/chart-${i}`,
        name: `Chart ${i}`,
        cloneHeroChecksum: String(i).repeat(32).slice(0, 32)
      })
    )
    const { playSummaries } = renderPaged([rows], [])

    await rowTitled('Chart 7')
    await waitFor(() => expect(playSummaries).toHaveBeenCalledTimes(1))
    // Eight rows, one call, eight checksums in it.
    expect(playSummaries.mock.calls[0][0]).toHaveLength(8)
  })

  it('asks once more per page appended, with only that page in the batch', async () => {
    const first = [chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]
    const second = [chart({ path: '/library/two', name: 'Two', cloneHeroChecksum: CHECKSUM_B })]
    const { playSummaries } = renderPaged(
      [first, second],
      [summary({ checksum: CHECKSUM_A, timesPlayed: 3 }), summary({ checksum: CHECKSUM_B })]
    )

    await rowTitled('One')
    await waitFor(() => expect(playSummaries).toHaveBeenCalledTimes(1))
    await fireEvent.click(await screen.findByRole('button', { name: /load more/i }))
    await rowTitled('Two')
    await waitFor(() => expect(playSummaries).toHaveBeenCalledTimes(2))

    expect(playSummaries.mock.calls[1][0]).toEqual([CHECKSUM_B])
    // The first page keeps its badge: appending must extend the map, not replace it.
    await waitFor(() =>
      expect(badgesOf(document.querySelector('.row') as HTMLElement)).toContain('3 PLAYS')
    )
  })

  it('asks the gate once for the whole visit, not once per page', async () => {
    const first = [chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]
    const second = [chart({ path: '/library/two', name: 'Two', cloneHeroChecksum: CHECKSUM_B })]
    const { playStatus } = renderPaged([first, second], [])

    await rowTitled('One')
    await fireEvent.click(await screen.findByRole('button', { name: /load more/i }))
    await rowTitled('Two')
    await waitFor(() => expect(playStatus).toHaveBeenCalledTimes(1))
  })

  it('never asks for summaries when the gate says nothing is recorded', async () => {
    const { playSummaries } = renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching({ available: false, playCount: 0 })
    )

    await rowTitled('One')
    // Given a moment to have made the call it must not make.
    await waitFor(() => expect(document.querySelector('.row')).not.toBeNull())
    expect(playSummaries).not.toHaveBeenCalled()
  })

  it('badges a played chart with its count and leaves an unplayed one bare', async () => {
    renderPaged(
      [
        [
          chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A }),
          chart({ path: '/library/two', name: 'Two', cloneHeroChecksum: CHECKSUM_B })
        ]
      ],
      [summary({ checksum: CHECKSUM_A, timesPlayed: 12 })]
    )

    const played = await rowTitled('One')
    await waitFor(() => expect(badgesOf(played)).toEqual(['12 PLAYS']))
    // Nothing at all on the row with no record. A "0 PLAYS" here would be the claim this whole
    // feature has to avoid making.
    expect(badgesOf(await rowTitled('Two'))).toEqual([])
  })

  it('says PLAY, not PLAYS, for a single play', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [summary({ checksum: CHECKSUM_A, timesPlayed: 1 })]
    )
    await waitFor(async () => expect(badgesOf(await rowTitled('One'))).toEqual(['1 PLAY']))
  })

  it('does not add a grid child, so a badged row keeps the row shape', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [summary({ checksum: CHECKSUM_A, timesPlayed: 4 })]
    )
    const row = await rowTitled('One')
    await waitFor(() => expect(badgesOf(row)).toEqual(['4 PLAYS']))
    expect(row.children).toHaveLength(declaredRowTracks())
  })

  it('carries the best score, the combo and the window in the badge hover text', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [
        summary({
          checksum: CHECKSUM_A,
          timesPlayed: 4,
          bestScore: 654_321,
          bestAccuracy: 0.9812,
          everFc: true,
          lastPlayedAt: '2026-09-01T20:00:00.0000000Z'
        })
      ]
    )
    const badge = await waitFor(() => {
      const found = document.querySelector('.badge.plays')
      if (!found) throw new Error('no play badge yet')
      return found
    })
    const title = badge.getAttribute('title') ?? ''
    expect(title).toContain('Best score 654,321 at 98.1%')
    expect(title).toContain('Full combo at least once.')
    expect(title).toContain('Counted only from when Encore started watching Clone Hero.')
  })

  it('states the window beside the list whenever counts are on screen', async () => {
    renderPaged([[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]], [])

    const caveat = await waitFor(() => {
      const found = document.querySelector('.caveat')
      if (!found) throw new Error('no caveat yet')
      return found
    })
    expect((caveat.textContent ?? '').replace(/\s+/g, ' ')).toContain(
      'Play counts start from when Encore began watching Clone Hero'
    )
  })

  it('leaves the never-played filter to say it, rather than saying it twice', async () => {
    renderPaged([[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]], [])
    await rowTitled('One')

    await fireEvent.click(screen.getByRole('button', { name: 'No plays recorded' }))
    await waitFor(() => {
      const caveats = [...document.querySelectorAll('.caveat')]
      expect(caveats).toHaveLength(1)
      expect(caveats[0].textContent).toContain('is in this list too')
    })
  })

  it('keeps the list when the play calls fail, because the badges are an addition to it', async () => {
    vi.stubGlobal('encore', {
      catalogQuery: (): Promise<ChartRecord[]> =>
        Promise.resolve([
          chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })
        ]),
      catalogCount: (): Promise<number> => Promise.resolve(1),
      updatesLast: () => Promise.resolve([]),
      playStatus: () => Promise.reject(new Error('no handler'))
    })
    render(Library, { onOpenChart: () => {} })

    const row = await rowTitled('One')
    expect(badgesOf(row)).toEqual([])
    expect(document.querySelector('.caveat')).toBeNull()
  })

  /**
   * The second record on a row.
   *
   * A row is dense enough that a second badge beside the first would be two numbers to tell
   * apart while scanning, and the obvious reading of two numbers side by side is the one this
   * feature must not invite: they are not addends. So there is one badge, it prefers Clone
   * Hero's own count because that is the superset, and the hover says which record answered.
   */
  const CHECKSUM_C = 'c'.repeat(32)

  it('badges a chart Encore never watched but Clone Hero has a record of', async () => {
    // The case that drew nothing at all before: no row in Encore's log, a full record in the
    // game's own table. This is most of a long-time player's library.
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching(),
      [lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 40 })]
    )
    await waitFor(async () => expect(badgesOf(await rowTitled('One'))).toEqual(['40 PLAYS']))
  })

  it('shows the lifetime count, not the observed one, and never both', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [summary({ checksum: CHECKSUM_A, timesPlayed: 3 })],
      watching(),
      [lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 40, observedPlays: 3 })]
    )
    const row = await rowTitled('One')

    await waitFor(() => expect(badgesOf(row)).toEqual(['40 PLAYS']))
    // 40 + 3 is not a number that means anything: Clone Hero counted those three too.
    expect(badgesOf(row)).not.toContain('43 PLAYS')
    expect(row.querySelectorAll('.badge.plays')).toHaveLength(1)
  })

  it('says how many of the count Encore saw, as a share of it rather than beside it', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [summary({ checksum: CHECKSUM_A, timesPlayed: 3, lastPlayedAt: '2026-09-01T20:00:00Z' })],
      watching(),
      [
        lifetimeChart({
          checksum: CHECKSUM_A,
          lifetimePlays: 40,
          observedPlays: 3,
          best: lifetimeBest(665_629, 98)
        })
      ]
    )
    const badge = await waitFor(() => {
      const found = document.querySelector('.badge.plays')
      if (!found?.getAttribute('title')?.includes('Clone Hero')) throw new Error('not yet')
      return found
    })
    const title = badge.getAttribute('title') ?? ''

    expect(title).toContain("Clone Hero's own count, over every play you have made")
    expect(title).toContain('Best score 665,629 at 98%')
    expect(title).toContain('Encore watched 3 of them happen')
    expect(title).not.toContain('Encore watched 3 plays.')
  })

  it('keeps the count and withholds the score for a chart with only an unreadable row', async () => {
    // The 21 charts in the owner's library that carry a variant nobody has decoded. The play
    // count is a record of real plays and stands; the score is on a scale nothing has checked.
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching(),
      [
        lifetimeChart({
          checksum: CHECKSUM_A,
          lifetimePlays: 7,
          best: null,
          unconfirmedRows: 1
        })
      ]
    )
    const badge = await waitFor(() => {
      const found = document.querySelector('.badge.plays')
      if (!found) throw new Error('no badge yet')
      return found
    })

    expect(badge.textContent?.replace(/\s+/g, ' ').trim()).toBe('7 PLAYS')
    const title = badge.getAttribute('title') ?? ''
    expect(title).toContain('on a scale Encore cannot read')
    expect(title).toContain('The play count is unaffected')
    expect(title).not.toContain('Best score')
    // Not a fault in the user's data, and not worded as one.
    expect(title).not.toMatch(/\b(corrupt|invalid|error|failed)\b/i)
  })

  it('says PLAYED, never 0 PLAYS, for a record with no count behind it', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching(),
      [lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 0, everPlayed: true })]
    )
    await waitFor(async () => expect(badgesOf(await rowTitled('One'))).toEqual(['PLAYED']))
  })

  it('falls back to the Encore count for a chart Clone Hero has no record of', async () => {
    renderPaged(
      [
        [
          chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A }),
          chart({ path: '/library/two', name: 'Two', cloneHeroChecksum: CHECKSUM_B }),
          chart({ path: '/library/three', name: 'Three', cloneHeroChecksum: CHECKSUM_C })
        ]
      ],
      [summary({ checksum: CHECKSUM_B, timesPlayed: 2 })],
      watching(),
      [lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 40 })]
    )

    await waitFor(async () => expect(badgesOf(await rowTitled('One'))).toEqual(['40 PLAYS']))
    expect(badgesOf(await rowTitled('Two'))).toEqual(['2 PLAYS'])
    // Neither record has it, so nothing at all: a zero would be the claim this must not make.
    expect(badgesOf(await rowTitled('Three'))).toEqual([])
  })

  it('asks the lifetime channel once per page, with that page in the batch', async () => {
    const first = [chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]
    const second = [chart({ path: '/library/two', name: 'Two', cloneHeroChecksum: CHECKSUM_B })]
    const { playLifetime } = renderPaged([first, second], [], watching(), [
      lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 40 }),
      lifetimeChart({ checksum: CHECKSUM_B, lifetimePlays: 2 })
    ])

    await rowTitled('One')
    await waitFor(() => expect(playLifetime).toHaveBeenCalledTimes(1))
    await fireEvent.click(await screen.findByRole('button', { name: /load more/i }))
    await rowTitled('Two')
    await waitFor(() => expect(playLifetime).toHaveBeenCalledTimes(2))

    expect(playLifetime.mock.calls[1][0]).toEqual([CHECKSUM_B])
    // The first page keeps its badge: appending extends the map rather than replacing it.
    await waitFor(() =>
      expect(badgesOf(document.querySelector('.row') as HTMLElement)).toContain('40 PLAYS')
    )
  })

  it('asks Clone Hero even when Encore has watched nothing at all', async () => {
    // The two are separate records with separate statuses. Gating the score files on Encore's
    // own log would hide a year of counts from exactly the user who just installed Encore.
    const { playLifetime } = renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching({ available: false, playCount: 0 }),
      [lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 40 })]
    )

    await waitFor(() => expect(playLifetime).toHaveBeenCalledTimes(1))
    await waitFor(async () => expect(badgesOf(await rowTitled('One'))).toEqual(['40 PLAYS']))
  })

  it('stops asking Clone Hero once it has answered that there is nothing', async () => {
    const first = [chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]
    const second = [chart({ path: '/library/two', name: 'Two', cloneHeroChecksum: CHECKSUM_B })]
    const { playLifetime } = renderPaged([first, second], [], watching(), [])

    await rowTitled('One')
    await waitFor(() => expect(playLifetime).toHaveBeenCalledTimes(1))
    await fireEvent.click(await screen.findByRole('button', { name: /load more/i }))
    await rowTitled('Two')
    expect(playLifetime).toHaveBeenCalledTimes(1)
  })

  it('states the right window beside the list for whichever record is answering', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching(),
      [lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 40 })]
    )
    const caveat = await waitFor(() => {
      const found = document.querySelector('.caveat')
      if (!found?.textContent?.includes('Clone Hero')) throw new Error('not the lifetime one yet')
      return found
    })
    const text = (caveat.textContent ?? '').replace(/\s+/g, ' ')

    expect(text).toContain("Play counts are Clone Hero's own, over every play you have made")
    // The old sentence was true when Encore's log was the only record and is now false.
    expect(text).not.toContain('start from when Encore began watching')
    expect(text).toContain('still not the same as never played')
  })

  it('tells the never-played filter which records actually answered', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching(),
      [lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 40 })]
    )
    await rowTitled('One')
    await fireEvent.click(screen.getByRole('button', { name: 'No plays recorded' }))

    const text = await waitFor(() => {
      const found = document.querySelector('.caveat')?.textContent?.replace(/\s+/g, ' ') ?? ''
      if (!found.includes('score files')) throw new Error('no filter caveat yet')
      return found
    })
    expect(text).toContain('which reach back before Encore was installed')
    expect(text).not.toContain('could not read')
  })

  it('warns that the filter is only the Encore log when the score files were not read', async () => {
    // The unavailable case, which is the normal one: only Linux has a verified location. A
    // sentence claiming both records here would be the misleading half of the feature.
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching(),
      []
    )
    await rowTitled('One')
    await fireEvent.click(screen.getByRole('button', { name: 'No plays recorded' }))

    const text = await waitFor(() => {
      const found = document.querySelector('.caveat')?.textContent?.replace(/\s+/g, ' ') ?? ''
      if (!found.includes('score files')) throw new Error('no filter caveat yet')
      return found
    })
    expect(text).toContain("Encore could not read Clone Hero's own score files")
    expect(text).toContain('before you installed Encore')
    expect(text).toContain('is in this list too')
  })

  it('keeps the row shape, because a lifetime badge is the same one badge', async () => {
    renderPaged(
      [[chart({ path: '/library/one', name: 'One', cloneHeroChecksum: CHECKSUM_A })]],
      [],
      watching(),
      [lifetimeChart({ checksum: CHECKSUM_A, lifetimePlays: 40 })]
    )
    const row = await rowTitled('One')
    await waitFor(() => expect(badgesOf(row)).toEqual(['40 PLAYS']))
    expect(row.children).toHaveLength(declaredRowTracks())
  })
})

/**
 * Clone Hero's markup reaches this list from song.ini, so every name the row draws has to be
 * read as text. The row itself is text assertions and they hold under jsdom; nothing here rests
 * on layout.
 */
describe('Library names written in Clone Hero markup', () => {
  const marked = (): ChartRecord =>
    chart({
      path: '/library/marked',
      name: `<b><color=#7B0000>Y</color><color=#8E0000>Y</color><color=#A31616>Z</color></b>`,
      artist: TAGGED_CHARTER,
      album: '<i>Moving Pictures</i>',
      genre: 'Prog',
      charter: EIGHT_TAG_CHARTER
    })

  it('draws the title, the meta line and the charter as text', async () => {
    renderLibrary([marked()])
    const row = await rowTitled('YYZ')
    expect(row.querySelector('.meta')?.textContent?.trim()).toBe(
      `${TAGGED_CHARTER_TEXT} · Moving Pictures · Prog`
    )
    expect(row.querySelector('.charter')?.textContent?.trim()).toBe(EIGHT_TAG_CHARTER_TEXT)
  })

  it('labels a facet option with the name and filters on what the catalog stores', async () => {
    // The two halves of the one rule worth pinning here: the user reads a charter, and the
    // query still carries the raw string the catalog was written with. Strip the value too and
    // the picker selects a charter that matches no row.
    const { filters } = renderWithFiltersFor({
      artists: [],
      genres: [],
      charters: [EIGHT_TAG_CHARTER],
      years: []
    })
    const select = await waitFor(() => {
      const found = screen.getByLabelText('Filter by charter') as HTMLSelectElement
      if (found.options.length < 2) throw new Error('facets not in yet')
      return found
    })
    const option = select.options[1]
    expect(option.textContent?.trim()).toBe(EIGHT_TAG_CHARTER_TEXT)
    expect(option.value).toBe(EIGHT_TAG_CHARTER)

    await fireEvent.change(select, { target: { value: EIGHT_TAG_CHARTER } })
    const sent = await waitFor(() => {
      const hit = [...filters].reverse().find((f) => f.charter !== undefined)
      if (!hit) throw new Error('no charter filter sent')
      return hit
    })
    expect(sent.charter).toBe(EIGHT_TAG_CHARTER)
  })

  it('keeps a name that is nothing but markup readable in the picker', async () => {
    // Stripping leaves nothing here, and a blank option is one the user cannot tell from the
    // next blank one. The raw string is ugly and it is at least a name.
    renderWithFiltersFor({ artists: [], genres: [], charters: ['<b></b>'], years: [] })
    const select = await waitFor(() => {
      const found = screen.getByLabelText('Filter by charter') as HTMLSelectElement
      if (found.options.length < 2) throw new Error('facets not in yet')
      return found
    })
    expect(select.options[1].textContent?.trim()).toBe('<b></b>')
  })

  function renderWithFiltersFor(facets: {
    artists: string[]
    genres: string[]
    charters: string[]
    years: number[]
  }): { filters: CatalogFilter[] } {
    const filters: CatalogFilter[] = []
    vi.stubGlobal('encore', {
      catalogQuery: (f: CatalogFilter): Promise<ChartRecord[]> => {
        filters.push(f)
        return Promise.resolve([])
      },
      catalogCount: (): Promise<number> => Promise.resolve(0),
      catalogFacets: (): Promise<typeof facets> => Promise.resolve(facets),
      updatesLast: () => Promise.resolve([])
    })
    render(Library, { onOpenChart: () => {} })
    return { filters }
  }
})
