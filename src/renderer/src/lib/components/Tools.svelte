<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { ChartIssueRow } from '../../../../main/catalog/issues'
  import type { FixBackup } from '../../../../main/issues/backup-store'
  import type { FixableCode } from '../../../../main/issues/fix'
  import { toCsv } from '../../../../shared/csv'
  import { fallbackChartName, formatBytes } from '../../../../shared/format'
  import {
    fixForRow,
    VIDEO_CONVERSION_SECONDS,
    type FixActionCode,
    type RowFix
  } from '../../../../shared/issue-fixes'
  import {
    explainIssue,
    ISSUE_GROUPS,
    type IssueGroupId,
    type IssueSeverity
  } from '../../../../shared/issue-labels'
  import { takeFocus, wrapTab } from '../focus-trap'
  import { assetJobs } from '../stores/assets'
  import { encore } from '../stores/bridge'
  import Duplicates from './Duplicates.svelte'

  // A row plus its human explanation. The raw code stays on the row so it can still be
  // read off the screen and exported.
  type ExplainedRow = ChartIssueRow & {
    label: string
    meaning: string
    group: IssueGroupId
    severity: IssueSeverity
    /** scan-chart's own text, kept only when it adds specifics beyond `meaning`. */
    detail: string | null
    /** What Encore can do about this row, or null, which is the answer for most of them. */
    fix: RowFix | null
  }

  /**
   * Cap on issue rows drawn per chart. A charting linter can emit thousands of notes for a
   * single dense chart; rendering them all is a frozen window and nobody reads past the first
   * few anyway. Nothing is dropped from the export; this bounds the DOM, not the data.
   */
  const ROWS_PER_CHART = 25

  /**
   * Charts named individually in a confirmation before it summarises the rest.
   *
   * "Fix all 39" cannot list 39 paths without becoming a wall nobody reads, and every chart past
   * the first few is getting the identical repair anyway. The count is always exact.
   */
  const CONFIRM_CHARTS = 8

  // ── state ──────────────────────────────────────────────────────────────────
  /**
   * `$state.raw`, not `$state`, for two reasons that both bite at this size.
   *
   * A real library reports 24,151 rows, and `$state` hands every one of them out through a proxy
   * it creates on first access, and the whole derived chain below then reads through them.
   * More sharply: a proxied row cannot cross the IPC boundary. `issuesFix` structured-clones its
   * payload, and structured clone refuses a Proxy outright (`DataCloneError: #<Object> could not
   * be cloned`, checked under this Node), so a fix would fail on the click with an error about
   * cloning, which is not a sentence anyone could act on. Nothing here mutates a row; the list
   * is only ever replaced wholesale, which raw handles.
   */
  let rows = $state.raw<ChartIssueRow[]>([])
  // null = no scan has ever run in this session; undefined = scan ran, zero issues
  let hasLoaded = $state(false)
  let scanError = $state<string | null>(null)
  let groupFilter = $state<IssueGroupId[]>([])
  // Charting-craft notes are off by default: on a real library they outnumber the actionable
  // findings by around a hundred to one, and they are the reason the list read as noise.
  let showQuality = $state(false)

  // Inline CSV export state. rowCount is set only when a kind filter was
  // active at export time, so the SAVED line can show how many rows went out.
  type CsvState =
    | { status: 'saved'; path: string; rowCount: number | null }
    | { status: 'canceled' }
    | { status: 'error'; message: string }
    | null
  let csvState = $state<CsvState>(null)

  // ── fix state ─────────────────────────────────────────────────────────────
  /**
   * Which codes have an action and whether their tools are present, straight from main.
   *
   * Null until `issues:fixable` has answered, and null again if it ever fails. While it is
   * null **no fix control is drawn anywhere**. Encore offers a repair only once it has confirmed
   * it can perform one; a button that appears optimistically and then reports that ffmpeg is
   * missing has already wasted the click it was asking for.
   */
  let fixable = $state<FixableCode[] | null>(null)

  /**
   * The run in flight: the row being fixed now, how far through the batch it is, and what failed.
   *
   * One row at a time, deliberately. Main takes a per-chart write lock and a video conversion
   * saturates the CPU for a minute; two at once would be slower overall and would make the
   * progress line meaningless.
   */
  let fixActive = $state.raw<ChartIssueRow | null>(null)
  let fixDone = $state(0)
  let fixTotal = $state(0)
  let fixCanceling = $state(false)
  let fixFailures = $state<{ chartPath: string; message: string }[]>([])
  /** The line left behind after a run finishes, so a batch that is over still says what it did. */
  let fixSummary = $state<string | null>(null)
  let ffmpegError = $state<string | null>(null)

  /** The plan awaiting confirmation. Null when no dialog is open. */
  type FixPlan = { rows: ExplainedRow[]; title: string }
  let confirming = $state.raw<FixPlan | null>(null)
  let confirmButton = $state<HTMLButtonElement | null>(null)
  let confirmCard = $state<HTMLElement | null>(null)

  // Focus lands on the confirm button when the dialog opens, so Escape/Enter both work without
  // reaching for the mouse. The dialog is the only thing on screen at that point. It goes back to
  // the button that opened the dialog when the dialog closes: `confirmButton` is bound inside the
  // `{#if}`, so it is null again the moment the dialog goes, and the effect's cleanup is the
  // restore. Without it a keyboard user is dropped at the top of the document after every Cancel.
  $effect(() => {
    const el = confirmButton
    if (!el) return undefined
    return takeFocus(el)
  })

  /**
   * The repair summary's "Show" is a filter that ignores the severity toggle and the category
   * chips entirely, because its whole purpose is to reach rows those are hiding. See `fixGroups`
   * for why that matters.
   */
  let fixFocus = $state<FixActionCode | null>(null)

  // ── derived: issue-scan job progress ──────────────────────────────────────
  const scanJob = $derived($assetJobs.get('issue-scan'))

  /**
   * True for the whole invoke, not just while a progress event says the job is running.
   *
   * Same reasoning as `fixRunning` below: derived from `assetJobs` this would be false for the
   * gap between the click and the first event from main, which on a cold scan is the discovery
   * walk, and exactly when a user who has changed their mind reaches for Cancel. A window in
   * which the button is not there yet is a window in which the app looks stuck.
   */
  let scanRunning = $state(false)
  let scanCanceling = $state(false)
  /** Left behind by a stopped scan, so it says so instead of just going quiet. */
  let scanCanceled = $state(false)
  const scanning = $derived(scanRunning || scanJob?.status === 'running')

  // ── derived: explained, filtered and grouped rows ──────────────────────────
  const explainedRows = $derived(
    rows.map((row): ExplainedRow => {
      // Description is passed because missingValue's severity depends on it.
      const { label, meaning, group, severity } = explainIssue(row.code, row.description)
      return {
        ...row,
        label,
        meaning,
        group,
        severity,
        detail: row.description.trim() === meaning.trim() ? null : row.description,
        // Row-level, not code-level: `extraValue` and `invalidIni` are only fixable when the
        // description is wording scan-chart actually wrote (the fix deletes what it parses out of
        // it), and one action covers both `invalidIni` and `multipleIniFiles`. Asking
        // shared/issue-fixes.ts is what keeps this answer identical to the one main will give.
        fix: fixForRow(row)
      }
    })
  )

  // Severity is applied before everything else, so the chip counts and the totals line
  // always describe the list actually on screen.
  const severityRows = $derived(
    showQuality ? explainedRows : explainedRows.filter((r) => r.severity === 'blocking')
  )
  const qualityCount = $derived(explainedRows.filter((r) => r.severity === 'quality').length)

  // Only categories that actually turned something up become chips: an empty
  // "Missing files" filter is noise.
  const groupChips = $derived(
    ISSUE_GROUPS.map((g) => ({
      ...g,
      count: severityRows.filter((r) => r.group === g.id).length
    })).filter((g) => g.count > 0)
  )

  const filteredRows = $derived(
    groupFilter.length === 0
      ? severityRows
      : severityRows.filter((r) => groupFilter.includes(r.group))
  )

  // Focusing one fix bypasses BOTH filters rather than adding a third. The rows it exists to
  // reach are exactly the ones the severity toggle is hiding, so a focus that respected the
  // toggle would show nothing and teach the user the button is broken.
  const visibleRows = $derived(
    fixFocus === null ? filteredRows : explainedRows.filter((r) => r.fix?.actionCode === fixFocus)
  )

  // A category chip only exists while that category has rows, so turning quality notes off
  // can remove the very chip that is filtering the list, leaving an empty screen and no
  // control to undo it. Drop filters that no longer have a chip.
  $effect(() => {
    const available = new Set(groupChips.map((c) => c.id))
    untrack(() => {
      const pruned = groupFilter.filter((g) => available.has(g))
      // Length is a sound proxy for equality only because filter can only REMOVE entries,
      // so pruned is always a subset. Keep it that way if this is ever rewritten.
      if (pruned.length !== groupFilter.length) groupFilter = pruned
    })
  })

  /** Bucket rows by chartPath, preserving first-seen order. */
  function byChart(source: ExplainedRow[]): [string, ExplainedRow[]][] {
    const order: string[] = []
    const buckets: Record<string, ExplainedRow[]> = {}
    for (const row of source) {
      if (!buckets[row.chartPath]) {
        order.push(row.chartPath)
        buckets[row.chartPath] = []
      }
      buckets[row.chartPath].push(row)
    }
    return order.map((p) => [p, buckets[p]])
  }

  // Two levels: a plain-language category section, then one card per affected chart.
  const sections = $derived(
    ISSUE_GROUPS.map((g) => {
      const groupRows = visibleRows.filter((r) => r.group === g.id)
      return { ...g, charts: byChart(groupRows), count: groupRows.length }
    }).filter((s) => s.count > 0)
  )

  const chartCount = $derived(new Set(visibleRows.map((r) => r.chartPath)).size)
  const issueCount = $derived(visibleRows.length)

  // ── derived: what Encore can repair ───────────────────────────────────────
  /**
   * **This is the answer to the discoverability trap, and it is why it reads every row.**
   *
   * `extraValue` and `albumArtSize` are both in `QUALITY_CODES`, so the "Charting quality notes"
   * toggle hides them, and they are the two largest fixes in the milestone. Measured over the
   * 219-chart reference library: 61 charts have a repairable row, and **54 of them have no
   * repairable row that survives the toggle being off**. Ship the buttons only on visible rows and
   * a user who never touches that toggle never learns that 39 of their covers can be resized.
   * (An earlier draft of this comment said "62 of the 71", which is 39 + 23 and 39 + 23 + 6 + 2:
   * per-code chart counts added up. Charts carry more than one code, so those sums overcount; the
   * distinct-chart figures are the ones above.)
   *
   * The toggle is not the thing to change: it correctly suppresses ~24,000 un-actionable lint
   * rows, and defaulting it on would bury the tab in noise. So this summary is computed from
   * `explainedRows` (every row of the report, before severity, before category chips, before
   * anything) and its Show button reaches those rows directly.
   */
  const fixGroups = $derived.by(() => {
    // Plain arrays rather than a Map keyed by code: there are four actions at most, so `find` is
    // cheaper than it looks, and a Map mutated inside a derived is the kind of thing
    // svelte/prefer-svelte-reactivity exists to catch.
    const groups: {
      actionCode: FixActionCode
      title: string
      rows: ExplainedRow[]
      chartPaths: string[]
    }[] = []
    for (const row of explainedRows) {
      const fix = row.fix
      if (fix === null) continue
      let group = groups.find((g) => g.actionCode === fix.actionCode)
      if (group === undefined) {
        group = { actionCode: fix.actionCode, title: fix.title, rows: [], chartPaths: [] }
        groups.push(group)
      }
      group.rows.push(row)
      if (!group.chartPaths.includes(row.chartPath)) group.chartPaths.push(row.chartPath)
    }
    return groups
  })

  const fixableChartCount = $derived(
    new Set(explainedRows.filter((r) => r.fix !== null).map((r) => r.chartPath)).size
  )

  /**
   * How many repairable charts the current filters are keeping off screen entirely.
   *
   * Said out loud in the summary rather than left for the user to infer. "Encore can repair 39 of
   * these charts" is only useful if it also explains why none of them are in the list below it.
   */
  const hiddenFixableCount = $derived.by(() => {
    // Counted in charts, because the line above it is counted in charts. A chart with two
    // repairable rows of which one is on screen is not hidden.
    const onScreen = new Set(visibleRows.filter((r) => r.fix !== null).map((r) => r.chartPath))
    const everywhere = new Set(explainedRows.filter((r) => r.fix !== null).map((r) => r.chartPath))
    let hidden = 0
    for (const chartPath of everywhere) if (!onScreen.has(chartPath)) hidden += 1
    return hidden
  })

  const availabilityByCode = $derived(new Map((fixable ?? []).map((f) => [f.code, f])))

  /** Whether a fix can run right now. False while `issues:fixable` has not answered. */
  function fixReady(actionCode: FixActionCode): boolean {
    return availabilityByCode.get(actionCode)?.available === true
  }

  /** Why a fix cannot run, in main's own words, or null. */
  function fixBlockedReason(actionCode: FixActionCode): string | null {
    const entry = availabilityByCode.get(actionCode)
    if (entry === undefined || entry.available) return null
    return entry.reason ?? 'Encore cannot run this fix right now.'
  }

  // ── fix run ───────────────────────────────────────────────────────────────
  /**
   * True for the whole run, not just while a chart is in flight.
   *
   * Derived from `fixActive` it would flicker false between two charts of a batch and let a
   * second run start in the gap. It is a property of the run, so it is state of the run.
   */
  let fixRunning = $state(false)

  /**
   * The active chart's progress, and only while it is genuinely running.
   *
   * `assetJobs` keeps terminal entries so a finished job can still show its last line, which
   * means a second fix on a chart already fixed once would open on the previous run's
   * finished "complete" at 100%. Reading only the running status costs a moment of "starting"
   * and never shows a percent that belongs to something that already finished.
   */
  const fixJob = $derived(
    fixActive === null ? undefined : $assetJobs.get(`fix:${fixActive.chartPath}`)
  )
  const fixPhase = $derived(fixJob?.status === 'running' ? fixJob.phase : 'starting')
  const fixPercent = $derived(fixJob?.status === 'running' ? fixJob.percent : null)

  const ffmpegJob = $derived($assetJobs.get('sidecar:ffmpeg'))
  const ffmpegInstalling = $derived(ffmpegJob?.status === 'running')

  const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  /**
   * Two rows are the same finding when all four fields match.
   *
   * Not identity: a fix replaces its chart's rows with fresh objects from main, so a row queued
   * before that point is a different object describing the same thing. Not a unique key either,
   * since scan-chart really does emit byte-identical rows (see the duplicate-findings test), but
   * two identical rows are two spellings of one repair, and treating them as one is right here.
   */
  function sameRow(a: ChartIssueRow, b: ChartIssueRow): boolean {
    return (
      a.chartPath === b.chartPath &&
      a.kind === b.kind &&
      a.code === b.code &&
      a.description === b.description
    )
  }

  /**
   * Swap one chart's rows for the ones main returned after fixing it.
   *
   * The whole point of `issues:fix` resolving with rows: the library report takes 3.4 s and
   * re-running it after each of six video conversions would be 20 s spent learning what the
   * per-chart re-scan has already said. The fresh rows land where the chart's first row was, so
   * the list does not reorder itself under the user mid-batch.
   */
  function replaceChartRows(chartPath: string, fresh: ChartIssueRow[]): void {
    const next: ChartIssueRow[] = []
    let placed = false
    for (const row of rows) {
      if (row.chartPath !== chartPath) {
        next.push(row)
        continue
      }
      if (!placed) {
        next.push(...fresh)
        placed = true
      }
    }
    rows = next
  }

  /**
   * Run a plan, one row at a time, and report honestly about all of it.
   *
   * A failure does not abandon the rest: with 39 covers queued, one chart whose art has been
   * deleted since the scan should cost that chart, not the other 38. A cancel does stop
   * everything, because that is what the user asked for.
   */
  async function runFixes(plan: FixPlan): Promise<void> {
    if (fixRunning) return
    fixRunning = true
    fixFailures = []
    fixSummary = null
    fixCanceling = false
    fixTotal = plan.rows.length
    fixDone = 0
    const fixedCharts: string[] = []

    for (const queued of plan.rows) {
      if (fixCanceling) break
      // Skipped rather than attempted: fixing one `invalidIni` row also clears the
      // `multipleIniFiles` row beside it, and a batch that then tried the second would fail on a
      // chart it had just repaired.
      if (!rows.some((row) => sameRow(row, queued))) {
        fixDone += 1
        continue
      }
      fixActive = queued
      try {
        // Stripped to the four fields the row really is: the queue holds explained rows, and the
        // label, meaning and fix hanging off them are this view's business, not main's.
        const fresh = await encore().issuesFix({
          chartPath: queued.chartPath,
          kind: queued.kind,
          code: queued.code,
          description: queued.description
        })
        replaceChartRows(queued.chartPath, fresh)
        if (!fixedCharts.includes(queued.chartPath)) fixedCharts.push(queued.chartPath)
      } catch (err) {
        // A cancel arrives as a rejection too. It is not a failure and does not belong in the
        // failure list; the user knows, they pressed the button.
        if (!fixCanceling) {
          fixFailures = [...fixFailures, { chartPath: queued.chartPath, message: asMessage(err) }]
        }
      } finally {
        fixActive = null
        fixDone += 1
      }
    }

    const fixedLabel = `FIXED ${fixedCharts.length} CHART${fixedCharts.length === 1 ? '' : 'S'}`
    const failedLabel = fixFailures.length > 0 ? `, ${fixFailures.length} FAILED` : ''
    fixSummary = fixCanceling ? `STOPPED. ${fixedLabel}${failedLabel}` : fixedLabel + failedLabel
    fixCanceling = false
    fixRunning = false
    fixTotal = 0
    fixDone = 0
    // After the run, not during it: the panel is what the user reaches for when they look at the
    // result and dislike it, and redrawing it after every chart would move the buttons under a
    // cursor mid-batch.
    await loadBackups()
  }

  // ── undo ──────────────────────────────────────────────────────────────────
  /**
   * The repairs that can still be taken back, newest first.
   *
   * Here rather than only in Settings because this is where the repair happened: a user who has
   * just converted six videos and does not like the result is looking at this screen, and an undo
   * they have to go and find in another tab is an undo they will not find. Settings shows the
   * total and offers to clear it, which is a different question (how much disk is this costing)
   * and belongs where the rest of the housekeeping is.
   *
   * Empty is the normal state, and draws nothing at all: a permanently visible "0 repairs can be
   * undone" would be a panel that is noise for everyone who has never pressed Fix.
   */
  let backups = $state.raw<FixBackup[]>([])
  let undoingId = $state<string | null>(null)
  /**
   * Why an undo was refused, against the entry that refused.
   *
   * Kept per id rather than as one message, because the interesting refusal ("this chart has
   * changed since the repair") is about one entry in a list of several, and a single error line
   * above the list would not say which.
   */
  let undoErrors = $state.raw<Record<string, string>>({})
  /** How many are listed before the rest are summarised. Six conversions is one plan's worth. */
  const UNDO_VISIBLE = 6
  let showAllBackups = $state(false)
  const visibleBackups = $derived(showAllBackups ? backups : backups.slice(0, UNDO_VISIBLE))

  /**
   * Which of the restore's phases the running undo is in, or null.
   *
   * Read from the shared asset-progress store rather than tracked here, on the same terms as
   * `fixJob`: main is the only thing that knows whether it is checking the chart, hashing its copy
   * or rebuilding an archive, and putting a 159 MB video back is long enough to be worth saying.
   * Falls back to a plain label when no event has arrived yet.
   */
  const undoJob = $derived(undoingId === null ? undefined : $assetJobs.get(`undo:${undoingId}`))
  const undoPhase = $derived(undoJob?.status === 'running' ? undoJob.phase : null)

  async function loadBackups(): Promise<void> {
    try {
      backups = (await encore().backupsList()).backups
    } catch {
      // Left as it was. An undo panel that cannot be listed is worth less than a wrong one: the
      // repairs themselves are unaffected and the entries are still on disk.
    }
  }

  /**
   * Put one repair back.
   *
   * Main refuses rather than restoring when the chart has changed since (see issues/restore.ts),
   * and that refusal is a sentence the user needs to read, not a failure to retry. It is shown
   * against the entry and the entry stays, so the undo is still there once they have moved
   * whatever changed out of the way.
   */
  async function undoBackup(backup: FixBackup): Promise<void> {
    if (undoingId !== null || fixRunning) return
    undoingId = backup.id
    undoErrors = Object.fromEntries(Object.entries(undoErrors).filter(([id]) => id !== backup.id))
    try {
      const { chartPath, rows: fresh } = await encore().backupsRestore(backup.id)
      // The same in-place update a fix does: the chart's rows come back from main, and the
      // library-wide report, which takes 3.4 s, is not re-run to learn what they already say.
      replaceChartRows(chartPath, fresh)
    } catch (err) {
      undoErrors = { ...undoErrors, [backup.id]: asMessage(err) }
    } finally {
      undoingId = null
      await loadBackups()
    }
  }

  /**
   * Stop the run: abort the chart being converted, and abandon what is queued behind it.
   *
   * Only the video conversion can actually be interrupted mid-flight. The others are a few
   * milliseconds of file writing and will have finished before the click lands, so for those
   * this reads as "stop after this one", which is what the button says.
   */
  async function cancelFixes(): Promise<void> {
    if (!fixRunning) return
    fixCanceling = true
    const active = fixActive
    if (active !== null) {
      try {
        await encore().issuesFixCancel(active.chartPath)
      } catch (err) {
        fixFailures = [...fixFailures, { chartPath: active.chartPath, message: asMessage(err) }]
      }
    }
  }

  // ── confirmation ──────────────────────────────────────────────────────────
  /**
   * What to call a plan.
   *
   * One chart can carry two different repairs (an oversized cover and a stray difficulty
   * rating), and its "Fix all" covers both. Naming such a plan after whichever row happened to
   * come first would put a heading on the dialog that describes half of what it is about to do.
   */
  function planTitle(planRows: ExplainedRow[]): string {
    const titles = [...new Set(planRows.map((r) => r.fix?.title).filter((t) => t !== undefined))]
    return titles.length === 1 ? titles[0] : `${planRows.length} fixes on this chart`
  }

  function confirmRow(row: ExplainedRow): void {
    if (row.fix === null) return
    confirming = { rows: [row], title: row.fix.title }
  }

  /** Every repairable row for one chart, from the rows on screen for it. */
  function confirmChart(chartFixes: ExplainedRow[]): void {
    if (chartFixes.length === 0) return
    confirming = { rows: chartFixes, title: planTitle(chartFixes) }
  }

  /** Every repairable row of one kind, across the whole report, filters included or not. */
  function confirmGroup(actionCode: FixActionCode): void {
    const group = fixGroups.find((g) => g.actionCode === actionCode)
    if (group === undefined) return
    confirming = { rows: group.rows, title: group.title }
  }

  function startConfirmed(): void {
    const plan = confirming
    confirming = null
    if (plan !== null) void runFixes(plan)
  }

  /** The distinct charts a plan touches, in order, for the confirmation's list. */
  const confirmCharts = $derived.by(() => {
    if (confirming === null) return []
    const charts: { chartPath: string; sentences: string[] }[] = []
    for (const row of confirming.rows) {
      const sentence = fixForRow(row)?.describe
      if (sentence === undefined) continue
      let chart = charts.find((c) => c.chartPath === row.chartPath)
      if (chart === undefined) {
        chart = { chartPath: row.chartPath, sentences: [] }
        charts.push(chart)
      }
      // Two rows of one chart often carry the same sentence (two stray .ini files, say); the
      // confirmation should list what will happen, not repeat itself.
      if (!chart.sentences.includes(sentence)) chart.sentences.push(sentence)
    }
    return charts
  })

  /**
   * How long the user is committing to, when that is worth saying out loud.
   *
   * Only conversion is slow enough to need this, and it is counted per video rather than per
   * chart in the plan: a mixed plan that converts one background and resizes a cover is a minute
   * of work, not two.
   */
  const confirmDuration = $derived.by(() => {
    const charts = (confirming?.rows ?? []).filter((r) => r.fix?.actionCode === 'badVideo').length
    if (charts === 0) return null
    const { min, max } = VIDEO_CONVERSION_SECONDS
    if (charts === 1) return `Converting takes about ${min} to ${max} seconds.`
    const low = Math.round((min * charts) / 60)
    const high = Math.round((max * charts) / 60)
    return (
      `Converting takes about ${min} to ${max} seconds per chart, so this run will take roughly ` +
      `${low === high ? `${low}` : `${low} to ${high}`} minute${high === 1 ? '' : 's'}. ` +
      `You can stop it at any time.`
    )
  })

  // ── ffmpeg ────────────────────────────────────────────────────────────────
  /**
   * Install ffmpeg from the row that needs it.
   *
   * Not a link to Settings: the user is looking at six charts whose backgrounds do not play and
   * a sentence saying why, and the answer to "so install it" is a button, not a tab to go and
   * work it out in. Main invalidates its cached ffmpeg lookup as part of the install
   * (sidecars/manager.ts), so re-asking `issues:fixable` afterwards is enough to make the Fix
   * buttons appear without restarting the app.
   */
  async function installFfmpeg(): Promise<void> {
    ffmpegError = null
    try {
      await encore().sidecarInstall('ffmpeg')
    } catch (err) {
      ffmpegError = asMessage(err)
    }
    await loadFixable()
  }

  async function loadFixable(): Promise<void> {
    try {
      fixable = await encore().issuesFixable()
    } catch {
      // Left null, which draws no fix controls at all. Better than offering repairs whose
      // availability is unknown.
      fixable = null
    }
  }

  // ── scan ────────────────────────────────────────────────────────────────────
  async function runScan(): Promise<void> {
    if (scanning || fixRunning) return
    scanError = null
    scanCanceled = false
    scanCanceling = false
    scanRunning = true
    csvState = null
    // A fresh report is a fresh set of rows; a summary and failures from the last run would be
    // describing charts that may not even be in it.
    fixSummary = null
    fixFailures = []
    try {
      rows = await encore().issuesScan()
      hasLoaded = true
    } catch (err) {
      // A cancel arrives as a rejection too. Main deliberately refuses to resolve with the rows
      // it had reached, because a partial report reads exactly like a complete one. Which of the
      // two this is comes from the button we pressed, not from the message: the wording is
      // main's to choose and the intent is ours to already know.
      if (scanCanceling) scanCanceled = true
      else scanError = err instanceof Error ? err.message : String(err)
    } finally {
      scanRunning = false
      scanCanceling = false
    }
  }

  /**
   * Stop the scan.
   *
   * What it can promise: nothing further is opened. Charts already being read finish (up to the
   * scan's concurrency limit, and one large `.sng` is not interruptible partway), so on a big
   * library this is "stop now", not "stop this instant". `rows` is left exactly as it was, which
   * means a cancelled scan falls back to the last report that actually completed rather than to
   * a truncated one.
   */
  async function cancelScan(): Promise<void> {
    if (!scanning || scanCanceling) return
    scanCanceling = true
    try {
      await encore().issuesScanCancel()
    } catch (err) {
      // The cancel itself failed, so the scan is still running and the button must come back.
      scanCanceling = false
      scanError = asMessage(err)
    }
  }

  // ── filter chips ─────────────────────────────────────────────────────────
  function toggleGroup(group: IssueGroupId): void {
    groupFilter = groupFilter.includes(group)
      ? groupFilter.filter((g) => g !== group)
      : [...groupFilter, group]
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  // Exports what the user SEES: when category chips are active, only the
  // filtered rows go out, and the SAVED line reports the exported row count.
  // Both the raw code and its human label ship, so the file stays greppable
  // while still being readable by someone who has never seen scan-chart.
  async function exportCsv(): Promise<void> {
    const exportRows = visibleRows
    if (exportRows.length === 0) return
    csvState = null
    const csvRows: string[][] = [
      ['chartPath', 'category', 'kind', 'code', 'label', 'meaning', 'description']
    ]
    for (const row of exportRows) {
      csvRows.push([
        row.chartPath,
        row.group,
        row.kind,
        row.code,
        row.label,
        row.meaning,
        row.description
      ])
    }
    const content = toCsv(csvRows)
    // Any withholding (category chips or hidden quality notes) makes the row count worth
    // reporting, so a much smaller file than the headline issue count is never a surprise.
    const filtered =
      groupFilter.length > 0 || fixFocus !== null || (!showQuality && qualityCount > 0)
    try {
      const path = await encore().saveTextFile({ defaultName: 'encore-issues.csv', content })
      csvState =
        path === null
          ? { status: 'canceled' }
          : { status: 'saved', path, rowCount: filtered ? exportRows.length : null }
    } catch (err) {
      csvState = { status: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── mount: load last report if one exists ────────────────────────────────
  onMount(() => {
    void encore()
      .issuesLast()
      .then((last) => {
        if (last !== null) {
          rows = last
          hasLoaded = true
        }
      })
      .catch(() => {
        // Not critical; the user can run a fresh scan
      })
    // Asked once, before any row is drawn: availability is a property of the machine, not of a
    // row, and 24,151 rows are not going to ask it each.
    void loadFixable()
    // Backups outlive the session, so a repair made yesterday is still undoable today and has to
    // be listed without the user repeating the scan that produced it.
    void loadBackups()
  })

  // ── progress line ─────────────────────────────────────────────────────────
  // 'canceled' is null here for the same reason 'done' is: both are said better elsewhere, by
  // the report itself, and by the SCAN CANCELED line below, which also has to explain that the
  // list underneath belongs to an earlier scan.
  const progressLine = $derived(
    scanJob
      ? scanJob.status === 'running'
        ? `${scanJob.phase}${scanJob.percent != null ? ` · ${scanJob.percent}%` : ''}`
        : scanJob.status === 'done' || scanJob.status === 'canceled'
          ? null
          : (scanJob.message ?? scanJob.phase)
      : null
  )
</script>

<div class="tools">
  <div class="toolbar">
    <!-- Blocked during a run as well as during a scan: a re-scan would replace the very rows the
         queue is working through. -->
    <button class="btn-primary" disabled={scanning || fixRunning} onclick={() => void runScan()}>
      {scanning ? 'Scanning…' : 'Scan library for issues'}
    </button>
    <!-- Only while a scan is actually in flight. A permanently present Cancel would be a control
         that does nothing most of the time, and the button beside it already says "Scanning…". -->
    {#if scanning}
      <button class="hairline" disabled={scanCanceling} onclick={() => void cancelScan()}>
        {scanCanceling ? 'Stopping…' : 'Cancel'}
      </button>
    {/if}
    {#if rows.length > 0}
      <button class="hairline" disabled={visibleRows.length === 0} onclick={() => void exportCsv()}>
        Export CSV
      </button>
    {/if}
  </div>

  <p class="intro">
    Checks every chart in your library for problems: missing audio or album art, chart files Clone
    Hero cannot play, and song.ini values it rejects or shows wrong. Results are grouped by what
    went wrong, so you know which charts to fix or download again.
  </p>

  <!-- Above the issue report and outside it, because it answers a different question from a
       different source: the issue scan walks the filesystem on a button press, and this reads the
       catalogue on mount. It is one line until it is opened, so the view still leads with the
       scan. -->
  <Duplicates />

  {#if progressLine}
    <p class="progress mono">{progressLine}</p>
  {/if}

  {#if scanCanceled}
    <!-- The second half is the part that matters: the list below did NOT come from the scan that
         was just stopped, and saying only "canceled" would leave the user reading stale counts as
         if they were fresh ones. -->
    <p class="progress mono">
      SCAN CANCELED{hasLoaded ? '. SHOWING THE LAST COMPLETED REPORT' : ''}
    </p>
  {/if}

  {#if scanError}
    <p class="progress mono">ERROR: {scanError}</p>
  {/if}

  {#if csvState}
    <p class="progress mono">
      {#if csvState.status === 'saved'}
        SAVED {csvState.rowCount != null ? `${csvState.rowCount} ROWS ` : ''}{csvState.path}
      {:else if csvState.status === 'canceled'}
        CANCELED
      {:else}
        ERROR: {csvState.message}
      {/if}
    </p>
  {/if}

  <!-- ── what Encore can repair ──────────────────────────────────────────────
       Above the filters, and counted across every row regardless of them. Two of the four fixes
       live on codes the quality toggle hides, so a summary drawn from the visible rows would be
       silent about 54 of the 61 repairable charts in a real library. (Distinct charts over the
       219-chart reference library, not "62 of 71", which added per-code chart counts together
       and double-counts every chart carrying more than one code.) -->
  {#if fixGroups.length > 0 && fixable !== null}
    <div class="fixable">
      <div class="fx-head">
        <h2 class="fx-title">
          Encore can fix {fixableChartCount} of these chart{fixableChartCount === 1 ? '' : 's'}
        </h2>
        {#if hiddenFixableCount > 0}
          <p class="fx-note">
            {hiddenFixableCount} of them {hiddenFixableCount === 1 ? 'is' : 'are'} hidden by the current
            filters. Show puts {hiddenFixableCount === 1 ? 'it' : 'them'} on screen.
          </p>
        {/if}
      </div>
      {#each fixGroups as group (group.actionCode)}
        {@const blocked = fixBlockedReason(group.actionCode)}
        <div class="fx-row">
          <span class="fx-label">{group.title}</span>
          <span class="fx-count mono">
            {group.chartPaths.length} CHART{group.chartPaths.length === 1 ? '' : 'S'}
            {#if group.rows.length !== group.chartPaths.length}
              · {group.rows.length} FIXES
            {/if}
          </span>
          <!-- Labelled with what it will show: four of these sit in a column, and "Show" on its
               own is the same name four times over to anyone not reading the row it is in. -->
          <button
            class="hairline"
            class:on={fixFocus === group.actionCode}
            aria-label={`${fixFocus === group.actionCode ? 'Showing' : 'Show'}: ${group.title}`}
            onclick={() => (fixFocus = fixFocus === group.actionCode ? null : group.actionCode)}
          >
            {fixFocus === group.actionCode ? 'Showing' : 'Show'}
          </button>
          {#if blocked === null}
            <button
              class="btn-primary fx-fix"
              disabled={fixRunning}
              aria-label={`Fix all ${group.chartPaths.length}: ${group.title}`}
              onclick={() => confirmGroup(group.actionCode)}
            >
              Fix all {group.chartPaths.length}
            </button>
          {/if}
        </div>
        {#if blocked !== null}
          <!-- The reason, then the answer to it, on the spot. Sending the user to Settings to work
               out what "badVideo" needs is how a tool loses someone. -->
          <p class="fx-blocked">
            {blocked}
            {#if group.actionCode === 'badVideo'}
              <button
                class="hairline"
                disabled={ffmpegInstalling}
                onclick={() => void installFfmpeg()}
              >
                {#if !ffmpegInstalling}
                  Install ffmpeg
                {:else if ffmpegJob?.percent != null}
                  Installing… {ffmpegJob.percent}%
                {:else}
                  Installing…
                {/if}
              </button>
            {/if}
          </p>
        {/if}
      {/each}
      {#if ffmpegError}
        <p class="fx-blocked mono">ERROR: {ffmpegError}</p>
      {/if}
    </div>
  {/if}

  <!-- ── a run in flight, and what it left behind ───────────────────────────── -->
  {#if fixRunning}
    <div class="fix-progress">
      <div class="fp-line">
        <span class="mono fp-count">
          FIXING {Math.min(fixDone + 1, fixTotal)} OF {fixTotal}
        </span>
        <span class="mono fp-phase">
          {fixPhase}{fixPercent != null ? ` · ${fixPercent}%` : ''}
        </span>
        <button class="hairline" disabled={fixCanceling} onclick={() => void cancelFixes()}>
          {fixCanceling ? 'Stopping…' : 'Cancel'}
        </button>
      </div>
      <p class="fp-path mono">{fixActive?.chartPath}</p>
      <!-- A real bar only when ffmpeg is reporting real progress. The other fixes are a few
           milliseconds of file writing and have no fraction to show; a bar crawling through an
           imagined percentage would be inventing information. -->
      {#if fixPercent != null}
        <div class="fp-track"><div class="fp-fill" style:width={`${fixPercent}%`}></div></div>
      {/if}
    </div>
  {/if}

  {#if fixSummary}
    <p class="progress mono">{fixSummary}</p>
  {/if}
  {#each fixFailures.slice(0, 5) as failure (failure.chartPath + failure.message)}
    <p class="progress fx-failure mono">FAILED {failure.chartPath}: {failure.message}</p>
  {/each}
  {#if fixFailures.length > 5}
    <p class="progress mono">+ {fixFailures.length - 5} MORE FAILED</p>
  {/if}

  <!-- ── undo ────────────────────────────────────────────────────────────────
       Directly under the run's result, because that is the moment the user decides whether they
       wanted it. Nothing is drawn when there is nothing to undo. -->
  {#if backups.length > 0}
    <div class="undo">
      <div class="fx-head">
        <h2 class="fx-title">
          {backups.length} fix{backups.length === 1 ? '' : 'es'} can be undone
        </h2>
        <p class="fx-note">
          Encore kept what each fix replaced, so any of them can be put back exactly as it was. The
          copies stay until you clear them in Settings.
        </p>
      </div>
      {#each visibleBackups as backup (backup.id)}
        <div class="ub-row">
          <div class="ub-text">
            <span class="ub-chart">{fallbackChartName(backup.chartPath)}</span>
            <span class="ub-what">{backup.describe}</span>
          </div>
          <span class="ub-size mono">{formatBytes(backup.sizeBytes)}</span>
          <button
            class="hairline"
            disabled={undoingId !== null || fixRunning}
            aria-label={`Undo: ${backup.describe} in ${backup.chartPath}`}
            onclick={() => void undoBackup(backup)}
          >
            {#if undoingId !== backup.id}
              Undo
            {:else}
              {undoPhase ?? 'Undoing'}…
            {/if}
          </button>
        </div>
        {#if undoErrors[backup.id]}
          <!-- The refusal is the feature, not an error to shrug at: "this chart has changed since
               the repair" is Encore declining to overwrite something the user did after it. -->
          <p class="ub-error">{undoErrors[backup.id]}</p>
        {/if}
      {/each}
      {#if backups.length > UNDO_VISIBLE}
        <button class="hairline ub-more" onclick={() => (showAllBackups = !showAllBackups)}>
          {showAllBackups ? 'Show fewer' : `Show all ${backups.length}`}
        </button>
      {/if}
    </div>
  {/if}

  {#if rows.length > 0}
    {#if fixFocus !== null}
      <!-- The chips are replaced rather than kept, because while a fix is focused they are not
           what is filtering the list and leaving them lit would say otherwise. -->
      <div class="chips">
        <span class="chips-label mono">SHOWING</span>
        <span class="focus-name"
          >{fixGroups.find((g) => g.actionCode === fixFocus)?.title ?? 'fixable issues'}</span
        >
        <button class="chip" onclick={() => (fixFocus = null)}>Show everything</button>
      </div>
    {:else}
      <div class="chips">
        <span class="chips-label mono">SHOW</span>
        {#each groupChips as chip (chip.id)}
          <button
            class="chip"
            class:on={groupFilter.includes(chip.id)}
            aria-pressed={groupFilter.includes(chip.id)}
            title={chip.blurb}
            onclick={() => toggleGroup(chip.id)}
          >
            {chip.label}
            <span class="chip-count mono">{chip.count}</span>
          </button>
        {/each}
        {#if qualityCount > 0}
          <button
            class="chip quality-toggle"
            class:on={showQuality}
            aria-pressed={showQuality}
            title="Charting-craft notes from scan-chart: short sustains, notes placed close together, difficulties that duplicate Expert. The chart still plays."
            onclick={() => (showQuality = !showQuality)}
          >
            Charting quality notes
            <span class="chip-count mono">{qualityCount}</span>
          </button>
        {/if}
      </div>
    {/if}

    <p class="totals mono">
      {issueCount} ISSUE{issueCount === 1 ? '' : 'S'} IN {chartCount} CHART{chartCount === 1
        ? ''
        : 'S'}
    </p>
  {/if}

  <div class="results">
    {#if rows.length === 0 && hasLoaded && !scanning}
      <p class="empty">No problems found. Every chart in your library checked out.</p>
    {:else if !hasLoaded && !scanning}
      <p class="empty">No report yet. Scan library for issues checks every chart you have.</p>
      <!-- `fixFocus === null` matters: a focused fix is showing rows the severity toggle is
           hiding, so `severityRows` can be empty while the list below it is full. -->
    {:else if severityRows.length === 0 && fixFocus === null && !scanning}
      <p class="empty">
        Nothing is broken. Every chart plays. The {qualityCount} finding{qualityCount === 1
          ? ''
          : 's'} above {qualityCount === 1 ? 'is a' : 'are'} charting quality note{qualityCount ===
        1
          ? ''
          : 's'}. Turn them on to read them.
      </p>
    {:else if sections.length > 0}
      {#each sections as section (section.id)}
        <section class="group">
          <div class="g-head">
            <h2 class="g-title">{section.label}</h2>
            <span class="g-count mono">{section.count}</span>
          </div>
          <p class="g-blurb">{section.blurb}</p>
          {#each section.charts as [chartPath, chartRows] (chartPath)}
            {@const chartFixes = chartRows.filter(
              (r) => r.fix !== null && fixReady(r.fix.actionCode)
            )}
            <div class="chart-group">
              <div class="chart-header">
                <span class="chart-path mono">{chartPath}</span>
                <!-- Offered only when EVERY row here is repairable, and only when there is more
                     than one. A single row already has its own button, and "Fix all 1" is a
                     control that says less than the thing beside it. -->
                {#if chartFixes.length === chartRows.length && chartFixes.length > 1}
                  <button
                    class="hairline chart-fix"
                    disabled={fixRunning}
                    aria-label={`Fix all ${chartFixes.length} in ${chartPath}`}
                    onclick={() => confirmChart(chartFixes)}
                  >
                    Fix all {chartFixes.length}
                  </button>
                {/if}
                <span class="chart-count mono">{chartRows.length}</span>
              </div>
              <!-- Keyed by index: a chart can legitimately report the same code with the
                   same description more than once (several notes at one timestamp), and a
                   duplicate key is a hard runtime error that blanks the whole list. -->
              {#each chartRows.slice(0, ROWS_PER_CHART) as row, i (i)}
                <div class="issue-row">
                  <div class="i-head">
                    <span class="i-label">{row.label}</span>
                    <!-- Raw code stays on screen, secondary: greppable and matches the CSV. -->
                    <span class="i-code mono">{row.code}</span>
                    <!-- A row with no action renders exactly as it did before this milestone: no
                         disabled button, no tooltip implying we could help if only you asked.
                         Most of a real report is these, and its worth is that it is honest. -->
                    {#if row.fix !== null && fixReady(row.fix.actionCode)}
                      <button
                        class="hairline i-fix"
                        disabled={fixRunning}
                        title={row.fix.describe}
                        aria-label={`Fix ${row.label} in ${chartPath}`}
                        onclick={() => confirmRow(row)}
                      >
                        Fix
                      </button>
                    {/if}
                  </div>
                  <p class="i-meaning">{row.meaning}</p>
                  {#if row.detail}
                    <p class="i-detail">{row.detail}</p>
                  {/if}
                  {#if row.fix !== null}
                    {@const blocked = fixBlockedReason(row.fix.actionCode)}
                    {#if blocked !== null}
                      <p class="i-blocked">
                        {blocked}
                        {#if row.fix.actionCode === 'badVideo'}
                          <button
                            class="hairline"
                            disabled={ffmpegInstalling}
                            onclick={() => void installFfmpeg()}
                          >
                            {ffmpegInstalling ? 'Installing…' : 'Install ffmpeg'}
                          </button>
                        {/if}
                      </p>
                    {/if}
                  {/if}
                </div>
              {/each}
              {#if chartRows.length > ROWS_PER_CHART}
                <p class="more mono">
                  + {chartRows.length - ROWS_PER_CHART} MORE IN THIS CHART. EXPORT CSV TO SEE THEM ALL
                </p>
              {/if}
            </div>
          {/each}
        </section>
      {/each}
    {:else if fixFocus !== null && !scanning}
      <!-- Reached by fixing every row of a focused group, which is a success and should not read
           as an empty filter. -->
      <p class="empty">
        Nothing left to fix here.
        <button class="linkish" onclick={() => (fixFocus = null)}>Show everything</button>
      </p>
    {:else if rows.length > 0 && !scanning}
      <!-- Rows exist but the active category chips filter them all out. -->
      <p class="empty mono">NO ISSUES MATCH THE SELECTED FILTERS</p>
    {/if}
  </div>

  <!-- ── confirmation ────────────────────────────────────────────────────────
       Every one of these writes to or deletes from a file in the user's library, so each names
       the chart and the exact file before it happens. "Clean up duplicates" is not a confirmation
       for something that deletes. -->
  {#if confirming !== null}
    <div class="modal">
      <!-- A button, not a div: it is dismissable with a click anywhere outside the card, and a
           button needs no a11y-ignore for having a click handler. Tab never lands on it, because
           the card below keeps Tab inside itself; the keyboard's ways out are Cancel and Escape. -->
      <button class="backdrop" aria-label="Cancel this fix" onclick={() => (confirming = null)}
      ></button>
      <!-- tabindex="-1", as on the shortcut sheet and the tour: a click on the card's own text
           would otherwise send focus to body, from where the next Tab walks into the view behind
           and this card's keydown never sees the key. -->
      <div
        class="c-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fix-confirm-title"
        tabindex="-1"
        bind:this={confirmCard}
        onkeydown={(event) => {
          if (confirmCard) wrapTab(event, confirmCard)
        }}
      >
        <h2 class="c-title" id="fix-confirm-title">
          Fix {confirmCharts.length} chart{confirmCharts.length === 1 ? '' : 's'}?
        </h2>
        <p class="c-what">{confirming.title}</p>
        <ul class="c-list">
          {#each confirmCharts.slice(0, CONFIRM_CHARTS) as entry (entry.chartPath)}
            <li>
              <span class="c-path mono">{entry.chartPath}</span>
              {#each entry.sentences as sentence, i (i)}
                <span class="c-sentence">{sentence}</span>
              {/each}
            </li>
          {/each}
        </ul>
        {#if confirmCharts.length > CONFIRM_CHARTS}
          <p class="c-more mono">
            + {confirmCharts.length - CONFIRM_CHARTS} MORE CHART{confirmCharts.length -
              CONFIRM_CHARTS ===
            1
              ? ''
              : 'S'}, THE SAME FIX ON EACH
          </p>
        {/if}
        {#if confirmDuration !== null}
          <p class="c-duration">{confirmDuration}</p>
        {/if}
        <p class="c-safety">
          None of this touches the chart file. Afterwards Encore re-reads each chart and checks that
          the ID Clone Hero matches charts by has not changed, so a fix cannot quietly cost you
          multiplayer.
        </p>
        <div class="c-actions">
          <button class="hairline" onclick={() => (confirming = null)}>Cancel</button>
          <button class="btn-primary" bind:this={confirmButton} onclick={startConfirmed}>
            Fix {confirmCharts.length} chart{confirmCharts.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && confirming !== null) confirming = null
  }}
/>

<style>
  .quality-toggle {
    /* Set apart from the category chips: this one changes what counts as a problem,
       the others only filter what is already on screen. */
    margin-left: 6px;
    border-style: dashed;
  }
  .more {
    padding: 6px 12px 10px;
    font-size: var(--fs-caption);
    color: var(--text-3);
    letter-spacing: var(--ls-caps);
  }
  .tools {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--hairline);
    flex-shrink: 0;
  }
  .hairline {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    font-family: var(--font-ui);
    flex-shrink: 0;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .hairline:hover:not(:disabled) {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .hairline:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Primary action of this view. */
  .btn-primary {
    border: 0;
    border-radius: 6px;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
    font-size: var(--fs-secondary);
    padding: 6px 14px;
    cursor: pointer;
    font-family: var(--font-ui);
    flex-shrink: 0;
    transition: filter var(--t-fast) var(--ease);
  }
  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Purpose line, which reads before any scan, so the view explains itself cold. */
  .intro {
    padding: 10px 16px 4px;
    margin: 0;
    max-width: 78ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
    flex-shrink: 0;
  }
  .progress {
    padding: 6px 16px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .chips {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px 6px;
    flex-shrink: 0;
  }
  .chips-label {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .chip:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .chip.on {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.25);
    background: var(--surface-2);
  }
  .chip-count {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .totals {
    padding: 4px 16px 8px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
    letter-spacing: var(--ls-caps);
    flex-shrink: 0;
  }
  .results {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .empty {
    padding: 16px 0;
    color: var(--text-3);
    font-size: var(--fs-secondary);
  }
  /* Category section: plain-language heading, then the charts it affects. */
  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }
  .group:first-child {
    margin-top: 0;
  }
  .g-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .g-title {
    margin: 0;
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--text-1);
  }
  .g-count {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .g-blurb {
    margin: -4px 0 0;
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  /* One card per chart: header strip + its issue rows. */
  .chart-group {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .chart-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 12px;
    background: var(--surface-2);
  }
  .chart-path {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    margin-right: 8px;
  }
  .chart-count {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
    flex-shrink: 0;
  }
  .issue-row {
    padding: 8px 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.035);
  }
  .i-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  /* The human label leads; the code trails it as quiet, copyable provenance. */
  .i-label {
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--text-1);
  }
  .i-code {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .i-meaning {
    margin: 3px 0 0;
    font-size: var(--fs-secondary);
    color: var(--text-2);
    line-height: var(--lh-snug);
  }
  /* scan-chart's own wording, which carries the specifics (file name, instrument, difficulty). */
  .i-detail {
    margin: 3px 0 0;
    font-size: var(--fs-secondary);
    color: var(--text-3);
    line-height: var(--lh-snug);
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono);
  }

  /* ── what Encore can repair ───────────────────────────────────────────────
     A card rather than another chip row: it is the one part of this view that offers to change
     something, and it has to read as an offer rather than as one more filter. */
  .fixable {
    margin: 8px 16px 2px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 10px 12px 11px;
    flex-shrink: 0;
  }
  /* The undo panel is the fixable panel's counterpart and shares its shell deliberately: one is
     what Encore can do to the library, the other is what it can take back. */
  .undo {
    margin: 8px 16px 2px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 10px 12px 11px;
    flex-shrink: 0;
  }
  .ub-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.035);
  }
  .ub-text {
    flex: 1;
    min-width: 0;
  }
  .ub-chart {
    display: block;
    font-size: var(--fs-secondary);
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ub-what {
    display: block;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
  }
  .ub-size {
    font-size: var(--fs-caption);
    color: var(--text-3);
    letter-spacing: var(--ls-caps);
    flex-shrink: 0;
  }
  .ub-error {
    margin: 0 0 5px;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-2);
    max-width: 80ch;
    overflow-wrap: anywhere;
  }
  .ub-more {
    margin-top: 8px;
  }
  .fx-head {
    margin-bottom: 6px;
  }
  .fx-title {
    margin: 0;
    font-size: var(--fs-secondary);
    font-weight: 600;
    color: var(--text-1);
  }
  .fx-note {
    margin: 3px 0 0;
    font-size: var(--fs-secondary);
    line-height: var(--lh-snug);
    color: var(--text-2);
    max-width: 70ch;
  }
  .fx-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    border-top: 1px solid rgba(255, 255, 255, 0.035);
  }
  .fx-label {
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--text-1);
    flex: 1;
    min-width: 0;
  }
  .fx-count {
    font-size: var(--fs-caption);
    color: var(--text-3);
    letter-spacing: var(--ls-caps);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .fx-fix {
    font-size: var(--fs-secondary);
    padding: 4px 11px;
  }
  .hairline.on {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.25);
    background: var(--surface-2);
  }
  .fx-blocked {
    margin: 0 0 4px;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
    max-width: 74ch;
  }
  .fx-blocked button {
    margin-left: 6px;
    vertical-align: baseline;
  }

  /* ── a run in flight ──────────────────────────────────────────────────── */
  .fix-progress {
    margin: 6px 16px 0;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 8px 12px 10px;
    flex-shrink: 0;
  }
  .fp-line {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .fp-count {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-1);
    flex-shrink: 0;
  }
  .fp-phase {
    font-size: var(--fs-caption);
    color: var(--text-2);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fp-path {
    margin: 4px 0 0;
    font-size: var(--fs-caption);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fp-track {
    margin-top: 7px;
    height: 3px;
    border-radius: 2px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .fp-fill {
    height: 100%;
    background: var(--accent-grad);
    transition: width var(--t-fast) var(--ease);
  }
  .fx-failure {
    white-space: normal;
    line-height: var(--lh-snug);
  }
  .focus-name {
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--text-1);
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--text-1);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    text-decoration: underline;
    cursor: pointer;
  }

  /* ── per-row and per-chart actions ────────────────────────────────────── */
  .i-fix,
  .chart-fix {
    font-size: var(--fs-caption);
    padding: 2px 9px;
    margin-left: auto;
  }
  .chart-fix {
    margin-left: 0;
    margin-right: 8px;
  }
  .i-blocked {
    margin: 5px 0 0;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .i-blocked button {
    margin-left: 6px;
  }

  /* ── confirmation ─────────────────────────────────────────────────────── */
  .modal {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    border: 0;
    padding: 0;
    cursor: default;
  }
  /* A full-viewport element cannot wear the app's focus ring without ringing the
     whole window, so its ring is drawn just inside the edge instead. */
  .backdrop:focus-visible {
    outline-offset: -3px;
  }
  /* The card itself does NOT scroll; `.c-list` does. When the whole card was the scroller, a plan
     with enough charts to overflow it opened already scrolled down: `confirmButton.focus()` pulls
     the focused button into view, which on a 39-chart plan scrolled 113px and pushed "Repair 39
     charts?" off the top. The heading and the two buttons are the parts a confirmation cannot
     afford to hide, so they stay outside the scrolling region and the list gives way instead. */
  .c-card {
    position: relative;
    width: min(560px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 16px 18px 14px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  }
  /* Focused only by a click on its own text (see the markup); it is a container, not a control,
     so it gets no ring of its own. */
  .c-card:focus-visible {
    outline: none;
  }
  .c-title {
    margin: 0;
    font-size: var(--fs-emphasis);
    font-weight: 600;
    color: var(--text-1);
  }
  .c-what {
    margin: 4px 0 10px;
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  .c-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* The one part of the card allowed to shrink and scroll. `min-height: 0` is what permits it:
       without it the list's automatic minimum is its full content height, and the card would grow
       past `max-height` again instead of the list yielding. */
    overflow-y: auto;
    min-height: 0;
  }
  .c-list li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-left: 2px solid var(--hairline);
    padding-left: 9px;
  }
  .c-path {
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .c-sentence {
    font-size: var(--fs-secondary);
    line-height: var(--lh-snug);
    color: var(--text-1);
  }
  .c-more {
    margin: 8px 0 0;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .c-duration {
    margin: 10px 0 0;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-1);
  }
  .c-safety {
    margin: 8px 0 0;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .c-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 14px;
  }
</style>
