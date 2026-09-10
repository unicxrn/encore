<script lang="ts">
  import { copyText, errorHeadline, errorReport } from '../errors'
  import { dismissRuntimeError, runtimeError } from '../stores/runtime-errors'

  /**
   * The strip for the errors a boundary structurally cannot catch.
   *
   * A rejected IPC call or a throwing timer unwinds through the event loop, past every
   * `<svelte:boundary>`, and today lands nowhere the user can see. It does not justify replacing
   * the screen, since the app is still working, but it must not be silent either. The symptom
   * the user actually gets is a button that did nothing.
   *
   * So: one line, dismissible, with the same Copy the fallback offers. See
   * `stores/runtime-errors.ts` for why only the most recent error is kept.
   */

  let copied = $state<boolean | null>(null)

  const headline = $derived($runtimeError === null ? '' : errorHeadline($runtimeError.value))

  // Re-arm Copy when a different error replaces the one on screen.
  $effect(() => {
    void headline
    copied = null
  })

  async function copy(): Promise<void> {
    const current = $runtimeError
    if (current === null) return
    copied = await copyText(errorReport(current.value, current.context))
  }
</script>

{#if $runtimeError !== null}
  <div class="bar" role="status">
    <span class="tag mono">BACKGROUND ERROR</span>
    <span class="msg" title={headline}>{headline}</span>
    {#if copied === true}
      <span class="note mono">COPIED</span>
    {:else if copied === false}
      <span class="note mono">COPY FAILED</span>
    {/if}
    <button class="hairline" onclick={() => void copy()}>Copy</button>
    <button class="hairline" onclick={dismissRuntimeError} aria-label="Dismiss background error">
      Dismiss
    </button>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px;
    border-top: 1px solid var(--hairline);
    background: var(--surface-1);
    flex-shrink: 0;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .tag {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--accent-hi);
    flex-shrink: 0;
  }
  /* One line, ellipsised: this sits in the app chrome and must not grow it. The full text goes
     to the clipboard, and the `title` puts it in a tooltip meanwhile. */
  .msg {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-secondary);
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    flex-shrink: 0;
  }
  .hairline {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-size: var(--fs-secondary);
    padding: 3px 10px;
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
</style>
