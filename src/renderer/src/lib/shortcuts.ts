/**
 * The app's keyboard shortcuts, as data plus one pure matcher.
 *
 * Two properties this file exists to hold:
 *
 * 1. **The sheet cannot drift from the bindings.** `SHORTCUTS` is both what
 *    `matchShortcut` implements and what `ShortcutSheet` prints, so a binding
 *    that changes and a help screen that does not is not a state this app can
 *    reach.
 * 2. **The matcher is pure.** It reads nothing but the event it is handed (no
 *    `document`, no `navigator`, no `instanceof` against a DOM global), so the
 *    whole decision table is testable under the node project, where none of
 *    those exist. What to *do* with a match is App's business, not this file's.
 *
 * ## Why these keys
 *
 * The app embeds `<chart-preview-player>`, which binds its own keydown handler
 * on its host element (`tabindex="0"`, so it takes focus on click) and claims
 * Space, ←, →, ↑, ↓, M, F, and Escape-while-fullscreen. Those events bubble to
 * `window`, so every one of them reaches the app's global listener too. Nothing
 * below claims a key from that list except Space, and Space is deliberately
 * gated on nothing being focused. When the preview has focus the event's target
 * is the player element, not `<body>`, so the player wins and the app stands
 * down. There is no key both layers act on.
 *
 * - `Mod+K`: focus search. Already the app's binding, and already advertised on
 *   the search field itself. Kept, not moved.
 * - `Mod+1…7`: the seven sidebar views in sidebar order. Digits are read off
 *   `code`, not `key`: on AZERTY the unshifted digit row produces `&`, `é`, `"`,
 *   so a `key`-based match would leave these unreachable for those users.
 *   Letters stay on `key`, where the mnemonic matters more than the position.
 * - `Space`: play/pause. The key everyone tries first, and the one the preview
 *   element already uses, so binding anything else would have taught two
 *   answers to one question. Safe to claim because it only fires when
 *   `document.activeElement` is `<body>`: a focused `<button>` still gets its
 *   own Space activation, a focused preview still gets the element's handler,
 *   and `<body>` is not a scroll container here (`overflow: hidden`, the view
 *   pane scrolls instead) so nothing is being taken away.
 * - `Escape`: cancel/close the topmost thing. Exempt from the typing guard,
 *   because no keyboard layout produces text from Escape, and "get me out of
 *   here" is the one thing that must work from inside a text field.
 * - `?`: the shortcut sheet, by convention.
 *
 * Nothing here uses Alt: `autoHideMenuBar` leaves Electron's default menu bound
 * to Alt on Linux, and a shortcut that also drops a menu over the window is not
 * a shortcut.
 */

/** The seven sidebar views, in sidebar order, which is the order `Mod+1…7` follows. */
export type ShortcutView = 'home' | 'browse' | 'library' | 'assets' | 'stats' | 'tools' | 'settings'

export type ShortcutId =
  'focus-search' | 'toggle-play' | 'dismiss' | 'show-shortcuts' | `go:${ShortcutView}`

/**
 * The subset of `KeyboardEvent` the matcher reads.
 *
 * Structural on purpose: a `KeyboardEvent` satisfies it, and so does an object
 * literal in a test, which is what lets the decision table be covered without a
 * DOM. `target` is deliberately `unknown`, because `isTypingTarget` duck-types
 * it rather than reaching for `HTMLElement`, which does not exist in node.
 */
export interface KeyChord {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  repeat?: boolean
  isComposing?: boolean
  target?: unknown
}

export interface ShortcutSpec {
  id: ShortcutId
  /**
   * The chord as the sheet prints it. `Mod` is a placeholder the sheet swaps for
   * `Ctrl` or `⌘`; see `renderKeys`.
   */
  keys: string
  /** What it does, in the sheet's own words. */
  what: string
  group: 'Navigation' | 'Playback' | 'General'
}

/** Sidebar order. Index + 1 is the digit that reaches each view. */
export const SHORTCUT_VIEWS: readonly ShortcutView[] = [
  'home',
  'browse',
  'library',
  'assets',
  'stats',
  'tools',
  'settings'
]

/**
 * Sidebar labels, repeated here because the sheet has to name the destination
 * the way the sidebar does. "Issues", not "tools", because the view ids appear
 * nowhere in the interface.
 */
const VIEW_LABELS: Record<ShortcutView, string> = {
  home: 'Home',
  browse: 'Explore',
  library: 'Installed',
  assets: 'Asset Studio',
  stats: 'Stats',
  tools: 'Issues',
  settings: 'Settings'
}

export const SHORTCUTS: readonly ShortcutSpec[] = [
  { id: 'focus-search', keys: 'Mod K', what: 'Search charts', group: 'General' },
  { id: 'show-shortcuts', keys: '?', what: 'Show this list', group: 'General' },
  {
    id: 'dismiss',
    keys: 'Esc',
    what: 'Close the panel, dialog or chart you are in',
    group: 'General'
  },
  { id: 'toggle-play', keys: 'Space', what: 'Play or pause the preview', group: 'Playback' },
  ...SHORTCUT_VIEWS.map((view, i): ShortcutSpec => ({
    id: `go:${view}`,
    keys: `Mod ${i + 1}`,
    what: `Go to ${VIEW_LABELS[view]}`,
    group: 'Navigation'
  }))
]

/** The order the sheet lists groups in: what you do most, first. */
export const SHORTCUT_GROUPS: readonly ShortcutSpec['group'][] = [
  'General',
  'Navigation',
  'Playback'
]

/** Uppercase tag name of an event target, or `''` for anything that has none. */
function tagOf(target: unknown): string {
  const tag = (target as { tagName?: unknown } | null)?.tagName
  return typeof tag === 'string' ? tag.toUpperCase() : ''
}

/**
 * Is this event target something the user is typing into?
 *
 * The single most common way a shortcut layer goes wrong, so it is its own
 * exported function with its own tests. Every `<input>` counts, including the
 * ones that hold no text (checkbox, radio, range): the failure mode of being
 * too strict is a shortcut that does not fire, and the failure mode of being too
 * loose is a keystroke that goes somewhere the user was not looking.
 *
 * `isContentEditable` is checked for completeness; the app has no
 * contenteditable today. jsdom does not implement the property, so that branch
 * is browser-only and deliberately untested.
 */
export function isTypingTarget(target: unknown): boolean {
  const el = target as { isContentEditable?: unknown } | null
  if (el?.isContentEditable === true) return true
  const tag = tagOf(target)
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * The whole decision table.
 *
 * Returns the shortcut this chord means, or null for "not ours, leave it
 * alone". Never mutates the event: preventing the default is the caller's
 * choice, because only the caller knows whether it is going to act.
 */
export function matchShortcut(e: KeyChord): ShortcutId | null {
  // Auto-repeat would fire a held key dozens of times a second; none of these
  // actions is one you want repeated. `isComposing` is the IME guard: a chord
  // pressed mid-composition belongs to the input method.
  if (e.repeat === true || e.isComposing === true) return null

  // Before the typing guard, deliberately: Escape produces no text on any
  // layout, and closing what you are in has to work from inside a text field.
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) return 'dismiss'

  const mod = e.ctrlKey || e.metaKey
  if (mod) {
    // Also before the typing guard: Ctrl and Cmd combos are not text either, so
    // Mod+K from inside one field can move you to the search field.
    if (e.altKey || e.shiftKey) return null
    if (e.key.toLowerCase() === 'k') return 'focus-search'
    const digit = Number(/^Digit([1-9])$/.exec(e.code)?.[1])
    if (digit >= 1 && digit <= SHORTCUT_VIEWS.length) return `go:${SHORTCUT_VIEWS[digit - 1]}`
    return null
  }

  if (e.altKey) return null
  if (isTypingTarget(e.target)) return null

  if (e.key === '?') return 'show-shortcuts'
  // Only when nothing at all is focused; see the module comment for why that is
  // what makes Space safe to claim alongside the preview element and buttons.
  if (e.key === ' ' && tagOf(e.target) === 'BODY') return 'toggle-play'
  return null
}

/**
 * `keys` with the `Mod` placeholder resolved, split into one label per key cap.
 *
 * The platform is passed in rather than sniffed so this stays pure; callers hand
 * it `navigator.platform`. `Mod` is Cmd on macOS and Ctrl everywhere else, which
 * is what `matchShortcut` implements by accepting either modifier.
 */
export function renderKeys(keys: string, platform: string): string[] {
  const isMac = /mac/i.test(platform)
  return keys.split(' ').map((cap) => (cap === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : cap))
}
