import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartIssueRow } from '../../../../main/catalog/issues'
import type { FixBackup } from '../../../../main/issues/backup-store'
import type { FixableCode } from '../../../../main/issues/fix'
import type { JobProgress } from '../../../../shared/schemas'
import { assetJobs } from '../stores/assets'
import Tools from './Tools.svelte'

/**
 * `encore()` reads `window.encore`, and under jsdom `globalThis` *is* `window`, so
 * `vi.stubGlobal('encore', …)` puts the fake exactly where the bridge looks for it.
 * `vi.unstubAllGlobals()` in afterEach removes it again.
 */
function stubEncore(rows: ChartIssueRow[]): void {
  vi.stubGlobal('encore', {
    issuesLast: (): Promise<ChartIssueRow[]> => Promise.resolve(rows),
    issuesScan: (): Promise<ChartIssueRow[]> => Promise.resolve(rows),
    saveTextFile: (): Promise<string | null> => Promise.resolve(null)
  })
}

/**
 * Renders with a last-scan report already on disk, which is how the view looks when the user
 * opens it after a scan. `onMount` fetches that report on a microtask, so nothing is on screen
 * until it resolves; the SHOW label is the first thing gated on rows being present.
 */
async function renderWithRows(rows: ChartIssueRow[]): Promise<void> {
  stubEncore(rows)
  render(Tools)
  await screen.findByText('SHOW')
}

const clickChip = (name: RegExp): Promise<unknown> =>
  fireEvent.click(screen.getByRole('button', { name }))

const QUALITY_TOGGLE = /Charting quality notes/

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * scan-chart buckets note timestamps into 10ms windows before it words its description, so two
 * genuinely distinct findings in the same window produce byte-identical rows. The real library
 * had 45 such pairs.
 */
const DUPLICATE_DESCRIPTION =
  'The note at 1:23.450 on expert guitar is too close to the end of the previous sustain.'

const duplicatePair: ChartIssueRow[] = [
  {
    chartPath: '/library/Rush - YYZ',
    kind: 'chart',
    code: 'badSustainGap',
    description: DUPLICATE_DESCRIPTION
  },
  {
    chartPath: '/library/Rush - YYZ',
    kind: 'chart',
    code: 'badSustainGap',
    description: DUPLICATE_DESCRIPTION
  }
]

describe('Tools: duplicate findings on one chart', () => {
  // The shipped defect: the inner {#each} was keyed by the row's identity, two identical rows
  // collided, Svelte threw and abandoned the block, and the user got populated filter chips
  // reading "14236 issues in 182 charts" above a body still saying "Run a scan to check your
  // library". Both halves of that contradiction are asserted here.
  it('draws both copies of an identical finding instead of throwing', async () => {
    await renderWithRows(duplicatePair)
    await clickChip(QUALITY_TOGGLE)

    expect(await screen.findAllByText('Note too close to the previous sustain')).toHaveLength(2)
    expect(screen.getByText('/library/Rush - YYZ')).toBeTruthy()
    expect(screen.queryByText(/No report yet/)).toBeNull()
    expect(screen.getByText('2 ISSUES IN 1 CHART')).toBeTruthy()
  })
})

/**
 * One blocking row and one quality row, in different categories. The quality row is what makes
 * the "Damaged or duplicate files" chip exist at all, which is the shape of the dead end.
 */
const mixedSeverities: ChartIssueRow[] = [
  {
    chartPath: '/library/Rush - YYZ',
    kind: 'folder',
    code: 'noAudio',
    description: 'No audio files were found.'
  },
  {
    chartPath: '/library/Rush - Tom Sawyer',
    kind: 'folder',
    code: 'albumArtSize',
    description: 'The album art is 1024x1024 instead of 512x512.'
  }
]

describe('Tools: the filter dead end', () => {
  // Reachable on the real library: with quality notes on, "Damaged or duplicate files" is a chip
  // only because of quality-grade rows. Turning quality notes back off removes the chip while it
  // is still filtering, so the list empties with no control left to undo it.
  it('drops a category filter whose chip disappears with the quality notes', async () => {
    await renderWithRows(mixedSeverities)

    await clickChip(QUALITY_TOGGLE)
    await clickChip(/Damaged or duplicate files/)
    // The filter is doing something: only the damaged row is listed. Both chips read as pressed
    // here, which is also what keeps the zero-pressed assertion below from passing vacuously.
    expect(await screen.findByText('Album art is the wrong size')).toBeTruthy()
    expect(screen.queryByText('No audio')).toBeNull()
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(2)

    await clickChip(QUALITY_TOGGLE)

    // The list must not be left empty, and no filter may outlive its chip. The first of these is
    // the assertion that bites: dropping the prune leaves the damaged filter active with its chip
    // gone, so the body falls through to NO ISSUES MATCH THE SELECTED FILTERS.
    await waitFor(() => {
      expect(screen.getByText('No audio')).toBeTruthy()
    })
    expect(screen.queryByText('NO ISSUES MATCH THE SELECTED FILTERS')).toBeNull()
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0)
  })
})

describe('Tools: the severity default', () => {
  // Quality notes outnumber the actionable findings roughly a hundred to one; hiding them is what
  // took the default view from 14,236 rows to 104.
  it('lists blocking findings and hides quality ones until the toggle is pressed', async () => {
    await renderWithRows(mixedSeverities)

    expect(screen.getByText('No audio')).toBeTruthy()
    expect(screen.queryByText('Album art is the wrong size')).toBeNull()
    expect(screen.getByText('1 ISSUE IN 1 CHART')).toBeTruthy()

    await clickChip(QUALITY_TOGGLE)

    expect(await screen.findByText('Album art is the wrong size')).toBeTruthy()
    expect(screen.getByText('No audio')).toBeTruthy()
    expect(screen.getByText('2 ISSUES IN 2 CHARTS')).toBeTruthy()
  })
})

/**
 * The fix actions, from the renderer's side.
 *
 * The shape of the fixture is the shape of the real problem: two of the four repairable codes
 * (`albumArtSize`, `extraValue`) are charting-quality notes, so the toggle that keeps ~24,000
 * lint rows out of the way hides them: 62 of the 71 repairable charts in the reference library.
 * The tests below are mostly about that.
 */
const ALL_FIXABLE: FixableCode[] = [
  { code: 'badVideo', available: true, reason: null },
  { code: 'extraValue', available: true, reason: null },
  { code: 'albumArtSize', available: true, reason: null },
  { code: 'invalidIni', available: true, reason: null }
]

const FFMPEG_MISSING: FixableCode[] = ALL_FIXABLE.map((entry) =>
  entry.code === 'badVideo'
    ? {
        code: 'badVideo',
        available: false,
        reason: 'Converting a video needs ffmpeg, which is not installed.'
      }
    : entry
)

const repairable: ChartIssueRow[] = [
  {
    chartPath: '/library/Rush - YYZ',
    kind: 'folder',
    code: 'noAudio',
    description: 'No audio files were found.'
  },
  {
    chartPath: '/library/Rush - YYZ',
    kind: 'folder',
    code: 'badVideo',
    description: '"video.mp4" will not work on Linux and should be converted to .webm.'
  },
  {
    chartPath: '/library/Rush - Tom Sawyer',
    kind: 'folder',
    code: 'albumArtSize',
    description: 'The album art is 1024x1024 instead of 512x512.'
  },
  {
    chartPath: '/library/Rush - Limelight',
    kind: 'folder',
    code: 'albumArtSize',
    description: 'The album art is 770x774 instead of 512x512.'
  },
  {
    chartPath: '/library/Rush - Limelight',
    kind: 'metadata',
    code: 'extraValue',
    description: 'Metadata contains "diff_bass", but bass is not charted.'
  }
]

interface FixStub {
  fix: ReturnType<typeof vi.fn>
  scan: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
}

/**
 * Stubs the four fix calls on top of the report ones.
 *
 * `issuesFix` resolves with the chart's fresh rows, which is the contract that lets the view
 * update one chart without re-running the 3.4 s library report, so `fixable` returning what it
 * was asked for and `issuesScan` staying untouched are both things the tests below check.
 */
function stubFixes(
  rows: ChartIssueRow[],
  fixable: FixableCode[] = ALL_FIXABLE,
  freshRows: (row: ChartIssueRow) => ChartIssueRow[] = () => []
): FixStub {
  const stub: FixStub = {
    fix: vi.fn((row: ChartIssueRow) => Promise.resolve(freshRows(row))),
    scan: vi.fn(() => Promise.resolve(rows)),
    cancel: vi.fn(() => Promise.resolve()),
    install: vi.fn(() => Promise.resolve())
  }
  vi.stubGlobal('encore', {
    issuesLast: (): Promise<ChartIssueRow[]> => Promise.resolve(rows),
    issuesScan: stub.scan,
    saveTextFile: (): Promise<string | null> => Promise.resolve(null),
    issuesFixable: (): Promise<FixableCode[]> => Promise.resolve(fixable),
    issuesFix: stub.fix,
    issuesFixCancel: stub.cancel,
    sidecarInstall: stub.install,
    // Nothing to undo, which is the state of a library nobody has repaired yet and the one that
    // draws no undo panel at all.
    backupsList: (): Promise<{ backups: FixBackup[]; totalBytes: number }> =>
      Promise.resolve({ backups: [], totalBytes: 0 })
  })
  return stub
}

async function renderFixable(
  rows: ChartIssueRow[] = repairable,
  fixable: FixableCode[] = ALL_FIXABLE,
  freshRows?: (row: ChartIssueRow) => ChartIssueRow[]
): Promise<FixStub> {
  const stub = stubFixes(rows, fixable, freshRows)
  render(Tools)
  // The summary is the last thing to arrive: it needs both the report and issues:fixable.
  await screen.findByText(/Encore can fix/)
  return stub
}

const dialog = (): HTMLElement => screen.getByRole('dialog')

describe('Tools: finding the repairs the filters are hiding', () => {
  /**
   * The milestone's central UI problem. `albumArtSize` and `extraValue` are quality-grade, so the
   * default view shows neither, and they are the two largest fixes there are. A summary drawn
   * from the visible rows would say "1 chart"; this one counts every row of the report.
   */
  it('counts repairable charts the quality toggle is hiding, and says they are hidden', async () => {
    await renderFixable()

    expect(screen.getByText(/Encore can fix 3 of these charts/)).toBeTruthy()
    // Two of those three charts are entirely off screen behind the quality toggle.
    expect(screen.getByText(/2 of them are hidden by the current filters/)).toBeTruthy()
    expect(screen.queryByText('Album art is the wrong size')).toBeNull()
    expect(screen.getByText('2 CHARTS')).toBeTruthy()
  })

  it('puts those rows on screen without touching the quality toggle', async () => {
    await renderFixable()

    await fireEvent.click(screen.getByRole('button', { name: /^Show: Resize the album art/ }))

    expect(await screen.findAllByText('Album art is the wrong size')).toHaveLength(2)
    // Only those rows: a focused list is the repair and nothing else, so the blocking noAudio row
    // on another chart is not in it.
    expect(screen.queryByText('No audio')).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: 'Show everything' }))

    // Back to exactly the view the user had. The toggle was never turned on. The focus reached
    // past it rather than through it, which is what keeps the other ~24,000 quality rows away.
    await waitFor(() => {
      expect(screen.getByText('No audio')).toBeTruthy()
    })
    expect(screen.queryByText('Album art is the wrong size')).toBeNull()
    expect(screen.getByRole('button', { name: QUALITY_TOGGLE }).getAttribute('aria-pressed')).toBe(
      'false'
    )
  })

  it('offers no fix control at all on a row Encore cannot repair', async () => {
    await renderFixable()

    // Default view holds two rows on one chart: noAudio (no action) and badVideo (an action).
    expect(screen.getByText('No audio')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Fix Video won't play/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Fix No audio/ })).toBeNull()
  })

  it('draws no fix control at all when it could not learn what is available', async () => {
    // issuesFixable rejecting leaves availability unknown, and an unknown availability is not an
    // offer. The report itself still renders.
    vi.stubGlobal('encore', {
      issuesLast: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
      issuesScan: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
      saveTextFile: (): Promise<string | null> => Promise.resolve(null),
      issuesFixable: (): Promise<FixableCode[]> => Promise.reject(new Error('no ipc'))
    })
    render(Tools)

    expect(await screen.findByText('No audio')).toBeTruthy()
    expect(screen.queryByText(/Encore can fix/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Fix / })).toBeNull()
  })
})

describe('Tools: confirming a repair', () => {
  it('names the chart and the exact file, and how long a conversion takes', async () => {
    await renderFixable()

    await fireEvent.click(screen.getByRole('button', { name: /^Fix Video won't play/ }))

    const card = dialog()
    expect(within(card).getByText('/library/Rush - YYZ')).toBeTruthy()
    // The sentence that names what is written and what is removed, verbatim from the action.
    expect(within(card).getByText(/Convert video\.mp4 to video\.webm/)).toBeTruthy()
    expect(within(card).getByText(/Convert video\.mp4 to video\.webm/).textContent).toContain(
      'remove video.mp4'
    )
    // 35-70 s of work should be stated before it starts, not discovered during.
    expect(within(card).getByText(/35 to 70 seconds/)).toBeTruthy()
  })

  it('does nothing at all if the confirmation is dismissed', async () => {
    const stub = await renderFixable()

    await fireEvent.click(screen.getByRole('button', { name: /^Fix Video won't play/ }))
    await fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(stub.fix).not.toHaveBeenCalled()
  })

  it('refreshes only the repaired chart, without re-running the library scan', async () => {
    const stub = await renderFixable()

    await fireEvent.click(screen.getByRole('button', { name: /^Fix Video won't play/ }))
    await fireEvent.click(within(dialog()).getByRole('button', { name: /^Fix 1 chart/ }))

    await waitFor(() => {
      expect(screen.getByText('FIXED 1 CHART')).toBeTruthy()
    })
    // The four fields of the row, and nothing else: the view's own label/meaning/fix hang off the
    // rows it renders and are not main's business.
    expect(stub.fix).toHaveBeenCalledWith({
      chartPath: '/library/Rush - YYZ',
      kind: 'folder',
      code: 'badVideo',
      description: '"video.mp4" will not work on Linux and should be converted to .webm.'
    })
    // The chart's rows came back from the fix, so the whole 3.4 s report is not re-run.
    expect(stub.scan).not.toHaveBeenCalled()
    // That chart's rows were replaced by what the fix returned, an empty list here, so both its
    // rows are gone and the other charts are untouched.
    expect(screen.queryByText('No audio')).toBeNull()
    expect(screen.getByText(/Encore can fix 2 of these charts/)).toBeTruthy()
  })

  it('reports a repair that failed instead of quietly dropping it', async () => {
    stubFixes(repairable)
    vi.stubGlobal('encore', {
      issuesLast: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
      issuesScan: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
      saveTextFile: (): Promise<string | null> => Promise.resolve(null),
      issuesFixable: (): Promise<FixableCode[]> => Promise.resolve(ALL_FIXABLE),
      issuesFix: (): Promise<ChartIssueRow[]> =>
        Promise.reject(new Error('no longer has a video Encore can convert'))
    })
    render(Tools)
    await screen.findByText(/Encore can fix/)

    await fireEvent.click(screen.getByRole('button', { name: /^Fix Video won't play/ }))
    await fireEvent.click(within(dialog()).getByRole('button', { name: /^Fix 1 chart/ }))

    await waitFor(() => {
      expect(screen.getByText(/no longer has a video Encore can convert/)).toBeTruthy()
    })
    expect(screen.getByText(/FIXED 0 CHARTS, 1 FAILED/)).toBeTruthy()
    // The row is still there, because nothing was repaired.
    expect(screen.getByText("Video won't play on Linux")).toBeTruthy()
  })
})

describe('Tools: repairing a group at once', () => {
  it('lists every chart it will touch and repairs them one after another', async () => {
    const stub = await renderFixable()

    await fireEvent.click(screen.getByRole('button', { name: /^Fix all 2: Resize the album art/ }))

    const card = dialog()
    expect(within(card).getByText('/library/Rush - Tom Sawyer')).toBeTruthy()
    expect(within(card).getByText('/library/Rush - Limelight')).toBeTruthy()
    await fireEvent.click(within(card).getByRole('button', { name: /^Fix 2 charts/ }))

    await waitFor(() => {
      expect(screen.getByText('FIXED 2 CHARTS')).toBeTruthy()
    })
    expect(stub.fix).toHaveBeenCalledTimes(2)
  })

  /**
   * One repair can clear rows a batch was already holding: fixing an `invalidIni` also removes
   * the `multipleIniFiles` row beside it. The rows the batch is carrying are checked against the
   * report before each one, so the second is skipped rather than sent to main to fail on a chart
   * that is already repaired.
   */
  it('skips a queued row that an earlier repair already cleared', async () => {
    const strayIniRows: ChartIssueRow[] = [
      {
        chartPath: '/library/Rush - YYZ',
        kind: 'folder',
        code: 'invalidIni',
        description: '"desktop.ini" is not named "song.ini".'
      },
      {
        chartPath: '/library/Rush - YYZ',
        kind: 'folder',
        code: 'multipleIniFiles',
        description: 'This chart has more than one .ini file.'
      }
    ]
    const stub = await renderFixable(strayIniRows)

    await fireEvent.click(
      screen.getByRole('button', { name: /^Fix all 1: Remove the \.ini files/ })
    )
    await fireEvent.click(within(dialog()).getByRole('button', { name: /^Fix 1 chart/ }))

    await waitFor(() => {
      expect(screen.getByText('FIXED 1 CHART')).toBeTruthy()
    })
    expect(stub.fix).toHaveBeenCalledTimes(1)
  })
})

describe('Tools: when ffmpeg is missing', () => {
  it('explains why on the row and offers the install there', async () => {
    const stub = await renderFixable(repairable, FFMPEG_MISSING)

    // No button that would fail 70 seconds later.
    expect(screen.queryByRole('button', { name: /^Fix Video won't play/ })).toBeNull()
    expect(screen.getAllByText(/needs ffmpeg, which is not installed/).length).toBeGreaterThan(0)
    // And the answer to it is right there, rather than in Settings.
    await fireEvent.click(screen.getAllByRole('button', { name: 'Install ffmpeg' })[0])

    expect(stub.install).toHaveBeenCalledWith('ffmpeg')
  })

  it('leaves the repairs that do not need it alone', async () => {
    await renderFixable(repairable, FFMPEG_MISSING)

    // The album-art group is unaffected: one missing tool does not disable the other three fixes.
    expect(screen.getByRole('button', { name: /^Fix all 2: Resize the album art/ })).toBeTruthy()
  })
})

describe('Tools: progress and cancel while a conversion runs', () => {
  // `assetJobs` is a module-level store shared by every test in this file, so what a test puts in
  // it has to come back out.
  afterEach(() => {
    assetJobs.set(new Map())
  })

  it("shows the conversion's real progress and stops it when asked", async () => {
    let release: (rows: ChartIssueRow[]) => void = () => {}
    const pending = new Promise<ChartIssueRow[]>((resolve) => {
      release = resolve
    })
    const cancel = vi.fn(() => Promise.resolve())
    vi.stubGlobal('encore', {
      issuesLast: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
      issuesScan: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
      saveTextFile: (): Promise<string | null> => Promise.resolve(null),
      issuesFixable: (): Promise<FixableCode[]> => Promise.resolve(ALL_FIXABLE),
      issuesFix: (): Promise<ChartIssueRow[]> => pending,
      issuesFixCancel: cancel
    })
    render(Tools)
    await screen.findByText(/Encore can fix/)

    await fireEvent.click(screen.getByRole('button', { name: /^Fix Video won't play/ }))
    await fireEvent.click(within(dialog()).getByRole('button', { name: /^Fix 1 chart/ }))

    // ffmpeg's own -progress output, arriving on the shared asset-progress channel.
    assetJobs.set(
      new Map([
        [
          'fix:/library/Rush - YYZ',
          {
            jobId: 'fix:/library/Rush - YYZ',
            kind: 'asset',
            phase: 'converting',
            percent: 43,
            message: null,
            status: 'running'
          } as JobProgress
        ]
      ])
    )

    expect(await screen.findByText(/converting · 43%/)).toBeTruthy()
    expect(screen.getByText('FIXING 1 OF 1')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(cancel).toHaveBeenCalledWith('/library/Rush - YYZ')
    release([])
    await waitFor(() => {
      expect(screen.getByText(/^STOPPED/)).toBeTruthy()
    })
  })

  it('shows the phase alone when the fix has no percentage to report', async () => {
    // The three file-writing fixes have no fraction to give. Printing a number anyway, or
    // animating a bar through an imagined one, would be inventing information.
    let release: (rows: ChartIssueRow[]) => void = () => {}
    const pending = new Promise<ChartIssueRow[]>((resolve) => {
      release = resolve
    })
    vi.stubGlobal('encore', {
      issuesLast: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
      issuesScan: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
      saveTextFile: (): Promise<string | null> => Promise.resolve(null),
      issuesFixable: (): Promise<FixableCode[]> => Promise.resolve(ALL_FIXABLE),
      issuesFix: (): Promise<ChartIssueRow[]> => pending,
      issuesFixCancel: (): Promise<void> => Promise.resolve()
    })
    render(Tools)
    await screen.findByText(/Encore can fix/)

    await fireEvent.click(screen.getByRole('button', { name: /^Show: Resize the album art/ }))
    await fireEvent.click(
      screen.getAllByRole('button', { name: /^Fix Album art is the wrong size/ })[0]
    )
    await fireEvent.click(within(dialog()).getByRole('button', { name: /^Fix 1 chart/ }))

    assetJobs.set(
      new Map([
        [
          'fix:/library/Rush - Tom Sawyer',
          {
            jobId: 'fix:/library/Rush - Tom Sawyer',
            kind: 'asset',
            phase: 'resizing',
            percent: null,
            message: null,
            status: 'running'
          } as JobProgress
        ]
      ])
    )

    expect(await screen.findByText('resizing')).toBeTruthy()
    expect(screen.queryByText(/%/)).toBeNull()
    release([])
  })
})

// ---------------------------------------------------------------------------
// Stopping a scan
// ---------------------------------------------------------------------------

interface ScanStub {
  cancel: ReturnType<typeof vi.fn>
  /** Reject the in-flight `issuesScan`, the way main does when it has been cancelled. */
  rejectScan: (err: unknown) => void
}

/**
 * Renders with a scan hanging, which is the only state the Cancel button exists in.
 *
 * `last` seeds the report the tab already had: the thing a cancelled scan falls back to, and
 * the reason the cancelled line has to say the list is not fresh.
 */
async function renderScanning(last: ChartIssueRow[] | null = null): Promise<ScanStub> {
  let rejectScan: (err: unknown) => void = () => {}
  const pending = new Promise<ChartIssueRow[]>((_resolve, reject) => {
    rejectScan = reject
  })
  const cancel = vi.fn(() => Promise.resolve())
  vi.stubGlobal('encore', {
    issuesLast: (): Promise<ChartIssueRow[] | null> => Promise.resolve(last),
    issuesScan: (): Promise<ChartIssueRow[]> => pending,
    issuesScanCancel: cancel,
    issuesFixable: (): Promise<FixableCode[]> => Promise.resolve([]),
    saveTextFile: (): Promise<string | null> => Promise.resolve(null)
  })
  render(Tools)
  await fireEvent.click(screen.getByRole('button', { name: 'Scan library for issues' }))
  return { cancel, rejectScan }
}

afterEach(() => {
  // `assetJobs` is a module-level store shared by every test in this file; a scan job left
  // running by one is a scan still in progress in the next.
  assetJobs.set(new Map())
})

describe('Tools: stopping a scan', () => {
  it('offers no Cancel until a scan is actually running', async () => {
    await renderWithRows(repairable)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('offers Cancel from the click, not from the first progress event', async () => {
    // The gap between the two is the discovery walk. A button that appears only once main has
    // something to report is missing exactly when the user first wants it.
    await renderScanning()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('asks main to stop, and says it is stopping', async () => {
    const stub = await renderScanning()

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(stub.cancel).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeTruthy()
  })

  it('reports a cancel as a cancel, not as an error', async () => {
    const stub = await renderScanning()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    stub.rejectScan(new Error('Issue scan canceled'))

    expect(await screen.findByText(/SCAN CANCELED/)).toBeTruthy()
    expect(screen.queryByText(/^ERROR:/)).toBeNull()
  })

  it('says the list below belongs to the last completed scan', async () => {
    // Main refuses to hand back a partial report, so what stays on screen is the previous one.
    // Not saying so would leave the user reading stale counts as if they were fresh.
    const stub = await renderScanning(repairable)
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    stub.rejectScan(new Error('Issue scan canceled'))

    expect(await screen.findByText(/SHOWING THE LAST COMPLETED REPORT/)).toBeTruthy()
  })

  it('does not claim a previous report when there has never been one', async () => {
    // `issuesLast` resolving null is "no scan has ever finished". An empty ARRAY is different:
    // that is a completed scan that found nothing, and it counts as a previous report.
    const stub = await renderScanning(null)
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    stub.rejectScan(new Error('Issue scan canceled'))

    expect(await screen.findByText(/SCAN CANCELED/)).toBeTruthy()
    expect(screen.queryByText(/LAST COMPLETED REPORT/)).toBeNull()
  })

  it('still reports a genuine scan failure as an error', async () => {
    const stub = await renderScanning()

    stub.rejectScan(new Error('EACCES: permission denied'))

    expect(await screen.findByText(/ERROR: EACCES/)).toBeTruthy()
    expect(screen.queryByText(/SCAN CANCELED/)).toBeNull()
  })

  it('lets the user scan again after cancelling', async () => {
    const stub = await renderScanning()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    stub.rejectScan(new Error('Issue scan canceled'))
    await screen.findByText(/SCAN CANCELED/)

    // Back to its resting label, and enabled. A cancel that left the button stuck on
    // "Scanning…" would be a worse trap than the one it was meant to open.
    const button = await screen.findByRole('button', { name: 'Scan library for issues' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })
})

/**
 * The undo panel.
 *
 * jsdom applies no CSS and computes no layout, so nothing here is a claim about how the panel
 * LOOKS: where it sits, whether it is legible, whether the sizes line up. Those are desktop QA.
 * What these do check is the behaviour a user depends on: that an undo is offered where the repair
 * happened, that pressing it puts the chart's rows back without re-running the library report, and
 * that a refusal is shown as the sentence it is rather than swallowed.
 */
function backupFor(over: Partial<FixBackup> = {}): FixBackup {
  return {
    id: 'kabcd-0011223344556677',
    createdAt: 1_700_000_000_000,
    chartPath: '/library/Rush - YYZ',
    chartType: 'folder',
    code: 'badVideo',
    actionCode: 'badVideo',
    describe: 'Convert video.mp4 to video.webm and remove video.mp4.',
    chartHash: 'abc123',
    files: [{ fileName: 'video.mp4', blob: '0.bin', byteLength: 1_500_000, sha256: 'aa' }],
    remove: ['video.webm'],
    metadata: [],
    guard: { chartType: 'folder', files: [] },
    sizeBytes: 1_500_000,
    ...over
  }
}

interface UndoStub {
  restore: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  scan: ReturnType<typeof vi.fn>
}

function stubUndo(
  backups: FixBackup[],
  restore: () => Promise<{ chartPath: string; rows: ChartIssueRow[] }>
): UndoStub {
  let remaining = backups
  const stub: UndoStub = {
    // Spends the entry only on success, as main does: a restored backup is deleted, a refused one
    // stays. Emptying before the call would make the refusal test pass by the panel vanishing.
    restore: vi.fn(async () => {
      const result = await restore()
      remaining = []
      return result
    }),
    list: vi.fn(() => Promise.resolve({ backups: remaining, totalBytes: 1_500_000 })),
    scan: vi.fn(() => Promise.resolve(repairable))
  }
  vi.stubGlobal('encore', {
    issuesLast: (): Promise<ChartIssueRow[]> => Promise.resolve(repairable),
    issuesScan: stub.scan,
    saveTextFile: (): Promise<string | null> => Promise.resolve(null),
    issuesFixable: (): Promise<FixableCode[]> => Promise.resolve(ALL_FIXABLE),
    issuesFix: (): Promise<ChartIssueRow[]> => Promise.resolve([]),
    backupsList: stub.list,
    backupsRestore: stub.restore
  })
  return stub
}

describe('Tools: undoing a repair', () => {
  // `assetJobs` is a module-level store shared by every test in this file, so what a test puts in
  // it has to come back out.
  afterEach(() => {
    assetJobs.set(new Map())
  })

  it('draws nothing when there is nothing to undo', async () => {
    await renderFixable()

    // A permanently visible "0 repairs can be undone" would be noise for everyone who has never
    // pressed Fix, which is most people most of the time.
    expect(screen.queryByText(/can be undone/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Undo:/ })).toBeNull()
  })

  it('offers the undo beside the repairs, naming the chart and what it would take back', async () => {
    stubUndo([backupFor()], () => Promise.resolve({ chartPath: '/library/Rush - YYZ', rows: [] }))
    render(Tools)

    expect(await screen.findByText('1 fix can be undone')).toBeTruthy()
    // The chart by its readable name, and the repair's own sentence, the one the confirmation
    // showed before it ran, so the user recognises what they are taking back.
    expect(screen.getByText('Rush - YYZ')).toBeTruthy()
    expect(screen.getByText('Convert video.mp4 to video.webm and remove video.mp4.')).toBeTruthy()
    // What it is costing on disk, in the same words Settings uses.
    expect(screen.getByText('1.4 MB')).toBeTruthy()
  })

  it('restores, updates only that chart, and drops the spent entry', async () => {
    const stub = stubUndo([backupFor()], () =>
      Promise.resolve({
        chartPath: '/library/Rush - YYZ',
        rows: [
          {
            chartPath: '/library/Rush - YYZ',
            kind: 'folder',
            code: 'badVideo',
            description: '"video.mp4" will not work on Linux and should be converted to .webm.'
          }
        ]
      })
    )
    render(Tools)
    await screen.findByText('1 fix can be undone')

    await fireEvent.click(screen.getByRole('button', { name: /^Undo:/ }))

    await waitFor(() => {
      expect(screen.queryByText(/can be undone/)).toBeNull()
    })
    expect(stub.restore).toHaveBeenCalledWith('kabcd-0011223344556677')
    // The chart's rows came back with the restore, so the 3.4 s library report is not re-run,
    // the same bargain `issuesFix` strikes.
    expect(stub.scan).not.toHaveBeenCalled()
    expect(screen.getByText("Video won't play on Linux")).toBeTruthy()
  })

  it("says which phase a running undo is in, from main's own events", async () => {
    // Putting a 159 MB video back is a copy, a hash and an archive rebuild. A button that read
    // "Undoing…" for all three would be inventing a single step where there are three.
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    stubUndo([backupFor()], async () => {
      await pending
      return { chartPath: '/library/Rush - YYZ', rows: [] }
    })
    render(Tools)
    await screen.findByText('1 fix can be undone')

    await fireEvent.click(screen.getByRole('button', { name: /^Undo:/ }))
    assetJobs.set(
      new Map([
        [
          'undo:kabcd-0011223344556677',
          {
            jobId: 'undo:kabcd-0011223344556677',
            kind: 'asset',
            phase: 'restoring',
            percent: null,
            message: null,
            status: 'running'
          } as JobProgress
        ]
      ])
    )

    expect(await screen.findByText('restoring…')).toBeTruthy()
    release()
    await waitFor(() => {
      expect(screen.queryByText(/can be undone/)).toBeNull()
    })
  })

  it('shows a refusal against the entry, and keeps the entry', async () => {
    // The refusal that matters: the user converted a video, downloaded a better one, and only
    // then reached for Undo. Main declines rather than overwriting, and that sentence is the
    // whole point; swallowing it would look like a button that does nothing.
    stubUndo([backupFor()], () =>
      Promise.reject(
        new Error('video.webm in /library/Rush - YYZ has been rewritten since this fix')
      )
    )
    render(Tools)
    await screen.findByText('1 fix can be undone')

    await fireEvent.click(screen.getByRole('button', { name: /^Undo:/ }))

    expect(await screen.findByText(/has been rewritten since this fix/)).toBeTruthy()
    // Still offered: once the user moves their new video aside, the undo is still there.
    expect(screen.getByRole('button', { name: /^Undo:/ })).toBeTruthy()
  })

  it('summarises a long history rather than listing all of it', async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      backupFor({ id: `kabcd-00112233445566${String(i).padStart(2, '0')}` })
    )
    stubUndo(many, () => Promise.resolve({ chartPath: '/library/Rush - YYZ', rows: [] }))
    render(Tools)
    await screen.findByText('9 fixes can be undone')

    expect(screen.getAllByRole('button', { name: /^Undo:/ })).toHaveLength(6)

    await fireEvent.click(screen.getByRole('button', { name: 'Show all 9' }))

    expect(screen.getAllByRole('button', { name: /^Undo:/ })).toHaveLength(9)
  })
})

describe('Tools: the confirmation keeps the keyboard inside it', () => {
  const opener = (): HTMLElement => screen.getByRole('button', { name: /^Fix Video won't play/ })
  const confirm = (): HTMLElement => within(dialog()).getByRole('button', { name: /^Fix 1 chart/ })
  const cancel = (): HTMLElement => within(dialog()).getByRole('button', { name: 'Cancel' })

  /** Opens the dialog from a focused opener, as a keyboard user would, and returns that opener. */
  async function open(): Promise<{ from: HTMLElement; stub: FixStub }> {
    const stub = await renderFixable()
    const from = opener()
    from.focus()
    await fireEvent.click(from)
    await waitFor(() => expect(document.activeElement).toBe(confirm()))
    return { from, stub }
  }

  it('lands on the confirm button on open and hands focus back to the opener on Cancel', async () => {
    const { from } = await open()

    await fireEvent.click(cancel())

    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(from))
  })

  it('wraps Tab off the last control back to the first, rather than into the view behind', async () => {
    await open()

    // jsdom does not move focus on Tab, so what is asserted is the handler's own work: claim the
    // event and put focus on the first control. Cancel comes before Fix in the card.
    const claimed = !(await fireEvent.keyDown(confirm(), { key: 'Tab' }))

    expect(claimed).toBe(true)
    expect(document.activeElement).toBe(cancel())
  })

  it('wraps Shift+Tab off the first control to the last', async () => {
    await open()
    cancel().focus()

    const claimed = !(await fireEvent.keyDown(cancel(), { key: 'Tab', shiftKey: true }))

    expect(claimed).toBe(true)
    expect(document.activeElement).toBe(confirm())
  })

  it('still closes on Escape, and hands focus back to the opener', async () => {
    const { from, stub } = await open()

    await fireEvent.keyDown(confirm(), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(stub.fix).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(from))
  })
})
