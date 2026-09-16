<script lang="ts">
  import { onMount } from 'svelte'
  import { toCsv } from '../../../../shared/csv'
  import {
    PLAY_HISTORY_PROMISE,
    TRASH_PROMISE,
    removalMessage,
    type ChartRemoval
  } from '../../../../shared/chart-removal'
  import {
    assetsHeld,
    assetsOnlyHere,
    DUPLICATE_TIERS,
    type DuplicateCopy,
    type DuplicateReport,
    type DuplicateTierId
  } from '../../../../shared/duplicates'
  import { fallbackChartName, formatBytes, stripRichText } from '../../../../shared/format'
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
   * **Removal is offered on tier 1 and nowhere else.** Tier 1 is the only claim here that
   * survives being acted on: those copies hold the same notes byte for byte. Removing a tier 2
   * copy throws away a different chart and orphans the scores set on it, and tier 3 is not waste
   * at all and says so, so neither carries a button.
   *
   * **Nothing is preselected and nothing is recommended.** Encore could work out which copy is
   * the richer one, and deliberately does not: a recommendation nobody checked is a decision
   * Encore made on the user's behalf, and the whole point of showing what each copy holds is
   * that the user sees the difference before choosing. The copies are listed in path order, as
   * they arrive.
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
  /**
   * The one copy whose removal is being confirmed, by path. Never more than one.
   *
   * The confirmation is an inline panel rather than a second press on a re-labelled button,
   * because it has to name the chart, say where the copy is, and list what that copy holds that
   * the others do not. None of that fits on a button, and all of it is the part the user is
   * meant to read before pressing anything.
   */
  let confirming = $state<string | null>(null)
  /** The path currently being removed, so its buttons can say so and cannot be pressed twice. */
  let removing = $state<string | null>(null)
  /** Why a removal failed, against the path that failed. The chart and its row are untouched. */
  let removeErrors = $state.raw<Record<string, string>>({})
  /** What the last removal did, kept on screen until the next one. */
  let removed = $state<string | null>(null)

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

  /** `a`, `a and b`, `a, b and c`. The asset lists are at most four items long. */
  function sentenceList(items: string[]): string {
    if (items.length < 2) return items.join('')
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
  }

  function copyLabel(copy: DuplicateCopy): string {
    const title = stripRichText(copy.name)
    const artist = stripRichText(copy.artist)
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
   * Drop one copy from the report in place, once it is really gone.
   *
   * Local rather than a second `catalogDuplicates()` call, and not because of the cost. The
   * library watcher has just seen the folder disappear and will run a scan of its own; re-asking
   * for the whole report puts this view in a race with that scan for no gain, when the one thing
   * that changed is a copy this component itself just removed. A group left holding a single
   * copy is no longer a duplicate of anything, so it goes with it.
   */
  function dropCopy(path: string): void {
    if (report === null) return
    report = {
      ...report,
      identical: report.identical
        .map((group) => ({ ...group, copies: group.copies.filter((c) => c.path !== path) }))
        .filter((group) => group.copies.length > 1),
      // The same chart can be listed under tiers 2 and 3 as well, and a path that is gone must
      // not stay on screen under a heading that offers to open it in a file manager.
      versions: report.versions
        .map((group) => ({ ...group, copies: group.copies.filter((c) => c.path !== path) }))
        .filter((group) => group.copies.length > 1),
      alternates: report.alternates
        .map((group) => ({
          ...group,
          charters: group.charters
            .map((charter) => ({
              ...charter,
              copies: charter.copies.filter((c) => c.path !== path)
            }))
            .filter((charter) => charter.copies.length > 0)
        }))
        .filter((group) => group.charters.length > 1),
      totalCharts: Math.max(0, report.totalCharts - 1)
    }
  }

  /**
   * Move one copy to the Trash, after the user has confirmed that copy by name.
   *
   * The failure path is the point: if the trash refuses, nothing about the library has changed,
   * so the copy stays exactly where it is on screen with the reason beside it. There is no
   * second attempt that deletes instead.
   */
  async function remove(copy: DuplicateCopy): Promise<void> {
    confirming = null
    removing = copy.path
    removeErrors = Object.fromEntries(Object.entries(removeErrors).filter(([p]) => p !== copy.path))
    try {
      const result: ChartRemoval = await encore().chartRemove(copy.path)
      removed = removalMessage(result.outcome, copyLabel(copy))
      dropCopy(copy.path)
    } catch (err) {
      removeErrors = { ...removeErrors, [copy.path]: asMessage(err) }
    } finally {
      removing = null
    }
  }

  /**
   * Every group in the report, flattened one row per copy.
   *
   * Exports the whole report rather than what is on screen, unlike the issue export: the caps
   * here are a rendering budget rather than a filter the user chose, so a file that stopped at
   * the twenty-fifth group would be missing rows for a reason nobody asked for. The tier is the
   * first column, so the file can be read back without having to infer which list a row was in.
   *
   * The names go out raw, unlike everywhere they are drawn. This file is a record of what the
   * charts say, sat next to their paths and Clone Hero checksums so it can be joined against a
   * library; a name Encore had quietly rewritten would match neither the song.ini it came from
   * nor the catalog, and stripRichText cannot be undone to recover the original.
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
    {#if report !== null && loadError === null && anything}
      <div class="d-acts">
        <button class="hairline" aria-expanded={open} onclick={() => (open = !open)}>
          {open ? 'Hide' : 'Show'}
        </button>
        <button class="hairline" onclick={() => void exportCsv()}>Export CSV</button>
      </div>
    {/if}
  </div>
  {#if report === null && loadError === null}
    <p class="d-sum mono">READING THE CATALOGUE…</p>
  {:else if loadError !== null}
    <p class="d-sum mono">ERROR: {loadError}</p>
  {:else}
    <p class="d-sum">{summary}</p>
  {/if}

  <!-- Said whenever it is not zero, and above the lists rather than under them: without it "no
       identical copies" reads as a finding, when on a catalogue scanned by an older build it
       means the comparison had nothing to work with. -->
  {#if report !== null && report.unidentifiedCharts > 0}
    <p class="d-note">
      {report.unidentifiedCharts} of your {report.totalCharts} charts carry no chart ID yet and are not
      compared here. Scanning your library again fills those in.
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
      Encore can remove a copy of a chart it found installed twice, and nothing else here. A removal
      goes to your system Trash, so you can put it back from there. Nothing is chosen for you: each
      copy lists what it holds, because two copies of the same chart file can still differ in album
      art, video, background or lyrics.
    </p>

    {#if removed}
      <p class="d-progress mono" role="status">{removed}</p>
    {/if}

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
              {@render copyRow(copy, group.copies)}
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
              <span class="g-name">{stripRichText(group.artist)} - {stripRichText(group.name)}</span
              >
              <span class="g-charter">charted by {stripRichText(group.charter)}</span>
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
              {@render copyRow(copy, null)}
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
              <span class="g-name">{stripRichText(group.artist)} - {stripRichText(group.name)}</span
              >
              <span class="g-meta mono">{group.charters.length} CHARTERS</span>
            </div>
            {#each group.charters as charter (charter.charter)}
              <p class="g-charter-head">{stripRichText(charter.charter)}</p>
              {#each charter.copies as copy (copy.path)}
                {@render copyRow(copy, null)}
              {/each}
            {/each}
          </div>
        {/each}
        {@render moreButton('alternates', report.alternates.length)}
      </div>
    {/if}
  {/if}
</section>

<!-- `group` is the copies this one sits with when a removal can be offered on it, and null on
     the two tiers where it cannot. Passing the whole group rather than a boolean is what lets
     the row say which of its contents no other copy in the set has, which is the only fact that
     makes this decision safe to make from a screen. -->
{#snippet copyRow(copy: DuplicateCopy, group: DuplicateCopy[] | null)}
  {@const held = assetsHeld(copy)}
  {@const only = group === null ? [] : assetsOnlyHere(copy, group)}
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
    {#if group !== null}
      <button
        class="hairline"
        aria-label={`Remove this copy: ${copy.path}`}
        disabled={removing === copy.path}
        onclick={() => (confirming = confirming === copy.path ? null : copy.path)}
      >
        {removing === copy.path ? 'Removing…' : 'Remove'}
      </button>
    {/if}
  </div>
  <!-- Shown for every copy in a removable set, including the ones holding nothing extra: a row
       that only spoke up when it had something would leave the user to read an absence, and an
       absence looks the same as a line that failed to render. -->
  {#if group !== null}
    <p class="c-holds">
      <span class="mono"
        >{copy.sizeBytes === null ? 'SIZE UNREAD' : formatBytes(copy.sizeBytes)}</span
      >
      {#if held.length > 0}
        Holds {sentenceList(held)}.
      {:else}
        No album art, video, background or lyrics.
      {/if}
      {#if only.length > 0}
        <span class="c-only">The only copy here with {sentenceList(only)}.</span>
      {/if}
    </p>
  {/if}
  {#if confirming === copy.path && group !== null}
    <div class="confirm">
      <p class="cf-text">
        Remove this copy of {copyLabel(copy)}?
        {#if only.length > 0}
          It is the only copy in this set with {sentenceList(only)}, and that goes with it.
        {:else}
          Everything this copy holds is held by another copy in this set as well.
        {/if}
        {TRASH_PROMISE}
        {PLAY_HISTORY_PROMISE}
      </p>
      <p class="cf-path mono">{copy.path}</p>
      <div class="cf-buttons">
        <button class="hairline" onclick={() => void remove(copy)}>Move to Trash</button>
        <button class="hairline" onclick={() => (confirming = null)}>Keep it</button>
      </div>
    </div>
  {/if}
  {#if removeErrors[copy.path]}
    <!-- The chart and its catalog row are both still there. The sentence says so, because the
         user is looking at a row that did not disappear and needs to know that is the truth
         rather than a list that failed to refresh. -->
    <p class="c-error" role="alert">
      Could not move this copy to the Trash: {removeErrors[copy.path]}. It is still on disk and
      still in your library.
    </p>
  {/if}
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
  /* A card among the issue cards, and the last of them, because it answers a different question
     from a different source: the issue scan walks the filesystem on a button press, this reads the
     catalogue on mount. One line until it is opened, so the view still leads with what the scan
     found. */
  .dupes {
    display: flex;
    flex-direction: column;
    gap: 7px;
    background: var(--ground-3);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    box-shadow: var(--elev-1);
    padding: 11px 13px;
    flex-shrink: 0;
  }
  /* The title and the two buttons on one line, the summary under them across the whole card.
     Measured: with the summary sharing the line, the 430px left beside the buttons wrapped three
     clauses into four lines and the closed card stood 141px tall. Given the full width it is two,
     and the 30px that saves is 30px the issue rows below get instead. */
  .d-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .d-title {
    flex-shrink: 0;
  }
  .d-acts {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .d-title {
    margin: 0;
    font-size: var(--fs-emphasis);
    line-height: var(--lh-tight);
    font-weight: 600;
    color: var(--text-1);
  }
  .d-sum {
    margin: 0;
    font-size: var(--fs-secondary);
    color: var(--text-2);
    line-height: var(--lh-snug);
    max-width: 78ch;
    min-width: 0;
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
    background: var(--ground-4);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    font-family: var(--font-ui);
    flex-shrink: 0;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .hairline:hover:not(:disabled) {
    color: var(--text-1);
    border-color: var(--border-2);
    background: var(--ground-5);
  }
  .hairline:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tier {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
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
     as the others but quieter, and its rule is the accent rather than the plain hairline: it
     reads as an aside, which is what it is. Every sentence in it says the same thing in words,
     because colour is not where a claim this important is allowed to live. */
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
    padding: 7px 0 7px 10px;
    border-left: 2px solid var(--hairline);
    background: var(--ground-2);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }
  .g-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    padding-right: 10px;
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
    padding-right: 10px;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
  }
  .g-charter-head {
    margin: 6px 0 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
  }
  /* Wraps rather than crushing. At the 509px the view column narrows to with the preview rail
     up, a path and two buttons do not fit on one line, and a path is the one thing in this row
     that has to stay readable: it is how a user tells two copies of one chart apart. */
  .copy {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 3px 10px 3px 0;
  }
  .c-type {
    font-size: var(--fs-caption);
    color: var(--text-3);
    flex-shrink: 0;
  }
  .c-path {
    flex: 1 1 200px;
    min-width: 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-error {
    margin: 0 0 4px;
    padding-right: 10px;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-2);
  }
  /* Indented to the path above it, so the line reads as belonging to that copy rather than to
     the group. Nothing about the removal decision is carried by colour alone: the "only copy
     with" clause is a sentence first and a brighter one second. */
  .c-holds {
    margin: 0 0 2px;
    padding: 0 10px 0 50px;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
  }
  .c-only {
    color: var(--text-1);
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 4px 10px 8px 0;
    padding: 9px 11px;
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    background: var(--ground-4);
  }
  .cf-text {
    margin: 0;
    max-width: 78ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .cf-path {
    margin: 0;
    font-size: var(--fs-caption);
    color: var(--text-3);
    overflow-wrap: anywhere;
  }
  .cf-buttons {
    display: flex;
    gap: 8px;
  }
  .t-more {
    align-self: flex-start;
  }
</style>
