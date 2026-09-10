<script lang="ts">
  import { takeFocus, wrapTab } from '../focus-trap'
  import { SHORTCUTS, SHORTCUT_GROUPS, renderKeys } from '../shortcuts'
  import { openTour } from '../stores/tour'
  import Icon from './Icon.svelte'

  /**
   * The shortcut sheet: `?` opens it, and the sidebar links to it for everyone
   * who would never guess that.
   *
   * Rendered from `SHORTCUTS`, the same table `matchShortcut` dispatches from,
   * so this screen cannot go stale against the bindings it documents.
   *
   * Escape is NOT handled here. App owns the dismiss order (sheet, then any
   * other modal, then the downloads panel, then the chart you are in), and a
   * second Escape listener down here would race it.
   */
  let { onclose }: { onclose: () => void } = $props()

  // navigator.platform is deprecated but is still the only synchronous answer in
  // Electron's renderer; userAgentData is Chromium-only and async. It is read
  // once here and passed in, so `renderKeys` itself stays pure.
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform

  const groups = $derived(
    SHORTCUT_GROUPS.map((group) => ({
      group,
      items: SHORTCUTS.filter((spec) => spec.group === group)
    })).filter((section) => section.items.length > 0)
  )

  let card = $state<HTMLElement | null>(null)

  /**
   * Move focus in on open and put it back on close (`takeFocus` explains the
   * restore). The card takes focus itself rather than the Close button, so a
   * screen reader reads the dialog's name and contents before its one control.
   */
  $effect(() => {
    const el = card
    if (!el) return undefined
    return takeFocus(el)
  })

  /**
   * Tab wraps inside the card: the sheet is `aria-modal`, so tabbing out of it
   * into a view it has just declared hidden would be a lie about what is
   * interactive. Shared with the tour and the fix confirmation, so the three
   * cannot drift apart on it.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (card) wrapTab(event, card)
  }
</script>

<div class="sheet">
  <!-- Click-outside-to-dismiss, and nothing else. A <button> rather than a div
       purely so it needs no a11y-ignore for having a click handler; it is taken
       out of the tab order and hidden from assistive tech because ✕ and Escape
       are the keyboard paths and a second unlabelled "close" would only be
       something extra to tab past. -->
  <button class="backdrop" tabindex="-1" aria-hidden="true" onclick={onclose}></button>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shortcuts-title"
    tabindex="-1"
    bind:this={card}
    onkeydown={onKeydown}
  >
    <div class="head">
      <h2 class="title" id="shortcuts-title">Keyboard shortcuts</h2>
      <button class="icon-btn x" onclick={onclose} aria-label="Close keyboard shortcuts">
        <Icon name="x" />
      </button>
    </div>
    {#each groups as section (section.group)}
      <section class="group" aria-labelledby="shortcuts-group-{section.group}">
        <h3 class="group-head mono" id="shortcuts-group-{section.group}">
          {section.group.toUpperCase()}
        </h3>
        <dl class="rows">
          {#each section.items as spec (spec.id)}
            <div class="row">
              <dt class="what">{spec.what}</dt>
              <dd class="chord">
                {#each renderKeys(spec.keys, platform) as cap, i (i)}
                  <kbd>{cap}</kbd>
                {/each}
              </dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
    <!-- Said once, here, because it is the rule that makes the bare keys above
         safe and it is not visible anywhere else. -->
    <p class="note">
      Shortcuts without <kbd>{renderKeys('Mod', platform)[0]}</kbd> stay out of the way while you
      are typing. The chart preview keeps its own keys while it has focus: <kbd>Space</kbd>,
      <kbd>←</kbd> <kbd>→</kbd> to seek,
      <kbd>↑</kbd> <kbd>↓</kbd> for volume, <kbd>M</kbd> to mute and <kbd>F</kbd> for fullscreen.
    </p>
    <!-- Not a row above: the tour has no key, and a row would say it did. The sheet closes first
         so the tour is not opened under it. -->
    <p class="note">
      <button
        class="link"
        onclick={() => {
          onclose()
          openTour()
        }}>Show the welcome tour</button
      >
    </p>
  </div>
</div>

<style>
  /* Same overlay geometry as the Issues confirmation, so the app has one modal
     shape rather than two. */
  .sheet {
    position: fixed;
    inset: 0;
    z-index: var(--z-sheet);
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
  .card {
    position: relative;
    width: min(520px, 100%);
    max-height: 100%;
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 16px 18px 14px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  }
  /* The card is focused on open (see the effect above); it is a container, not a
     control, so it gets no ring of its own. */
  .card:focus-visible {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .title {
    font-size: var(--fs-emphasis);
    font-weight: 600;
    color: var(--text-1);
  }
  /* Box, colour and hit area come from the global `.icon-btn` (tokens.css); only its place in
     the row is decided here. */
  .x {
    margin-left: auto;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .group + .group {
    margin-top: 14px;
  }
  /* Same mono micro-caps as Settings' section heads and Home's row heads. */
  .group-head {
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    margin-bottom: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 5px 0;
  }
  .row + .row {
    border-top: 1px solid rgba(255, 255, 255, 0.035);
  }
  .what {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  .chord {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  /* Same key cap as the CTRL K hint in the titlebar. */
  kbd {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-2);
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 2px 5px;
    background: var(--surface-2);
  }
  .note {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--hairline);
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  /* Same accent text link as the sidebar's status card. */
  .link {
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    color: var(--accent);
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .link:hover {
    color: var(--accent-hi);
  }
</style>
