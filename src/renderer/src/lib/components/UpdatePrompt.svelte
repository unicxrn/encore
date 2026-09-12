<script lang="ts">
  /**
   * The one thing a launch says about a newer Encore.
   *
   * Until this existed the startup check ran, found a release, pushed the answer to the renderer,
   * and the only place it surfaced was the Updates row in Settings. Nobody opens Settings to find
   * out that something they did not know about is waiting, so the check was work nobody saw.
   *
   * Deliberately not a second update flow. Every control here calls what the Settings row already
   * calls: the notes go through `openOfferedWhatsNew`, and the install hands off to the download
   * the Updates row owns, in Settings, where the percent and the Restart button already live. One
   * flow, and one place the per-platform rules are written down.
   *
   * A modal on the welcome tour's pattern, and on its layer. App renders this only when neither
   * the tour nor the what's new panel is up, so the three never stack. Escape is NOT handled here:
   * App owns the dismiss order for every modal on this layer, and a second listener would race it.
   */
  import { takeFocus, wrapTab } from '../focus-trap'

  let {
    version,
    currentVersion,
    canApply,
    note,
    onskip,
    oninstall,
    onnotes
  }: {
    /** The release the check found. */
    version: string
    /** The release running now. Empty when a failed call left the store nothing to carry. */
    currentVersion: string
    /** Whether Encore can replace this copy of itself. False hides the install control. */
    canApply: boolean
    /** The target's sentence. On a copy that cannot apply an update it is the whole answer. */
    note: string
    /** Dismiss for this launch. The prompt comes back the next time Encore starts. */
    onskip: () => void
    /** Start the download and hand the user to the Updates row that owns the rest of it. */
    oninstall: () => void
    /** Open the changelog on the offered version. */
    onnotes: () => void
  } = $props()

  /**
   * Both versions in one sentence, or one when that is all there is.
   *
   * "You are running x" is the part that makes the number above it mean something, so it is worth
   * a clause. It is dropped rather than printed empty when the store has no running version: that
   * only happens after a call that never reached main, and "You are running ." is worse than
   * saying nothing.
   */
  const lead = $derived(
    currentVersion === ''
      ? `Encore ${version} is available.`
      : `Encore ${version} is available. You are running ${currentVersion}.`
  )

  let card = $state<HTMLElement | null>(null)

  /** Focus in on open, back to the opener on close. Same as the tour and the what's new panel. */
  $effect(() => {
    const el = card
    if (!el) return undefined
    return takeFocus(el)
  })

  function onKeydown(event: KeyboardEvent): void {
    if (!card) return
    wrapTab(event, card)
  }
</script>

<div class="update-prompt">
  <!-- Click-outside-to-dismiss, and nothing else; see the shortcut sheet for why it is a button
       and why it is hidden from the keyboard and assistive tech. Outside is Skip, which is the
       cheapest answer here and the one the user is most likely to mean. -->
  <button class="backdrop" tabindex="-1" aria-hidden="true" onclick={onskip}></button>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="update-prompt-title"
    tabindex="-1"
    bind:this={card}
    onkeydown={onKeydown}
  >
    <h2 class="title" id="update-prompt-title">Update available</h2>
    <p class="lead selectable">{lead}</p>
    <!-- Always, on every target. On Windows and the AppImage it says a restart is involved; on
         the deb it warns about the password prompt before the button is pressed; on anything
         Encore cannot replace it is the whole answer, and the reason there is no install button
         below. Same sentence the Updates row shows, from the same place. -->
    <p class="note selectable">{note}</p>
    <!-- What Skip costs, said before it is pressed. The owner's rule for this prompt is that
         skipping means not now rather than never: nothing is written down, so the next launch
         asks again. A user who cannot tell those apart will not press it. -->
    <p class="hint">Skipping brings this back the next time Encore starts.</p>

    <div class="foot">
      <!-- Before the install control, and in that order for the reason the Settings row puts it
           there: reading what is in a release is the step that comes first, and a user who has to
           start a download to find out what they are getting has not been given a choice. -->
      <button class="hairline" aria-label="What is new in Encore {version}" onclick={onnotes}>
        What's new
      </button>
      <button class="skip" aria-label="Skip this update until the next launch" onclick={onskip}>
        Skip
      </button>
      {#if canApply}
        <!-- Names both steps, because both happen: the press starts a download, and the note
             above says what the restart does. A button labelled Install on a press that only
             fetches would be describing the wrong half. -->
        <button
          class="btn-primary"
          aria-label="Download and install Encore {version}"
          onclick={oninstall}
        >
          Download and install
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Same overlay geometry and the same layer as the welcome tour and the what's new panel. The
     three never draw together (App renders one at most), and all three sit under the shortcut
     sheet at 60, so ? still works over any of them. */
  .update-prompt {
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
  /* The narrowest card in the set (the sheet is 520, the tour 560, the what's new panel 640),
     because it holds the least: three short paragraphs and a row of buttons, none of it a list
     or a grid, and a card sized for a list would set its three sentences across a line longer
     than they want to be read at. Reasoned from the type scale rather than measured in the
     running app; jsdom computes no layout, so nothing in the suite can check it. */
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(480px, 100%);
    max-height: 100%;
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
    padding: 20px;
  }
  .card:focus-visible {
    outline: none;
  }
  .title {
    font-size: var(--fs-heading);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
    line-height: var(--lh-display);
    color: var(--text-1);
  }
  .lead {
    margin-top: 10px;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-1);
  }
  .note {
    margin-top: 8px;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .hint {
    margin-top: 8px;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--hairline);
  }
  .hairline {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    /* 5px against the primary's 6px, for the tour's reason: this one has a 1px border and that
       one has none, so this is what makes the two the same height. */
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
  /* Quiet, and pushed to the right of the notes button so the two answers to "what now" sit
     together at the end of the row. The tour's Skip is the same control in the same register. */
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
