<script lang="ts">
  import { copyText, errorHeadline, errorReport } from '../errors'

  /**
   * What the user sees instead of a blank window.
   *
   * Three jobs, in the order they matter:
   *
   * 1. **Say what broke.** A blank screen is indistinguishable from a hang, and in a packaged
   *    build there is no DevTools to go and ask.
   * 2. **Offer a way back.** `onRetry` re-runs the boundary's children; `onLeave` goes somewhere
   *    known-good. Both are given because they fail differently: a transient error clears on
   *    retry, and a deterministic one never will, so a screen with only Try again is a trap.
   * 3. **Make the error reportable.** The stack is on screen and selectable, and Copy puts the
   *    whole report (version, context, stack) on the clipboard. A screenshot of a stack trace
   *    is how bugs actually get reported.
   */
  let {
    error,
    where,
    scope,
    onRetry,
    onLeave
  }: {
    error: unknown
    /** Where it happened, e.g. "Tools view". Rides along in the copied report. */
    where: string
    /** 'view' keeps the sidebar; 'app' means the shell itself failed. Picks the wording. */
    scope: 'view' | 'app'
    onRetry: () => void
    /**
     * The escape hatch. Home for a broken view, a window reload for a broken shell. The caller
     * decides, because `location.reload()` is the one line here that cannot be exercised under
     * jsdom and it does not belong in the component that everything else about this screen is
     * tested through.
     */
    onLeave: () => void
  } = $props()

  const headline = $derived(errorHeadline(error))
  const report = $derived(errorReport(error, where))

  // null = not asked yet. Set to false when the clipboard is unavailable or refuses, which is why
  // the report is on screen and selectable rather than hidden behind the button.
  let copied = $state<boolean | null>(null)
  // Re-arm the Copy button when a different error lands in the same fallback.
  $effect(() => {
    void report
    copied = null
  })

  async function copy(): Promise<void> {
    copied = await copyText(report)
  }
</script>

<div class="fallback" class:app={scope === 'app'}>
  <div class="card">
    <p class="eyebrow mono">CRASH</p>
    <h2 class="title">
      {scope === 'app' ? 'Encore crashed' : 'This screen crashed'}
    </h2>
    <p class="lede">
      {#if scope === 'app'}
        The window could not finish drawing. Reload to start it over. Your library and settings are
        untouched, since nothing here writes to disk.
      {:else}
        The rest of Encore is still running, so you can move to another section from the sidebar.
        Nothing was written to your library.
      {/if}
    </p>

    <!-- role="alert" here, on the message, and not on the whole card: an alert is read the moment
         it appears, interrupting whatever the screen reader was saying. The message is what the
         user needs to hear then. The stack below is for the report, reached on purpose. -->
    <p class="headline mono" role="alert">{headline}</p>

    <div class="actions">
      <button class="btn-primary" onclick={onRetry}>Try again</button>
      <button class="hairline" onclick={onLeave}>
        {scope === 'app' ? 'Reload Encore' : 'Go to Home'}
      </button>
      <button class="hairline" onclick={() => void copy()}>Copy details</button>
      {#if copied === true}
        <span class="copy-note mono">COPIED</span>
      {:else if copied === false}
        <span class="copy-note mono">COPY FAILED. SELECT THE TEXT BELOW</span>
      {/if}
    </div>

    <!-- Always open, never behind a disclosure. The user is being asked to report this, and a
         detail they have to find first is a detail that does not make it into the report. -->
    <pre class="report mono">{report}</pre>
  </div>
</div>

<style>
  .fallback {
    display: flex;
    justify-content: center;
    padding: 40px 20px;
  }
  /* The shell-level fallback replaces the whole window, so it centres in the viewport rather
     than in a content pane that no longer exists. */
  .fallback.app {
    align-items: center;
    height: 100vh;
    background: var(--bg);
  }
  .card {
    width: min(680px, 100%);
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .eyebrow {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--accent-hi);
  }
  .title {
    font-size: var(--fs-emphasis);
    font-weight: 600;
    color: var(--text-1);
  }
  .lede {
    font-size: var(--fs-body);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .headline {
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-1);
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    padding: 9px 11px;
    overflow-wrap: anywhere;
    /* body sets `user-select: none` app-wide; the whole point of this screen is that its text
       can be selected and copied. */
    user-select: text;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .copy-note {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .report {
    max-height: 260px;
    overflow: auto;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    padding: 10px 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
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
  .btn-primary:hover {
    filter: brightness(1.12);
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
</style>
