import { render, screen, within, waitFor } from '@testing-library/svelte'
import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChartRecordSchema, type ChartRecord } from '../../../../shared/schemas'
import type { ChartVerdict } from '../../../../shared/updates'
import { verdicts } from '../stores/updates'
import { globalQuery } from '../stores/global-search'
import { browseSearch } from '../stores/search'
import { advancedBody, emptyAdvanced, type AdvancedQuery } from '../api/advanced'
import type { ChartData, NoteCount, SearchResult } from '../api/enchor'
import type { ChartTarget } from './Home.svelte'

// Clicking a tag chip runs a real search through the module-scoped `browseSearch`, which was
// constructed with the real `fetch` at import time. Mocking the API module is the seam that
// works after that; the same one Browse's tests use. Partial, because Detail also reads
// `albumArtUrl` and `INSTRUMENTS` from here.
const searchCharts = vi.fn<(...args: unknown[]) => Promise<SearchResult>>()
vi.mock('../api/enchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/enchor')>()),
  searchCharts: (...args: unknown[]) => searchCharts(...args)
}))

import Detail from './Detail.svelte'

// U+2014. What Detail renders for "we do not know", in both the stat cards and the ABOUT rows.
const EM_DASH = '—'

/**
 * Local fixtures go through the real schema so every field Detail reads is the field the catalog
 * would actually hand it. A renamed or re-typed column breaks these tests rather than letting a
 * hand-written literal drift away from the row shape in the database.
 */
function localRecord(overrides: Partial<ChartRecord> & { path: string }): ChartRecord {
  return ChartRecordSchema.parse({
    chartType: 'folder',
    folderHash: overrides.path,
    modifiedTime: 0,
    songLength: 273_000,
    ...overrides
  })
}

/**
 * The remote half of the same chart. `ChartData` is a hand-written interface over the Encore
 * API's JSON rather than a schema, so this is a plain literal; the type still fails the build if
 * the API shape the component reads moves.
 */
function remoteChart(overrides: Partial<ChartData> = {}): ChartData {
  return {
    chartId: 1,
    songId: null,
    md5: 'd'.repeat(32),
    albumArtMd5: null,
    hasVideoBackground: false,
    name: 'YYZ',
    artist: 'Rush',
    album: 'Moving Pictures',
    genre: 'Prog',
    year: '1981',
    charter: 'Chartist',
    song_length: 273_000,
    diff_guitar: 4,
    diff_bass: 3,
    diff_drums: 5,
    diff_keys: null,
    diff_vocals: null,
    ...overrides
  }
}

/** Two instruments, four charted difficulties between them: the same array either source stores. */
const NOTE_COUNTS: NoteCount[] = [
  { instrument: 'guitar', difficulty: 'hard', count: 902 },
  { instrument: 'guitar', difficulty: 'expert', count: 1408 },
  { instrument: 'bass', difficulty: 'expert', count: 800 }
]

/**
 * `encore()` reads `window.encore`, and under jsdom `globalThis` *is* `window`, so
 * `vi.stubGlobal('encore', …)` puts the fake exactly where the bridge looks for it.
 *
 * Only `existsByMeta` is stubbed: it is the one call Detail's mount effect makes, and only on the
 * remote branch. The local branch never touches the bridge, so it is stubbed there too purely so
 * a future call from that branch fails loudly rather than on `undefined`.
 *
 * The props go under `props` rather than at the top level: Detail's own prop is called `target`,
 * which is also one of testing-library's render options, and a flat spread is rejected outright.
 */
function renderDetail(target: ChartTarget): void {
  vi.stubGlobal('encore', {
    existsByMeta: (): Promise<boolean[]> => Promise.resolve([false])
  })
  render(Detail, { props: { target, onBack: () => {}, onNavigate: () => {} } })
}

const EMPTY_PAGE: SearchResult = { found: 0, out_of: 0, page: 1, data: [] }

afterEach(async () => {
  vi.unstubAllGlobals()
  // The verdict map is module-level so Detail and Installed read one thing; a test that seeds it
  // must not leak that seed into the next.
  verdicts.set(new Map())
  // `browseSearch` and `globalQuery` are module-scoped too, and a chip clicked in one test leaves
  // a filter applied, a panel open and a term cleared for the next.
  searchCharts.mockResolvedValue(EMPTY_PAGE)
  browseSearch.clearAdvanced()
  browseSearch.setAdvancedOpen(false)
  globalQuery.set('')
  // `clearAdvanced` may have started a run; let it settle before the mock is reset under it.
  await new Promise((r) => setTimeout(r, 0))
  searchCharts.mockReset()
})

const DIFF_KEYS = ['E', 'M', 'H', 'X'] as const

/**
 * The difficulty matrix as one readable string per instrument, e.g. `Guitar ··HX`.
 *
 * The charted state renders as an SVG check and the uncharted one as an empty `<span>`, so the
 * cell's accessible name is the only version of it a test can read (jsdom draws nothing). Reading
 * every row and every cell means an instrument or a difficulty that renders when it should not
 * fails the comparison, instead of slipping past an assertion on one cell.
 */
function matrixRows(): string[] {
  const table = screen.getByRole('table')
  return within(table)
    .getAllByRole('row')
    .slice(1) // the E/M/H/X column headers
    .map((row) => {
      const label = within(row).getByRole('rowheader').textContent?.trim()
      const cells = within(row)
        .getAllByRole('cell')
        .map((cell, i) =>
          cell.getAttribute('aria-label')?.endsWith(': charted') ? DIFF_KEYS[i] : '·'
        )
      return `${label} ${cells.join('')}`
    })
}

/**
 * The value rendered beside a label, for both the stat cards (`<span>`/`<span>`) and the ABOUT
 * list (`<dt>`/`<dd>`). In each the value is the label's next element sibling.
 *
 * Only safe for labels that appear once: LENGTH and YEAR are both a stat and an ABOUT row, so
 * this would match whichever came first. NOTES, INSTRUMENTS and VOCALS are unique.
 */
function valueBeside(label: string): string {
  const value = screen.getByText(label).nextElementSibling
  if (!value) throw new Error(`nothing rendered beside the "${label}" label`)
  return value.textContent?.trim() ?? ''
}

const SCAN_HINT = /Run Scan library to read them/i

describe('Detail: local and remote render the same matrix from their own source', () => {
  // The two sources have repeatedly diverged. The catalog stores noteCounts under the API's own
  // field names precisely so one helper can serve both, and these two cases are the check that it
  // still does: same counts in, same matrix out, whichever side they arrived from.
  it("builds the matrix from a local record's stored note counts", async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({ path: '/library/Rush - YYZ', name: 'YYZ', noteCounts: NOTE_COUNTS })
    })

    expect(await screen.findByRole('table')).toBeTruthy()
    expect(matrixRows()).toEqual(['Guitar ··HX', 'Bass ···X'])
  })

  it("builds the matrix from a remote chart's notesData", async () => {
    renderDetail({
      kind: 'remote',
      chart: remoteChart({ notesData: { noteCounts: NOTE_COUNTS } })
    })

    expect(await screen.findByRole('table')).toBeTruthy()
    expect(matrixRows()).toEqual(['Guitar ··HX', 'Bass ···X'])
  })
})

describe('Detail: the "run a library scan" hint', () => {
  // A catalog row written before the note-count columns existed carries an empty noteCounts until
  // the user rescans. Telling them so is the only way they learn the matrix is empty for a fixable
  // reason rather than because the chart is empty.
  it('tells the user to scan when a local chart has no note data', async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({ path: '/library/Rush - Limelight', name: 'Limelight', noteCounts: [] })
    })

    expect(await screen.findByText(SCAN_HINT)).toBeTruthy()
  })

  // The same emptiness on the remote side means the API has not processed the chart. Scanning the
  // library would not change it by one byte, so the instruction is not merely unhelpful there;
  // it is false. The remote branch gets DiffMatrix's own neutral empty state instead.
  it('does not tell the user to scan when a remote chart has no note data', async () => {
    renderDetail({ kind: 'remote', chart: remoteChart({ notesData: null }) })

    expect(await screen.findByText(/NO CHART DATA/i)).toBeTruthy()
    expect(screen.queryByText(SCAN_HINT)).toBeNull()
  })
})

describe('Detail: the INSTRUMENTS stat', () => {
  it('counts the instruments that carry notes', async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({ path: '/library/Rush - YYZ', name: 'YYZ', noteCounts: NOTE_COUNTS })
    })

    expect(await screen.findByRole('table')).toBeTruthy()
    expect(valueBeside('INSTRUMENTS')).toBe('2')
  })

  /**
   * The stat used to be `String(matrixRows.length)`, which renders a literal `0` for a chart whose
   * notes were never read: a wrong number asserted about a chart that plainly has four
   * instruments, sitting in a card of its own where it reads as a measurement. The NOTES stat
   * beside it already dashed out in the same situation, so the pair contradicted each other.
   */
  it('dashes out, like NOTES, for a local chart whose notes were never read', async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({ path: '/library/Rush - Limelight', name: 'Limelight', noteCounts: [] })
    })

    expect(await screen.findByText(SCAN_HINT)).toBeTruthy()
    expect(valueBeside('INSTRUMENTS')).toBe(EM_DASH)
    expect(valueBeside('NOTES')).toBe(EM_DASH)
  })

  // Not a local-only hole: notesData is optional on ChartData and the API omits it for a chart it
  // has not processed, so gating the dash on `record` would have left the remote side lying.
  it('dashes out for a remote chart the API has not processed', async () => {
    renderDetail({ kind: 'remote', chart: remoteChart({ notesData: null }) })

    expect(await screen.findByText(/NO CHART DATA/i)).toBeTruthy()
    expect(valueBeside('INSTRUMENTS')).toBe(EM_DASH)
    expect(valueBeside('NOTES')).toBe(EM_DASH)
  })

  /**
   * The other half of the fix, and the reason the discriminator is the noteCounts array rather
   * than the matrix row count: a populated array that yields no rows is a measured zero. "We
   * looked and found nothing" is a true statement and must survive as a number; only "we never
   * looked" becomes a dash. Reading matrixRows.length collapses the two.
   */
  it('still reports a measured zero when the notes were read and no instrument carried any', async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({
        path: '/library/Broken Chart',
        name: 'Broken Chart',
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 0 }]
      })
    })

    expect(await screen.findByText('Broken Chart')).toBeTruthy()
    expect(valueBeside('INSTRUMENTS')).toBe('0')
  })
})

describe('Detail: the vocals row', () => {
  // Vocals cannot join the E/M/H/X matrix: scan-chart's instrument union excludes it, so
  // noteCounts never carries it and any matrix row for it would be invented. It is a metadata row
  // instead, where the row's PRESENCE carries "this chart has a vocal track" and the value only
  // reports the rating.
  it('shows the rating when the charter set one', async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({
        path: '/library/Rush - YYZ',
        name: 'YYZ',
        hasVocals: true,
        diffVocals: 4
      })
    })

    expect(await screen.findByText('VOCALS')).toBeTruthy()
    expect(valueBeside('VOCALS')).toBe('4')
  })

  it('dashes when the chart has vocals the charter never rated', async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({
        path: '/library/Rush - YYZ',
        name: 'YYZ',
        hasVocals: true,
        diffVocals: null
      })
    })

    expect(await screen.findByText('VOCALS')).toBeTruthy()
    expect(valueBeside('VOCALS')).toBe(EM_DASH)
  })

  // Absent, not dashed. A dash here would claim the chart has a vocal track nobody rated.
  it('omits the row entirely when the chart has no vocals', async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({
        path: '/library/Rush - YYZ',
        name: 'YYZ',
        hasVocals: false,
        diffVocals: null
      })
    })

    expect(await screen.findByText('YYZ')).toBeTruthy()
    expect(screen.queryByText('VOCALS')).toBeNull()
  })

  // Rows scanned before hasVocals was stored still carry a rating, and that rating is evidence of
  // a vocal track. Keying the row on hasVocals alone would hide it on every such row.
  it('shows the row for a pre-hasVocals row that still carries a rating', async () => {
    renderDetail({
      kind: 'local',
      record: localRecord({
        path: '/library/Rush - YYZ',
        name: 'YYZ',
        hasVocals: false,
        diffVocals: 3
      })
    })

    expect(await screen.findByText('VOCALS')).toBeTruthy()
    expect(valueBeside('VOCALS')).toBe('3')
  })
})

/**
 * The Chorus version check on a local chart.
 *
 * Every assertion here is on text and on whether the bridge was called. Nothing checks placement
 * or styling: jsdom applies no CSS and computes no layout, so how this card actually looks beside
 * the difficulty matrix is desktop QA, not something this file can speak to.
 */
describe('Detail: Chorus version check', () => {
  const record = localRecord({
    path: '/library/Rush - YYZ',
    name: 'YYZ',
    artist: 'Rush',
    charter: 'Chartist',
    chartHash: 'LOCAL',
    tempoMapHash: 'TEMPO',
    noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 1408 }]
  })

  function renderWithBridge(updatesCheck: () => Promise<unknown>): void {
    vi.stubGlobal('encore', {
      existsByMeta: (): Promise<boolean[]> => Promise.resolve([false]),
      updatesCheck
    })
    render(Detail, {
      props: { target: { kind: 'local', record }, onBack: () => {}, onNavigate: () => {} }
    })
  }

  const alternateVerdict = {
    kind: 'alternate',
    local: { path: record.path },
    alternates: [
      {
        chartId: 634733,
        noteCount: 12374,
        modifiedTime: '2026-05-16T18:34:48.885Z',
        md5: 'a'.repeat(32)
      }
    ]
  } as unknown as ChartVerdict
  const alternate = { verdicts: [alternateVerdict] }

  /**
   * The single most important behaviour here. One check is one request against a 50-per-minute
   * budget, so opening a chart must not spend one. The brief's "cheap and not automatic-by-
   * surprise" is enforced right here.
   */
  it('does not contact Chorus until the user asks', async () => {
    const updatesCheck = vi.fn().mockResolvedValue({ verdicts: [] })
    renderWithBridge(updatesCheck)
    expect(await screen.findByText('Check')).toBeTruthy()
    expect(updatesCheck).not.toHaveBeenCalled()
  })

  it('checks only the chart on screen, not the library', async () => {
    const updatesCheck = vi.fn().mockResolvedValue({ verdicts: [] })
    renderWithBridge(updatesCheck)
    ;(await screen.findByText('Check')).click()
    expect(updatesCheck).toHaveBeenCalledWith(['/library/Rush - YYZ'])
  })

  it('reports an exact match as nothing to do', async () => {
    renderWithBridge(() =>
      Promise.resolve({ verdicts: [{ kind: 'current', local: { path: record.path } }] })
    )
    ;(await screen.findByText('Check')).click()
    expect(await screen.findByText(/Nothing to update/)).toBeTruthy()
  })

  /**
   * "different", never "newer". Chorus exposes no field that orders two uploads of one chart, so
   * the wording is the finding, not a cosmetic choice, and asserting on it keeps a later edit from
   * quietly upgrading the claim past the evidence.
   */
  it('offers an alternate as a different version, not a newer one', async () => {
    renderWithBridge(() => Promise.resolve(alternate))
    ;(await screen.findByText('Check')).click()
    const note = await screen.findByText(/different version of this chart/)
    expect(note.textContent).not.toMatch(/newer|out of date|outdated/i)
  })

  it('shows the alternate note count and date to judge it by', async () => {
    renderWithBridge(() => Promise.resolve(alternate))
    ;(await screen.findByText('Check')).click()
    expect(await screen.findByText('12374 notes')).toBeTruthy()
    expect(screen.getByText('2026-05-16')).toBeTruthy()
  })

  it('promises the existing chart and its added assets are left alone', async () => {
    renderWithBridge(() => Promise.resolve(alternate))
    ;(await screen.findByText('Check')).click()
    expect(await screen.findByText(/left untouched/)).toBeTruthy()
  })

  it('explains an unknown chart without implying anything is wrong with it', async () => {
    renderWithBridge(() =>
      Promise.resolve({ verdicts: [{ kind: 'unknown', local: { path: record.path } }] })
    )
    ;(await screen.findByText('Check')).click()
    expect(await screen.findByText(/private chart, or\s+renamed/)).toBeTruthy()
  })

  it('surfaces a failed check instead of reporting the chart current', async () => {
    renderWithBridge(() => Promise.reject(new Error('Chorus Encore is rate-limiting')))
    ;(await screen.findByText('Check')).click()
    expect(await screen.findByText(/rate-limiting/)).toBeTruthy()
    expect(screen.queryByText(/Nothing to update/)).toBeNull()
  })

  /**
   * Main keeps every verdict of the session and stores/updates.ts mirrors that map, so a chart
   * the Installed list already badges has an answer before Detail opens. Showing it costs no
   * request; showing "Check" instead would make the badge's "Open it to compare" a promise Detail
   * does not keep. The control stays, because a cached verdict describes a remote index that
   * moves and the user may want a fresh answer.
   */
  it('seeds the card from a verdict the session already holds, without a check', async () => {
    const updatesCheck = vi.fn().mockResolvedValue(alternate)
    verdicts.set(new Map([[record.path, alternateVerdict]]))
    renderWithBridge(updatesCheck)

    // "by the same charter" is the alternate branch's phrase; the idle copy also says "different
    // version of this chart", so a looser match would pass on the wrong state.
    expect(
      await screen.findByText(/different version of this chart by the same charter/)
    ).toBeTruthy()
    expect(screen.getByText('12374 notes')).toBeTruthy()
    expect(screen.getByText('Check')).toBeTruthy()
    expect(updatesCheck).not.toHaveBeenCalled()
  })

  it('seeds a current verdict the same way', async () => {
    const updatesCheck = vi.fn().mockResolvedValue({ verdicts: [] })
    verdicts.set(new Map([[record.path, { kind: 'current', local: alternateVerdict.local }]]))
    renderWithBridge(updatesCheck)

    expect(await screen.findByText(/Nothing to update/)).toBeTruthy()
    expect(updatesCheck).not.toHaveBeenCalled()
  })

  it('stays idle when the session holds a verdict only for some other chart', async () => {
    const updatesCheck = vi.fn().mockResolvedValue({ verdicts: [] })
    verdicts.set(
      new Map([['/library/Somebody Else', { kind: 'current', local: alternateVerdict.local }]])
    )
    renderWithBridge(updatesCheck)

    expect(await screen.findByText(/Asks Chorus Encore whether/)).toBeTruthy()
    expect(screen.queryByText(/Nothing to update/)).toBeNull()
    expect(updatesCheck).not.toHaveBeenCalled()
  })

  /**
   * The verdict goes to the shared map, not a local copy: Installed reads that map for its badge
   * on the way back, before its own replay lands, so the user sees what they just watched happen.
   */
  it('shares a verdict it produced with the store, so Installed can badge it', async () => {
    renderWithBridge(() => Promise.resolve(alternate))
    ;(await screen.findByText('Check')).click()
    await screen.findByText(/different version of this chart by the same charter/)

    expect(get(verdicts).get(record.path)?.kind).toBe('alternate')
  })

  it('re-runs the check on demand even when a cached verdict is on screen', async () => {
    const updatesCheck = vi
      .fn()
      .mockResolvedValue({ verdicts: [{ kind: 'current', local: alternateVerdict.local }] })
    verdicts.set(new Map([[record.path, alternateVerdict]]))
    renderWithBridge(updatesCheck)
    await screen.findByText(/different version of this chart by the same charter/)

    screen.getByText('Check').click()

    expect(await screen.findByText(/Nothing to update/)).toBeTruthy()
    expect(updatesCheck).toHaveBeenCalledWith([record.path])
    expect(get(verdicts).get(record.path)?.kind).toBe('current')
  })
})

/**
 * The metadata chips under the title.
 *
 * These tests pin the wiring: which filter a click applies, what it replaces, what it clears and
 * where it goes. What they cannot pin is anything the user sees, because jsdom applies no CSS and
 * computes no layout. That a chip still looks like a chip once it is a <button> rests on the
 * `.chip.tag` rule restating the font family a button brings of its own, which is reasoning about
 * a declaration rather than a measurement.
 */
describe('Detail: the metadata chips search on their field', () => {
  const TAGGED = remoteChart({
    charter: 'Numbuh681',
    year: '2016',
    album: 'Utopia',
    genre: 'Visual Kei Rock'
  })

  /** The applied advanced query, as the endpoint would be asked for it. */
  const appliedBody = (): Record<string, unknown> => advancedBody(get(browseSearch.advanced))

  function renderTagged(
    onNavigate: (id: string) => void = () => {},
    { inLibrary = false }: { inLibrary?: boolean } = {}
  ): void {
    searchCharts.mockResolvedValue(EMPTY_PAGE)
    vi.stubGlobal('encore', {
      existsByMeta: (): Promise<boolean[]> => Promise.resolve([inLibrary])
    })
    render(Detail, {
      props: {
        target: { kind: 'remote', chart: TAGGED } satisfies ChartTarget,
        onBack: () => {},
        onNavigate
      }
    })
  }

  it('offers one button per tag, named so it says what it does', async () => {
    // "Numbuh681" on its own does not tell a screen reader user that the control searches, and
    // does not say which of the four fields it searches on.
    renderTagged()

    for (const [field, value] of [
      ['charter', 'Numbuh681'],
      ['year', '2016'],
      ['album', 'Utopia'],
      ['genre', 'Visual Kei Rock']
    ]) {
      const button = await screen.findByRole('button', {
        name: `Search charts with ${field} ${value}`
      })
      // The visible text is the value alone; the label is what adds the rest.
      expect(button.textContent?.trim()).toBe(value)
    }
  })

  it('applies exactly one text filter, exact and not excluded', async () => {
    // Exact because the value came out of the catalog verbatim rather than being typed. Measured
    // against the live service: a loose album match on "Utopia" also returns "Dystopia: Road to
    // Utopia", which is not the album the user pointed at.
    renderTagged()

    ;(await screen.findByRole('button', { name: 'Search charts with charter Numbuh681' })).click()

    await waitFor(() =>
      expect(appliedBody()).toEqual({
        charter: { value: 'Numbuh681', exact: true, exclude: false }
      })
    )
    // All three keys, always: the endpoint answers 400 naming the missing path when either flag
    // is left out, so a filter short of one of them is a failed request, not a smaller one.
    const applied = get(browseSearch.advanced) as AdvancedQuery
    expect(Object.keys(applied.text.charter).sort()).toEqual(['exact', 'exclude', 'value'])
  })

  it('sends that filter to the service, and only once', async () => {
    // Explore re-applies the global query when it mounts. Without the query being settled here
    // too, that mount would schedule a second request for the rows this one is already fetching.
    renderTagged()

    ;(await screen.findByRole('button', { name: 'Search charts with album Utopia' })).click()

    await waitFor(() => expect(searchCharts).toHaveBeenCalledTimes(1))
    const params = searchCharts.mock.calls[0][0] as { advanced: AdvancedQuery }
    expect(params.advanced.text.album).toEqual({ value: 'Utopia', exact: true, exclude: false })
    await new Promise((r) => setTimeout(r, 400))
    expect(searchCharts).toHaveBeenCalledTimes(1)
  })

  it('replaces the filters that were already on rather than joining them', async () => {
    // "Search this charter" means charts by that charter, not that charter narrowed by whatever
    // an earlier search left behind.
    const seeded = emptyAdvanced()
    seeded.text.genre = { value: 'Metal', exact: false, exclude: false }
    seeded.flags.modchart = true
    searchCharts.mockResolvedValue(EMPTY_PAGE)
    browseSearch.setAdvancedDraft(seeded)
    browseSearch.applyAdvanced()
    await waitFor(() => expect(Object.keys(appliedBody()).length).toBe(2))

    renderTagged()
    ;(await screen.findByRole('button', { name: 'Search charts with charter Numbuh681' })).click()

    await waitFor(() =>
      expect(appliedBody()).toEqual({
        charter: { value: 'Numbuh681', exact: true, exclude: false }
      })
    )
  })

  it('clears the plain search term, which the advanced endpoint ignores', async () => {
    // A term left in a visible box would be describing results it had no part in.
    globalQuery.set('utopia')
    renderTagged()

    ;(await screen.findByRole('button', { name: 'Search charts with year 2016' })).click()

    expect(get(globalQuery)).toBe('')
  })

  it('opens the panel, so the changed result set has a visible reason', async () => {
    // The closed panel's badge counts to one without saying one of what. Open, it names the
    // field, the value and the Exact tick, and is where the user edits or drops them.
    renderTagged()

    ;(
      await screen.findByRole('button', { name: 'Search charts with genre Visual Kei Rock' })
    ).click()

    await waitFor(() => expect(get(browseSearch.advancedOpen)).toBe(true))
  })

  it('goes to Explore, where the results are', async () => {
    const onNavigate = vi.fn()
    renderTagged(onNavigate)

    ;(await screen.findByRole('button', { name: 'Search charts with album Utopia' })).click()

    expect(onNavigate).toHaveBeenCalledWith('browse')
  })

  it('leaves the IN LIBRARY chip inert, because it is not a search', async () => {
    // It says something about the user's own library. There is no Chorus field to search it on.
    renderTagged(() => {}, { inLibrary: true })

    const chip = await screen.findByText('IN LIBRARY', { selector: 'span.chip' })
    expect(chip.tagName).toBe('SPAN')
    // The chip row holds the four searchable tags and nothing else clickable. Scoped to that row
    // because the actions below it carry a disabled IN LIBRARY button of their own, which is the
    // Download slot rather than a chip.
    const row = chip.parentElement as HTMLElement
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim())
    ).toEqual(['Numbuh681', '2016', 'Utopia', 'Visual Kei Rock'])
  })
})
