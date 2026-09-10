<script lang="ts">
  /**
   * The welcome tour: five screens, one per thing Encore does, shown once on first run and again
   * from Settings or the shortcut sheet whenever asked.
   *
   * A modal on the shortcut sheet's pattern rather than a view of its own, for one reason: on a
   * first run it has to come BEFORE the folder picker and, later, must NOT bring the picker back.
   * Layered over whatever is on screen, it does both without knowing which case it is in. On a
   * first run that is Welcome, already probing for the library underneath; later it is Settings.
   *
   * Escape is NOT handled here. App owns the dismiss order (sheet, then this, then the rest), and a
   * second Escape listener down here would race it. `onclose` is what Skip, Done and the backdrop
   * call; App hands in the store's `finishTour`, which is what records the tour as seen.
   *
   * Each view screen is also a door: once a library folder is set, an Open button closes the tour
   * and switches to the view the screen just described. `onopen` is App's `goTo`, called after
   * `onclose`, so the tour is recorded as seen on this path too.
   */
  import type { ViewId } from './Sidebar.svelte'
  import { takeFocus, wrapTab } from '../focus-trap'
  import { hasLibrary } from '../stores/settings'

  let { onclose, onopen }: { onclose: () => void; onopen: (view: ViewId) => void } = $props()

  interface Screen {
    title: string
    body: string
    /** One 24-unit stroke path, drawn in the sidebar's style. */
    glyph: string
    /** The view this screen describes, for its Open button. The first screen has none. */
    view?: ViewId
  }

  /**
   * The four view glyphs are the sidebar's own paths, copied rather than imported: Sidebar keeps
   * them in a private table, and this screen must show the shape the user is about to click, not a
   * near miss. WelcomeTour.svelte.test.ts reads them back out of Sidebar's source, so a redrawn
   * sidebar icon fails there instead of drifting here.
   *
   * Copy is written to be read once by someone who has never opened the app. No screen says more
   * than the view it describes can do; the Issues claims are the ones fix.ts enforces.
   */
  const SCREENS: readonly Screen[] = [
    {
      title: 'What Encore does',
      body:
        'Encore manages your Clone Hero charts. It finds and fixes problems in them, fetches ' +
        'new charts from Chorus Encore, and adds the art, video and lyrics a chart is missing.',
      // A disc: the one screen with no sidebar item of its own.
      glyph: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z'
    },
    {
      title: 'Installed',
      view: 'library',
      body:
        'Every chart in your library, with a filter box to find one. Open a chart to see its ' +
        'details and hear a preview.',
      glyph: 'M4 5h16M4 12h16M4 19h10'
    },
    {
      title: 'Explore',
      view: 'browse',
      body:
        'Search Chorus Encore, the community chart database, and download what you find. Tick ' +
        'several rows to download them all at once.',
      glyph: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm9 16-3.5-3.5'
    },
    {
      title: 'Issues',
      view: 'tools',
      body:
        'A scan finds problems in your charts and offers a fix for the ones it can correct ' +
        'safely. Fixes never change the identity Clone Hero matches charts by, so multiplayer ' +
        'keeps working, and every fix can be undone.',
      glyph:
        'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm7 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z'
    },
    {
      title: 'Asset Studio',
      view: 'assets',
      body:
        'Adds album art, a background image or video, and lyrics to charts that lack them. It ' +
        'lists the charts still missing something, so you can work through them.',
      glyph:
        'M12 3v10.5M9.5 12.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 6c2 0 3-1 5-1v4c-2 0-3 1-5 1'
    }
  ]

  let step = $state(0)
  const screen = $derived(SCREENS[step])
  const last = $derived(step === SCREENS.length - 1)

  let card = $state<HTMLElement | null>(null)

  /**
   * Move focus in on open and put it back on close. Same reasoning as the shortcut sheet: the card
   * takes focus itself so a screen reader reads the dialog's name (the current heading) before its
   * controls, and the restore is what keeps a keyboard user from landing at the top of the
   * document when the tour goes.
   */
  $effect(() => {
    const el = card
    if (!el) return undefined
    return takeFocus(el)
  })

  /**
   * Change screen, and put focus back on the card.
   *
   * Two things that buys. Enter keeps advancing without the user having to find Next again, and a
   * screen reader hears the new heading, because the card is labelled by it. It also sidesteps the
   * button that was pressed disappearing under focus: Back is not on the first screen and Next is
   * not on the last.
   */
  function go(to: number): void {
    step = to
    card?.focus()
  }

  function next(): void {
    if (last) onclose()
    else go(step + 1)
  }

  /**
   * Whether the screen on show has a door: a view of its own, and a library for that view to
   * show. On a first run there is no folder yet and the picker is underneath, so opening Installed
   * would put an empty list over the question that fills it; `hasLibrary` is false until the
   * folder is set, and false before settings load, so the buttons never flash on a cold start.
   */
  const door = $derived($hasLibrary ? screen.view : undefined)

  /** Through the door: closed and seen first, then the view. */
  function open(): void {
    if (!door) return
    onclose()
    onopen(door)
  }

  /**
   * Enter advances, but only while the card itself has focus. A user who tabbed to Back or Skip
   * and pressed Enter wants that button, and the button's own activation handles it.
   *
   * Left and Right are Back and Next from anywhere in the card, buttons included: an arrow on a
   * focused button has no meaning of its own for this handler to be taking. Nothing else is
   * listening for them, and that was checked, not assumed. The tour has no text input for an
   * arrow to move a caret in. App's window listener runs `matchShortcut`, which declines every
   * arrow key (shortcuts.test.ts pins that). And the chart preview, the one element in the app
   * that binds the arrows (to seek), binds them on its own host element only (chart-preview
   * 1.3.0 registers `keydown` on the custom element and touches `window` only for `resize`), so
   * an arrow pressed inside this card never reaches it. It cannot be focused while the tour is
   * up: the card takes focus on open, Tab wraps inside it, and the backdrop covers the rest of
   * the window, which holds even when the shortcut sheet opens the tour over a chart's detail.
   *
   * Past either end the key does nothing. Right on the last screen is not Done: finishing is a
   * choice, made with Enter or the button, not something a key held a moment too long walks into.
   * A held key is declined for the same reason `matchShortcut` declines auto-repeat.
   *
   * Tab wraps inside the card, as in the shortcut sheet and the fix confirmation, and by the same
   * shared code: the dialog is `aria-modal`, so tabbing out into a view it has declared hidden
   * would be a lie about what is interactive.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (!card) return
    if (event.key === 'Enter') {
      if (event.target !== card) return
      event.preventDefault()
      next()
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
      const to = event.key === 'ArrowLeft' ? step - 1 : step + 1
      if (to < 0 || to >= SCREENS.length) return
      event.preventDefault()
      go(to)
      return
    }
    wrapTab(event, card)
  }
</script>

<div class="tour">
  <!-- Click-outside-to-dismiss, and nothing else; see the shortcut sheet for why it is a button
       and why it is hidden from the keyboard and assistive tech. -->
  <button class="backdrop" tabindex="-1" aria-hidden="true" onclick={onclose}></button>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="tour-title"
    tabindex="-1"
    bind:this={card}
    onkeydown={onKeydown}
  >
    <div class="head">
      <!-- Words, so the position is readable and announceable; dots alone say neither. -->
      <span class="count">{step + 1} of {SCREENS.length}</span>
      <!-- On every screen, including the last, where it does the same as Done. -->
      <button class="skip" onclick={onclose}>Skip tour</button>
    </div>
    {#key step}
      <div class="screen">
        <div class="glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d={screen.glyph} />
          </svg>
        </div>
        <div class="text">
          <h2 class="title" id="tour-title">{screen.title}</h2>
          <p class="body selectable">{screen.body}</p>
        </div>
      </div>
    {/key}
    <div class="foot">
      {#if last}
        <p class="note">Press <kbd>?</kbd> any time for shortcuts.</p>
      {/if}
      <div class="actions">
        <!-- The door lives in the footer's button row, first, so leaving reads apart from moving
             on. A hairline button like Back: the same 26px, so the footer the tour pins at one
             height on every screen (see .screen) keeps it with a third button in the row. Named
             as the sidebar names the view, which is where the user lands. Measured with it in the
             row, at 960 and 1280 wide: the card is still 560 by 232 and the footer 41px on every
             screen, and on the last, the note ends 64px short of the three buttons. -->
        {#if door}
          <button class="hairline" onclick={open}>Open {screen.title}</button>
        {/if}
        {#if step > 0}
          <button class="hairline" onclick={() => go(step - 1)}>Back</button>
        {/if}
        <button class="btn-primary" onclick={next}>{last ? 'Done' : 'Next'}</button>
      </div>
    </div>
  </div>
</div>

<style>
  /* Same overlay geometry as the shortcut sheet and the Issues confirmation: one modal shape.
     Stacked one step BELOW the sheet (60) so that ? can open the sheet over this, which the last
     screen promises. */
  .tour {
    position: fixed;
    inset: 0;
    z-index: 55;
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
    width: min(560px, 100%);
    max-height: 100%;
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 14px 20px 18px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  }
  /* Focused on open and after every step (see `go`); a container, not a control, so no ring. */
  .card:focus-visible {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  /* Same mono micro-caps as the section heads elsewhere. Upper-cased here, not in the markup, so
     what is read out is "2 of 5" and what is drawn matches the sidebar. */
  .count {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    line-height: var(--lh-tight);
    color: var(--text-3);
  }
  .skip {
    margin-left: auto;
    background: none;
    border: 0;
    padding: 2px 0;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    color: var(--text-3);
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .skip:hover {
    color: var(--text-1);
  }
  .screen {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    /* Tall enough for a three-line body, so the footer does not move under the pointer between
       the two-line screens and the three-line ones. Measured in the running app at the card's
       one width (560px, at both 960 and 1280 wide): 9px text offset + 23px title + 8px gap +
       67px of body (three lines at 14px x 1.6) + the 18px padding below = 125px. Without it the
       card was 217px on Installed and 234px on Issues, and Next moved 17px between them. */
    min-height: 125px;
    padding-bottom: 18px;
    animation: fade-in var(--t-fast) var(--ease);
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .glyph {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent-hi);
  }
  .glyph svg {
    width: 22px;
    height: 22px;
  }
  .text {
    flex: 1;
    min-width: 0;
    /* Lines up the heading's cap height with the top of the glyph tile. */
    padding-top: 9px;
  }
  .title {
    font-size: var(--fs-heading);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
    line-height: var(--lh-display);
    color: var(--text-1);
    margin-bottom: 8px;
  }
  .body {
    font-size: var(--fs-body);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 14px;
    border-top: 1px solid var(--hairline);
  }
  /* Flex with flat leading, so the key cap inside sets no line box of its own and the note can
     never be what decides the footer's height; the buttons beside it do. */
  .note {
    display: flex;
    align-items: center;
    gap: 0.3em;
    font-size: var(--fs-secondary);
    line-height: var(--lh-flat);
    color: var(--text-3);
  }
  /* Same key cap as the shortcut sheet's. */
  kbd {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-flat);
    letter-spacing: var(--ls-caps);
    color: var(--text-2);
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 2px 5px;
    background: var(--surface-2);
  }
  .actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .hairline {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    /* 5px, not the primary button's 6px: this one has a 1px border and that one has none, so
       this is what makes Back and Next the same 26px. Measured with 6px, the footer was 43px on
       every screen that has Back and 41px on the first, which has not. */
    padding: 5px 12px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .hairline:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .btn-primary {
    border: 0;
    border-radius: 6px;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    padding: 6px 14px;
    cursor: pointer;
    transition: filter var(--t-fast) var(--ease);
  }
  .btn-primary:hover {
    filter: brightness(1.12);
  }
</style>
