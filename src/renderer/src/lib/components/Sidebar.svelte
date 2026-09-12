<script lang="ts" module>
  export type ViewId = 'home' | 'browse' | 'library' | 'assets' | 'stats' | 'tools' | 'settings'
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { encore } from '../stores/bridge'
  import { APP_VERSION } from '../../../../shared/constants'

  let {
    view,
    downloadsOpen,
    onNavigate,
    onToggleDownloads,
    onShowShortcuts
  }: {
    view: ViewId
    downloadsOpen: boolean
    onNavigate: (id: ViewId) => void
    onToggleDownloads: () => void
    onShowShortcuts: () => void
  } = $props()

  interface NavItem {
    label: string
    d: string
    view?: ViewId
    action?: () => void
  }

  const SECTIONS: { header: string; items: NavItem[] }[] = [
    {
      header: 'MENU',
      items: [
        { view: 'home', label: 'Home', d: 'M4 11.5 12 4.5l8 7M6.5 9.75V19.5h11V9.75' },
        {
          view: 'browse',
          label: 'Explore',
          d: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm9 16-3.5-3.5'
        }
      ]
    },
    {
      header: 'LIBRARY',
      items: [
        { view: 'library', label: 'Installed', d: 'M4 5h16M4 12h16M4 19h10' },
        {
          label: 'Downloads',
          d: 'M12 4.5v9.5m0 0 4-4m-4 4-4-4M5.5 19.5h13',
          // Closure (not a direct reference) so the current prop value is called.
          action: () => onToggleDownloads()
        },
        {
          view: 'assets',
          // "Assets" read as a second copy of Installed; "Asset Studio" names the job.
          // The view id is unchanged; this is a label-only rename.
          label: 'Asset Studio',
          d: 'M12 3v10.5M9.5 12.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 6c2 0 3-1 5-1v4c-2 0-3 1-5 1'
        },
        {
          view: 'stats',
          // Last in this group rather than next to Installed, which reads better and costs
          // more: `Mod+1…7` follows this order, so a row inserted higher up would move every
          // digit below it. Here it takes the next free digit and only Issues and Settings
          // shift, which is the smallest change that still puts it where it belongs.
          label: 'Stats',
          d: 'M4 19.5h16M7 19V11m5 8V5.5m5 13.5v-6'
        }
      ]
    },
    {
      header: 'TOOLS',
      items: [
        {
          view: 'tools',
          label: 'Issues',
          d: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm7 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z'
        },
        {
          view: 'settings',
          label: 'Settings',
          d: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0-6v2m0 14v2m9-9h-2M5 12H3m13.7-6.7-1.4 1.4M7.7 16.3l-1.4 1.4m0-11.4 1.4 1.4m8.6 8.6 1.4 1.4'
        }
      ]
    }
  ]

  let ytdlpLine = $state('YT-DLP …')

  onMount(() => {
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
  {#each SECTIONS as section (section.header)}
    <!-- The visible header names the group, so it is pointed at rather than
         duplicated into an aria-label. Without this the three headers are
         decoration and the sidebar is one flat run of eight buttons. -->
    <div class="section" role="group" aria-labelledby="sidebar-{section.header}">
      <div class="section-header" id="sidebar-{section.header}">{section.header}</div>
      {#each section.items as item (item.label)}
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
          {item.label}
        </button>
      {/each}
    </div>
  {/each}
  <div class="bottom">
    <div class="status-card">
      <div class="status-line">ENCORE {APP_VERSION}</div>
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
    <div class="version">v{APP_VERSION}</div>
  </div>
</nav>

<style>
  .sidebar {
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid var(--hairline);
    display: flex;
    flex-direction: column;
    padding: 14px 12px 10px;
    overflow-y: auto;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: var(--fs-emphasis);
    /* Exception: 0.14em, wider than --ls-caps. Six letters set as a wordmark, not a
       label. The extra tracking is what makes it read as a mark rather than a heading. */
    letter-spacing: 0.14em;
    padding: 2px 10px 14px;
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
     ground. A fill was tried and rejected: --accent-dim composited over --bg is
     #1d1530, which measures 1.01:1 against --surface-2, i.e. the same slab to the
     eye, and the two lit rows the audit found would have been back. What carries the
     state instead is the glyph turning violet and a chevron at the row's far edge
     pointing at the panel it opened, both in --accent-text: 7.2:1 on --bg (tokens.css),
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
       4.38:1 (see tokens.css). Hover goes to text-1 like the app's other quiet controls. */
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
