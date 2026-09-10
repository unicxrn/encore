<script lang="ts">
  import type { QueuedDownload } from '../../../../shared/schemas'
  import { downloads } from '../stores/downloads'
  import { encore } from '../stores/bridge'
  import Icon from './Icon.svelte'

  let { onclose }: { onclose: () => void } = $props()

  /**
   * The status enum in words. `item.status` is what the queue stores and the IPC contract
   * carries (`running`, `canceled`), and until this it was printed as the item's label. A
   * lookup rather than a formatter: the union is closed, and `Record` over it means a status
   * added without a word for it fails typecheck instead of reaching the screen as the enum.
   */
  const STATUS_LABEL: Record<QueuedDownload['status'], string> = {
    queued: 'Queued',
    running: 'Downloading',
    done: 'Done',
    canceled: 'Canceled',
    error: 'Failed'
  }

  const FINISHED = new Set(['done', 'canceled', 'error'])
  const hasFinished = $derived($downloads.some((item) => FINISHED.has(item.status)))
</script>

<div class="panel">
  <div class="head">
    <span class="label">DOWNLOADS</span>
    {#if hasFinished}
      <button class="clear" onclick={() => void encore().clearFinished()}>Clear</button>
    {/if}
    <button class="icon-btn x" onclick={onclose} aria-label="Close"><Icon name="x" /></button>
  </div>
  {#if $downloads.length === 0}
    <p class="empty">No downloads yet. Pick charts in Explore and press Download.</p>
  {:else}
    {#each $downloads as item (item.md5)}
      <div class="item">
        <div class="info">
          <span class="name">{item.folderName}</span>
          <span class="status mono"
            >{STATUS_LABEL[item.status]}{item.percent != null ? ` · ${item.percent}%` : ''}</span
          >
          {#if item.message}<span class="msg">{item.message}</span>{/if}
        </div>
        {#if item.status === 'error'}
          <button onclick={() => void encore().downloadRetry(item.md5)}>Retry</button>
        {:else if item.status === 'queued' || item.status === 'running'}
          <button onclick={() => void encore().downloadCancel(item.md5)}>Cancel</button>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  /* Floating card 10px above the bottom stack, so it reads as a surface-1 card rather than a
     slab welded to the window corner.

     Anchored with `bottom: calc(100% + 10px)` to App's `.foot` (the positioned box holding
     the player bar AND the runtime error strip above it), NOT to the window and NOT to the
     bar. `bottom: 74px` against the app shell (64px of bar plus the gap) was only true while
     nothing sat above the bar; anchoring to the bar itself was no better, because the strip
     stacks above the bar, not below it. Measured at 1280×800 with the strip showing, both of
     those put the panel at y 657-727 over a strip at 699-736, covering its Copy and Dismiss
     buttons (707-729). Against `.foot` the panel's bottom edge is 10px above the strip's top. */
  .panel {
    position: absolute;
    z-index: var(--z-popover);
    bottom: calc(100% + 10px);
    right: 12px;
    width: 340px;
    max-height: 45vh;
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 12px 14px;
  }
  .head {
    display: flex;
    align-items: center;
    /* The close button's 28px box is taller than the 12px label beside it; pulling the head up
       keeps the label where it sat before the button grew. */
    margin: -4px 0 4px;
  }
  .label {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
    letter-spacing: var(--ls-caps);
  }
  .clear {
    margin-left: auto;
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-caption);
    padding: 3px 9px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .clear:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Box, colour and hit area come from the global `.icon-btn` (tokens.css). The 8px gap is
     the hit area's own reach, so the halo stops exactly at Clear's edge instead of over it. */
  .x {
    margin-left: 8px;
    margin-right: -6px;
  }
  .empty {
    color: var(--text-3);
    font-size: var(--fs-secondary);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
  }
  .item:last-child {
    border-bottom: 0;
  }
  .info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  /* Folder name is a filesystem path segment, so mono, like every other path in
     the app. */
  .name {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .msg {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Retry/Cancel stay ghost: neither is the panel's primary action. */
  .item button {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-caption);
    padding: 4px 10px;
    cursor: pointer;
    flex-shrink: 0;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .item button:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
</style>
