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
  <!-- The mark from build/logo/encore-small.svg: the strike bar and the five frets, without
       the rounded square the icon files paint behind them (the sidebar IS that colour). This
       is the only place the real mark appears in the app; everywhere else the brand is the
       word. Decorative: the word beside it is the name. -->
  <div class="brand">
    <svg class="mark" viewBox="17 80 116 24" aria-hidden="true">
      <rect x="17" y="97" width="116" height="5" rx="2.5" fill="#4b4270" />
      <rect x="19" y="82" width="20" height="15" rx="7" fill="#35c759" />
      <rect x="42" y="82" width="20" height="15" rx="7" fill="#ff453a" />
      <rect x="65" y="82" width="20" height="15" rx="7" fill="#ffd60a" />
      <rect x="88" y="82" width="20" height="15" rx="7" fill="#0a84ff" />
      <rect x="111" y="82" width="20" height="15" rx="7" fill="#ff9f0a" />
    </svg>
    <span>ENC<span class="o">O</span>RE</span>
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
        <span class="game-label">{entry.label}</span>
        <span class="game-note mono">{entry.note}</span>
      </button>
    {/each}
  </div>

  <div class="quick">
    <!-- Import playlist is disabled rather than absent: the frame is what this step is for, and a
         control that is coming reads better as a control that is not ready than as a gap that
         will change shape later. `title` carries the reason; `disabled` keeps it out of the tab
         order and out of every click. Surprise me was the other one and is a control now. -->
    <button class="quick-btn" disabled title="Playlist import is not built yet">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        aria-hidden="true"
      >
        <path d="M4 6h11M4 11h11M4 16h7M17.5 10v9m0 0 3-3m-3 3-3-3" />
      </svg>
      Import playlist
    </button>
    <!-- Goes to Explore and fills it, which is why the title says where: a quick action that
         changes the view has to say so before it is pressed, or the list the user was looking at
         appears to have been replaced by five charts for no reason. -->
    <button
      class="quick-btn"
      title="Five charts you do not have, drawn at random. Opens Explore."
      onclick={onSurprise}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        aria-hidden="true"
      >
        <path d="M5 5h4l10 14h-4M5 19h4l2-3m5-8 3-3m0 0-3-3m3 3h-4l-1 1.5M19 19l-3-3m3 3-3 3" />
      </svg>
      Surprise me
    </button>
  </div>

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
        {entry.label}
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
  <div class="bottom">
    <div class="status-card">
      <!-- The update state, read from the same store Settings reads, so the footer cannot say
           something the Updates row disagrees with. Polite: it rewrites itself when the startup
           check answers, which is seconds after mount and nowhere near the user's attention. -->
      <div class="status-line" role="status">{updateLine}</div>
      <!-- The line rewrites itself when the sidecar probe answers, seconds after
           mount. Polite so it waits for a gap rather than cutting in. -->
      <div class="status-line" role="status">{ytdlpLine}</div>
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
    <div class="version">ENCORE v{APP_VERSION}</div>
  </div>
</nav>

<style>
  /* No width here any more: the app shell's grid owns column 1, and a component that also
     declared one would be a second answer to the same question. */
  .sidebar {
    border-right: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
    padding: 0 12px 10px;
    overflow-y: auto;
  }
  /* The sidebar now runs to the window's top edge, so this block is beside the title bar
     rather than under it, and has to drag the window like the title bar does. It holds no
     control, so nothing inside needs `no-drag`. Its height matches row 1 of the shell, which
     is what keeps the wordmark's baseline level with the search field's. */
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 50px;
    flex-shrink: 0;
    font-weight: 700;
    font-size: var(--fs-emphasis);
    /* Exception: 0.14em, wider than --ls-caps. Six letters set as a wordmark, not a
       label. The extra tracking is what makes it read as a mark rather than a heading. */
    letter-spacing: 0.14em;
    padding: 0 10px;
    -webkit-app-region: drag;
  }
  /* ── game switcher ──────────────────────────────────────────────────────── */
  .games {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin: 10px 0 12px;
  }
  .game {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    background: var(--ground-2);
    color: var(--text-2);
    font-family: var(--font-ui);
    text-align: left;
    padding: 7px 9px;
    cursor: pointer;
  }
  .game.on {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--text-1);
  }
  /* The unselected tile is the one that is not available, so it is drawn as unavailable
     rather than merely unselected: no pointer, and the note under it says "Not yet". */
  .game:disabled {
    cursor: default;
    opacity: 0.65;
  }
  .game-label {
    font-size: var(--fs-secondary);
    font-weight: 600;
    line-height: var(--lh-tight);
  }
  .game-note {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  /* ── quick actions ──────────────────────────────────────────────────────── */
  .quick {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  .quick-btn {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    text-align: left;
    padding: 6px 9px;
    cursor: pointer;
  }
  .quick-btn:disabled {
    cursor: default;
    color: var(--text-3);
  }
  .quick-btn svg {
    width: 15px;
    height: 15px;
    flex-shrink: 0;
  }
  /* ── source switcher ────────────────────────────────────────────────────── */
  .source {
    display: flex;
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  /* Sized by their labels, not by equal thirds. Measured: three equal segments across the 214px
     the sidebar's padding leaves give each 71px, and "Chorus Encore" and "RhythmVerse" are both
     wider than that, so both source names arrived on screen ellipsised. A source the user cannot
     read is worse than an uneven control. `flex: 0 1 auto` lets each take what it needs and lets
     the longest give way first if a font ever makes them too wide together. */
  .seg {
    flex: 0 1 auto;
    min-width: 0;
    border: 0;
    border-left: 1px solid var(--border-1);
    background: transparent;
    color: var(--text-3);
    font-family: var(--font-ui);
    font-size: var(--fs-caption);
    padding: 5px 7px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .seg:first-child {
    border-left: 0;
  }
  .seg.on {
    background: var(--ground-4);
    color: var(--text-1);
  }
  .seg:disabled {
    cursor: default;
  }
  .source-note {
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
    padding: 6px 2px 14px;
  }
  /* The viewBox is cropped to the frets and the bar (116×24 units), so at 32px wide the mark
     is 7px tall and a fret is about 5px by 4px: measured at 24×5 the bar under the frets all
     but vanished, and at 32×7 it is a line again while the whole mark still sits inside the
     word's cap height. */
  .mark {
    width: 32px;
    height: 7px;
    flex-shrink: 0;
  }
  .brand .o {
    color: var(--accent);
  }
  .section {
    margin-bottom: 14px;
  }
  .section-header {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
    padding: 0 10px 6px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-body);
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
  }
  .item.active {
    background: var(--surface-2);
    color: var(--text-1);
  }
  .item.active::before {
    content: '';
    position: absolute;
    left: -12px;
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

     Measured rather than assumed (scripts/measure-sidebar.mjs): the row track is 213px and the
     padding, glyph and gap take 46 of them, so a label and a figure share 167px. At the largest
     figures anyone could reach (99,999 charts, 9,999 queued) every one of the nine labels is
     drawn whole, and the longest, "Asset Studio", still has 87.9px of the 167 spare because it
     carries no figure at all. The ellipsis this rule declares has nothing to do yet. */
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
  .bottom {
    margin-top: auto;
    padding-top: 14px;
  }
  .status-card {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .status-line {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-snug);
    color: var(--text-2);
  }
  .settings-link {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 0;
    margin-top: 2px;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    /* --accent-text, not --accent: 13px text on the surface-1 card, where --accent measures
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
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    padding: 10px 10px 2px;
  }
</style>
