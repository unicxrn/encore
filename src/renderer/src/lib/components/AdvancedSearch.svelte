<script lang="ts">
  import { get } from 'svelte/store'
  import {
    ADVANCED_FLAGS,
    ADVANCED_RANGES,
    ADVANCED_SINGLES,
    ADVANCED_TEXT_FIELDS,
    cloneAdvanced,
    emptyAdvanced,
    type AdvancedQuery
  } from '../api/advanced'
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
  const count = search.advancedCount
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
  <div class="cols">
    <fieldset class="col">
      <legend>Match text</legend>
      <p class="hint">
        Exact matches the whole field rather than part of it. Exclude leaves matching charts out.
      </p>
      {#each ADVANCED_TEXT_FIELDS as field (field.key)}
        <div class="text-row">
          <label class="field-label" for="adv-{field.key}">{field.label}</label>
          <input
            class="text-input"
            id="adv-{field.key}"
            type="text"
            autocomplete="off"
            bind:value={draft.text[field.key].value}
          />
          <!-- Named after the field rather than "Exact": six checkboxes all called Exact are six
               controls a screen reader cannot tell apart, and the visible word stays because
               sighted readers have the row to place it. -->
          <label class="tick">
            <input
              type="checkbox"
              aria-label="Match {field.label} exactly"
              bind:checked={draft.text[field.key].exact}
            />
            <span>Exact</span>
          </label>
          <label class="tick">
            <input
              type="checkbox"
              aria-label="Exclude charts matching {field.label}"
              bind:checked={draft.text[field.key].exclude}
            />
            <span>Exclude</span>
          </label>
        </div>
      {/each}
    </fieldset>

    <fieldset class="col">
      <legend>Ranges</legend>
      <p class="hint">Either end on its own works. Leave both empty to ignore a range.</p>
      {#each ADVANCED_RANGES as range (range.label)}
        <div class="range-row">
          <span class="field-label">{range.label}</span>
          <!-- `value` and `oninput` rather than `bind:value`: a bound number input hands back a
               number, or null once the box is empty, and the draft holds strings so that a blank
               box is "not set" and a half-typed "1e" is still on screen while it is being typed. -->
          <input
            class="num"
            type="number"
            step={range.step}
            inputmode="decimal"
            placeholder="any"
            aria-label="Lowest {range.label.toLowerCase()}{range.unit ? `, in ${range.unit}` : ''}"
            value={draft.numbers[range.min]}
            oninput={(e) => (draft.numbers[range.min] = e.currentTarget.value)}
          />
          <span class="to">to</span>
          <input
            class="num"
            type="number"
            step={range.step}
            inputmode="decimal"
            placeholder="any"
            aria-label="Highest {range.label.toLowerCase()}{range.unit ? `, in ${range.unit}` : ''}"
            value={draft.numbers[range.max]}
            oninput={(e) => (draft.numbers[range.max] = e.currentTarget.value)}
          />
          {#if range.unit}<span class="to">{range.unit}</span>{/if}
        </div>
      {/each}
    </fieldset>

    <fieldset class="col">
      <legend>Single fields</legend>
      {#each ADVANCED_SINGLES as single (single.key)}
        <div class="single-row">
          <label class="field-label" for="adv-{single.key}">{single.label}</label>
          <!-- The `type` varies by field, and Svelte will not two-way bind an input whose type is
               dynamic, so this pair does by hand what `bind:value` would have done. -->
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
    <legend>Chart features</legend>
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

  <div class="actions">
    <button class="apply" type="submit">Search</button>
    <!-- Always present, not only while something is on: a form that has been edited but not
         searched has nothing to show for itself yet, and this is the way back out of it. -->
    <button class="clear" type="button" onclick={clear}>Clear filters</button>
    {#if $count > 0}
      <span class="applied">{$count} {$count === 1 ? 'filter' : 'filters'} applied</span>
    {/if}
  </div>
</form>

<style>
  .panel {
    margin: 0 16px 10px;
    padding: 12px 14px 14px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }
  /* auto-fit over a floor rather than three declared columns: the window is resizable and this
     panel is wide, so a fixed three would either crush the text boxes or strand a gutter. None of
     that has been seen; jsdom computes no layout. */
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 14px 20px;
  }
  /* fieldset/legend rather than a div and a heading: these are groups of controls, and the
     grouping is what a screen reader announces when focus enters one. The UA border is dropped
     because the panel already draws one and a second is noise. */
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
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
  .text-row,
  .range-row,
  .single-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 7px;
  }
  .field-label {
    flex: 0 0 62px;
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  /* Same box as Explore's search input and Installed's filter row, so the three read as one
     control family. */
  .text-input,
  .num {
    background: var(--surface-2);
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
    width: 70px;
    flex: 0 0 auto;
  }
  .text-input:focus,
  .num:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  .tick {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--fs-caption);
    color: var(--text-3);
    cursor: pointer;
    white-space: nowrap;
  }
  /* 16px as everywhere else in the app: 13px, the UA default, was the smallest target here. */
  .tick input {
    margin: 0;
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .to {
    font-size: var(--fs-caption);
    color: var(--text-3);
    white-space: nowrap;
  }
  .flags {
    margin-top: 12px;
  }
  .flag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* Installed's filter toggles, to the pixel: the same question asked of a different catalog
     should not look like a different control. */
  .toggle {
    appearance: none;
    background: var(--surface-2);
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
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--hairline);
  }
  /* The one action the panel exists for, in the same gradient as Detail's Download and Explore's
     bulk Download, because it is the same weight of act: it spends a request. */
  .apply {
    border: 0;
    border-radius: 6px;
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
    border-radius: 6px;
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
  .applied {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
</style>
