<script lang="ts">
  import { get } from 'svelte/store'
  import {
    ADVANCED_FLAGS,
    ADVANCED_RANGES,
    ADVANCED_SINGLES,
    ADVANCED_TEXT_FIELDS,
    advancedBody,
    cloneAdvanced,
    emptyAdvanced,
    type AdvancedQuery,
    type RangeSpec
  } from '../api/advanced'
  import { INSTRUMENTS } from '../api/enchor'
  import type { SearchStore } from '../stores/search'

  let { search }: { search: SearchStore } = $props()

  // Seeded from the store rather than from nothing: Explore is destroyed by every navigation and
  // by opening a chart Detail, so a form that only lived here would be empty on the way back even
  // though the results it produced were still on screen.
  //
  // svelte-ignore state_referenced_locally
  // (Reading the seed once is the point. The store this panel edits is the same object for the
  // life of the app, and re-seeding the draft from it would undo the user's typing.)
  let draft = $state<AdvancedQuery>(cloneAdvanced(get(search.advancedDraft)))

  // Every edit goes back to the store as it is made. The request does not: `applyAdvanced` is
  // what searches, and it is behind the Search button, because thirty controls searching on
  // change is thirty requests against the 50 a minute the API allows.
  $effect(() => {
    search.setAdvancedDraft($state.snapshot(draft) as AdvancedQuery)
  })

  // svelte-ignore state_referenced_locally
  // (As with the stores below: one store, for the life of the app.)
  const draftReset = search.advancedDraftReset

  // Seeded again whenever the store replaced the draft itself rather than being handed one. The
  // Clear chip beside the Advanced button is on screen while this panel is open and goes straight
  // to the store, which cannot reach this copy: the boxes went on showing an artist and an album
  // that nothing was filtering by, and the next keystroke in any of them wrote all of it back and
  // re-armed the dropped-filters banner's offer to put it back too. The header's intensity band
  // writes the draft the same way, through `setIntensity`.
  $effect(() => {
    // Read for the dependency. The number itself means nothing; see `advancedDraftReset`.
    void $draftReset
    draft = cloneAdvanced(get(search.advancedDraft))
  })

  function apply(): void {
    // Written through here as well as in the effect above, so a press that lands in the same tick
    // as the keystroke before it still searches for what is in the boxes.
    search.setAdvancedDraft($state.snapshot(draft) as AdvancedQuery)
    search.applyAdvanced()
  }

  function clear(): void {
    draft = emptyAdvanced()
    search.clearAdvanced()
  }

  // svelte-ignore state_referenced_locally
  // (As above: one store, for the life of the app.)
  const applied = search.advanced
  // svelte-ignore state_referenced_locally
  const filters = search.filters

  /**
   * Whether the boxes are asking something the rows on screen did not come back for.
   *
   * The count of applied filters is NOT repeated here. It is on the Advanced button directly
   * above this panel, in a badge that is on screen whether the panel is open or shut, and a
   * second copy of one number is a second place for it to be wrong. What the header cannot say
   * is this: the form does not search as it is edited, so thirty filled-in controls above a list
   * that ignores them is the panel's own failure mode, and nothing else on screen admits to it.
   *
   * Compared as request bodies rather than as forms, so the parts of the draft that would not
   * be sent (a blank box, a half-typed `1e`, an unticked Exact beside an empty value) do not
   * count as an unsearched edit. `advancedBody` builds its keys in a fixed order, so two equal
   * bodies stringify identically.
   */
  const unsearched = $derived(
    JSON.stringify(advancedBody($applied)) !==
      JSON.stringify(advancedBody($state.snapshot(draft) as AdvancedQuery))
  )

  /**
   * The intensity pair, which is the one range this panel shares with the filter header.
   *
   * It stays here rather than being handed over outright, for two reasons. It is the same two
   * fields the header's band edits and not a copy of them (`setIntensity` writes both the applied
   * query and this draft), so an open panel has to show what the header set. And these two boxes
   * take any integer, which the header's two lists deliberately do not: they run 1 to 6 with an
   * open 7+ floor, and a ceiling of 0 or of 8 is only askable here.
   *
   * What does NOT stay is the trap. Intensity is rated per instrument, and with none named the
   * endpoint reads the band against all of them at once; an uncharted instrument carries -1, so
   * every chart clears any maximum and `maxIntensity: 1` answers with 95,093 of the 95,299 charts
   * there are (measured; see ADVANCED_RANGES). So the pair is off until an instrument is chosen,
   * exactly as the header's band is, and off it says why.
   */
  function isIntensity(range: RangeSpec): boolean {
    return range.min === 'minIntensity'
  }

  const instrument = $derived($filters.instrument)
  const bandOff = $derived(instrument === null)
  const instrumentLabel = $derived(
    INSTRUMENTS.find((opt) => opt.value === instrument)?.label ?? 'the chosen instrument'
  )

  /**
   * What to call one end of a range out loud.
   *
   * The live intensity boxes are named plainly, with no instrument in the name, because the
   * header's own band is named for the instrument and two controls sharing one accessible name
   * is one control a screen reader cannot point at. Off, they take the reason instead, because a
   * disabled control that does not say why is a dead end.
   */
  function rangeName(end: 'Lowest' | 'Highest', range: RangeSpec): string {
    const base = `${end} ${range.label.toLowerCase()}${range.unit ? `, in ${range.unit}` : ''}`
    return isIntensity(range) && bandOff ? `${base}, off until an instrument is chosen` : base
  }

  /**
   * The singles, split by the question they answer rather than by their shape in the API.
   *
   * "Updated after" is a range with one end, so it belongs with the ranges. The two hashes are
   * not a way to narrow a search at all: each one identifies a single chart, and a hash in the
   * box makes every other control on this form irrelevant. They go last, on their own.
   */
  const WHEN = ADVANCED_SINGLES.filter((single) => single.key === 'modifiedAfter')
  const EXACT = ADVANCED_SINGLES.filter((single) => single.key !== 'modifiedAfter')
</script>

<!-- The form is a form: Enter in any box submits it, which is what anyone who has typed a title
     into the first field expects, and it saves a reach for the button at the bottom of thirty
     controls. -->
<form
  class="panel"
  id="advanced-panel"
  onsubmit={(e) => {
    e.preventDefault()
    apply()
  }}
>
  <!-- The controls scroll and the actions do not. The form is taller than the window has to give
       at every size the shell supports: 458px of controls at a 1308px view, 901px at the 509px
       one where the columns stack, against a window that can be 600px tall. Unbounded it took
       that height from the list rather than from itself, and `.table` came back 1px with the
       results gone, in this panel's 0.3.1 shape as well as in this one. Search and Clear stay
       outside the scroller, because a primary action you have to scroll a form to reach is one
       that gets missed. -->
  <div class="body">
    <div class="cols">
      <fieldset class="col">
        <legend>Words</legend>
        <p class="hint">
          Exact matches the whole field rather than part of it. Exclude leaves matching charts out.
        </p>
        {#each ADVANCED_TEXT_FIELDS as field (field.key)}
          <div class="row">
            <label class="field-label" for="adv-{field.key}">{field.label}</label>
            <input
              class="text-input"
              id="adv-{field.key}"
              type="text"
              autocomplete="off"
              bind:value={draft.text[field.key].value}
            />
            <!-- Pressed pills rather than checkboxes, which is what the rest of this panel and
                 the filter header above it already use for a thing that is on or off: the chart
                 features below, Explore's List/Grid pair. Twelve checkboxes among them were the
                 app asking one kind of question two ways.

                 Named after the field rather than "Exact": six controls all called Exact are six
                 controls a screen reader cannot tell apart, and the visible word stays because
                 sighted readers have the row to place it. -->
            <button
              class="toggle mod"
              type="button"
              aria-label="Match {field.label} exactly"
              aria-pressed={draft.text[field.key].exact}
              onclick={() => (draft.text[field.key].exact = !draft.text[field.key].exact)}
              >Exact</button
            >
            <button
              class="toggle mod"
              type="button"
              aria-label="Exclude charts matching {field.label}"
              aria-pressed={draft.text[field.key].exclude}
              onclick={() => (draft.text[field.key].exclude = !draft.text[field.key].exclude)}
              >Exclude</button
            >
          </div>
        {/each}
      </fieldset>

      <fieldset class="col">
        <legend>Numbers</legend>
        <p class="hint">Either end on its own works. Leave both empty to ignore a range.</p>
        {#each ADVANCED_RANGES as range (range.label)}
          {@const off = isIntensity(range) && bandOff}
          <div class="row">
            <span class="field-label" class:muted={off}>{range.label}</span>
            <!-- `value` and `oninput` rather than `bind:value`: a bound number input hands back a
                 number, or null once the box is empty, and the draft holds strings so that a
                 blank box is "not set" and a half-typed "1e" is still on screen while it is being
                 typed.

                 No `max`, on any of these and least of all on intensity. Charters rate past the
                 top of the drawn scale: `{instrument: 'guitar', minIntensity: 7}` answers with
                 2,419 charts reading 7, 8, 9 and 20 (measured 2026-09-15), so a ceiling here
                 would quietly exclude real results. Length is in MINUTES and goes out as typed;
                 see ADVANCED_RANGES for what reading it as seconds cost. -->
            <input
              class="num"
              type="number"
              step={range.step}
              inputmode="decimal"
              placeholder="any"
              disabled={off}
              aria-label={rangeName('Lowest', range)}
              value={draft.numbers[range.min]}
              oninput={(e) => (draft.numbers[range.min] = e.currentTarget.value)}
            />
            <span class="to" class:muted={off}>to</span>
            <input
              class="num"
              type="number"
              step={range.step}
              inputmode="decimal"
              placeholder="any"
              disabled={off}
              aria-label={rangeName('Highest', range)}
              value={draft.numbers[range.max]}
              oninput={(e) => (draft.numbers[range.max] = e.currentTarget.value)}
            />
            {#if range.unit}<span class="to" class:muted={off}>{range.unit}</span>{/if}
            {#if off}
              <span class="why">pick an instrument</span>
            {:else if isIntensity(range)}
              <span class="why">rated for {instrumentLabel}</span>
            {/if}
          </div>
        {/each}
        {#each WHEN as single (single.key)}
          <div class="row">
            <label class="field-label" for="adv-{single.key}">{single.label}</label>
            <!-- The `type` varies by field, and Svelte will not two-way bind an input whose type
                 is dynamic, so this pair does by hand what `bind:value` would have done. -->
            <input
              class="text-input"
              id="adv-{single.key}"
              type={single.type}
              autocomplete="off"
              aria-describedby="adv-hint-{single.key}"
              value={draft.singles[single.key]}
              oninput={(e) => (draft.singles[single.key] = e.currentTarget.value)}
            />
            <span class="hint inline" id="adv-hint-{single.key}">{single.hint}</span>
          </div>
        {/each}
      </fieldset>
    </div>

    <fieldset class="flags">
      <legend>What the chart has</legend>
      <p class="hint">
        A lit one means the chart has to have it. Nothing here asks for its absence, because Chorus
        Encore's own form does not either.
      </p>
      <div class="flag-row">
        {#each ADVANCED_FLAGS as flag (flag.key)}
          <button
            class="toggle"
            type="button"
            aria-pressed={draft.flags[flag.key]}
            onclick={() => (draft.flags[flag.key] = !draft.flags[flag.key])}>{flag.label}</button
          >
        {/each}
      </div>
    </fieldset>

    <!-- Full width and side by side rather than a third column, which is what these two used to
         be. Measured at a 668px view: the third fieldset did not fit beside the other two and
         wrapped to a grid row of its own 216px tall, so two short fields cost as much height as a
         column of six. A third column only fits from 832px of view up, and the view is 509px at
         its narrowest. -->
    <fieldset class="exact">
      <legend>One exact chart</legend>
      <div class="exact-row">
        {#each EXACT as single (single.key)}
          <div class="pair">
            <label class="field-label" for="adv-{single.key}">{single.label}</label>
            <input
              class="text-input"
              id="adv-{single.key}"
              type={single.type}
              autocomplete="off"
              aria-describedby="adv-hint-{single.key}"
              value={draft.singles[single.key]}
              oninput={(e) => (draft.singles[single.key] = e.currentTarget.value)}
            />
            <span class="hint inline" id="adv-hint-{single.key}">{single.hint}</span>
          </div>
        {/each}
      </div>
    </fieldset>
  </div>

  <div class="actions">
    <button class="apply" type="submit">Search</button>
    <!-- Always present, not only while something is on: a form that has been edited but not
         searched has nothing to show for itself yet, and this is the way back out of it. -->
    <button class="clear" type="button" onclick={clear}>Clear filters</button>
    {#if unsearched}
      <!-- role="status" rather than "alert": it follows something the user just did, and the
           button beside it is already the way to act on it. -->
      <span class="pending" role="status">Not searched yet</span>
    {/if}
  </div>
</form>

<style>
  /* The header's second storey rather than a card that landed on top of it. The filter row above
     ends without a rule and this picks up its 16px gutter, so opening Advanced reads as the
     header getting taller; the one rule is at the bottom, where the header now ends. A bordered
     box here made the same controls look like a dialog about the list rather than part of it. */
  .panel {
    display: flex;
    flex-direction: column;
    padding: 2px 16px 12px;
    margin-bottom: 10px;
    border-bottom: 1px solid var(--hairline);
    /* Everything the window has spare, and no more, so the list keeps a floor rather than the
       panel keeping a share.

       430px is what is above and around this, measured rather than picked: the search box and
       filter row above it are 118px, and 150px at the 509px view where that row wraps to three
       lines; the window chrome outside the results column is 130px; and the rest is a floor for
       the list, so that narrowing by a filter still visibly answers. The floor holds at every
       width the shell supports: 182px of list, and 150px in that one narrow case. A plain 50vh
       left 20px of list at the 600px minimum window, and no bound at all left 1px.

       How many rows or cards that floor is has NOT been measured. The offscreen run this was
       measured in reaches no network, so the list it reports is an empty box of the right
       height; see scripts/measure-advanced-panel.mjs.

       The form is 458px of controls at 1308px of view and 901px at 509px, where the columns
       stack, so how much of it this bound hides depends on both dimensions; the panel scrolls the
       rest rather than taking it off the list. Above a 1000px window the wide case fits whole. */
    max-height: calc(100vh - 430px);
  }
  .body {
    overflow-y: auto;
    /* A flex item's floor is its content, so without this the scroller is never shorter than the
       form inside it and the `max-height` above does nothing. */
    min-height: 0;
  }
  /* auto-fit over a floor rather than two declared columns: the window is resizable and this
     panel is wide, so a fixed two would crush the text boxes at the 509px the view narrows to
     when the preview rail opens. */
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(264px, 1fr));
    gap: 14px 20px;
  }
  /* fieldset/legend rather than a div and a heading: these are groups of controls, and the
     grouping is what a screen reader announces when focus enters one. The UA border is dropped
     because the columns are told apart by their gutter and a second frame is noise. */
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  /* The header's own micro-label, to the letter: mono, caps, --ls-caps, --text-3. The same voice
     as the RESULTS count at the top of the view. */
  legend {
    padding: 0 0 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
  }
  .hint {
    margin: 0 0 8px;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
    max-width: 46ch;
  }
  .hint.inline {
    margin: 0;
    flex: 1 1 100%;
  }
  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 7px;
  }
  /* Explore's `.band-label`, which is the label beside its intensity pair: one size, one colour
     for every name that sits to the left of a control. */
  .field-label {
    flex: 0 0 62px;
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  /* Every control in this panel is the header's chip: --surface-1 on the window, one hairline,
     fully rounded. The panel used to raise its boxes to --surface-2 while sitting on a card of
     its own, which put the same input one step lighter here than in the row above it. */
  .text-input,
  .num {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    padding: 4px 11px;
    color: var(--text-1);
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    transition: border-color var(--t-fast) var(--ease);
    min-width: 0;
  }
  .text-input {
    flex: 1 1 110px;
  }
  .num {
    width: 68px;
    flex: 0 0 auto;
  }
  .text-input:focus,
  .num:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Matches the disabled chip in the filter header, which is the same state for the same reason:
     intensity is not a question until an instrument is chosen. */
  .num:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .to {
    font-size: var(--fs-caption);
    color: var(--text-3);
    white-space: nowrap;
  }
  /* The reason the pair is off, and what it is a band of once it is on. Explore's `.band-why`. */
  .why {
    font-size: var(--fs-caption);
    color: var(--text-3);
    white-space: nowrap;
  }
  .muted {
    opacity: 0.5;
  }
  .flags,
  .exact {
    margin-top: 12px;
  }
  .flag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .exact-row {
    display: flex;
    flex-wrap: wrap;
    gap: 7px 20px;
  }
  /* The same floor the columns above use, so the two hashes break onto separate lines at exactly
     the width the columns do rather than at one of their own. */
  .pair {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    flex: 1 1 264px;
    min-width: 0;
  }
  /* Explore's layout pair and Installed's filter toggles, to the pixel: the same question asked
     of a different catalog should not look like a different control. */
  .toggle {
    appearance: none;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 12px;
    cursor: pointer;
    white-space: nowrap;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  /* The two modifiers on a text field are subordinate to it: same shape, one step quieter, so a
     row reads as a box with two switches on it rather than as three controls of equal weight. */
  .toggle.mod {
    font-size: var(--fs-caption);
    padding: 3px 9px;
  }
  .toggle:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .toggle[aria-pressed='true'] {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text-1);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--hairline);
  }
  /* The one action the panel exists for, in the same gradient as Detail's Download and Explore's
     bulk Download, because it is the same weight of act: it spends a request. */
  .apply {
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--accent-grad);
    color: #fff;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    font-weight: 600;
    padding: 5px 16px;
    cursor: pointer;
    transition: filter var(--t-fast) var(--ease);
  }
  .apply:hover {
    filter: brightness(1.12);
  }
  .clear {
    background: none;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .clear:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .pending {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    white-space: nowrap;
  }
</style>
