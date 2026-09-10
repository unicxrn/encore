<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { get } from 'svelte/store'
  import { encore } from '../stores/bridge'
  import type { Encore } from '../stores/bridge'
  import { settings, welcomeDismissed } from '../stores/settings'
  import { startScan } from '../stores/scan'
  import type { ViewId } from './Sidebar.svelte'

  let { onNavigate }: { onNavigate: (id: ViewId) => void } = $props()

  // Taken off the bridge rather than imported from `src/main/catalog/detect-library`: the
  // renderer's tsconfig does not include src/main, and the IPC method's own return type is the
  // contract this view is written against anyway.
  type Candidate = Awaited<ReturnType<Encore['libraryDetect']>>[number]

  /**
   * What a scan costs, in words, before the user starts one.
   *
   * M13 shrank this by an order of magnitude, and the copy that used to stand here went false in
   * both halves. It said the window would not respond while the scan ran, and put that at about a
   * minute for every 300 charts. That figure came from a 37 s scan of the 207-chart reference
   * library; the same scan now measures 3.9-4.2 s, and the main process blocks in slices of a
   * single chart's parse (10 ms median, 173 ms at worst) rather than for the whole run. Five
   * seconds per 200 charts rounds the measured ~19 ms/chart up to ~25 ms, for headroom on a
   * cold page cache and a slower disk than the one it was measured on. The profile, and why no
   * worker thread was added, are in src/main/catalog/scanner.ts.
   *
   * There is still no spinner here, but the reason it was left out (that an animated one would
   * stall mid-turn and read as a crash) no longer applies at four seconds. Whether one is worth
   * adding is now an ordinary UI question, not something a freeze settles.
   */
  const SCAN_WARNING =
    'It takes about five seconds for every 200 charts, and the window stays usable while it runs.'

  // null until the probe answers. The two branches below say opposite things ("here is your
  // library" / "nothing found"), so neither may render on a guess.
  let detected = $state<Candidate[] | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  const candidate = $derived(detected?.[0] ?? null)

  const countLabel = $derived.by(() => {
    if (!candidate) return ''
    // `chartCount` stopped at the cap, so it is a floor. Printing it as an exact total would be
    // a lie about a library that could be any size above it.
    if (candidate.countCapped) return `${candidate.chartCount}+ charts`
    if (candidate.chartCount === 0) return 'No charts in it yet'
    return `${candidate.chartCount} ${candidate.chartCount === 1 ? 'chart' : 'charts'}`
  })

  onMount(() => {
    void (async () => {
      try {
        detected = await encore().libraryDetect()
      } catch {
        // A probe that threw and a probe that found nothing lead to the same place: the user
        // picks the folder by hand. Reporting the failure would only name a step they did not
        // take and cannot repair.
        detected = []
      }
    })()
  })

  async function useFolder(path: string): Promise<void> {
    if (busy) return
    busy = true
    error = null
    const next = { ...get(settings), libraryFolders: [{ path, isDefault: true }] }
    // Flush the disabled button and its "Scanning" label before anything can block. The IPC
    // round-trip below then yields long enough for the frame to paint, so the message is on
    // screen by the time the scan takes the main thread away.
    await tick()
    try {
      // `settingsSet` directly instead of `patchSettings`: writing to the `settings` store is
      // what closes this view (App swaps in Home), and doing that first would replace the
      // warning above with an empty Home for the whole length of the freeze.
      await encore().settingsSet(next)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      busy = false
      return
    }
    try {
      await startScan()
    } finally {
      // The folder is saved either way, so the welcome has done its job; a scan that failed is
      // the catalog's problem to report, not a reason to hold the user here.
      settings.set(next)
      busy = false
    }
  }

  async function chooseFolder(): Promise<void> {
    if (busy) return
    const path = await encore().pickFolder()
    if (!path) return
    await useFolder(path)
  }
</script>

<div class="welcome">
  <div class="card">
    <h1>Encore</h1>
    <p class="lede selectable">
      A library manager for Clone Hero: the charts you already have, and the ones you do not yet.
    </p>

    {#if detected !== null}
      <!-- The heading is the one thing that says which of the two branches you
           are looking at, so it names the region rather than being decoration.
           Both branches use the same id because only one of them ever renders. -->
      <section class="offer" aria-labelledby="welcome-offer">
        {#if candidate}
          <h2 id="welcome-offer">FOUND ON THIS COMPUTER</h2>
          <p class="path selectable">{candidate.path}</p>
          <p class="count">{countLabel}</p>
          {#if candidate.chartCount > 0}
            <p class="warn">
              Adding it starts a one-time scan of every chart in the folder. {SCAN_WARNING}
            </p>
          {/if}
          <button
            class="btn-primary"
            disabled={busy}
            onclick={() => void useFolder(candidate.path)}
          >
            {busy ? 'Scanning…' : 'Use this folder'}
          </button>
        {:else}
          <h2 id="welcome-offer">NO CLONE HERO FOLDER FOUND</h2>
          <p class="warn">
            Encore looked where Clone Hero keeps its songs by default. If yours is somewhere else,
            point it there — that starts a one-time scan of every chart in it. {SCAN_WARNING}
          </p>
          <button class="btn-primary" disabled={busy} onclick={() => void chooseFolder()}>
            {busy ? 'Scanning…' : 'Choose a folder'}
          </button>
        {/if}
        <!-- The user pressed a button and it failed; this line is the whole
             report. role="alert" so it is not left for them to notice. -->
        {#if error}
          <p class="err" role="alert">Encore could not save that folder: {error}</p>
        {/if}
      </section>
    {/if}

    <div class="past">
      <!-- Dismissing before navigating is what keeps Home from throwing this view back up when
           the user clicks it in the sidebar. It lasts the session only; see welcomeDismissed. -->
      <button
        class="ghost"
        onclick={() => {
          welcomeDismissed.set(true)
          onNavigate('browse')
        }}>Explore charts instead</button
      >
      <span class="hint">Browsing needs no folder; downloading one does.</span>
    </div>
  </div>
</div>

<style>
  .welcome {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    width: min(460px, 100%);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  h1 {
    font-size: var(--fs-heading);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
  }
  .lede {
    font-size: var(--fs-body);
    color: var(--text-2);
    line-height: var(--lh-prose);
  }
  /* Same mono micro-caps as Settings' section heads and Home's row heads. */
  h2 {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    margin-bottom: 10px;
  }
  .offer {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 14px 16px 16px;
  }
  .path {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    color: var(--text-1);
    overflow-wrap: anywhere;
  }
  .count {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    color: var(--text-3);
    margin-top: 3px;
  }
  .warn {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    line-height: var(--lh-prose);
    margin-top: 10px;
  }
  .err {
    font-size: var(--fs-secondary);
    color: var(--accent-hi);
    margin-top: 10px;
  }
  .btn-primary {
    margin-top: 12px;
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
  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .past {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .ghost {
    background: var(--surface-2);
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
  .ghost:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .hint {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
</style>
