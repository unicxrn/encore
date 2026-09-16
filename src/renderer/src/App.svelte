<script lang="ts">
  import { onMount } from 'svelte'
  import Assets from './lib/components/Assets.svelte'
  import Browse from './lib/components/Browse.svelte'
  import Detail from './lib/components/Detail.svelte'
  import ErrorFallback from './lib/components/ErrorFallback.svelte'
  import Home, { type ChartTarget } from './lib/components/Home.svelte'
  import Icon from './lib/components/Icon.svelte'
  import Library from './lib/components/Library.svelte'
  import Rail from './lib/components/Rail.svelte'
  import RuntimeErrorBar from './lib/components/RuntimeErrorBar.svelte'
  import Settings from './lib/components/Settings.svelte'
  import Stats from './lib/components/Stats.svelte'
  import PlayerBar from './lib/components/PlayerBar.svelte'
  import ShortcutSheet from './lib/components/ShortcutSheet.svelte'
  import Sidebar, { type ViewId } from './lib/components/Sidebar.svelte'
  import Tools from './lib/components/Tools.svelte'
  import UpdatePrompt from './lib/components/UpdatePrompt.svelte'
  import Welcome from './lib/components/Welcome.svelte'
  import WelcomeTour from './lib/components/WelcomeTour.svelte'
  import WhatsNew from './lib/components/WhatsNew.svelte'
  import { initSettings, needsWelcome, settings, settingsLoaded } from './lib/stores/settings'
  import { encore } from './lib/stores/bridge'
  import { errorHeadline } from './lib/errors'
  import { finishTour, tourOpen } from './lib/stores/tour'
  import {
    closeWhatsNew,
    initWhatsNew,
    openOfferedWhatsNew,
    whatsNew
  } from './lib/stores/whats-new'
  import { initDownloads } from './lib/stores/downloads'
  import { initScan } from './lib/stores/scan'
  import { initAssets } from './lib/stores/assets'
  import { appUpdate, downloadAppUpdate, initAppUpdate } from './lib/stores/app-update'
  import { offeredUpdate } from '../../shared/app-update'
  import { globalQuery } from './lib/stores/global-search'
  import { togglePlay } from './lib/stores/preview-controller'
  import { matchShortcut, renderKeys, type ShortcutView } from './lib/shortcuts'
  import { railOnScreen } from './lib/rail-visible'
  import { surprise } from './lib/stores/surprise'

  let view = $state<ViewId>('home')
  // The chart page's subject: opened from Installed's rows, from the rail's All details, or by
  // `selectChart` falling through at a width with no rail. While set, Detail replaces the
  // current view; Back clears it and returns to the view underneath.
  let detailChart = $state<ChartTarget | null>(null)
  /**
   * The rail's subject: the last chart this launch picked out, and null before the first one.
   *
   * Written four ways now. An Explore row picks a chart without navigating anywhere, a Home row
   * does the same, an Installed row's Preview button does the same, and opening a chart page
   * still points the rail at what the page is showing.
   *
   * Deliberately NOT cleared when Detail closes, and deliberately not cleared by navigating to
   * Settings or Stats. The rail is "what you are previewing", which is the same subject the
   * player bar directly beneath it already holds across every view; a rail that emptied on the
   * two views with nothing to select would be contradicting the bar under it on the same
   * screen. What it costs is that the rail is empty until the first chart of the session, which
   * is a state that ends and does not come back.
   */
  let railChart = $state<ChartTarget | null>(null)
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
    stats: 'Stats',
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

  /**
   * What the two title-bar buttons could not do, in the words the user needs.
   *
   * A launch that the operating system refused, or a reveal of a folder that has since been
   * removed from the library, is a direct answer to a press: it belongs beside the button that
   * was pressed and not in a console nobody can open in a packaged build. `RuntimeErrorBar` is
   * the other on-screen surface and is deliberately not this one: it exists for the errors that
   * unwind past every boundary with nobody waiting on them, and it labels itself BACKGROUND
   * ERROR, which this is not.
   *
   * The note renders `position: absolute` under the bar, so a message of any length costs the
   * 50px title row nothing. scripts/measure-top-bar.mjs measures that rather than assuming it.
   */
  let topbarError = $state<string | null>(null)

  /**
   * Whether Encore launches the game on this platform at all.
   *
   * Linux and Windows; see `gameLaunchSupported` in main/game/executable.ts for why macOS is
   * out. The button is not drawn there rather than being drawn and always refusing: a control
   * that cannot work on this machine is worth less than the room it takes in a 50px row.
   * `window.encore` is read directly because the platform is a value on the bridge rather than a
   * channel, and it cannot change while the process runs.
   */
  const canLaunchGame = typeof window === 'undefined' || window.encore?.platform !== 'darwin'

  /**
   * Start Clone Hero, or go and ask where it is.
   *
   * An unset path leads to the setting rather than failing: the user pressed a button that names
   * a thing Encore does not yet know how to do, and the answer to that is the one screen where
   * they can say. A path that IS set is main's to check and to run, and its refusal is what the
   * note below shows.
   */
  const launchGame = async (): Promise<void> => {
    topbarError = null
    if ($settings.gamePath === '') {
      goTo('settings')
      return
    }
    try {
      await encore().gameLaunch()
    } catch (err) {
      topbarError = errorHeadline(err)
    }
  }

  /**
   * Open the library in the system file manager.
   *
   * `chartReveal` rather than a channel of its own, which is the point: main already has one
   * guarded route from a path to the desktop shell, it already refuses anything outside the
   * configured folders, and a library folder is inside itself by that check. A second channel
   * would be a second place for that guard to be forgotten.
   *
   * The folder is the one downloads land in, since that is the one a user asking for "my
   * library" has just put something into. With none configured there is nothing to open, and
   * Settings is where that is fixed.
   */
  const openLibrary = async (): Promise<void> => {
    topbarError = null
    const folders = $settings.libraryFolders
    const target = folders.find((f) => f.isDefault) ?? folders[0]
    if (!target) {
      goTo('settings')
      return
    }
    try {
      await encore().chartReveal(target.path)
    } catch (err) {
      topbarError = errorHeadline(err)
    }
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
   * Five charts the user does not have, and the view they belong in.
   *
   * Explore is where this lands because Explore is the list of charts that are not in the
   * library: the rows, the health dot, the pips, the per-row download, the multi-select and the
   * rail a row fills are all already built for exactly these five charts, and a surprise shown
   * anywhere else would be a second, poorer copy of that list. The store puts a line over it
   * saying where the rows came from; see `SearchStore.present`.
   *
   * Navigating first rather than when the answer arrives. The press has to be visibly heard, the
   * roll's own note is on the view it is navigating to, and a failure then lands beside the list
   * rather than in a sidebar tile with no room for a sentence.
   */
  const surpriseMe = (): void => {
    goTo('browse')
    void surprise.roll()
  }

  /**
   * Point the rail at a chart, without taking the list away.
   *
   * What Explore's rows do, what Home's rows do, and what Installed's per-row Preview button
   * does. Browsing is a scanning task: the pips, the health dot, the statistics and the highway
   * in the rail are the whole of "is this the version I want", and a page swap per chart is the
   * wrong weight for a question answered that often. The chart page is still there, reached from the rail once a
   * chart is in it, for the four things only it has.
   *
   * The fallback is the width case. Below the shell's breakpoint the rail is `display: none`, so
   * filling it would be a click with nothing to show for it; there the chart page is the only
   * place the answer can go, and the rail is pointed at it anyway so widening the window later
   * finds the column already holding the right chart. `railOnScreen` asks the element rather
   * than the window, so the breakpoint stays written down once, in the media query below.
   *
   * Installed cannot reach the fallback: its Preview button is hidden by the same query that
   * hides the rail. It shares this handler regardless, because a second copy of the rule is a
   * second place for it to go wrong.
   */
  const selectChart = (target: ChartTarget): void => {
    railChart = target
    if (!railOnScreen()) detailChart = target
  }

  /**
   * The launch prompt for a newer Encore: whether it is owed, and what pressing anything does.
   *
   * Skipping is session state, held here rather than in a store and written nowhere. The owner's
   * rule is that Skip means not now and not never, so the flag lives exactly as long as this
   * component does, which is exactly as long as the launch does. A store would outlive a remount
   * and a setting would outlive the launch, and either one would quietly turn Skip into never.
   */
  let updateSkipped = $state(false)

  /** Null unless a check has found a release. See `offeredUpdate` for why only that state. */
  const updateOffer = $derived(offeredUpdate($appUpdate))

  /**
   * Whether something else already owns this launch.
   *
   * The tour and the what's new panel share this layer and both open themselves. They are also
   * both earned: the tour by a first run, the panel by the update the user just installed.
   */
  const launchTaken = $derived($tourOpen || $whatsNew !== null)

  const updatePromptOpen = $derived(
    updateOffer !== null && !updateSkipped && $settingsLoaded && !launchTaken
  )

  /**
   * One interruption per launch, decided once.
   *
   * Three things can want the screen when Encore starts: the first-run tour, the what's new panel
   * after an update, and this. Stacking them, or letting whichever resolves first win, is the
   * defect. So the update prompt is last in the order and it yields the whole launch rather than
   * queueing behind: if either of the others was up at the moment the check's answer arrived,
   * this launch is spent and the prompt is skipped exactly as if the user had pressed Skip. It
   * asks again next time, which costs the user one launch and never costs them two cards at once.
   * A fresh install is the case that matters most: the tour is open, so nothing tells someone who
   * has just installed Encore that Encore needs updating.
   *
   * Gated on `settingsLoaded`, because that is the moment the other two decide. Before it they are
   * both closed and both undecided, so a check that answered first would win a race rather than
   * an argument. `decided` is a plain variable, not state: the decision is made once and nothing
   * renders from it.
   */
  let decided = false
  $effect(() => {
    if (decided) return
    if (!$settingsLoaded) return
    if (updateOffer === null) return
    decided = true
    if (launchTaken) updateSkipped = true
  })

  /** Not now, not never: nothing is written, so the next launch asks again. */
  const skipUpdate = (): void => {
    updateSkipped = true
  }

  /**
   * Start the download and hand the user to the row that owns the rest of it.
   *
   * Deliberately not a second download path. `downloadAppUpdate` is the call the Updates row in
   * Settings makes, and Settings is where the percent, the failure and the Restart button already
   * are, so this navigates there rather than growing a copy of that row inside a modal. The skip
   * flag is set as well, so the prompt is gone the moment it is pressed rather than for the frames
   * between the invoke and main's first state push.
   */
  const installUpdate = (): void => {
    updateSkipped = true
    goTo('settings')
    void downloadAppUpdate()
  }

  /**
   * The changelog, opened on the offered version rather than on the running one.
   *
   * A build ships the changelog it was built from, so it has no entry for a release published
   * after it. `openOfferedWhatsNew` is the existing answer to exactly that: it says the release
   * exists, says the notes are not in this build, and links its release page. It does NOT skip the update. The
   * panel outranks this prompt on the shared layer, so the prompt is hidden while the notes are
   * open and comes back when they are closed, which is what someone who pressed "What's new" to
   * decide is asking for.
   */
  const showUpdateNotes = (): void => {
    if (updateOffer === null) return
    openOfferedWhatsNew(updateOffer.version)
  }

  // The rail follows what the user opens, and holds it afterwards. Written here rather than at
  // each caller for the reason the downloads effect below gives: the callers are many.
  $effect(() => {
    if (detailChart !== null) railChart = detailChart
  })

  /**
   * Navigating closes the downloads panel.
   *
   * Keyed on `viewKey` rather than wired into each caller, because the callers are many and
   * scattered: the sidebar, `Mod+1-7`, the search field, Home's links, an Installed row, the
   * rail's All details, Detail's Back and the error fallback's Go to Home. One of those forgetting to close
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
    // Last of the three that share this layer, in the order they render in. Escape here is Skip:
    // the same not-now the button says, written nowhere, so the next launch asks again.
    if (updatePromptOpen) {
      skipUpdate()
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
    // Modal on the same terms as the other two on this layer, and exempted from the generic
    // dialog guard below for the same reason: ? has to keep opening the sheet over it.
    if (updatePromptOpen && id !== 'dismiss' && id !== 'show-shortcuts') return
    // Everything below `dismiss` in the ordering above applies to the view
    // underneath a modal dialog, so none of it may fire while one is open.
    if (
      id !== 'dismiss' &&
      !$tourOpen &&
      $whatsNew === null &&
      !updatePromptOpen &&
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
    <Sidebar
      {view}
      {downloadsOpen}
      onNavigate={goTo}
      onToggleDownloads={() => (downloadsOpen = !downloadsOpen)}
      onShowShortcuts={() => (shortcutsOpen = true)}
      onSurprise={surpriseMe}
    />
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- topbar is a drag region; dblclick-maximize matches native caption-bar behavior -->
    <header class="topbar" ondblclick={() => control('maximize')}>
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
      <!-- The two things the title bar can do about the world outside Encore, in the order the
           approved design puts them: the game first, then the folder the charts are in, then the
           window controls. Both are `no-drag`, or a press would begin a window move instead. -->
      <div class="actions">
        {#if canLaunchGame}
          <button
            class="action"
            onclick={() => void launchGame()}
            ondblclick={(e) => e.stopPropagation()}
          >
            <Icon name="play" size={13} />
            <span>Launch Clone Hero</span>
          </button>
        {/if}
        <button
          class="action"
          onclick={() => void openLibrary()}
          ondblclick={(e) => e.stopPropagation()}
        >
          <Icon name="folder" size={13} />
          <span>My library</span>
        </button>
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
      <!-- Out of flow, so a sentence of any length costs the 50px row nothing. `role="alert"`
           because it is the answer to something the user just pressed and nothing else on screen
           will have changed to say so. -->
      {#if topbarError !== null}
        <div class="topbar-note" role="alert">
          <p>{topbarError}</p>
          <button class="hairline" onclick={() => (topbarError = null)}>Dismiss</button>
        </div>
      {/if}
    </header>
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
              <!-- Home's chart rows land where Explore's do. Both are places a chart is
                   scanned rather than read, so both hand the rail the chart and leave the page
                   where it is; `selectChart` is also what falls through to the chart page at a
                   width where there is no rail to fill. -->
              <Home onNavigate={(id) => (view = id)} onSelectChart={selectChart} />
            {/if}
          {:else if view === 'browse'}
            <!-- Explore has one way out of a row and it does not navigate: the rail is where a
                 result lands. Nothing here opens the chart page, which is why Browse is handed
                 no way to; the route to it is the rail's own, beside the chart it is showing. -->
            <Browse onSelectChart={selectChart} />
          {:else if view === 'library'}
            <!-- Two ways out of a row, and only one of them navigates. Preview writes the rail's
                 subject directly, which is the same slot Detail's effect above writes and the
                 same one the rail reads, so a previewed chart survives leaving Installed exactly
                 as an opened one does.

                 Explore differs deliberately: an Installed row is a chart the user already has,
                 so opening it is a visit to a file they own and the page is the right weight for
                 that. An Explore row is a candidate among 95,000, and the question is which one
                 to take. -->
            <Library onOpenChart={(target) => (detailChart = target)} onSelectChart={selectChart} />
          {:else if view === 'assets'}
            <Assets />
          {:else if view === 'stats'}
            <Stats />
          {:else if view === 'tools'}
            <Tools />
          {:else if view === 'settings'}
            <Settings />
          {/if}
        </svelte:boundary>
      </main>
    {/key}
    <!-- Its own boundary, and a third one rather than a wider one: the rail reads a chart
         record and renders a preview, so it can throw for reasons the content pane never
         would, and a rail that throws must cost the user the rail and not the app. -->
    <svelte:boundary>
      {#snippet failed(error: unknown, reset: () => void)}
        <!-- Deliberately not `ErrorFallback`: that draws a whole pane, and this column is
             374px wide. The message the rail can afford is one line, with the reason in the
             tooltip for whoever is reporting it. -->
        <aside class="rail rail-failed" aria-label="Chart detail">
          <p title={error instanceof Error ? error.message : String(error)}>
            The rail stopped working.
          </p>
          <button class="btn-ghost" onclick={reset}>Try again</button>
        </aside>
      {/snippet}
      <!-- The one route from the rail to the chart page, and it is the rail's rather than
           Explore's on purpose: a control on every row would be thirty invitations to leave the
           list, which is the thing this arrangement exists to stop. Here there is one, beside
           the chart it would open, and it goes with the column below the breakpoint, where the
           row click opens the page directly and nothing needs routing. -->
      <Rail target={railChart} onOpenDetail={(target) => (detailChart = target)} />
    </svelte:boundary>
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
    {:else if updatePromptOpen && updateOffer !== null}
      <!-- Last in the chain, and part of it rather than a block of its own, so the exclusivity is
           structural: one layer, one card, whatever three independent decisions concluded. The
           `updateOffer !== null` here is what narrows it for the props; `updatePromptOpen` has
           already required it. -->
      <UpdatePrompt
        version={updateOffer.version}
        currentVersion={updateOffer.currentVersion}
        canApply={updateOffer.canApply}
        note={updateOffer.note}
        onskip={skipUpdate}
        oninstall={installUpdate}
        onnotes={showUpdateNotes}
      />
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
  /* The window frame: three columns, three rows, and every child placed by hand.
     
     The placement is the whole of this rule and none of it is optional. A grid with fewer
     explicit rows than it has children auto-places the overflow into implicit rows, and the
     symptom is not a warning: the content pane lands in the player's row, the player is pushed
     into an implicit fourth, and the window paints as a black band with everything crushed at
     the bottom. That is not a hypothetical; it is what this frame did twice before the rules
     below were written. `grid-auto-rows: 0` is the belt: anything that ever did auto-place
     collapses to nothing and shows up in `scripts/measure-play-stats.mjs` as a zero-height
     region rather than as a silently rearranged window.

     The four launch overlays (the tour, what's new, the update prompt, the shortcut sheet) are
     `position: fixed` in their own components, so they are out of flow and are not grid items
     at all. They are the reason the belt exists rather than a reason to widen the template. */
  .app {
    display: grid;
    grid-template-columns: 238px 1fr 374px;
    grid-template-rows: 50px 1fr 70px;
    grid-auto-rows: 0;
    height: 100vh;
    position: relative;
  }
  /* Below this the rail is more chrome than the content column can pay for: at the 960px
     minimum window width the three fixed tracks leave 348px for the view, which is narrower
     than the rail beside it. The rail is the thing that goes, because it is the only one of
     the five that repeats what another screen already shows. */
  @media (max-width: 1120px) {
    .app {
      grid-template-columns: 238px 1fr;
    }
    .app > :global(.rail) {
      display: none;
    }
    /* Anything whose only job is to point the rail at a chart goes with the rail. Installed's
       per-row Preview button is the one such control; it lives in Library.svelte and is hidden
       from here so this width stays written down once, in the query above it. */
    .app :global(.to-rail) {
      display: none;
    }
    .topbar,
    .foot {
      grid-column: 2 / 3;
    }
  }
  /* Column 1, all three rows: the sidebar runs from the window's top edge to its bottom one,
     so the wordmark sits beside the top bar rather than under it. Placed from here rather than
     from the component, so all five placements are readable in one block. */
  .app > :global(.sidebar) {
    grid-column: 1 / 2;
    grid-row: 1 / 4;
    min-height: 0;
  }
  .topbar {
    grid-column: 2 / 4;
    grid-row: 1 / 2;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 100%;
    /* Padding on the left only. The window controls have to stay flush in the corner (see the
       focus-ring rule below, which exists because the close button's right edge IS innerWidth),
       so the row is inset where it begins and not where it ends. */
    padding: 0 0 0 14px;
    border-bottom: 1px solid var(--hairline);
    -webkit-app-region: drag;
    position: relative;
  }
  /* In flow rather than absolutely centred, which is what makes room for the two buttons.
     Centred, the box was placed from the row's midpoint and knew nothing about what was to its
     right, so the buttons were drawn straight over it. Measured with the centred rule and the
     buttons both in place (scripts/measure-top-bar.mjs): 237px of overlap at a 960px window,
     175px at 1120 and again at 1121, 95px at 1280, and clear only at 1920. Laid out in the row,
     the buttons take their width first and the search takes what is left, up to the same
     maximum it had before. `min-width` is what stops it collapsing to its content at the 960px
     window minimum; `flex: 1` is what keeps it as wide as it used to be above that. */
  .search {
    position: relative;
    flex: 1 1 auto;
    min-width: 180px;
    max-width: 420px;
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
  /* `margin-left: auto` here rather than on `.controls`: one auto margin puts everything from
     this point on against the right edge, where two would split the free space and float the
     buttons somewhere in the middle of the row. */
  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 8px;
    -webkit-app-region: no-drag;
  }
  .actions .action {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 29px;
    padding: 0 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    white-space: nowrap;
    cursor: pointer;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .actions .action:hover {
    border-color: var(--accent);
    color: var(--text-1);
  }
  .controls {
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
  /* Anchored to the title bar and out of its flow, so the row stays exactly 50px whatever the
     message says. Right-aligned under the buttons it belongs to, capped so a long path wraps
     rather than running the width of the window, and above the view underneath it. */
  .topbar-note {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 5;
    max-width: min(460px, calc(100% - 16px));
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 6px;
    padding: 9px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    box-shadow: var(--elev-3);
    -webkit-app-region: no-drag;
  }
  .topbar-note p {
    margin: 0;
    font-size: var(--fs-secondary);
    color: var(--text-1);
  }
  .topbar-note .hairline {
    flex-shrink: 0;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 3px 9px;
    cursor: pointer;
  }
  /* Row 3 is 70px and this box is content-sized against it, pinned to the row's bottom edge.
     That is what lets the runtime error strip appear without moving the player bar: the strip
     grows this box UPWARD, over the bottom of the content column, instead of pushing the bar
     off the window the way a stretched 70px item would. The downloads panel anchors to this
     box (see DownloadsPanel's `.panel`), so it keeps clearing the strip by the same 10px. */
  .foot {
    grid-column: 2 / 4;
    grid-row: 3 / 4;
    align-self: end;
    position: relative;
    width: 100%;
  }
  .view {
    grid-column: 2 / 3;
    grid-row: 2 / 3;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }
  /* The rail's own column. The component paints it; this rule only places it, for the same
     reason every other child here carries a placement. */
  .app > :global(.rail) {
    grid-column: 3 / 4;
    grid-row: 2 / 3;
    min-height: 0;
  }
  .rail-failed {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 16px;
    border-left: 1px solid var(--hairline);
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  .rail-failed .btn-ghost {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 5px 12px;
    cursor: pointer;
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
