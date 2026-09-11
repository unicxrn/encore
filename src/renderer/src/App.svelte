<script lang="ts">
  import { onMount } from 'svelte'
  import Assets from './lib/components/Assets.svelte'
  import Browse from './lib/components/Browse.svelte'
  import Detail from './lib/components/Detail.svelte'
  import ErrorFallback from './lib/components/ErrorFallback.svelte'
  import Home, { type ChartTarget } from './lib/components/Home.svelte'
  import Icon from './lib/components/Icon.svelte'
  import Library from './lib/components/Library.svelte'
  import RuntimeErrorBar from './lib/components/RuntimeErrorBar.svelte'
  import Settings from './lib/components/Settings.svelte'
  import PlayerBar from './lib/components/PlayerBar.svelte'
  import ShortcutSheet from './lib/components/ShortcutSheet.svelte'
  import Sidebar, { type ViewId } from './lib/components/Sidebar.svelte'
  import Tools from './lib/components/Tools.svelte'
  import Welcome from './lib/components/Welcome.svelte'
  import WelcomeTour from './lib/components/WelcomeTour.svelte'
  import WhatsNew from './lib/components/WhatsNew.svelte'
  import { initSettings, needsWelcome, settingsLoaded } from './lib/stores/settings'
  import { finishTour, tourOpen } from './lib/stores/tour'
  import { closeWhatsNew, initWhatsNew, whatsNew } from './lib/stores/whats-new'
  import { initDownloads } from './lib/stores/downloads'
  import { initScan } from './lib/stores/scan'
  import { initAssets } from './lib/stores/assets'
  import { initAppUpdate } from './lib/stores/app-update'
  import { globalQuery } from './lib/stores/global-search'
  import { togglePlay } from './lib/stores/preview-controller'
  import { matchShortcut, renderKeys, type ShortcutView } from './lib/shortcuts'

  let view = $state<ViewId>('home')
  // Chart opened from Home or Explore. While set, Detail replaces the current
  // view; Back clears it and returns to the view underneath.
  let detailChart = $state<ChartTarget | null>(null)
  let downloadsOpen = $state(false)
  let shortcutsOpen = $state(false)
  let searchEl = $state<HTMLInputElement | null>(null)

  // The sidebar's labels, not the view ids. A bug report that says "Issues view" can be matched
  // against what the user was looking at; one that says "tools" cannot, because that word appears
  // nowhere in the interface.
  const VIEW_NAMES: Record<ViewId, string> = {
    home: 'Home',
    browse: 'Explore',
    library: 'Installed',
    assets: 'Asset Studio',
    tools: 'Issues',
    settings: 'Settings'
  }

  /**
   * Identity of what the content pane is currently showing.
   *
   * Two jobs. It names the broken screen in the error report, and "Tools view" is worth more to
   * whoever reads it than a minified stack alone. It also keys the view boundary below, which is
   * what makes navigating away from a broken screen work: a `<svelte:boundary>` that has failed
   * keeps rendering its fallback until something resets it, so without this key a user who
   * clicked Home would still be looking at the Tools crash.
   */
  const viewKey = $derived<unknown>(detailChart ?? view)
  const viewName = $derived(detailChart === null ? `${VIEW_NAMES[view]} view` : 'Chart detail')

  // The hint printed in the search field. Off the same table the sheet renders
  // and `matchShortcut` dispatches from, so the three cannot disagree. It used
  // to be the literal string "CTRL K", which was a lie on macOS.
  const searchHint = renderKeys('Mod K', typeof navigator === 'undefined' ? '' : navigator.platform)

  const control = (action: 'minimize' | 'maximize' | 'close'): void => {
    void window.encore.windowControl(action)
  }

  const onSearchInput = (value: string): void => {
    globalQuery.set(value)
    detailChart = null
    if (view !== 'browse') view = 'browse'
  }

  const goTo = (id: ViewId): void => {
    detailChart = null
    view = id
  }

  /**
   * Navigating closes the downloads panel.
   *
   * Keyed on `viewKey` rather than wired into each caller, because the callers are many and
   * scattered: the sidebar, `Mod+1-6`, the search field, Home's links, every card that opens a
   * chart, Detail's Back and the error fallback's Go to Home. One of those forgetting to close
   * the panel would be the bug this exists to prevent, so the closing is attached to the one
   * thing every one of them does: change what the content pane shows.
   *
   * `viewKey` is what the `{#key}` below already recreates the pane on, so "navigation" here
   * means exactly what it means there: a different view, or a chart opened or closed. The
   * panel's own toggle does not touch it, so reopening on the same view stays open. The first
   * run, on mount, writes `false` over `false`.
   */
  $effect(() => {
    void viewKey
    downloadsOpen = false
  })

  /**
   * Escape, resolved against whatever is layered on screen.
   *
   * Ordered outermost-first, and it stops at the first thing it finds: pressing
   * Escape with the downloads panel open over a chart closes the panel and
   * leaves the chart, which is what "close the thing I am in" has to mean if it
   * is to mean anything.
   *
   * Returns false when there was nothing to dismiss, so the caller can leave the
   * event alone rather than swallowing a key nothing acted on.
   */
  const dismiss = (): boolean => {
    if (shortcutsOpen) {
      shortcutsOpen = false
      return true
    }
    // The welcome tour sits under the sheet (? opens the sheet over it) and over everything else.
    // Escape is its Skip, so closing it here records it as seen, the same as Skip does.
    if ($tourOpen) {
      finishTour()
      return true
    }
    // What's new sits on the tour's layer and never draws beside it (see the render below), so
    // its place in the order is the tour's place. Closing it writes nothing, unlike the tour:
    // when a launch decides to show it, the version is recorded then rather than on dismissal,
    // so every way out of it costs the same.
    if ($whatsNew !== null) {
      closeWhatsNew()
      return true
    }
    // Any OTHER modal dialog on screen owns the keyboard, including Escape. The
    // Issues repair confirmation is one, and it has its own handler. Found
    // by role rather than by a flag because the dialogs belong to view
    // components App does not, and must not, keep state for.
    if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return false
    if (downloadsOpen) {
      downloadsOpen = false
      return true
    }
    if (detailChart !== null) {
      detailChart = null
      return true
    }
    return false
  }

  const onKeydown = (e: KeyboardEvent): void => {
    const id = matchShortcut(e)
    if (id === null) return
    // While the sheet is up it is modal: it may be closed and nothing else.
    if (shortcutsOpen && id !== 'dismiss' && id !== 'show-shortcuts') return
    // The tour is modal the same way, with the same two exceptions: its last screen says ? works
    // any time, so the sheet may open over it. It is exempted from the generic guard below for
    // that reason alone; the guard would otherwise see the tour's own dialog and stop the sheet.
    if ($tourOpen && id !== 'dismiss' && id !== 'show-shortcuts') return
    // Modal on the same terms as the tour, and exempted from the generic dialog guard below for
    // the same reason: ? has to keep opening the sheet over it.
    if ($whatsNew !== null && id !== 'dismiss' && id !== 'show-shortcuts') return
    // Everything below `dismiss` in the ordering above applies to the view
    // underneath a modal dialog, so none of it may fire while one is open.
    if (
      id !== 'dismiss' &&
      !$tourOpen &&
      $whatsNew === null &&
      document.querySelector('[role="dialog"][aria-modal="true"]') !== null
    ) {
      return
    }

    if (id === 'dismiss') {
      // Only claimed when it actually dismissed something. An Escape that hit
      // nothing still belongs to whatever is focused: a native <select>'s
      // dropdown, say.
      if (dismiss()) e.preventDefault()
      return
    }
    e.preventDefault()
    if (id === 'focus-search') searchEl?.focus()
    else if (id === 'show-shortcuts') shortcutsOpen = !shortcutsOpen
    else if (id === 'toggle-play') togglePlay()
    // `ShortcutView` is declared in shortcuts.ts as its own union rather than
    // imported from Sidebar.svelte, which the node test project cannot compile.
    // This assignment is what keeps the two honest: the moment they diverge,
    // svelte-check fails here.
    else goTo(id.slice('go:'.length) as ShortcutView)
  }

  onMount(() => {
    void initSettings()
    const offDownloads = initDownloads()
    const offScan = initScan()
    const offAssets = initAssets()
    // Subscribed here rather than in Settings, because the two states that arrive unasked (the
    // startup check's result, and download progress) land while that tab is closed as often as
    // not, and a subscription that only exists while the panel is mounted would miss them.
    const offAppUpdate = initAppUpdate()
    // Decides, once the settings load resolves, whether this launch is the first on a new version
    // and so owes the user the changelog. Here rather than in Settings for the obvious reason:
    // nobody opens Settings to find out what an update changed.
    const offWhatsNew = initWhatsNew()
    window.addEventListener('keydown', onKeydown)
    return () => {
      offDownloads()
      offScan()
      offAssets()
      offAppUpdate()
      offWhatsNew()
      window.removeEventListener('keydown', onKeydown)
    }
  })
</script>

<!--
  TWO boundaries, not one, and the nesting is the whole design.

  The inner one wraps only the content pane. A component that throws there takes the pane and
  nothing else: the titlebar, the sidebar and the player bar keep rendering, so the user can walk
  away from the broken screen instead of being trapped in front of it. That is the case worth
  optimising for, since a view is where nearly all of this app's rendering happens.

  The outer one exists because the inner one cannot cover the chrome that makes escape possible.
  If `Sidebar` or `PlayerBar` is what threw, there is nothing left to navigate with, and the honest
  answer is a full-window screen offering a reload. It is deliberately the worse experience,
  reached only when the better one is unavailable.

  Neither catches an async rejection or a throwing event handler; those unwind past every
  boundary. `installGlobalErrorHandlers` (main.ts) is the path for those, and `RuntimeErrorBar`
  below is where they surface.
-->
<svelte:boundary>
  {#snippet failed(error, reset)}
    <ErrorFallback
      {error}
      where="app shell"
      scope="app"
      onRetry={reset}
      onLeave={() => window.location.reload()}
    />
  {/snippet}
  <div class="app">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- titlebar is a drag region; dblclick-maximize matches native caption-bar behavior -->
    <header class="titlebar" ondblclick={() => control('maximize')}>
      <div class="search" ondblclick={(e) => e.stopPropagation()}>
        <input
          bind:this={searchEl}
          value={$globalQuery}
          placeholder="Search charts…"
          aria-label="Search charts"
          oninput={(e) => onSearchInput(e.currentTarget.value)}
        />
        <!-- aria-hidden: the input's own label already names it, and a screen
             reader reading "Ctrl K" after it would be describing a key the user
             has no way to act on from inside the field's announcement. -->
        <span class="kbd" aria-hidden="true">{searchHint.join(' ').toUpperCase()}</span>
      </div>
      <div class="controls">
        <!-- ondblclick stops propagation so button double-clicks don't trigger the header maximize -->
        <button
          onclick={() => control('minimize')}
          ondblclick={(e) => e.stopPropagation()}
          aria-label="Minimize"><Icon name="minus" size={14} /></button
        >
        <button
          onclick={() => control('maximize')}
          ondblclick={(e) => e.stopPropagation()}
          aria-label="Maximize"><Icon name="square" size={12} /></button
        >
        <button
          class="close"
          onclick={() => control('close')}
          ondblclick={(e) => e.stopPropagation()}
          aria-label="Close"><Icon name="x" size={14} /></button
        >
      </div>
    </header>
    <div class="body">
      <Sidebar
        {view}
        {downloadsOpen}
        onNavigate={goTo}
        onToggleDownloads={() => (downloadsOpen = !downloadsOpen)}
        onShowShortcuts={() => (shortcutsOpen = true)}
      />
      <!-- The {#key} here is the boundary's reset, NOT a re-render device: the {#if} chain below
         already creates a fresh component (and a fresh root element) on every navigation, and an
         earlier {#key} around a wrapper div was removed for adding a second teardown to each one.
         What it buys back is that a boundary which has caught an error keeps showing its fallback
         until it is reset, so without this, clicking Home while Tools is broken would leave the
         Tools crash on screen. Keyed on the chart object rather than the view id so opening a
         different chart clears a failed Detail too. The fade still rides on the new root element
         via CSS; {#key} adds no element of its own. -->
      {#key viewKey}
        <main class="view">
          <svelte:boundary>
            {#snippet failed(error, reset)}
              <ErrorFallback
                {error}
                where={viewName}
                scope="view"
                onRetry={reset}
                onLeave={() => {
                  detailChart = null
                  view = 'home'
                }}
              />
            {/snippet}
            {#if detailChart}
              <Detail
                target={detailChart}
                onBack={() => (detailChart = null)}
                onNavigate={(id) => {
                  detailChart = null
                  view = id
                }}
              />
            {:else if view === 'home'}
              <!-- The welcome replaces Home only, never the whole app: the sidebar keeps working, so
             nobody is stuck behind it. It is also why the gate is not applied to the other
             branches: a first-run user who clicks Settings must get Settings. -->
              {#if !$settingsLoaded}
                <!-- Deliberately empty for the one frame the settings load takes. `settings` starts
               at its defaults, which have no library folders, so rendering either Home or
               Welcome here would be a guess, and the wrong one flashes on every cold start. -->
              {:else if $needsWelcome}
                <Welcome onNavigate={(id) => (view = id)} />
              {:else}
                <Home
                  onNavigate={(id) => (view = id)}
                  onOpenChart={(target) => (detailChart = target)}
                />
              {/if}
            {:else if view === 'browse'}
              <Browse onOpenChart={(target) => (detailChart = target)} />
            {:else if view === 'library'}
              <Library onOpenChart={(target) => (detailChart = target)} />
            {:else if view === 'assets'}
              <Assets />
            {:else if view === 'tools'}
              <Tools />
            {:else if view === 'settings'}
              <Settings />
            {/if}
          </svelte:boundary>
        </main>
      {/key}
    </div>
    <!-- One positioned box for the strip and the bar together. The downloads panel (rendered
         inside PlayerBar) sets `bottom: calc(100% + 10px)` against its containing block, and
         that block has to be this wrapper, not the bar: the strip stacks ABOVE the bar, so a
         panel anchored to the bar alone measured y 657-727 at 1280×800 over a strip at
         699-736, covering its Copy and Dismiss buttons (707-729). Anchored here it clears the
         strip by the same 10px it clears the bar. -->
    <div class="foot">
      <RuntimeErrorBar />
      <PlayerBar bind:open={downloadsOpen} />
    </div>
    <!-- The tour is layered over the view rather than being one, so a first run gets it before
         the folder picker underneath, and a later reopening gets it over Settings without the
         picker. Rendered before the sheet, which stacks above it. -->
    {#if $tourOpen}
      <WelcomeTour onclose={finishTour} onopen={goTo} />
    {:else if $whatsNew !== null}
      <!-- Never beside the tour, which is why this is an {:else if} and not a second block. The
           two cannot both be owed on one launch (a first run records the version and stays quiet,
           see whatsNewOnLaunch), but the tour can be reopened from Settings at any time, and two
           cards on one layer would stack on each other. The tour wins: it is the one the user
           just asked for. -->
      <WhatsNew version={$whatsNew.version} offered={$whatsNew.offered} onclose={closeWhatsNew} />
    {/if}
    <!-- Inside the app shell but outside the view boundary: the sheet documents
         the keys that navigate away from a broken screen, so it has to survive
         one. -->
    {#if shortcutsOpen}
      <ShortcutSheet onclose={() => (shortcutsOpen = false)} />
    {/if}
  </div>
</svelte:boundary>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    position: relative;
  }
  .titlebar {
    display: flex;
    align-items: center;
    height: 40px;
    padding: 0;
    border-bottom: 1px solid var(--hairline);
    -webkit-app-region: drag;
    position: relative;
  }
  .search {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: min(420px, 40vw);
    display: flex;
    align-items: center;
    -webkit-app-region: no-drag;
  }
  .search input {
    width: 100%;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    padding: 6px 64px 6px 11px;
    color: var(--text-1);
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    transition: border-color var(--t-fast) var(--ease);
  }
  .search input:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  .search .kbd {
    position: absolute;
    right: 8px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-flat);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 2px 5px;
    pointer-events: none;
  }
  .controls {
    margin-left: auto;
    display: flex;
    -webkit-app-region: no-drag;
  }
  .controls button {
    width: 42px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  /* These three sit flush in the window corner (measured, the close button's
     right edge IS `innerWidth`), so the app's outward 2px focus ring loses its
     top and right sides to the window edge. Drawn inside the button instead,
     where all four sides survive. Same colour and width as everywhere else. */
  .controls button:focus-visible {
    outline-offset: -3px;
  }
  .controls button:hover {
    background: var(--surface-2);
    color: var(--text-1);
  }
  .controls button.close:hover {
    background: var(--accent);
    color: var(--bg);
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .foot {
    position: relative;
    flex-shrink: 0;
  }
  .view {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }
  /* Each view component renders one root element, and switching views creates a
     new one, so the entry animation plays exactly once per navigation without
     an extra wrapper or a {#key} block. Height is deliberately not set here:
     the views that need to fill the pane declare `height: 100%` themselves, and
     forcing it on the others would shrink their column-flex content. */
  .view > :global(*) {
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
</style>
