<script lang="ts">
  import { onMount } from 'svelte'
  import { toCsv } from '../../../../shared/csv'
  import {
    DUPLICATE_TIERS,
    type DuplicateCopy,
    type DuplicateReport,
    type DuplicateTierId
  } from '../../../../shared/duplicates'
  import { fallbackChartName } from '../../../../shared/format'
  import { encore } from '../stores/bridge'

  /**
   * What the library holds more than one copy of.
   *
   * Lives beside the issue report rather than inside it, and is deliberately not one of its
   * rows: an issue is something wrong with a chart, and two of these three tiers are not wrong
   * with anything. It also comes from a different place. The issue scan walks the filesystem and
   * takes seconds; this is two grouped queries over the catalog and takes tens of milliseconds,
   * so it loads on mount with no button to press and no progress to report.
   *
   * **Nothing here removes anything.** The only action offered is opening a copy in the system
   * file manager. Deleting a chart folder is a different class of operation from the verified,
   * undoable asset writes this app makes, and a report that is confident enough to point at a
   * duplicate is not the same as a tool that should be trusted to remove one.
   */

  /**
   * Groups drawn per tier before the rest are folded behind a button.
   *
   * A library that has been collected for years can report alternate charts in the hundreds, and
   * a page of six hundred expanded groups is a scroll nobody finishes. The export carries every
   * one of them; this bounds the DOM, not the data.
   */
  const GROUPS_SHOWN = 25

  let report = $state.raw<DuplicateReport | null>(null)
  let loadError = $state<string | null>(null)
  let open = $state(false)
  /** Which tiers have been expanded past GROUPS_SHOWN. */
  let expanded = $state<DuplicateTierId[]>([])
  /** Why a reveal failed, against the path that failed. Empty is the normal state. */
  let revealErrors = $state.raw<Record<string, string>>({})

  type CsvState =
    | { status: 'saved'; path: string }
    | { status: 'canceled' }
    | { status: 'error'; message: string }
    | null
  let csvState = $state<CsvState>(null)

  const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  onMount(() => {
    void encore()
      .catalogDuplicates()
      .then((result) => {
        report = result
      })
      .catch((err: unknown) => {
        loadError = asMessage(err)
      })
  })

  /**
   * Copies that could be removed without losing a chart: every copy past the first in each
   * identical group.
   *
   * Counted for tier 1 alone. The other two tiers have no such number, because there is nothing
   * about them that is spare, and inventing one for the summary would be the whole mistake this
   * report is arranged to avoid.
   */
  const redundantCopies = $derived(
    (report?.identical ?? []).reduce((total, group) => total + group.copies.length - 1, 0)
  )

  const identicalCharts = $derived(
    (report?.identical ?? []).reduce((total, group) => total + group.copies.length, 0)
  )

  const anything = $derived(
    report !== null &&
      (report.identical.length > 0 || report.versions.length > 0 || report.alternates.length > 0)
  )

  /** The one-line answer, which is the only thing on screen until the panel is opened. */
  const summary = $derived.by(() => {
    if (report === null) return null
    if (!anything) return 'Nothing in your library is installed twice.'
    const parts: string[] = []
    if (report.identical.length > 0) {
      parts.push(
        `${identicalCharts} charts are the same chart file (${redundantCopies} ` +
          `${redundantCopies === 1 ? 'copy is' : 'copies are'} spare)`
      )
    }
    if (report.versions.length > 0) {
      parts.push(
        `${report.versions.length} ${report.versions.length === 1 ? 'chart is' : 'charts are'} installed at more than one version`
      )
    }
    if (report.alternates.length > 0) {
      parts.push(
        `${report.alternates.length} ${report.alternates.length === 1 ? 'song has' : 'songs have'} charts by more than one charter`
      )
    }
    return `${parts.join('. ')}.`
  })

  /** `3 SETS`, `1 SET`. The counts beside the tier headings are the only place it is needed. */
  function counted(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 'S'}`
  }

  function toggleExpanded(tier: DuplicateTierId): void {
    expanded = expanded.includes(tier) ? expanded.filter((t) => t !== tier) : [...expanded, tier]
  }

  function shown<T>(tier: DuplicateTierId, groups: T[]): T[] {
    return expanded.includes(tier) ? groups : groups.slice(0, GROUPS_SHOWN)
  }

  function tierMeta(id: DuplicateTierId): { title: string; blurb: string } {
    // Non-null by construction: DUPLICATE_TIERS carries an entry for every DuplicateTierId, and
    // the type is what keeps the two in step. The fallback keeps this total without an assertion.
    return DUPLICATE_TIERS.find((t) => t.id === id) ?? { title: id, blurb: '' }
  }

  function copyLabel(copy: DuplicateCopy): string {
    const title = copy.name?.trim() ?? ''
    const artist = copy.artist?.trim() ?? ''
    if (title && artist) return `${artist} - ${title}`
    if (title) return title
    // Falls back to reading a name out of the path, the same way the rest of the app does for a
    // chart whose song.ini gave it none.
    return fallbackChartName(copy.path)
  }

  /**
   * Open one copy in the system file manager.
   *
   * The whole of what this view does about a duplicate, on purpose: it puts the user in front of
   * both copies in the place where deleting one is their decision, made with their own file
   * manager's confirmation and their own undo.
   */
  async function reveal(path: string): Promise<void> {
    revealErrors = Object.fromEntries(Object.entries(revealErrors).filter(([p]) => p !== path))
    try {
      await encore().chartReveal(path)
    } catch (err) {
      revealErrors = { ...revealErrors, [path]: asMessage(err) }
    }
  }

  /**
   * Every group in the report, flattened one row per copy.
   *
   * Exports the whole report rather than what is on screen, unlike the issue export: the caps
   * here are a rendering budget rather than a filter the user chose, so a file that stopped at
   * the twenty-fifth group would be missing rows for a reason nobody asked for. The tier is the
   * first column, so the file can be read back without having to infer which list a row was in.
   */
  async function exportCsv(): Promise<void> {
    if (report === null) return
    csvState = null
    const rows: string[][] = [
      ['tier', 'group', 'artist', 'title', 'charter', 'chartType', 'path', 'cloneHeroChecksum']
    ]
    const push = (tier: string, group: string, copy: DuplicateCopy): void => {
      rows.push([
        tier,
        group,
        copy.artist ?? '',
        copy.name ?? '',
        copy.charter ?? '',
        copy.chartType,
        copy.path,
        copy.cloneHeroChecksum ?? ''
      ])
    }
    for (const group of report.identical) {
      for (const copy of group.copies) push('identical', group.checksum, copy)
    }
    for (const group of report.versions) {
      for (const copy of group.copies) {
        push('versions', `${group.artist} - ${group.name} [${group.charter}]`, copy)
      }
    }
    for (const group of report.alternates) {
      for (const charter of group.charters) {
        for (const copy of charter.copies) {
          push('alternates', `${group.artist} - ${group.name}`, copy)
        }
      }
    }
    try {
      const path = await encore().saveTextFile({
        defaultName: 'encore-duplicates.csv',
        content: toCsv(rows)
      })
      csvState = path === null ? { status: 'canceled' } : { status: 'saved', path }
    } catch (err) {
      csvState = { status: 'error', message: asMessage(err) }
    }
  }
</script>

<section class="dupes">
  <div class="d-head">
    <h2 class="d-title">Duplicate charts</h2>
    {#if report === null && loadError === null}
      <span class="d-sum mono">READING THE CATALOGUE…</span>
    {:else if loadError !== null}
      <span class="d-sum mono">ERROR: {loadError}</span>
    {:else}
      <span class="d-sum">{summary}</span>
      {#if anything}
        <button class="hairline" aria-expanded={open} onclick={() => (open = !open)}>
          {open ? 'Hide' : 'Show'}
        </button>
        <button class="hairline" onclick={() => void exportCsv()}>Export CSV</button>
      {/if}
    {/if}
  </div>

  <!-- Said whenever it is not zero, and above the lists rather than under them: without it "no
       identical copies" reads as a finding, when on a catalogue scanned by an older build it
       means the comparison had nothing to work with. -->
  {#if report !== null && report.unidentifiedCharts > 0}
    <p class="d-note">
      {report.unidentifiedCharts} of your {report.totalCharts} charts carry no chart ID yet, so they cannot
      be compared to the rest. Scanning your library again fills those in.
    </p>
  {/if}

  {#if csvState}
    <p class="d-progress mono">
      {#if csvState.status === 'saved'}
        SAVED {csvState.path}
      {:else if csvState.status === 'canceled'}
        CANCELED
      {:else}
        ERROR: {csvState.message}
      {/if}
    </p>
  {/if}

  {#if open && report !== null}
    <p class="d-safety">
      Encore never deletes a chart. This report says what is duplicated and where each copy is;
      removing one is yours to do, in your own file manager.
    </p>

    {#if report.identical.length > 0}
      {@const meta = tierMeta('identical')}
      <div class="tier">
        <div class="t-head">
          <h3 class="t-title">{meta.title}</h3>
          <span class="t-count mono">{counted(report.identical.length, 'SET')}</span>
        </div>
        <p class="t-blurb">{meta.blurb}</p>
        {#each shown('identical', report.identical) as group (group.checksum)}
          <div class="group">
            <div class="g-head">
              <span class="g-name">{copyLabel(group.copies[0])}</span>
              <span class="g-meta mono">{group.copies.length} COPIES · SAME CHART FILE</span>
            </div>
            {#each group.copies as copy (copy.path)}
              {@render copyRow(copy)}
            {/each}
          </div>
        {/each}
        {@render moreButton('identical', report.identical.length)}
      </div>
    {/if}

    {#if report.versions.length > 0}
      {@const meta = tierMeta('versions')}
      <div class="tier">
        <div class="t-head">
          <h3 class="t-title">{meta.title}</h3>
          <span class="t-count mono">{counted(report.versions.length, 'CHART')}</span>
        </div>
        <p class="t-blurb">{meta.blurb}</p>
        {#each shown('versions', report.versions) as group (`${group.artist}/${group.name}/${group.charter}`)}
          <div class="group">
            <div class="g-head">
              <span class="g-name">{group.artist} - {group.name}</span>
              <span class="g-charter">charted by {group.charter}</span>
              <span class="g-meta mono">
                {group.copies.length} COPIES
                {#if group.versionCount > 1}
                  · {group.versionCount} VERSIONS
                {/if}
                {#if group.unknownCount > 0}
                  · {group.unknownCount} NOT COMPARED
                {/if}
              </span>
            </div>
            <!-- The overlap with the list above, said here rather than left to be worked out by
                 comparing paths between two sections. -->
            {#if group.identicalCopies > 0}
              <p class="g-note">
                {group.identicalCopies} of these are the same chart file as each other, and are listed
                under the same chart installed twice as well.
              </p>
            {/if}
            {#each group.copies as copy (copy.path)}
              {@render copyRow(copy)}
            {/each}
          </div>
        {/each}
        {@render moreButton('versions', report.versions.length)}
      </div>
    {/if}

    <!-- Tier 3. Marked `calm` rather than sharing the other two tiers' styling, because the
         thing most likely to go wrong in this whole view is a user reading it as a fault and
         deleting a chart they deliberately kept. -->
    {#if report.alternates.length > 0}
      {@const meta = tierMeta('alternates')}
      <div class="tier calm">
        <div class="t-head">
          <h3 class="t-title">{meta.title}</h3>
          <span class="t-count mono">{counted(report.alternates.length, 'SONG')}</span>
        </div>
        <p class="t-blurb">{meta.blurb}</p>
        {#each shown('alternates', report.alternates) as group (`${group.artist}/${group.name}`)}
          <div class="group">
            <div class="g-head">
              <span class="g-name">{group.artist} - {group.name}</span>
              <span class="g-meta mono">{group.charters.length} CHARTERS</span>
            </div>
            {#each group.charters as charter (charter.charter)}
              <p class="g-charter-head">{charter.charter}</p>
              {#each charter.copies as copy (copy.path)}
                {@render copyRow(copy)}
              {/each}
            {/each}
          </div>
        {/each}
        {@render moreButton('alternates', report.alternates.length)}
      </div>
    {/if}
  {/if}
</section>

{#snippet copyRow(copy: DuplicateCopy)}
  <div class="copy">
    <span class="c-type mono">{copy.chartType === 'sng' ? 'SNG' : 'FOLDER'}</span>
    <span class="c-path mono">{copy.path}</span>
    <button
      class="hairline"
      aria-label={`Show in folder: ${copy.path}`}
      onclick={() => void reveal(copy.path)}
    >
      Show in folder
    </button>
  </div>
  {#if revealErrors[copy.path]}
    <p class="c-error">{revealErrors[copy.path]}</p>
  {/if}
{/snippet}

{#snippet moreButton(tier: DuplicateTierId, total: number)}
  {#if total > GROUPS_SHOWN}
    <button class="hairline t-more" onclick={() => toggleExpanded(tier)}>
      {expanded.includes(tier) ? `Show first ${GROUPS_SHOWN}` : `Show all ${total}`}
    </button>
  {/if}
{/snippet}

<style>
  .dupes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 16px 12px;
    border-bottom: 1px solid var(--hairline);
    flex-shrink: 0;
  }
  .d-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .d-title {
    margin: 0;
    font-size: var(--fs-emphasis);
    font-weight: 600;
    color: var(--text-1);
  }
  .d-sum {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-secondary);
    color: var(--text-2);
    line-height: var(--lh-prose);
  }
  .d-note,
  .d-safety {
    margin: 0;
    max-width: 78ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .d-progress {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: var(--font-mono);
    letter-spacing: var(--ls-caps);
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
  .hairline:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .tier {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
  }
  .t-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .t-title {
    margin: 0;
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--text-1);
  }
  .t-count {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .t-blurb {
    margin: 0;
    max-width: 78ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  /* The alternate-charts tier. Nothing about it is a warning, so its heading is the same weight
     as the others but its rule is the accent rather than the plain hairline: it reads as an
     aside, which is what it is. */
  .calm .t-title {
    color: var(--text-2);
  }
  .calm .group {
    border-left: 2px solid var(--accent-dim);
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 0 6px 10px;
    border-left: 2px solid var(--hairline);
  }
  .g-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .g-name {
    font-size: var(--fs-secondary);
    color: var(--text-1);
  }
  .g-charter {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .g-meta {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .g-note {
    margin: 2px 0;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
  }
  .g-charter-head {
    margin: 6px 0 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
  }
  .copy {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
  }
  .c-type {
    font-size: var(--fs-caption);
    color: var(--text-3);
    flex-shrink: 0;
  }
  .c-path {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-error {
    margin: 0 0 4px;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-2);
  }
  .t-more {
    align-self: flex-start;
  }
</style>
