<script lang="ts">
  import { encore } from '../stores/bridge'
  import { fallbackChartName } from '../../../../shared/format'
  import {
    chartListsPhrase,
    describeChartListMove,
    sameChart,
    chartKey
  } from '../../../../shared/chart-key'
  import { favouriteIds, isFavourited, reloadFavourites } from '../stores/favourites'
  import { setlists, setlistsWith, reloadSetlists } from '../stores/setlists'
  import {
    GAMEPLAY_KEYS_NOTE,
    METADATA_FIELDS,
    yearRefusal,
    type ChartMetadataFields,
    type EditableIniKey
  } from '../../../../shared/metadata-fields'
  import type { ChartMetadataRead } from '../../../../main/metadata/edit'
  import type { ChartRecord } from '../../../../shared/schemas'

  /**
   * The metadata editor: the one place in Encore where what the user typed is written into a
   * chart they own.
   *
   * ## What it is the answer to
   *
   * The Issues view finds `missingValue` and deliberately refuses to repair it. Its own words
   * are that a Chorus entry matched by exact hash is this same upload carrying the same blank,
   * and for a difficulty rating it goes further: "Only the person who charted it can say how hard
   * it is, so Encore cannot fill it in." That is true of the ratings and it is NOT true of the
   * album, the year or the artist's spelling, which the person who owns the chart knows. This
   * view is that gap and nothing wider, which is why it offers six fields and not thirty. See
   * shared/metadata-fields.ts for how the six were chosen.
   *
   * ## The seven it will not offer
   *
   * `getChartHash` mixes seven gameplay keys into what Clone Hero matches charts between players
   * by, and this form REFUSES them rather than warning about them. Three reasons, in order:
   * `assertKeyIsNotHashed` in main already throws on them, so a form that offered a text box
   * would be offering a control whose save cannot succeed; the cost of getting one wrong is paid
   * socially, weeks later, in a lobby, with nothing to trace it back to; and a confirmation
   * dialog is a thing people click through, which is not a suitable last line of defence for a
   * chart there is no copy of.
   *
   * They are SHOWN, read-only, with the sentence saying why, because the alternative is a form
   * that silently lacks them and a user who goes looking for the setting that turns them on. That
   * is the same decision `unrepairableNote` made for the two Issues rows that look repairable and
   * are not, and it is worded to agree with them.
   *
   * ## One chart at a time
   *
   * There is no batch here, and that is a decision rather than an omission. Five of the six
   * fields (title, album, year, genre, charter) are per-chart values a batch could only overwrite
   * with one shared string, which is a way of making a library wrong faster. The sixth, the
   * artist's spelling, is the one genuinely batch-shaped case, and nothing in this repo measures
   * how many charts a rename would touch: the catalog records spelling variants as separate
   * `catalog:facets` entries rather than as a finding, so there is no count to size the feature
   * against. Re-open it on that measurement.
   *
   * ## Props
   *
   * `chart` opens the editor on a chart something else already chose (a future Edit control on
   * the preview rail, say). Null, which is what the nav entry passes, opens the finder instead.
   * `onSaved` hands back the chart's re-indexed catalog row, so a caller holding a list can
   * refresh the row the user just corrected without a scan.
   */
  let {
    chart = null,
    onSaved
  }: {
    chart?: ChartRecord | null
    onSaved?: (record: ChartRecord) => void
  } = $props()

  /**
   * The chart being edited: the prop, until the finder picks something else.
   *
   * A writable `$derived` rather than state seeded once, so a caller that later hands in a
   * DIFFERENT chart re-opens the editor on it, and so the finder's own choice survives every
   * re-render in between. The plain `$state(chart)` form would ignore the second chart; a
   * `$state` kept in step by an `$effect` would draw the finder for one frame on a mount that
   * already knows which chart it is about.
   */
  let chosen = $derived(chart)

  let read = $state<ChartMetadataRead | null>(null)
  let loadError = $state<string | null>(null)
  let loading = $state(false)

  /** What is in the boxes. Seeded from the file, and compared against it to find what changed. */
  let draft = $state<ChartMetadataFields | null>(null)

  let saving = $state(false)
  let saveError = $state<string | null>(null)
  /** What the last successful save changed, for the line that confirms it. Null before any. */
  let savedFields = $state<EditableIniKey[] | null>(null)
  /**
   * What the last successful save did to the user's favourites and setlists, or null.
   *
   * Kept beside `savedFields` rather than folded into it, because it is the answer to a different
   * question: that one says what the chart now holds, this one says what moved somewhere else.
   */
  let movedLists = $state<string | null>(null)

  $effect(() => {
    const target = chosen
    read = null
    draft = null
    loadError = null
    saveError = null
    savedFields = null
    movedLists = null
    let stale = false
    const abandon = (): void => {
      stale = true
    }
    if (target === null) return abandon
    loading = true
    encore()
      .chartReadMetadata({ path: target.path, chartType: target.chartType })
      .then((answer) => {
        // The chart changed while the read was in flight: discard it, or the form would fill
        // with one chart's values under another chart's name.
        if (stale) return
        read = answer
        draft = { ...answer.fields }
      })
      .catch((err: unknown) => {
        if (!stale) loadError = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        if (!stale) loading = false
      })
    return abandon
  })

  /** Only what the user changed. A key absent here is a line the ini editor never looks at. */
  const dirty = $derived.by<EditableIniKey[]>(() => {
    const onDisk = read
    const typed = draft
    if (onDisk === null || typed === null) return []
    return METADATA_FIELDS.map((field) => field.key).filter(
      (key) => typed[key].trim() !== onDisk.fields[key].trim()
    )
  })

  /** The one field with a shape the catalog cannot hold anything else in. See `yearRefusal`. */
  const yearProblem = $derived(draft === null ? null : yearRefusal(draft.year))

  /**
   * The lists this chart is on, named, while what is typed would rename it out from under them.
   *
   * Three of the six boxes above are the three fields a favourite and a setlist entry are keyed by
   * (shared/chart-key.ts), so editing any of them renames the thing those rows name. Main moves
   * them with the chart and the line under the button says what it moved, but a warning BEFORE the
   * press is what stops the user having to undo an edit to find out. Null when nothing would move:
   * when the three fields are untouched, when the edit is a change of case only, which every one of
   * these comparisons ignores anyway, and when the chart is on no list.
   *
   * Read off the FILE rather than off the catalog row, because the file is what the boxes hold and
   * a row can lag it by a scan.
   */
  const listsAtStake = $derived.by(() => {
    const onDisk = read
    const typed = draft
    if (onDisk === null || typed === null) return null
    const from = chartKey(onDisk.fields)
    if (sameChart(from, chartKey(typed))) return null
    return chartListsPhrase(
      isFavourited($favouriteIds, from),
      [...setlistsWith($setlists, from)].map(
        (id) => $setlists.find((list) => list.id === id)?.name ?? ''
      )
    )
  })

  const canSave = $derived(
    read !== null && read.refusal === null && dirty.length > 0 && yearProblem === null && !saving
  )

  async function save(): Promise<void> {
    if (draft === null || chosen === null || !canSave) return
    const fields: Partial<ChartMetadataFields> = {}
    for (const key of dirty) fields[key] = draft[key].trim()
    saving = true
    saveError = null
    savedFields = null
    movedLists = null
    try {
      const result = await encore().chartWriteMetadata({
        path: chosen.path,
        chartType: chosen.chartType,
        fields
      })
      savedFields = result.changed
      movedLists = describeChartListMove(result.listMove)
      // The two stores hold what main had BEFORE this save, and a save that renamed the chart has
      // just moved rows in both. Re-read them, or the heart on the rail would keep drawing the old
      // title as the favourited one until the next launch. Only when something actually moved:
      // most saves touch no list at all, and two IPC calls per album correction is noise.
      if (result.listMove !== null && result.listMove !== undefined) {
        await Promise.all([reloadFavourites(), reloadSetlists()])
      }
      // Re-read rather than assuming: the file is the authority, and the values it now holds are
      // what the next save has to diff against. An assumed state would let a second save send a
      // field the first one had already written.
      const fresh = await encore().chartReadMetadata({
        path: chosen.path,
        chartType: chosen.chartType
      })
      read = fresh
      draft = { ...fresh.fields }
      // `chosen` is deliberately NOT replaced with the fresh row. It is what the load effect
      // keys on, so assigning a new object would re-run the read, and with it wipe the line that
      // just said what was saved. The heading reads its title off `read` instead, which is the
      // file rather than a row that may lag it.
      if (result.record !== null) onSaved?.(result.record)
    } catch (err) {
      // The message from main, verbatim. Every refusal it can produce is already a sentence
      // written for this screen: a chart that has moved, an archive that packs its own song.ini,
      // a write that failed, a hash that moved.
      saveError = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }

  function revert(): void {
    if (read === null) return
    draft = { ...read.fields }
    saveError = null
    savedFields = null
    movedLists = null
  }

  // ── the finder ─────────────────────────────────────────────────────────────
  /**
   * Choosing a chart from inside the view, because the nav entry arrives with none.
   *
   * A search over the catalog rather than a list of the whole library: the reference library runs
   * to 219 charts and a real one to thousands, and somebody who came here is thinking of one
   * chart in particular. `catalog:query` is a read the app already makes on every Installed page.
   */
  let query = $state('')
  let results = $state<ChartRecord[]>([])
  let searching = $state(false)
  let searchError = $state<string | null>(null)
  let searched = $state(false)

  $effect(() => {
    const term = query.trim()
    let stale = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const abandon = (): void => {
      stale = true
      clearTimeout(timer)
    }
    if (chosen !== null) return abandon
    searchError = null
    if (term === '') {
      results = []
      searched = false
      return abandon
    }
    searching = true
    // A short wait, so a five-letter artist is one query rather than five. The catalog is local
    // and fast, but the list redrawing under a typist's fingers is the cost worth avoiding.
    timer = setTimeout(() => {
      encore()
        .catalogQuery({ search: term, limit: 25 })
        .then((rows) => {
          if (stale) return
          results = rows
          searched = true
        })
        .catch((err: unknown) => {
          if (!stale) searchError = err instanceof Error ? err.message : String(err)
        })
        .finally(() => {
          if (!stale) searching = false
        })
    }, 200)
    return abandon
  })

  function choose(record: ChartRecord): void {
    chosen = record
    query = ''
    results = []
    searched = false
  }

  function clearChart(): void {
    chosen = null
  }

  /**
   * The heading, read off the FILE once it has been read and off the catalog row until then.
   *
   * The row is what the finder listed and can lag the chart by a scan; the file is what the form
   * below is editing. Taking the heading from the row would leave a saved title corrected in the
   * box and stale two lines above it.
   */
  const title = $derived.by(() => {
    if (chosen === null) return ''
    return read?.fields.name || chosen.name || fallbackChartName(chosen.path)
  })
  const subtitle = $derived.by(() => {
    if (chosen === null) return ''
    const parts =
      read === null ? [chosen.artist, chosen.album] : [read.fields.artist, read.fields.album]
    return parts.filter(Boolean).join(' · ')
  })

  const savedLine = $derived.by(() => {
    if (savedFields === null) return null
    if (savedFields.length === 0) return 'Nothing to change: the chart already said this.'
    const names = savedFields
      .map((key) => METADATA_FIELDS.find((field) => field.key === key)?.label ?? key)
      .join(', ')
    return `Saved. ${names} ${savedFields.length === 1 ? 'is' : 'are'} now what this chart says.`
  })
</script>

<!--
  One centred column, capped at a measure, exactly as Settings is and for the same reason: the
  view column is 509px at its narrowest (a 1121px window, where the rail has just appeared) and
  over 1300px on a wide one, and a form row 1300px across puts its label and its box at opposite
  ends of the screen.
-->
<div class="editor selectable">
  <header class="page">
    <h1>Metadata editor</h1>
    <p class="lede">
      Correct a chart's song details in place: a missing year, an album nobody filled in, an artist
      spelled differently from the rest of your library. Chart issues finds these and will not
      repair them, because Chorus holds the same blanks your copy does. You know what they should
      say.
    </p>
  </header>

  <section class="group" aria-labelledby="metaedit-chart">
    <div class="group-head">
      <h2 id="metaedit-chart">Chart</h2>
      <p class="group-note prose">
        One chart at a time. Every field below belongs to this chart alone, so there is nothing here
        that could be applied to several at once without overwriting what makes them different.
      </p>
    </div>

    {#if chosen === null}
      <div class="block">
        <label class="row-label" for="metaedit-search">Find a chart</label>
        <input
          id="metaedit-search"
          class="wide"
          type="search"
          placeholder="Song, artist, album or charter…"
          bind:value={query}
        />
        {#if searchError}
          <p class="tool-error" role="alert">{searchError}</p>
        {:else if searching}
          <p class="hint mono">SEARCHING…</p>
        {:else if searched && results.length === 0}
          <p class="hint prose">
            No chart in the catalog matches that. Only charts Encore has scanned can be edited,
            because the editor writes to the file the scan found.
          </p>
        {/if}
        {#if results.length > 0}
          <ul class="results">
            {#each results as row (row.path)}
              <li>
                <button class="result" onclick={() => choose(row)}>
                  <span class="r-title">{row.name ?? fallbackChartName(row.path)}</span>
                  <span class="r-sub"
                    >{[row.artist, row.album, row.charter].filter(Boolean).join(' · ') || '—'}</span
                  >
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else}
      <div class="block chosen">
        <div class="chosen-text">
          <p class="chosen-title">{title}</p>
          <p class="chosen-sub">{subtitle || '—'}</p>
          <p class="chosen-path mono">{chosen.path}</p>
        </div>
        <button class="hairline sentence" onclick={clearChart}>Choose another chart</button>
      </div>
    {/if}
  </section>

  {#if chosen !== null}
    <section class="group" aria-labelledby="metaedit-fields">
      <div class="group-head">
        <h2 id="metaedit-fields">Song details</h2>
        <p class="group-note prose">
          These are the six values Clone Hero shows and Encore sorts, filters and groups your
          library by. Clearing one is allowed and means the chart sets nothing, which is how it
          arrived if the field is empty now.
        </p>
      </div>

      {#if loading}
        <p class="block hint mono">READING THE CHART…</p>
      {:else if loadError}
        <p class="block tool-error" role="alert">{loadError}</p>
      {:else if read !== null && read.refusal !== null}
        <!-- Not a failed save: this chart cannot be edited at all, and saying so before anything
             is typed is the whole reason the read carries a sentence rather than a boolean. -->
        <p class="block tool-error" role="alert">{read.refusal}</p>
      {:else if read !== null && draft !== null}
        <div class="block">
          {#each METADATA_FIELDS as field (field.key)}
            <div class="row">
              <div class="row-text">
                <label class="row-label" for="metaedit-{field.key}">{field.label}</label>
                <p class="hint">{field.hint}</p>
              </div>
              <input
                id="metaedit-{field.key}"
                class="wide"
                type="text"
                maxlength="400"
                bind:value={draft[field.key]}
              />
            </div>
            {#if dirty.includes(field.key)}
              <!-- The old value, on screen, for as long as the new one is unsaved. This is the
                   editor's undo: there is no backup store behind a metadata edit, because the
                   value being replaced is one the user is looking at rather than one Encore
                   chose on their behalf. -->
              <p class="was">
                Was <span class="mono">{read.fields[field.key] || '—'}</span>
              </p>
            {/if}
          {/each}

          {#if yearProblem}
            <p class="tool-error" role="alert">{yearProblem}</p>
          {/if}

          {#if listsAtStake}
            <!-- Before the press, not after it. Main carries the rows across either way; this is
                 so the user is not told about it for the first time by a heart that has moved. -->
            <p class="at-stake prose" role="status">
              This chart is in {listsAtStake}. A favourite and a setlist entry name a chart by its
              title, artist and charter, so saving carries this one over to the new details.
            </p>
          {/if}

          <div class="block-actions">
            <button class="btn-primary" disabled={!canSave} onclick={() => void save()}>
              {saving ? 'Saving…' : 'Save to the chart'}
            </button>
            <button
              class="hairline sentence"
              disabled={dirty.length === 0 || saving}
              onclick={revert}
            >
              Revert
            </button>
            <p class="hint prose">
              Writes {read.synthetic
                ? "this chart's header and rebuilds the archive around it"
                : `this chart's ${read.iniName ?? 'song.ini'}`}. Encore re-reads the chart
              afterwards and refuses to report a save unless both of the values Clone Hero
              identifies this chart by are unchanged.
            </p>
          </div>

          {#if saveError}
            <p class="tool-error" role="alert">{saveError}</p>
          {:else if savedLine}
            <!-- One live region holding both lines rather than two: what was saved and what moved
                 with it are one announcement, and two would be read as two events. -->
            <div role="status">
              <p class="saved">{savedLine}</p>
              {#if movedLists}
                <p class="saved prose">{movedLists}</p>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </section>

    <section class="group" aria-labelledby="metaedit-gameplay">
      <div class="group-head">
        <h2 id="metaedit-gameplay">Gameplay values Encore will not edit</h2>
        <p class="group-note prose">{GAMEPLAY_KEYS_NOTE}</p>
      </div>
      <div class="block">
        {#if read !== null && read.gameplay.length > 0}
          <dl class="gameplay">
            {#each read.gameplay as entry (entry.key)}
              <div class="g-row">
                <dt class="mono">{entry.key}</dt>
                <dd class="mono">{entry.value}</dd>
              </div>
            {/each}
          </dl>
          <p class="hint prose">
            Changing one of these by hand is something a text editor will let you do. If you do,
            this chart stops matching every other copy of it.
          </p>
        {:else}
          <p class="hint prose">
            This chart leaves all seven at their defaults, so none of them is mixed into its
            identity at all. Nothing here to show, and nothing here to lose.
          </p>
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  /* The measure and the card shape are Settings', deliberately: this is the app's other form,
     and two forms that answer to different geometry read as two applications. */
  .editor {
    padding: 22px 24px 36px;
    max-width: 768px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .page {
    margin-bottom: 2px;
  }
  h1 {
    font-size: var(--fs-heading);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
    line-height: var(--lh-display);
  }
  .lede {
    margin-top: 6px;
    max-width: 62ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .group {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    box-shadow: var(--elev-2);
    padding: 16px 18px 18px;
  }
  h2 {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
  }
  .group-head {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-1);
  }
  .group-note {
    margin-top: 6px;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .block {
    padding-top: 14px;
  }
  /* A control row: its name and its explanation on the left, the box on the right, and the box
     dropping to a line of its own once the pair no longer fits. At 509px, which is the narrowest
     this view is ever asked to be, every row is stacked; above about 700px they sit side by
     side. Both states are the design rather than one being a fallback. */
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .row + .row {
    margin-top: 14px;
  }
  .row-text {
    flex: 1 1 200px;
    min-width: 0;
  }
  .row-label {
    display: block;
    font-size: var(--fs-secondary);
    color: var(--text-1);
  }
  .row-text .hint {
    margin-top: 3px;
  }
  input {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    padding: 6px 9px;
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    transition: border-color var(--t-fast) var(--ease);
  }
  input:focus {
    border-color: var(--border-2);
  }
  /* 260px is the point below which a label and a box on one line leave the box too narrow to
     read a song title in; the same number Settings' template field uses.

     Grows at twice the label's rate, which is not cosmetic. The label block holds a word and a
     short sentence and stops needing room quickly; the box holds a song title, and the longest
     in the reference library needs 476px to draw at once. Splitting the row's spare width evenly
     left the box at 365px on a 1920px window with 768px of column to spend. */
  input.wide {
    flex: 2 1 260px;
    min-width: 0;
  }
  /* The finder's box is not in a flex row, so the growth above does nothing for it and it fell
     back to the user agent's own 202px at every window width. It is the only control on its
     line and it holds a search term, so it takes the line. */
  input#metaedit-search {
    display: block;
    width: 100%;
    margin-top: 8px;
  }
  /* The old value, under the row that changed it. Indented to the box's side of the row on a
     wide window and left where it falls on a narrow one, which is where the box is too. */
  .was {
    margin-top: 5px;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
  }
  .was .mono {
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .block-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  .block-actions .hint {
    flex: 1 1 260px;
    min-width: 0;
  }
  .btn-primary {
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    padding: 6px 14px;
    cursor: pointer;
    flex-shrink: 0;
    transition: filter var(--t-fast) var(--ease);
  }
  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .btn-primary:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .hairline {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    font-family: var(--font-mono);
    flex-shrink: 0;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .hairline.sentence {
    font-family: var(--font-ui);
  }
  .hairline:hover:not(:disabled) {
    color: var(--text-1);
    border-color: var(--border-2);
  }
  .hairline:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .hint {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .prose {
    max-width: 68ch;
    line-height: var(--lh-prose);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
  }
  .tool-error {
    margin-top: 10px;
    font-size: var(--fs-caption);
    color: var(--text-2);
    line-height: var(--lh-prose);
    overflow-wrap: anywhere;
  }
  /* Green, where the refusals above are neutral. A save that worked is the one moment in this
     view worth colouring, and --success is outside the accent family so it cannot read as a
     selection. */
  .saved {
    margin-top: 10px;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--success);
  }
  /* The move line is a continuation of the line above it, not a second announcement, so it sits
     closer to that than the first sits to the button. */
  .saved + .saved {
    margin-top: 4px;
  }
  /* --warning, not --error: nothing here is wrong and nothing is being refused. It is the colour
     the app already uses for a consequence the user should see before they choose it. */
  .at-stake {
    margin-top: 10px;
    font-size: var(--fs-caption);
    color: var(--warning);
  }
  /* The results list is a well: the one place in this view holding the user's content rather
     than controls, which is what --ground-0 is the token scale's recessed step for. */
  .results {
    margin-top: 10px;
    list-style: none;
    background: var(--ground-0);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    max-height: 320px;
    overflow-y: auto;
  }
  .results li + li {
    border-top: 1px solid var(--border-1);
  }
  .result {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    padding: 8px 11px;
    cursor: pointer;
    font-family: var(--font-ui);
    transition: background var(--t-fast) var(--ease);
  }
  .result:hover {
    background: var(--ground-2);
  }
  .r-title {
    display: block;
    font-size: var(--fs-secondary);
    color: var(--text-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .r-sub {
    display: block;
    margin-top: 1px;
    font-size: var(--fs-caption);
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chosen {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }
  .chosen-text {
    flex: 1 1 260px;
    min-width: 0;
  }
  .chosen-title {
    font-size: var(--fs-emphasis);
    font-weight: 600;
    color: var(--text-1);
    line-height: var(--lh-tight);
    overflow-wrap: anywhere;
  }
  .chosen-sub {
    margin-top: 2px;
    font-size: var(--fs-secondary);
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  /* Wraps rather than ellipsises, on the same argument Settings' library paths make: the path is
     the content of the line, and there is only ever one of them here. */
  .chosen-path {
    margin-top: 4px;
    font-size: var(--fs-caption);
    color: var(--text-3);
    line-height: var(--lh-snug);
    overflow-wrap: anywhere;
  }
  .gameplay {
    background: var(--ground-0);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
  }
  .g-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 6px 11px;
  }
  .g-row + .g-row {
    border-top: 1px solid var(--border-1);
  }
  .g-row dt {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .g-row dd {
    flex: 0 0 auto;
    color: var(--text-1);
  }
  .gameplay + .hint {
    margin-top: 10px;
  }
</style>
