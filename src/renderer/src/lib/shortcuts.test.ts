import { describe, expect, it } from 'vitest'
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  SHORTCUT_VIEWS,
  isTypingTarget,
  matchShortcut,
  renderKeys,
  type KeyChord
} from './shortcuts'

/** A chord with everything released and nothing focused, overridden per test. */
function chord(over: Partial<KeyChord>): KeyChord {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: { tagName: 'BODY' },
    ...over
  }
}

const inField = { tagName: 'INPUT' }

describe('isTypingTarget', () => {
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('claims a focused <%s>', (tagName) => {
    expect(isTypingTarget({ tagName })).toBe(true)
  })

  it('is case-insensitive about the tag name, because XHTML-ish DOMs report lowercase', () => {
    expect(isTypingTarget({ tagName: 'input' })).toBe(true)
  })

  it('claims a contenteditable element whatever it is', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it.each(['BODY', 'BUTTON', 'DIV', 'CHART-PREVIEW-PLAYER'])('leaves <%s> alone', (tagName) => {
    expect(isTypingTarget({ tagName })).toBe(false)
  })

  it('survives a target that is not an element at all', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
    // window is the target of a keydown that reaches the listener with nothing focused
    // in some engines, and it has no tagName.
    expect(isTypingTarget({})).toBe(false)
  })
})

describe('matchShortcut: not firing while the user types', () => {
  it('does not play/pause on Space typed into a field', () => {
    expect(matchShortcut(chord({ key: ' ', code: 'Space', target: inField }))).toBeNull()
  })

  it('does not open the sheet on ? typed into a field', () => {
    expect(matchShortcut(chord({ key: '?', shiftKey: true, target: inField }))).toBeNull()
  })

  it('still allows Mod+K from inside a field, since a modifier combo is not text', () => {
    expect(matchShortcut(chord({ key: 'k', code: 'KeyK', ctrlKey: true, target: inField }))).toBe(
      'focus-search'
    )
  })

  it('still allows Escape from inside a field, since no layout types an Escape', () => {
    expect(matchShortcut(chord({ key: 'Escape', target: inField }))).toBe('dismiss')
  })

  it('still allows a view switch from inside a field', () => {
    expect(matchShortcut(chord({ key: '2', code: 'Digit2', ctrlKey: true, target: inField }))).toBe(
      'go:browse'
    )
  })
})

describe('matchShortcut: keys the chart-preview element already owns', () => {
  // The embedded <chart-preview-player> binds Space, arrows, M, F and
  // Escape-while-fullscreen on its host, and those events bubble to window. The app
  // must decline every one of them so the two layers never both act.
  it.each([
    ['ArrowUp', 'ArrowUp'],
    ['ArrowDown', 'ArrowDown'],
    ['ArrowLeft', 'ArrowLeft'],
    ['ArrowRight', 'ArrowRight'],
    ['m', 'KeyM'],
    ['f', 'KeyF']
  ])('declines %s, which the preview binds', (key, code) => {
    expect(matchShortcut(chord({ key, code }))).toBeNull()
  })

  it('declines Space when the preview element itself has focus', () => {
    // The element sets tabindex="0", so a click puts focus on it and its own handler runs.
    expect(
      matchShortcut(chord({ key: ' ', code: 'Space', target: { tagName: 'CHART-PREVIEW-PLAYER' } }))
    ).toBeNull()
  })

  it('declines Space when a button has focus, so Space still activates the button', () => {
    expect(
      matchShortcut(chord({ key: ' ', code: 'Space', target: { tagName: 'BUTTON' } }))
    ).toBeNull()
  })

  it('takes Space only when nothing at all is focused', () => {
    expect(matchShortcut(chord({ key: ' ', code: 'Space' }))).toBe('toggle-play')
  })
})

describe('matchShortcut: the bindings', () => {
  it('focuses search on Ctrl+K and on Cmd+K', () => {
    expect(matchShortcut(chord({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBe('focus-search')
    expect(matchShortcut(chord({ key: 'K', code: 'KeyK', metaKey: true }))).toBe('focus-search')
  })

  it('leaves Ctrl+Shift+K and Ctrl+Alt+K alone', () => {
    expect(
      matchShortcut(chord({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true }))
    ).toBeNull()
    expect(matchShortcut(chord({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('maps Mod+1…6 onto the six views in sidebar order', () => {
    for (const [i, view] of SHORTCUT_VIEWS.entries()) {
      expect(
        matchShortcut(chord({ key: String(i + 1), code: `Digit${i + 1}`, ctrlKey: true }))
      ).toBe(`go:${view}`)
    }
  })

  it('reads the digit off `code`, so AZERTY reaches the views too', () => {
    // On AZERTY the unshifted top-row 1 key produces '&'. A key-based match would
    // leave every view switch unreachable for those users.
    expect(matchShortcut(chord({ key: '&', code: 'Digit1', ctrlKey: true }))).toBe('go:home')
  })

  it("has no seventh view, so Mod+7 is nobody's", () => {
    expect(matchShortcut(chord({ key: '7', code: 'Digit7', ctrlKey: true }))).toBeNull()
  })

  it('opens the sheet on ?', () => {
    expect(matchShortcut(chord({ key: '?', shiftKey: true }))).toBe('show-shortcuts')
  })

  it('dismisses on Escape', () => {
    expect(matchShortcut(chord({ key: 'Escape' }))).toBe('dismiss')
  })

  it('ignores an auto-repeating key, so holding Space does not stutter the player', () => {
    expect(matchShortcut(chord({ key: ' ', code: 'Space', repeat: true }))).toBeNull()
  })

  it('ignores a chord pressed mid-IME-composition', () => {
    expect(matchShortcut(chord({ key: ' ', code: 'Space', isComposing: true }))).toBeNull()
  })

  it('claims no bare letter, so typing into an unfocused view is never a command', () => {
    for (const key of 'abcdefghijklmnopqrstuvwxyz') {
      expect(matchShortcut(chord({ key, code: `Key${key.toUpperCase()}` }))).toBeNull()
    }
  })
})

describe('the sheet is generated from the bindings', () => {
  it('lists every shortcut matchShortcut can return', () => {
    const listed = new Set(SHORTCUTS.map((s) => s.id))
    const expected = new Set<string>([
      'focus-search',
      'toggle-play',
      'dismiss',
      'show-shortcuts',
      ...SHORTCUT_VIEWS.map((v) => `go:${v}`)
    ])
    expect(listed).toEqual(expected)
  })

  it('puts every entry in a group the sheet renders', () => {
    for (const spec of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(spec.group)
  })

  it('names the views the way the sidebar does, not by their view ids', () => {
    const what = SHORTCUTS.filter((s) => s.id.startsWith('go:')).map((s) => s.what)
    expect(what).toContain('Go to Issues')
    expect(what).toContain('Go to Explore')
    expect(what).not.toContain('Go to tools')
  })
})

describe('renderKeys', () => {
  it('spells Mod as Ctrl off macOS', () => {
    expect(renderKeys('Mod K', 'Linux x86_64')).toEqual(['Ctrl', 'K'])
    expect(renderKeys('Mod 3', 'Win32')).toEqual(['Ctrl', '3'])
  })

  it('spells Mod as ⌘ on macOS', () => {
    expect(renderKeys('Mod K', 'MacIntel')).toEqual(['⌘', 'K'])
  })

  it('leaves a chord with no Mod alone', () => {
    expect(renderKeys('Esc', 'Linux x86_64')).toEqual(['Esc'])
  })
})
