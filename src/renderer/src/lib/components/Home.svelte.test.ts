import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Writable } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartRecord, JobProgress } from '../../../../shared/schemas'
import { ChartRecordSchema } from '../../../../shared/schemas'
import type { ChartData } from '../api/enchor'
import { scanProgress } from '../stores/scan'
import { settings } from '../stores/settings'
import { defaultSettings } from '../../../../shared/settings-defaults'
import {
  EIGHT_TAG_CHARTER,
  EIGHT_TAG_CHARTER_TEXT
} from '../../../../../test/helpers/marked-up-names'

// The latest-charts row talks to the Enchor API over the network. Stubbed at the store, not at
// fetch: the row's own fetching is the store's business and is tested there, and a writable in
// its place is what lets these tests put charts in the row without a request.
vi.mock('../stores/latest-charts', async () => {
  const { writable } = await import('svelte/store')
  return {
    latestCharts: writable({ charts: [], loading: false, error: null, total: null }),
    loadLatestCharts: (): Promise<void> => Promise.resolve()
  }
})

const { latestCharts } = await import('../stores/latest-charts')
interface LatestState {
  charts: ChartData[]
  total: number | null
  loading: boolean
  error: string | null
}
const latest = latestCharts as unknown as Writable<LatestState>

const { default: Home } = await import('./Home.svelte')

const chart = (path: string, name: string): ChartRecord =>
  ChartRecordSchema.parse({
    path,
    name,
    chartType: 'folder',
    folderHash: path,
    modifiedTime: 0
  })

/** Enough of a search result for a row to draw. The API sends every one of these on every hit. */
const remote = (over: Partial<ChartData> = {}): ChartData =>
  ({
    chartId: 1,
    songId: 42,
    md5: 'a'.repeat(32),
    albumArtMd5: null,
    hasVideoBackground: false,
    name: 'Everlong',
    artist: 'Foo Fighters',
    album: 'The Colour and the Shape',
    genre: 'Rock',
    year: '1997',
    charter: 'CharterA',
    song_length: 250_000,
    diff_guitar: 4,
    diff_bass: null,
    diff_drums: null,
    diff_keys: null,
    diff_vocals: null,
    ...over
  }) as ChartData

const progress = (status: JobProgress['status'], percent: number): JobProgress => ({
  jobId: 'scan',
  kind: 'scan',
  phase: status === 'running' ? 'scanning' : status,
  percent,
  message: null,
  status
})

type Props = { onNavigate?: (id: string) => void; onSelectChart?: (target: unknown) => void }

function renderHome(api: Record<string, unknown> = {}, props: Props = {}): void {
  vi.stubGlobal('encore', {
    catalogQuery: () => Promise.resolve([]),
    catalogCount: () => Promise.resolve(0),
    platform: 'linux',
    ...api
  })
  render(Home, { onNavigate: () => {}, onSelectChart: () => {}, ...props })
}

/** A library with a folder configured and `total` charts in it, from one helper. */
function stocked(rows: ChartRecord[], total = rows.length, needWork = 0): Record<string, unknown> {
  settings.set({ ...defaultSettings(), libraryFolders: [{ path: '/songs', isDefault: true }] })
  return {
    catalogQuery: () => Promise.resolve(rows),
    catalogCount: (filter: { missing?: string[] }) =>
      Promise.resolve(filter.missing ? needWork : total)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  scanProgress.set(null)
  settings.set(defaultSettings())
  latest.set({ charts: [], loading: false, error: null, total: null })
})

/**
 * Home is where the first-run user lands: Welcome saves the folder, starts the scan and closes
 * itself immediately (catalog:scan resolves once the scan has STARTED, not once it is finished),
 * so this view is the one on screen for the whole scan. A cancel that only existed on the
 * Installed tab would be a control the user who most needs it has to go looking for.
 */
describe('Home: cancelling a scan', () => {
  it('offers no cancel until a scan is actually running', async () => {
    // A folder configured, because the scan controls are only offered where a scan can run:
    // with no folder the hero's button points at Settings instead.
    renderHome(stocked([], 0))
    await screen.findByText('Scan library')
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull()
  })

  it('asks main to stop the scan when the cancel is pressed', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    renderHome({ ...stocked([], 0), catalogScanCancel: cancel })
    scanProgress.set(progress('running', 40))

    await fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('refreshes the library row after a cancel, because the rows it wrote were kept', async () => {
    let rows: ChartRecord[] = []
    const query = vi.fn(() => Promise.resolve(rows))
    renderHome({ ...stocked([], 0), catalogQuery: query })
    await waitFor(() => expect(query).toHaveBeenCalled())

    rows = [chart('/library/Rush - YYZ', 'YYZ')]
    scanProgress.set(progress('canceled', 42))

    expect(await screen.findByText('YYZ')).toBeTruthy()
  })
})

/**
 * The hero is the state of the library rather than a wordmark, so what it says has to come from
 * the catalog and not from the handful of rows on screen.
 */
describe('Home: the hero', () => {
  it('counts the whole library, not the rows it happens to be showing', async () => {
    renderHome(stocked([chart('/l/a', 'A')], 207))

    // The row is one chart; the hero says 207, which is what `catalogCount` answered with no
    // filter on it. A hero that counted the rows would say 1 on every library.
    expect(await screen.findByText('207')).toBeTruthy()
    expect(screen.getByText('charts')).toBeTruthy()
  })

  it('says the singular for a library of one', async () => {
    renderHome(stocked([chart('/l/a', 'A')], 1))
    expect(await screen.findByText('chart')).toBeTruthy()
  })

  it('offers the charts still missing something as a way into Asset Studio', async () => {
    const onNavigate = vi.fn()
    renderHome(stocked([chart('/l/a', 'A')], 207, 12), { onNavigate })

    const link = await screen.findByRole('button', { name: /12 missing art, video or lyrics/i })
    await fireEvent.click(link)
    expect(onNavigate).toHaveBeenCalledWith('assets')
  })

  it('asks for the missing-asset count the way Asset Studio asks for it', async () => {
    const count = vi.fn().mockResolvedValue(0)
    renderHome({ ...stocked([], 0), catalogCount: count })

    // 'any', not 'all': a chart missing only its lyrics is a chart with something left to do.
    await waitFor(() =>
      expect(count).toHaveBeenCalledWith({
        missing: ['albumArt', 'background', 'video', 'lyrics'],
        missingMode: 'any'
      })
    )
  })

  it('says so plainly when there is nothing left to add', async () => {
    renderHome(stocked([chart('/l/a', 'A')], 207, 0))
    expect(await screen.findByText(/every chart has its art/i)).toBeTruthy()
  })

  it('shows the community catalog as the size of what Explore searches', async () => {
    latest.set({ charts: [], loading: false, error: null, total: 95_214 })
    const onNavigate = vi.fn()
    renderHome(stocked([], 0), { onNavigate })

    await fireEvent.click(await screen.findByRole('button', { name: /95,214 on Chorus Encore/ }))
    expect(onNavigate).toHaveBeenCalledWith('browse')
  })

  it('omits the community figure rather than guessing one when the API did not say', async () => {
    renderHome(stocked([], 0))
    await screen.findByText('Nothing scanned yet')
    expect(screen.queryByText(/on Chorus Encore/)).toBeNull()
  })

  it('claims nothing about the library until the count has answered', async () => {
    settings.set({ ...defaultSettings(), libraryFolders: [{ path: '/songs', isDefault: true }] })
    renderHome({
      catalogQuery: () => new Promise(() => {}),
      catalogCount: () => new Promise(() => {})
    })

    // App recreates Home on every navigation back to it, so this state is entered on every
    // visit. A hero that read an unanswered count as zero would say "nothing scanned yet" across
    // the top of a 207-chart library for as long as SQLite took, on every one of them.
    await screen.findByText('YOUR LIBRARY')
    expect(screen.queryByText('Nothing scanned yet')).toBeNull()
    // The figure's unit, which is the only element whose whole text is that one word.
    expect(screen.queryByText('charts')).toBeNull()
    // The button is decided on the folder list, which App has already loaded, so it does not
    // change under the pointer a moment later.
    expect(screen.getByRole('button', { name: 'Scan library' })).toBeTruthy()
  })

  it('reports a running scan in the hero, where the figures it is changing are', async () => {
    renderHome(stocked([], 0))
    scanProgress.set(progress('running', 40))
    await waitFor(() => expect(screen.getByText(/scanning,/i)).toBeTruthy())
    expect(screen.getByText('40')).toBeTruthy()
  })
})

/**
 * The empty library, which is what a new user sees first and the one state that must not read as
 * a failure. Each case names where it is in the setup, and the button beside it is the next step.
 */
describe('Home: a library with nothing in it', () => {
  it('reads as a step not taken yet when no folder is configured', async () => {
    const onNavigate = vi.fn()
    renderHome({}, { onNavigate })

    expect(await screen.findByText('No folder yet')).toBeTruthy()
    // Scanning cannot help before a folder exists, so the button leads to the one thing that can.
    await fireEvent.click(screen.getByRole('button', { name: 'Add your folder' }))
    expect(onNavigate).toHaveBeenCalledWith('settings')
    expect(screen.queryByRole('button', { name: 'Scan library' })).toBeNull()
  })

  it('offers the scan once a folder is configured and nothing has been read yet', async () => {
    renderHome(stocked([], 0))
    expect(await screen.findByText('Nothing scanned yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Scan library' })).toBeTruthy()
  })

  it('says the scan came back empty, rather than repeating "nothing scanned yet"', async () => {
    renderHome(stocked([], 0))
    await screen.findByText('Nothing scanned yet')

    scanProgress.set(progress('done', 100))

    // The one case where the folder itself can be named as the problem; see libraryGap.
    expect(await screen.findByText('No charts found')).toBeTruthy()
  })

  it("keeps the row's own explanation, which is what names the folder and the scan", async () => {
    renderHome()
    // The hero is four words and a button; the sentence that says where both live stays in the
    // row it is about.
    expect(await screen.findByText(/add your clone hero songs folder in settings/i)).toBeTruthy()
  })

  it('claims no missing-asset figure for a library with no charts in it', async () => {
    renderHome(stocked([], 0, 0))
    await screen.findByText('Nothing scanned yet')
    // "Every chart has its art" is true of a library of nothing and useless; it is a claim about
    // charts, and there are none.
    expect(screen.queryByText(/every chart has its art/i)).toBeNull()
  })
})

/**
 * Where a row click goes. Home's rows land where Explore's do: the caller is handed the chart and
 * decides between the rail and the chart page, which is the decision App takes with `railOnScreen`
 * and is tested end to end there.
 */
describe('Home: a row hands its chart over rather than navigating', () => {
  it('hands over a chart from the latest row as a remote target', async () => {
    latest.set({ charts: [remote()], loading: false, error: null, total: 1 })
    const onSelectChart = vi.fn()
    const onNavigate = vi.fn()
    renderHome(stocked([], 0), { onSelectChart, onNavigate })

    await fireEvent.click(await screen.findByRole('button', { name: /^Everlong/ }))

    expect(onSelectChart).toHaveBeenCalledWith({
      kind: 'remote',
      chart: expect.objectContaining({ name: 'Everlong' })
    })
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('hands over a chart from the library row as a local target', async () => {
    const record = chart('/library/Rush - YYZ', 'YYZ')
    const onSelectChart = vi.fn()
    renderHome(stocked([record], 1), { onSelectChart })

    await fireEvent.click(await screen.findByRole('button', { name: /^YYZ/ }))

    expect(onSelectChart).toHaveBeenCalledWith({ kind: 'local', record })
  })

  it('names the row for the chart, not for the word on the button', async () => {
    latest.set({ charts: [remote()], loading: false, error: null, total: 1 })
    renderHome(stocked([], 0))

    // Every alternate version of a song repeats its title, so the charter is what tells them
    // apart, and the name a screen reader reads has to carry it.
    expect(
      await screen.findByRole('button', {
        name: 'Everlong Foo Fighters · The Colour and the Shape · 1997, charted by CharterA'
      })
    ).toBeTruthy()
  })

  it('shows at most six charts a row, and See all is the way to the rest', async () => {
    latest.set({
      charts: Array.from({ length: 10 }, (_, i) => remote({ chartId: i, name: `Chart ${i}` })),
      loading: false,
      error: null,
      total: 10
    })
    const onNavigate = vi.fn()
    renderHome(stocked([], 0), { onNavigate })

    expect(await screen.findByText('Chart 5')).toBeTruthy()
    expect(screen.queryByText('Chart 6')).toBeNull()

    await fireEvent.click(screen.getAllByRole('button', { name: 'See all' })[0])
    expect(onNavigate).toHaveBeenCalledWith('browse')
  })

  it('asks the catalog for only the rows it draws', async () => {
    const query = vi.fn().mockResolvedValue([])
    renderHome({ ...stocked([], 0), catalogQuery: query })
    await waitFor(() => expect(query).toHaveBeenCalledWith({ search: '', offset: 0, limit: 6 }))
  })
})

/**
 * The play data moved to its own tab. What is left to check here is that Home does not reach
 * for it any more: the panel owned a bridge subscription and three calls, and a Home that still
 * made one of them would be spending a read on a block it no longer draws.
 */
describe('Home: no longer the place the play data lives', () => {
  it('draws no play panel, and asks the bridge for nothing about plays', async () => {
    const playStatus = vi.fn()
    const playStats = vi.fn()
    const onPlayRecorded = vi.fn()
    renderHome({
      ...stocked([chart('/library/YYZ', 'YYZ')], 1),
      playStatus,
      playStats,
      onPlayRecorded
    })

    expect(await screen.findByText('YYZ')).toBeTruthy()
    expect(screen.queryByText('YOUR PLAYS')).toBeNull()
    expect(playStatus).not.toHaveBeenCalled()
    expect(playStats).not.toHaveBeenCalled()
    expect(onPlayRecorded).not.toHaveBeenCalled()
  })

  it('opens with the chart rows, which are the first thing under the hero', async () => {
    renderHome()

    const latestHead = await screen.findByText('LATEST CHARTS')
    const library = await screen.findByText('IN YOUR LIBRARY')
    expect(
      latestHead.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})

describe('Home: a name written in Clone Hero markup', () => {
  it('reads the library row as text, and falls back when the name is only tags', async () => {
    // Home is the one view the strip pass could not reach, because the Stats move held this file.
    // Both rows here are real shapes: a charter styles their name and song.ini carries it whole.
    renderHome(stocked([chart('/l/a', EIGHT_TAG_CHARTER), chart('/l/Only Tags', '<b></b>')], 2))
    expect(await screen.findByText(EIGHT_TAG_CHARTER_TEXT)).toBeTruthy()
    // A name that strips to nothing used to render an empty span. The path is what is left to
    // identify the chart by, and it is what every other view falls back to.
    expect(screen.getByText('Only Tags')).toBeTruthy()
    expect(screen.queryByText(/color=#/)).toBeNull()
  })
})

// The health mark on a Chorus row names who found the problem, and the name is an argument rather
// than a constant inside issueTitle, because Installed draws the same mark for problems found on
// this disk. Nothing else in this file reads the mark, so a change to that signature reached the
// compiler and no test.
describe('Home: the mark on a Chorus row says Chorus found it', () => {
  afterEach(() => {
    latest.set({ charts: [], total: null, loading: false, error: null })
  })

  it('names Chorus as the finder', async () => {
    renderHome()
    latest.set({
      charts: [
        remote({
          metadataIssues: [{ metadataIssue: 'missingValue', description: 'no year' }]
        } as Partial<ChartData>)
      ],
      total: 1,
      loading: false,
      error: null
    })
    const mark = await screen.findByTitle(/Chorus found/)
    expect(mark).toBeTruthy()
  })
})

/**
 * The row's difficulty display, which is Explore's.
 *
 * jsdom applies no CSS, so nothing here can see a ring. What it can see is which of the two
 * drawings the component was asked for, and that is the whole of what changed: `.ring` exists
 * only in the icon form and `.letter` only in the other, so the two are exclusive and either
 * one being present names the form. The column still says the same three things about a chart,
 * which the accessible names below are what pin.
 */
describe('Home: the difficulty column', () => {
  const parts = (): string[] =>
    [...document.querySelectorAll('.row .diffs .part')].map((part) =>
      (part.getAttribute('aria-label') ?? '').trim()
    )

  it('draws each part as a glyph in a ring rather than as a letter', async () => {
    latest.set({ charts: [remote()], loading: false, error: null, total: 1 })
    renderHome(stocked([], 0))
    await screen.findByText('Everlong')

    expect(document.querySelectorAll('.row .diffs .part')).toHaveLength(3)
    expect(document.querySelectorAll('.row .diffs .ring')).toHaveLength(3)
    expect(document.querySelectorAll('.row .diffs .letter')).toHaveLength(0)
    // A ring with no path is a ring with no instrument in it.
    for (const ring of document.querySelectorAll('.row .diffs .ring')) {
      expect(ring.querySelector('svg path')?.getAttribute('d')).toBeTruthy()
    }
  })

  /**
   * What the column says, which the change to how it is drawn must not have touched. The three
   * states are the component's, and a row is where they are actually reached from: `diff_guitar`
   * rated, `diff_bass` absent from a chart that has no bass track, and a drum track the charter
   * never rated.
   */
  it("still tells the three states apart, in Explore's order", async () => {
    latest.set({
      charts: [
        remote({
          diff_guitar: 4,
          diff_bass: null,
          diff_drums: null,
          notesData: { instruments: ['guitar', 'drums'] }
        } as Partial<ChartData>)
      ],
      loading: false,
      error: null,
      total: 1
    })
    renderHome(stocked([], 0))
    await screen.findByText('Everlong')

    expect(parts()).toEqual([
      'Guitar: difficulty 4 of 6',
      'Bass: not charted',
      'Drums: charted, no difficulty rating'
    ])
  })
})

/**
 * The row's shape, which is now Explore's shape: a cover, the song with a band of chips under
 * its subtitle, the difficulty and a mark. The charter and the length used to be tracks at the
 * far end of the row and are chips in that band, and the whole of what the change bought is that
 * the two tracks went. jsdom applies no CSS, so none of this is about how it looks; what is
 * pinned is where each fact lives in the row, which is what would drift back.
 */
describe('Home: the row', () => {
  /** A record carrying the two fields the band draws, which `chart` leaves out. */
  const sung = (path: string, name: string): ChartRecord =>
    ChartRecordSchema.parse({
      path,
      name,
      chartType: 'folder',
      folderHash: path,
      modifiedTime: 0,
      charter: 'CharterA',
      songLength: 250_000
    })

  const rowOf = (name: string): HTMLElement => {
    const row = screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('.row')
    if (row === null) throw new Error(`no row around ${name}`)
    return row as HTMLElement
  }

  /**
   * The `.row` rule's declared track count, read out of the component source, the way
   * Library.svelte.test.ts reads its own. jsdom applies no CSS, so `getComputedStyle` cannot
   * answer this and a constant written here would only restate one half of the pair. A child
   * added to the markup without a track added to the grid falls silently onto a second line.
   */
  function declaredRowTracks(): number {
    const source = readFileSync(join(__dirname, 'Home.svelte'), 'utf8')
    const rule = /^\s*\.row\s*\{([^}]*)\}/m.exec(source)
    if (!rule) throw new Error('no `.row {…}` rule in Home.svelte')
    const declaration = /grid-template-columns:\s*([^;]+);/.exec(rule[1])
    if (!declaration) throw new Error('`.row` declares no grid-template-columns')
    const collapsed = declaration[1]
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/minmax\([^()]*\)/g, 'm')
    if (/[(),]/.test(collapsed)) throw new Error(`cannot count tracks in \`${collapsed}\``)
    return collapsed.split(' ').length
  }

  it('gives a row exactly as many element children as .row declares grid tracks', async () => {
    renderHome(stocked([chart('/library/Rush - YYZ', 'YYZ')], 1))
    await screen.findByText('YYZ')
    expect(rowOf('YYZ').children).toHaveLength(declaredRowTracks())
  })

  it('carries the charter and the length as chips in the band, not as tracks', async () => {
    renderHome(stocked([sung('/library/Rush - YYZ', 'YYZ')], 1))
    await screen.findByText('YYZ')

    const band = rowOf('YYZ').querySelector('.song .badges')
    if (band === null) throw new Error('no band under the subtitle')
    // The band's own children, not a sweep of the row: a charter drawn anywhere else in the row
    // is exactly the arrangement this replaced, and a sweep would pass on it.
    // Svelte's own scoping class is dropped: it changes whenever the stylesheet does, and this
    // is about which chips the band holds and in what order.
    expect(
      [...band.children].map((el) =>
        el.className
          .split(' ')
          .filter((name) => !name.startsWith('svelte-'))
          .join(' ')
      )
    ).toEqual(['badge mono length', 'badge mono charter'])
  })

  it('draws no length chip for a chart whose song.ini never said', async () => {
    // `msToTime` answers with a dash, and a bordered box around a dash is a box saying nothing.
    renderHome(stocked([chart('/library/Rush - YYZ', 'YYZ')], 1))
    await screen.findByText('YYZ')
    expect(rowOf('YYZ').querySelector('.badges .length')).toBeNull()

    latest.set({
      charts: [remote({ song_length: 250_000 })],
      loading: false,
      error: null,
      total: 1
    })
    await screen.findByText('Everlong')
    expect(rowOf('Everlong').querySelector('.badges .length')?.textContent).toBe('4:10')
  })
})

/**
 * One row, drawn three times.
 *
 * Explore, Installed and Home are three files with three copies of the same row rule, and the
 * thing that goes wrong is one of them being edited and the other two not: the covers were 52px,
 * 40px and 40px for exactly that reason. jsdom applies no CSS and there is no shared stylesheet
 * to read, so the source is the only place a test can see this at all. It says nothing about how
 * any of it looks; it says the three numbers are still one number.
 */
describe('the three lists draw one row', () => {
  const FILES = ['Browse.svelte', 'Library.svelte', 'Home.svelte']
  const source = (file: string): string => readFileSync(join(__dirname, file), 'utf8')

  /** The row's cover rule, by the name each file gives it. Library calls its square a thumb. */
  const COVERS: [string, string][] = [
    ['Browse.svelte', '\\.cover'],
    ['Library.svelte', '\\.thumb'],
    ['Home.svelte', '\\.cover']
  ]
  const declaration = (text: string, rule: string, prop: string): string => {
    const found = new RegExp(`\\n {2}${rule} \\{([^}]*)\\}`).exec(text)
    if (!found) throw new Error(`no \`${rule}\` rule`)
    const value = new RegExp(`${prop}:\\s*([^;]+);`).exec(found[1])
    if (!value) throw new Error(`\`${rule}\` declares no ${prop}`)
    return value[1].trim()
  }

  it('draws the cover at one size, and off the radius scale rather than a number', () => {
    const sizes = COVERS.map(([file, rule]) => declaration(source(file), rule, 'width'))
    expect(new Set(sizes)).toEqual(new Set(['52px']))
    for (const [file, rule] of COVERS) {
      // A literal here is a fourth corner radius nobody chose; --radius-sm is the step the rest
      // of the app rounds small boxes to. The grid card's art is not this square and is not
      // covered: it is 148px of cover art rather than a 52px mark in a list row.
      expect(declaration(source(file), rule, 'border-radius'), file).toBe('var(--radius-sm)')
    }
  })

  it('gives the band under the subtitle the same box in every row', () => {
    for (const file of FILES) {
      const rule = /\n {2}\.badges \{([^}]*)\}/.exec(source(file))
      if (!rule) throw new Error(`no \`.badges\` rule in ${file}`)
      // nowrap is the claim: a band that wraps on the rows carrying a long charter and not on
      // the rest is a list of two row heights, which is the thing the eye stumbles down.
      expect(rule[1], `${file} lets its band wrap`).toMatch(/flex-wrap:\s*nowrap/)
      expect(rule[1], `${file} sets its band a different gap`).toMatch(/gap:\s*6px/)
      expect(rule[1], `${file} sets its band a different offset`).toMatch(/margin-top:\s*5px/)
    }
  })
})
