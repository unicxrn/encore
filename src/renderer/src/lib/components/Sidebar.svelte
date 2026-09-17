<script lang="ts" module>
  export type ViewId =
    | 'home'
    | 'browse'
    | 'library'
    | 'setlists'
    | 'assets'
    | 'stats'
    | 'tools'
    | 'duplicates'
    | 'metadata'
    | 'settings'
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { encore } from '../stores/bridge'
  import { appUpdate } from '../stores/app-update'
  import { downloads } from '../stores/downloads'
  import { spareCopies } from '../stores/duplicates'
  import { issueTally } from '../stores/issue-tally'
  import { scanProgress } from '../stores/scan'
  import { setlistCount } from '../stores/setlists'
  import { APP_VERSION } from '../../../../shared/constants'

  let {
    view,
    downloadsOpen,
    onNavigate,
    onToggleDownloads,
    onShowShortcuts,
    onSurprise
  }: {
    view: ViewId
    downloadsOpen: boolean
    onNavigate: (id: ViewId) => void
    onToggleDownloads: () => void
    onShowShortcuts: () => void
    /** Draw five charts the user does not have, and go to where they will be. App owns both. */
    onSurprise: () => void
  } = $props()

  interface NavItem {
    label: string
    d: string
    view?: ViewId
    action?: () => void
    /** Which of the four figures below belongs on this row, if any. */
    count?: CountId
  }

  /**
   * The four numbers this nav can carry, and what each one costs to know.
   *
   * The rule they all obey: **a count is drawn only when it is greater than zero.** On every one
   * of these four, a zero is at least as likely to mean "nothing has looked" as "there is none".
   * An unscanned catalog counts no charts; a launch where nobody opened Issues has no report. A
   * nav drawing the same glyph for both would be telling the user something it does not know, so
   * it draws none. An absent count claims nothing, which is the honest thing to claim.
   *
   * - `library` is `catalogCount({})`, the same call Home's hero makes, on the same channel. One
   *   indexed `SELECT COUNT(*)`, asked once on mount and again when a library scan stops. Nothing
   *   is asked per render.
   * - `downloads` is the queue, filtered to what is still running or waiting. It costs nothing at
   *   all: `downloads` is a store App subscribes to for the whole launch so the player bar can
   *   draw the same number, and this is a second reader of it rather than a second subscription.
   * - `duplicates` is the spare-copy count off the duplicate report, read once per launch by its
   *   store (see stores/duplicates.ts for what that read costs). It counts byte-identical copies
   *   and nothing else, because the other two tiers of that report are not faults.
   * - `issues` is the only one that cannot be asked for. Main's report is a cache that is null
   *   until a scan completes in this launch, and reading it copies 24,151 rows to count them. It
   *   is published by the Issues view instead, so the pill appears once something has looked and
   *   is absent every launch nothing has. stores/issue-tally.ts carries the whole reasoning.
   * - `setlists` is how many setlists there are, off the store App loads once per launch. It costs
   *   one property read per render and no query at all: the list is already in memory so the rail
   *   can draw which setlists hold a chart, and this is a second reader of it, the arrangement
   *   `downloads` has with the queue. It counts setlists and not the charts in them, because the
   *   row names the destination rather than its contents.
   */
  type CountId = 'library' | 'downloads' | 'duplicates' | 'issues' | 'setlists'

  /** Charts in the catalog, or null before the count answers and after one that failed. */
  let libraryTotal = $state<number | null>(null)

  const activeDownloads = $derived(
    $downloads.filter((item) => item.status === 'running' || item.status === 'queued').length
  )

  const countValues = $derived<Record<CountId, number | null>>({
    library: libraryTotal,
    downloads: activeDownloads,
    duplicates: $spareCopies,
    issues: $issueTally?.brokenCharts ?? null,
    setlists: $setlistCount
  })

  /**
   * What each figure means, said in words for the row's accessible name.
   *
   * Without this a screen reader gets "Installed 1,204", which is a number with no unit attached
   * to a word that is not a noun. The figure on screen is the same one; only the reading changes.
   */
  const COUNT_SAYS: Record<CountId, (n: number) => string> = {
    library: (n) => `${n.toLocaleString()} charts`,
    downloads: (n) => `${n} still to download`,
    duplicates: (n) => `${n} spare ${n === 1 ? 'copy' : 'copies'}`,
    issues: (n) => `${n} ${n === 1 ? 'chart is' : 'charts are'} broken`,
    setlists: (n) => `${n} ${n === 1 ? 'setlist' : 'setlists'}`
  }

  /** The Issues figure is a warning and is drawn as one; the other four are quiet. */
  const isPill = (id: CountId): boolean => id === 'issues'

  function countOf(item: NavItem): { figure: string; says: string; pill: boolean } | null {
    if (item.count === undefined) return null
    const n = countValues[item.count]
    if (n === null || n <= 0) return null
    return {
      figure: n.toLocaleString(),
      says: COUNT_SAYS[item.count](n),
      pill: isPill(item.count)
    }
  }

  /**
   * Two groups, and the ORDER inside them is what `Mod+1…9` means.
   *
   * SHORTCUT_VIEWS in shortcuts.ts is this list read top to bottom, pinned against this component
   * by its own test, so moving a row between groups is free and moving one past another is not.
   * Duplicates went in beside Issues, which is where the approved design puts it and which pushed
   * Settings from the seventh digit to the eighth. Setlists went in below Downloads, where the
   * design draws it, and pushed Settings off the end of the digits altogether. shortcuts.ts
   * records why Settings is the one that keeps paying for this.
   */
  const SECTIONS: { header: string; items: NavItem[] }[] = [
    {
      header: 'LIBRARY',
      items: [
        { view: 'home', label: 'Home', d: 'M4 11.5 12 4.5l8 7M6.5 9.75V19.5h11V9.75' },
        {
          view: 'browse',
          label: 'Explore',
          d: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm9 16-3.5-3.5'
        },
        { view: 'library', label: 'Installed', d: 'M4 5h16M4 12h16M4 19h10', count: 'library' },
        {
          label: 'Downloads',
          d: 'M12 4.5v9.5m0 0 4-4m-4 4-4-4M5.5 19.5h13',
          count: 'downloads',
          // Closure (not a direct reference) so the current prop value is called.
          action: () => onToggleDownloads()
        },
        {
          view: 'setlists',
          // The design's glyph: lines of a list with a note beside them. Not a heart and not a
          // folder, because a setlist is neither the charts you liked nor a place on disk.
          d: 'M4 6h11M4 12h11M4 18h7M18 8v9M18 17a2 2 0 1 0 0 .01',
          label: 'Setlists',
          count: 'setlists'
        },
        {
          view: 'assets',
          // "Assets" read as a second copy of Installed; "Asset Studio" names the job.
          // The view id is unchanged; this is a label-only rename.
          label: 'Asset Studio',
          d: 'M12 3v10.5M9.5 12.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 6c2 0 3-1 5-1v4c-2 0-3 1-5 1'
        }
      ]
    },
    {
      header: 'TOOLS',
      items: [
        {
          view: 'stats',
          label: 'Statistics',
          d: 'M4 19.5h16M7 19V11m5 8V5.5m5 13.5v-6'
        },
        {
          view: 'tools',
          label: 'Issues',
          d: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm7 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
          count: 'issues'
        },
        {
          view: 'duplicates',
          label: 'Duplicates',
          // Two overlapping squares, the shape every file manager uses for a copy.
          d: 'M8 8h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm7 0V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2',
          count: 'duplicates'
        },
        {
          view: 'metadata',
          // A pencil over lines of text: the fields it edits are the ones a row prints.
          d: 'M4 7h9M4 12h6M4 17h5m6.5-1.5L20 10l-2-2-4.5 5.5L13 17l2.5-1.5Z',
          label: 'Metadata editor'
        },
        {
          view: 'settings',
          label: 'Settings',
          d: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0-6v2m0 14v2m9-9h-2M5 12H3m13.7-6.7-1.4 1.4M7.7 16.3l-1.4 1.4m0-11.4 1.4 1.4m8.6 8.6 1.4 1.4'
        }
      ]
    }
  ]

  /**
   * The game the library belongs to.
   *
   * Encore reads Clone Hero's folders, Clone Hero's score files and Clone Hero's checksum, and
   * every one of those is specific to it. YARG is here as a tile and not as a menu item because
   * a switcher with one tile is not a switcher, and because the tile can say plainly that it is
   * not wired yet; a greyed row in a dropdown says nothing at all. Selecting it is refused
   * rather than silently ignored.
   */
  const GAMES = [
    { id: 'clonehero', label: 'Clone Hero', note: 'Your library' },
    { id: 'yarg', label: 'YARG', note: 'Not yet' }
  ] as const
  const game = 'clonehero'

  /**
   * Where Explore searches. Only the first of these is implemented.
   *
   * The two that are not are drawn as disabled controls carrying the reason, rather than as
   * live-looking segments that quietly do nothing: this app already downloads from Chorus
   * Encore and only from Chorus Encore, and a segment that looked switchable would be claiming
   * a source the downloads queue cannot fetch from.
   */
  const SOURCES = [
    { id: 'chorus', label: 'Chorus Encore', live: true },
    { id: 'rhythmverse', label: 'RhythmVerse', live: false },
    { id: 'both', label: 'Both', live: false }
  ] as const
  const source = 'chorus'
  const NOT_WIRED = 'Not connected yet. Encore searches Chorus Encore.'

  let ytdlpLine = $state('YT-DLP …')

  /**
   * One short line about Encore's own next release, for the footer.
   *
   * `appUpdate` is cast from the bridge rather than parsed (see the store), so a payload whose
   * `state` is not one of the seven the union names is reachable, not impossible. It says so
   * instead of rendering an empty line, which is how this was found: the offscreen measurement
   * script's fake bridge answers `{ state: 'idle' }`, a string where the union has an object,
   * and the footer's first line measured as the empty string.
   */
  const updateLine = $derived.by(() => {
    const state = $appUpdate?.state
    if (state === undefined) return 'UPDATE …'
    switch (state.kind) {
      case 'idle':
        return 'UPDATES NOT CHECKED'
      case 'checking':
        return 'CHECKING FOR UPDATES'
      case 'current':
        return 'UP TO DATE'
      case 'available':
        return `UPDATE ${state.version} AVAILABLE`
      case 'downloading':
        return state.percent === null ? 'DOWNLOADING UPDATE' : `DOWNLOADING ${state.percent}%`
      case 'ready':
        return `UPDATE ${state.version} READY`
      case 'error':
        return 'UPDATE CHECK FAILED'
      default:
        return 'UPDATE STATE UNKNOWN'
    }
  })

  /**
   * Whether the footer card is the lit one.
   *
   * Three of the seven states are Encore holding a release for the user: one offered, one coming
   * down, one waiting to be installed. Those are the states the approved design draws as a card
   * with an accent border and an accent wash behind it, and the other four are the states where
   * there is nothing to act on. A card lit in every state would be lit in none of them.
   *
   * `state` is read through two optional chains because it is cast rather than parsed (see
   * `updateLine`): a payload whose `state` is a bare string reaches this, and `.kind` on a string
   * is undefined, which is not one of the three and leaves the card quiet.
   */
  const updateWaiting = $derived(
    ['available', 'downloading', 'ready'].includes($appUpdate?.state?.kind ?? '')
  )

  /**
   * How many charts the catalog holds.
   *
   * `catalogCount({})` is what Home's hero asks for the same figure, on the same channel: this is
   * a second reader of one question, not a second way to ask it. A failure leaves the number null
   * and the row draws nothing, which is right: a sidebar that answered a failed count with 0
   * would be reporting an empty library.
   */
  async function readLibraryTotal(): Promise<void> {
    try {
      libraryTotal = await encore().catalogCount({})
    } catch {
      libraryTotal = null
    }
  }

  /**
   * A scan that has stopped has moved the catalog under this number, so it is re-asked.
   *
   * 'canceled' counts along with 'done' for the reason the scan store gives: a cancelled scan
   * keeps every row it wrote. The `mounted` guard is what stops an already-settled status from
   * firing a second read on top of the one onMount does.
   */
  let mounted = false
  $effect(() => {
    const status = $scanProgress?.status
    if (mounted && (status === 'done' || status === 'canceled')) void readLibraryTotal()
  })

  onMount(() => {
    void readLibraryTotal()
    mounted = true
    encore()
      .sidecarStatus('ytdlp')
      .then((s) => {
        ytdlpLine = s.installed && s.version ? `YT-DLP ${s.version}` : 'YT-DLP NOT INSTALLED'
      })
      .catch(() => {
        ytdlpLine = 'YT-DLP NOT INSTALLED'
      })
  })
</script>

<!-- Named because it is not the only navigation landmark a screen reader will
     find in this window, and "navigation" twice over is no help to anyone. -->
<nav class="sidebar" aria-label="Sections">
  <!-- The mark from build/logo/encore-small.svg: the strike bar and the five frets, back on the
       rounded square the icon files paint behind them. The square was dropped when the sidebar
       was the same colour as the icon's ground and so drew nothing; it is here now because the
       tile is the accent gradient rather than that ground, which is what the approved design
       asks the mark to be. The bar is white at half strength rather than the file's #4b4270:
       that value was picked to sit on a near-black square and is invisible on violet.

       This is the only place the real mark appears in the app; everywhere else the brand is the
       word. Decorative: the words beside it are the name. -->
  <div class="brand">
    <span class="mark-tile" aria-hidden="true">
      <svg class="mark" viewBox="17 80 116 24">
        <rect x="17" y="97" width="116" height="5" rx="2.5" fill="rgba(255, 255, 255, 0.5)" />
        <rect x="19" y="82" width="20" height="15" rx="7" fill="#35c759" />
        <rect x="42" y="82" width="20" height="15" rx="7" fill="#ff453a" />
        <rect x="65" y="82" width="20" height="15" rx="7" fill="#ffd60a" />
        <rect x="88" y="82" width="20" height="15" rx="7" fill="#0a84ff" />
        <rect x="111" y="82" width="20" height="15" rx="7" fill="#ff9f0a" />
      </svg>
    </span>
    <span class="brand-words">
      <span class="wordmark">ENC<span class="o">O</span>RE</span>
      <!-- What the app is, under what it is called. Mono and tracked out, so the two lines are
           told apart by their faces rather than only by their sizes. -->
      <span class="brand-sub">CHART MANAGER</span>
    </span>
  </div>

  <!-- A radiogroup and not a tablist: these pick which library Encore is looking at, which is a
       setting, not a view. Only one of the two can be chosen, and the other says why. -->
  <div class="games" role="radiogroup" aria-label="Game">
    {#each GAMES as entry (entry.id)}
      <button
        class="game"
        class:on={game === entry.id}
        role="radio"
        aria-checked={game === entry.id}
        disabled={entry.id !== game}
        title={entry.id === game ? undefined : 'Encore reads Clone Hero libraries'}
      >
        <!-- Lit on the tile that is the library Encore is reading, and drawn by the
             stylesheet on that tile alone. Violet rather than the design's green: selection in
             this app is violet everywhere else, and a second colour for the same idea here
             would be a second idea. -->
        <span class="game-dot" aria-hidden="true"></span>
        <span class="game-label">{entry.label}</span>
        <span class="game-note">{entry.note}</span>
      </button>
    {/each}
  </div>

  <div class="quick">
    <!-- Import playlist is disabled rather than absent: the frame is what this step is for, and a
         control that is coming reads better as a control that is not ready than as a gap that
         will change shape later. `title` carries the reason; `disabled` keeps it out of the tab
         order and out of every click. Surprise me was the other one and is a control now. -->
    <button class="quick-btn" disabled title="Playlist import is not built yet">
      <!-- The block is the design's, and its colour is not: the design fills this one with
           Spotify's green, which on a control that cannot import anything would be advertising
           an integration that does not exist. It gets the neutral fill until the row is built,
           and the live row beside it is the one carrying the accent. -->
      <span class="quick-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path d="M4 6h11M4 11h11M4 16h7M17.5 10v9m0 0 3-3m-3 3-3-3" />
        </svg>
      </span>
      <span class="quick-text">
        <b>Import playlist</b>
        <!-- aria-hidden for the reason the nav's figures are: `title` already carries this to a
             screen reader as the button's description, and said twice it would be read twice.
             It is on screen because a reason only a hover can reach is no reason at all. -->
        <span class="quick-note" aria-hidden="true">Not built yet</span>
      </span>
    </button>
    <!-- Goes to Explore and fills it, which is why the title says where: a quick action that
         changes the view has to say so before it is pressed, or the list the user was looking at
         appears to have been replaced by five charts for no reason. -->
    <button
      class="quick-btn"
      title="Five charts you do not have, drawn at random. Opens Explore."
      onclick={onSurprise}
    >
      <span class="quick-icon live" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path d="M5 5h4l10 14h-4M5 19h4l2-3m5-8 3-3m0 0-3-3m3 3h-4l-1 1.5M19 19l-3-3m3 3-3 3" />
        </svg>
      </span>
      <span class="quick-text">
        <b>Surprise me</b>
        <span class="quick-note" aria-hidden="true">Five charts at random</span>
      </span>
    </button>
  </div>

  <!-- Everything from the source switcher down is one scroller, which is the approved design's
       shape and not an arrangement of convenience. The brand, the game tiles and the two quick
       actions are the chrome that says which library this is, and the footer is the card that
       says what the app is doing; none of the four should leave the screen because the nav is
       long. What scrolls is the list, and the source box scrolls with it, so a user who wants
       the whole nav can push the box they are not using out of the way. -->
  <div class="navwrap">
    <!-- Named on screen rather than only in the group's `aria-label`. The block below is three
         rows in a well and nothing above it said what they pick between. -->
    <div class="group-label">SOURCE</div>
    <!-- Rows in a well, not three pills in a strip. The strip was the defect: three segments
         sharing 198px gave each about 66, and "Chorus Encore" needs 82 and "RhythmVerse" 71, so
         every one of the three arrived ellipsised and the user was choosing between
         "Chorus Enc...", "RhythmVe..." and "B...". A name the user cannot read is not a choice.
         Stacked, each row has the whole track and the widest of the three has 100px to spare.

         No figures on these rows, which is where the design puts 95,299 and 61,402. A count
         beside RhythmVerse would be sizing a catalogue the download queue cannot fetch from. -->
    <div class="source" role="radiogroup" aria-label="Chart source">
      {#each SOURCES as entry (entry.id)}
        <button
          class="seg"
          class:on={source === entry.id}
          role="radio"
          aria-checked={source === entry.id}
          disabled={!entry.live}
          title={entry.live ? undefined : NOT_WIRED}
        >
          <i class="seg-dot" aria-hidden="true"></i><span class="seg-label">{entry.label}</span>
        </button>
      {/each}
    </div>
    <!-- Said once in text rather than three times in tooltips: a tooltip is not an answer for
         someone who never hovers, and the two dead segments need one between them. -->
    <p class="source-note">{NOT_WIRED}</p>

    {#each SECTIONS as section (section.header)}
      <!-- The visible header names the group, so it is pointed at rather than
           duplicated into an aria-label. Without this the three headers are
           decoration and the sidebar is one flat run of eight buttons. -->
      <div class="section" role="group" aria-labelledby="sidebar-{section.header}">
        <div class="section-header" id="sidebar-{section.header}">{section.header}</div>
        {#each section.items as item (item.label)}
          {@const count = countOf(item)}
          <!-- Two different kinds of item share this button, and they need
               different state words. A view is a destination, so the active one is
               `aria-current="page"`, not `aria-selected`, which only means
               anything inside a tablist or a listbox. Downloads is not a
               destination at all: it opens a panel over the app, which is
               `aria-expanded`. Svelte drops an attribute whose value is
               `undefined`, so each item carries exactly one of the two.

               The classes split the same way, and that is the visual half of the
               same distinction. `active` is the page marker; `open` is the panel's
               own state, styled to read as "expanded" (see the rules below). The
               Downloads row used to borrow `active` while the panel was open, so on
               Issues or Settings two rows lit identically and a sighted user had no
               way to tell the page from the panel; aria-current got it right and
               the paint did not. -->
          <button
            class="item"
            class:active={item.view !== undefined && view === item.view}
            class:open={item.view === undefined && downloadsOpen}
            aria-current={item.view !== undefined && view === item.view ? 'page' : undefined}
            aria-expanded={item.view === undefined ? downloadsOpen : undefined}
            aria-label={count === null ? undefined : `${item.label}, ${count.says}`}
            title={count === null ? undefined : count.says}
            onclick={() => (item.view ? onNavigate(item.view) : item.action?.())}
          >
            <!-- Decorative: every item's name is the text beside the glyph. -->
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
            >
              <path d={item.d} />
            </svg>
            <!-- The label is its own box so it can ellipsise against the figure beside it rather
                 than pushing it out of the 238px column. -->
            <span class="label">{item.label}</span>
            <!-- aria-hidden because the row's own `aria-label` already reads the figure with its
                 unit attached; announced here as well it would be a bare number after a noun. -->
            {#if count !== null}
              <span class="count" class:pill={count.pill} aria-hidden="true">{count.figure}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  </div>
  <div class="foot">
    <!-- One card, lit only when there is a release to act on. The design draws it lit, because
         the design draws the one state where Encore is holding an update; the other four states
         have nothing to press and the card says so quietly instead. Same strings either way:
         which of the seven states this is, and then what the sidecar is. -->
    <div class="status-card" class:waiting={updateWaiting}>
      <div class="status-head">
        <!-- Decorative: the line beside it is what the card says. -->
        <svg
          class="status-glyph"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          aria-hidden="true"
        >
          <path d="M12 4.5v9.5m0 0 4-4m-4 4-4-4M5.5 19.5h13" />
        </svg>
        <!-- The update state, read from the same store Settings reads, so the footer cannot say
             something the Updates row disagrees with. Polite: it rewrites itself when the startup
             check answers, which is seconds after mount and nowhere near the user's attention. -->
        <div class="status-line" role="status">{updateLine}</div>
      </div>
      <!-- The line rewrites itself when the sidecar probe answers, seconds after
           mount. Polite so it waits for a gap rather than cutting in. -->
      <div class="status-line sub" role="status">{ytdlpLine}</div>
      <div class="status-links">
        <button class="settings-link" onclick={() => onNavigate('settings')}>Open Settings</button>
        <!-- `?` opens the same sheet. This is here because a shortcut nobody can
             find is not a feature, and this card is the only part of the chrome
             that is already about "what is this app doing". The key is in the
             tooltip rather than the label: `title` is only a fallback for the
             accessible name, so it adds the hint without renaming the button. -->
        <button class="settings-link" title="Press ? anywhere" onclick={onShowShortcuts}>
          Keyboard shortcuts
        </button>
      </div>
    </div>
    <div class="version">ENCORE v{APP_VERSION}</div>
  </div>
</nav>

<style>
  /* No width here any more: the app shell's grid owns column 1, and a component that also
     declared one would be a second answer to the same question.

     The ground is --ground-2, one step above the window. The column used to be the window's own
     colour, which is why it read as a region of the background rather than as a thing standing
     beside the content; the approved design has it lifted, and a lifted plane is what lets the
     well under the source rows and the recessed footer strip read as recessed at all. */
  .sidebar {
    background: var(--ground-2);
    border-right: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }
  /* The sidebar runs to the window's top edge, so this block is beside the title bar rather
     than under it, and has to drag the window like the title bar does. It holds no control, so
     nothing inside needs `no-drag`. Its height matches row 1 of the shell, which is what keeps
     the wordmark's baseline level with the search field's, and is why the heavier mark below
     had to fit 50px rather than ask for more: 31px of tile inside 50px of row. */
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 50px;
    flex-shrink: 0;
    padding: 0 12px;
    -webkit-app-region: drag;
  }
  /* The tile the icon files paint and the sidebar used to stand in for. 31px square, the
     middle step of the radius scale, and the accent gradient the primary buttons already use,
     so the mark is the same violet as everything else the app calls its own.

     No shadow under it. The approved design casts a violet halo here, and this file cannot:
     tokens.test.ts holds every component's box-shadow to one of the four --elev steps, all of
     which are black, and a violet one is not a shadow anyway. Its weight is 31px of gradient at
     the top of a column where nothing else is that colour, which is enough. */
  .mark-tile {
    width: 31px;
    height: 31px;
    flex-shrink: 0;
    border-radius: var(--radius);
    background: var(--accent-grad);
    display: grid;
    place-items: center;
  }
  /* The viewBox is cropped to the frets and the bar (116x24 units). 21px wide inside a 31px
     tile leaves 5px of gradient either side, and puts each fret at about 3.6 by 2.7px, which
     is the size they are in the 32px icon the taskbar draws. */
  .mark {
    width: 21px;
    height: 4.34px;
    display: block;
  }
  .brand-words {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .wordmark {
    font-size: var(--fs-emphasis);
    font-weight: 700;
    line-height: var(--lh-flat);
    color: var(--text-1);
    /* Exception: 0.14em, wider than --ls-caps. Six letters set as a wordmark, not a
       label. The extra tracking is what makes it read as a mark rather than a heading. */
    letter-spacing: 0.14em;
  }
  .brand .o {
    color: var(--accent);
  }
  .brand-sub {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-flat);
    letter-spacing: var(--ls-caps);
    color: var(--accent-tint);
  }
  /* -- game switcher --------------------------------------------------------- */
  .games {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    flex-shrink: 0;
    padding: 0 12px 12px;
  }
  /* 52px tiles, which is what makes them tiles rather than two lines of text with a box drawn
     round them. `position: relative` is for the dot; `overflow: hidden` keeps the gradient
     inside the radius. */
  .game {
    position: relative;
    overflow: hidden;
    height: 52px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    align-items: flex-start;
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    /* One step BELOW the column, not above it. The tile that is not the library Encore reads is
       the tile that is off, and a recessed plane is what off looks like. */
    background: var(--ground-1);
    color: var(--text-3);
    font-family: var(--font-ui);
    text-align: left;
    padding: 0 10px;
    cursor: pointer;
  }
  .game.on {
    border-color: var(--accent);
    background: linear-gradient(150deg, var(--accent-dim), var(--ground-3));
    color: var(--text-1);
  }
  /* The unselected tile is the one that is not available, and is drawn as unavailable rather
     than merely unselected: recessed where the live one is lifted, quiet where it is violet,
     no dot, no pointer, and a note underneath that says "Not yet" in words.

     What it does NOT do is fade. `opacity: 0.65` was what carried this before, and it put the
     note at 3.23:1 on the tile, under the 4.5:1 this file's own comment says the small labels
     have to clear. A reason the user cannot read is not a reason, so the unavailability is
     carried by everything except the text's contrast. */
  .game:disabled {
    cursor: default;
  }
  .game-dot {
    position: absolute;
    top: 7px;
    right: 8px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent-tint);
    opacity: 0;
  }
  .game.on .game-dot {
    opacity: 1;
  }
  .game-label {
    font-size: var(--fs-secondary);
    font-weight: 600;
    line-height: var(--lh-tight);
  }
  /* The UI face and not the mono one. Measured: "Your library" set in mono at --fs-caption with
     --ls-caps needs 97.9px and the tile's text box is 80.5px, so it wrapped to a second line
     inside a 52px tile. The label above it is already the UI face; the note matching it costs
     the tile nothing and buys back 30px. */
  .game-note {
    font-size: var(--fs-caption);
    line-height: var(--lh-tight);
    color: var(--text-3);
  }
  .game.on .game-note {
    color: var(--accent-tint);
  }
  /* -- quick actions --------------------------------------------------------- */
  .quick {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
    padding: 0 12px 10px;
  }
  .quick-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    background: var(--ground-3);
    color: var(--text-1);
    font-family: var(--font-ui);
    text-align: left;
    padding: 7px 10px;
    cursor: pointer;
    transition:
      border-color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .quick-btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--ground-4);
  }
  /* Recessed and quiet, the same pair of moves the off game tile makes, so "not ready" looks
     the same wherever this sidebar says it. No hover response at all: a row that lights under
     the pointer is a row that is offering something. */
  .quick-btn:disabled {
    cursor: default;
    background: var(--ground-1);
    color: var(--text-3);
  }
  .quick-icon {
    width: 27px;
    height: 27px;
    flex-shrink: 0;
    border-radius: var(--radius-sm);
    display: grid;
    place-items: center;
    background: var(--ground-4);
    color: var(--text-3);
  }
  .quick-icon.live {
    background: var(--accent-dim);
    color: var(--accent-text);
  }
  .quick-icon svg {
    width: 15px;
    height: 15px;
  }
  .quick-text {
    min-width: 0;
  }
  .quick-text b {
    display: block;
    font-size: var(--fs-secondary);
    font-weight: 600;
    line-height: var(--lh-tight);
  }
  .quick-note {
    display: block;
    font-size: var(--fs-caption);
    line-height: var(--lh-tight);
    color: var(--text-3);
  }
  /* -- the scroller ---------------------------------------------------------- */
  /* Two shapes, and which one the column gets is decided by whether it can afford the nicer
     one. Measured (scripts/measure-sidebar.mjs): the four fixed blocks take 340px and the nav
     plus the source well below them is 580px, so a column shorter than about 940px cannot hold
     a pinned footer AND the whole nav. Pinning it anyway is what a first pass at this did, and
     at the 600px window minimum (src/main/index.ts) it left ZERO nav rows on screen before the
     user scrolled: the brand, the tiles, the quick actions and the footer had taken 340 of the
     600, and the source well and its reason took the rest.

     So the default is the column scrolling as one, which is what it did before any of this, and
     which puts eleven of eleven rows on screen at 800px and five at 600. The query below is the
     upgrade, not the fallback, and it turns on at the height where it costs the nav nothing. At
     940px both shapes draw the same pixels, so nothing jumps across the boundary.

     `flex: 0 0 auto` rather than the default `0 1 auto`, and this is not belt and braces. The
     column is a flex container whose height the shell's grid fixes, so when its content is
     taller than the window every item that CAN shrink does, and an item whose automatic minimum
     size is zero shrinks to nothing. The old source strip declared `overflow: hidden` and so had
     exactly that minimum: measured in a real engine it was 2px tall at a 960x800 window, which
     is the whole control gone, and 26px at 1920x1080 where the column happened to fit. Nothing
     in here clips itself now, so nothing in here has a zero minimum, but the four blocks around
     this one all say `flex-shrink: 0` and this one saying it too is what makes the column scroll
     rather than squeeze. */
  .navwrap {
    flex: 0 0 auto;
    padding: 0 10px 10px;
  }
  @media (min-height: 940px) {
    .sidebar {
      overflow: hidden;
    }
    /* `min-height: 0` is what makes `flex: 1` mean "what is left" rather than "at least my
       content": without it a flex child refuses to shrink below its content and the footer is
       pushed off the bottom of the window instead of the list scrolling. */
    .navwrap {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .foot {
      margin-top: 0;
    }
  }
  /* -- source switcher ------------------------------------------------------- */
  /* The well. --ground-0 is the token for exactly this, an inset list on a lifted plane, and
     two steps below the column is what makes the selected row's --ground-4 fill read as a row
     standing up out of it. */
  .source {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    background: var(--ground-0);
    padding: 4px;
  }
  /* A full row each, which is the fix. Each takes the whole track rather than a third of it,
     so no source name is ellipsised at any window width. */
  .seg {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-3);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    line-height: var(--lh-tight);
    text-align: left;
    padding: 6px 9px;
    cursor: pointer;
  }
  .seg.on {
    background: var(--ground-4);
    color: var(--text-1);
    font-weight: 600;
  }
  .seg:disabled {
    cursor: default;
  }
  /* The dot says which row is the live one, and it is drawn in the accent on that row alone.
     No glow behind it: this column is open all day, and a 7px halo on a 5px dot is a light
     source rather than a state.

     The unlit dots are --text-3 and not --border-2. A border colour measures 1.51:1 on the
     well, which is a dot you cannot see rather than a dot that is off; --text-3 measures
     6.39:1, the same as the label beside it, so the row reads as one quiet thing. What carries
     the selection is not the dot's brightness anyway: the live row also has a fill, a heavier
     label and --text-1 to the others' --text-3. */
  .seg-dot {
    width: 5px;
    height: 5px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--text-3);
  }
  .seg.on .seg-dot {
    background: var(--accent-hi);
  }
  .seg-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source-note {
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
    padding: 7px 6px 0;
  }
  /* -- nav ------------------------------------------------------------------- */
  /* One rule for both kinds of label above a group: the source well's and the two section
     headers'. They are the same typographic job and were two sizes apart. */
  .group-label,
  .section-header {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-tight);
    text-transform: uppercase;
    color: var(--text-3);
    padding: 14px 6px 7px;
  }
  .group-label {
    padding-top: 12px;
  }
  .section-header {
    padding-left: 10px;
  }
  /* The two groups are told apart by their headers and by this. 8px rather than the 14 it was:
     the header above each already carries 14px of its own top padding, so the pair was reading
     as a 22px gutter between LIBRARY and TOOLS in a column that has rows to fit. */
  .section {
    margin-bottom: 8px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-body);
    /* 500 rather than 400. Nine rows of book weight under a 700 wordmark and two 600 tiles was
       the flattest run in the column. */
    font-weight: 500;
    text-align: left;
    padding: 7px 10px;
    cursor: pointer;
    position: relative;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .item:hover {
    color: var(--text-1);
    background: var(--ground-3);
  }
  .item.active {
    background: var(--surface-2);
    color: var(--text-1);
    font-weight: 600;
  }
  .item.active::before {
    content: '';
    position: absolute;
    left: -10px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 2px;
    background: var(--accent);
  }
  /* The panel-open state, built to be nothing the page marker is. The page row is a
     surface-2 fill with the accent bar in the gutter; this row keeps a transparent
     ground. A fill was tried and rejected: --accent-dim, #1d1440, measures 1.01:1
     against --surface-2, i.e. the same slab to the eye, and the two lit rows the audit
     found would have been back. What carries the
     state instead is the glyph turning violet and a chevron at the row's far edge
     pointing at the panel it opened, both in --accent-text: 7.3:1 on --bg (tokens.css),
     well past the 3:1 a non-text state indicator needs. The label lifts to text-1 like
     the page row's so the row reads as engaged, not merely hovered.

     `top: 50%` and a transform, not a margin: the chevron is a pseudo-element on a
     positioned row, so it takes no space and the row's box is the same width and
     height open or closed. Measured: the row holds still. */
  .item.open {
    color: var(--text-1);
  }
  .item.open svg {
    color: var(--accent-text);
  }
  .item.open::after {
    content: '';
    position: absolute;
    right: 12px;
    top: 50%;
    width: 5px;
    height: 5px;
    border-top: 1.7px solid var(--accent-text);
    border-left: 1.7px solid var(--accent-text);
    /* A square with two sides, turned so the corner points up: the panel sits above
       the bar this row is standing in for, and up is where it opened. The -30% rather
       than -50% recentres the rotated corner on the text's x-height. */
    transform: translateY(-30%) rotate(45deg);
  }
  .item svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  /* The label gives way, never the figure. `min-width: 0` is what lets it: without it a flex item
     refuses to shrink below its content and the count is pushed past the column's right edge
     instead.

     Measured rather than assumed (scripts/measure-sidebar.mjs): the row track is 202px and the
     padding, glyph and gap take 46 of them, so a label and a figure share 156px. At the largest
     figures anyone could reach (99,999 charts, 9,999 queued) every one of the eleven labels is
     drawn whole, and the longest, "Metadata editor", still has 5.7px of the 156 spare beside a
     five-digit figure it can never carry. The ellipsis this rule declares has nothing to do. */
  .item .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item .count {
    margin-left: auto;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-flat);
    letter-spacing: var(--ls-caps);
    /* So a figure changing from 999 to 1,000 does not shuffle the digits left of it. */
    font-variant-numeric: tabular-nums;
    font-weight: 400;
    color: var(--text-3);
  }
  /* Issues alone. It is the only one of the four that is a report of something wrong, and the
     approved design draws it as a warning rather than as a tally. Dark text on --warning, which
     is the pairing tokens.css intends for that colour as a fill. */
  .item .count.pill {
    color: var(--ground-0);
    background: var(--warning);
    border-radius: 9px;
    padding: 2px 7px;
    font-weight: 700;
    letter-spacing: 0;
  }
  /* The open Downloads row draws a chevron at `right: 12px` (see `.item.open::after`), and the
     figure would be underneath it. The row is the only one that can carry both, so the gap is
     made here rather than in the chevron's own rule. */
  .item.open .count {
    margin-right: 13px;
  }
  /* -- footer ---------------------------------------------------------------- */
  /* Recessed, and out of the scroller: what the app is doing should not have to be scrolled to.
     The strip is --ground-0 like the source well, so the two sunken regions in this column are
     the same plane rather than two nearly-equal darks. */
  .foot {
    flex-shrink: 0;
    /* Bottom of the column when there is slack, and below the nav when there is not. In the
       taller shape above there is never slack here, because the nav takes it. */
    margin-top: auto;
    border-top: 1px solid var(--hairline);
    background: var(--ground-0);
    padding: 10px 12px;
  }
  .status-card {
    background: var(--ground-3);
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    padding: 9px 11px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  /* Lit for the three states that are Encore holding a release: offered, coming down, waiting.
     Accent border and an accent wash running off it, which is the treatment the design gives
     this card, spent on the states where there is something to press. */
  .status-card.waiting {
    border-color: var(--accent);
    background: linear-gradient(100deg, var(--accent-dim), var(--ground-3));
  }
  .status-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status-glyph {
    width: 15px;
    height: 15px;
    flex-shrink: 0;
    color: var(--text-3);
  }
  .status-card.waiting .status-glyph {
    color: var(--accent-text);
  }
  .status-line {
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-snug);
    color: var(--text-1);
  }
  /* The second line is the sidecar, not the update. Quieter, and no glyph, so the card has one
     headline rather than two things shouting at the same weight. */
  .status-line.sub {
    font-weight: 400;
    color: var(--text-3);
    padding-left: 23px;
  }
  /* Stacked, deliberately. Side by side they need 207px and the card's text box is 174, so the
     pair wrapped anyway and paid a row gap for the privilege. Two links, two lines, aligned. */
  .status-links {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    margin-top: 3px;
  }
  .settings-link {
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    /* --accent-text, not --accent: 13px text on the card, where --accent measures
       4.29:1 (see tokens.css). Hover goes to text-1 like the app's other quiet controls. */
    color: var(--accent-text);
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .settings-link:hover {
    color: var(--text-1);
  }
  .version {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-flat);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    text-align: center;
    padding-top: 9px;
  }
</style>
