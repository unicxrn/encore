import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WelcomeTour from './WelcomeTour.svelte'
import tourSource from './WelcomeTour.svelte?raw'
import sidebarSource from './Sidebar.svelte?raw'
import { settings, settingsLoaded } from '../stores/settings'
import { defaultSettings } from '../../../../shared/settings-defaults'

/**
 * The first-run tour: five screens, one per thing Encore does, in a modal.
 *
 * jsdom applies no CSS, so nothing here says how the card looks or where the buttons sit; that is
 * desktop QA. What it pins is the walk: every screen reachable forward and back, Skip on all of
 * them, Enter as Next, the arrows as Back and Next, the count, the door each view screen opens
 * once there is a library to open it on, and the same focus discipline as the shortcut sheet.
 */

/** The heading of each screen, in order. The count is derived from this, not hardcoded twice. */
const TITLES = ['What Encore does', 'Installed', 'Explore', 'Issues', 'Asset Studio']

/** The view each screen from the second on describes, by the id App switches on. */
const DOORS: readonly [title: string, view: string][] = [
  ['Installed', 'library'],
  ['Explore', 'browse'],
  ['Issues', 'tools'],
  ['Asset Studio', 'assets']
]

type Props = { onclose?: () => void; onopen?: (view: string) => void }

function mount(props: Props = {}): ReturnType<typeof render> {
  return render(WelcomeTour, { onclose: vi.fn(), onopen: vi.fn(), ...props })
}

/** What the renderer knows once settings have loaded with a library folder in them. */
function withLibrary(): void {
  settings.set({ ...defaultSettings(), libraryFolders: [{ path: '/songs', isDefault: true }] })
  settingsLoaded.set(true)
}

afterEach(() => {
  settings.set(defaultSettings())
  settingsLoaded.set(false)
})

function dialog(): HTMLElement {
  return screen.getByRole('dialog')
}

async function next(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  }
}

describe('WelcomeTour contents', () => {
  it('is a modal dialog named by the screen it is showing', () => {
    mount()
    const d = screen.getByRole('dialog', { name: TITLES[0] })
    expect(d.getAttribute('aria-modal')).toBe('true')
  })

  it('counts the screens as words, not dots', async () => {
    mount()
    expect(dialog().textContent).toMatch(new RegExp(`1 of ${TITLES.length}`, 'i'))
    await next()
    expect(dialog().textContent).toMatch(new RegExp(`2 of ${TITLES.length}`, 'i'))
  })

  it('walks every screen forward with Next and back with Back', async () => {
    mount()
    for (let i = 0; i < TITLES.length; i += 1) {
      expect(screen.getByRole('heading', { name: TITLES[i] })).toBeTruthy()
      if (i < TITLES.length - 1) await next()
    }
    for (let i = TITLES.length - 1; i > 0; i -= 1) {
      await fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(screen.getByRole('heading', { name: TITLES[i - 1] })).toBeTruthy()
    }
  })

  it('has no Back on the first screen, so there is nothing to tab past', async () => {
    mount()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    await next()
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()
  })

  it('keeps Skip on every screen, and Skip closes', async () => {
    const onclose = vi.fn()
    mount({ onclose })
    for (let i = 0; i < TITLES.length; i += 1) {
      expect(screen.getByRole('button', { name: 'Skip tour' })).toBeTruthy()
      if (i < TITLES.length - 1) await next()
    }
    await fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('ends with Done, and says where the shortcuts are once, at the end', async () => {
    const onclose = vi.fn()
    mount({ onclose })
    expect(dialog().textContent).not.toMatch(/any time for shortcuts/i)

    await next(TITLES.length - 1)

    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    expect(dialog().textContent).toMatch(/press .*\? any time for shortcuts/i)
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('closes from a click on the backdrop, which is a pointer affordance only', async () => {
    const onclose = vi.fn()
    const { container } = mount({ onclose })
    const backdrop = container.querySelector('.backdrop')
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop?.getAttribute('tabindex')).toBe('-1')
    await fireEvent.click(backdrop!)
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('shows each view under the glyph the sidebar uses for it', () => {
    // The icon is the one thing on the screen the user will see again, on the sidebar item they
    // are about to click; a different drawing here would teach them the wrong shape. Read out of
    // Sidebar's own source so a redrawn sidebar icon fails here instead of drifting.
    mount()
    const views = TITLES.slice(1)
    for (const label of views) {
      const m = new RegExp(`label: '${label}'[\\s\\S]*?\\bd: '([^']+)'`).exec(sidebarSource)
      if (!m) throw new Error(`no sidebar icon for ${label}`)
      expect(tourSource, `${label} glyph`).toContain(`'${m[1]}'`)
    }
  })

  it('contains no em or en dash, anywhere in the file', () => {
    expect(tourSource).not.toMatch(/[–—]/)
  })
})

describe('WelcomeTour doors', () => {
  it('opens no view on a first run, when there is no library folder to show one on', async () => {
    // Loaded, and loaded with nothing: the state under the folder picker. A door here would open
    // an empty Installed over the picker the user has not answered yet.
    settingsLoaded.set(true)
    mount()
    for (let i = 0; i < TITLES.length; i += 1) {
      expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
      if (i < TITLES.length - 1) await next()
    }
  })

  it('stays a slideshow until settings have loaded, whatever the defaults say', () => {
    // The pre-load store value has no folders; the gate reads the loaded flag, not the list.
    settings.set({ ...defaultSettings(), libraryFolders: [{ path: '/songs', isDefault: true }] })
    mount()
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
  })

  it('opens the view each screen describes once a library folder is set', async () => {
    withLibrary()
    const onclose = vi.fn()
    const onopen = vi.fn()
    mount({ onclose, onopen })
    // The first screen is about the app, not a view; nothing to open from it.
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
    for (const [i, [title, view]] of DOORS.entries()) {
      await next()
      // Named as the sidebar names the view, so the door and the item it leads to read the same.
      await fireEvent.click(screen.getByRole('button', { name: `Open ${title}` }))
      // Closed AND seen: App hands in finishTour as onclose, which is what records it.
      expect(onclose).toHaveBeenCalledTimes(i + 1)
      expect(onopen).toHaveBeenCalledTimes(i + 1)
      expect(onopen).toHaveBeenLastCalledWith(view)
    }
  })

  it('keeps Skip beside the door, and the last screen its note', async () => {
    withLibrary()
    mount()
    await next(TITLES.length - 1)
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Asset Studio' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    expect(dialog().textContent).toMatch(/any time for shortcuts/i)
  })
})

describe('WelcomeTour keyboard', () => {
  it('takes focus on open and hands it back on close', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = mount()
    await waitFor(() => expect(document.activeElement).toBe(dialog()))

    unmount()

    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('advances on Enter while the card itself has focus', async () => {
    mount()
    const d = dialog()
    d.focus()
    const claimed = !(await fireEvent.keyDown(d, { key: 'Enter' }))
    expect(claimed).toBe(true)
    expect(screen.getByRole('heading', { name: TITLES[1] })).toBeTruthy()
  })

  it('leaves Enter on a button to that button', async () => {
    // A user who tabbed to Back and pressed Enter wants Back, not Next. The handler stands down
    // and the button's own activation does the work (jsdom fires no click for it, so the screen
    // staying put is the whole assertion).
    mount()
    await next()
    const back = screen.getByRole('button', { name: 'Back' })
    back.focus()
    const claimed = !(await fireEvent.keyDown(back, { key: 'Enter' }))
    expect(claimed).toBe(false)
    expect(screen.getByRole('heading', { name: TITLES[1] })).toBeTruthy()
  })

  it('finishes on Enter from the last screen', async () => {
    const onclose = vi.fn()
    mount({ onclose })
    await next(TITLES.length - 1)
    dialog().focus()
    await fireEvent.keyDown(dialog(), { key: 'Enter' })
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('moves forward on Right and back on Left, from the card or from a button', async () => {
    mount()
    const d = dialog()
    d.focus()
    expect(!(await fireEvent.keyDown(d, { key: 'ArrowRight' }))).toBe(true)
    expect(screen.getByRole('heading', { name: TITLES[1] })).toBeTruthy()
    // Unlike Enter, not gated on the card: an arrow on a focused button has no meaning of its
    // own for the handler to be stealing.
    const back = screen.getByRole('button', { name: 'Back' })
    back.focus()
    expect(!(await fireEvent.keyDown(back, { key: 'ArrowRight' }))).toBe(true)
    expect(screen.getByRole('heading', { name: TITLES[2] })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(dialog()))
    expect(!(await fireEvent.keyDown(dialog(), { key: 'ArrowLeft' }))).toBe(true)
    expect(screen.getByRole('heading', { name: TITLES[1] })).toBeTruthy()
  })

  it('does nothing past either end: Left on the first screen, Right on the last', async () => {
    const onclose = vi.fn()
    mount({ onclose })
    dialog().focus()
    expect(await fireEvent.keyDown(dialog(), { key: 'ArrowLeft' })).toBe(true)
    expect(screen.getByRole('heading', { name: TITLES[0] })).toBeTruthy()

    await next(TITLES.length - 1)
    // Right is Next, and there is no Next on the last screen; Done stays a choice, on Enter or
    // the button, rather than something a key held a moment too long walks into.
    expect(await fireEvent.keyDown(dialog(), { key: 'ArrowRight' })).toBe(true)
    expect(screen.getByRole('heading', { name: TITLES[TITLES.length - 1] })).toBeTruthy()
    expect(onclose).not.toHaveBeenCalled()
  })

  it('declines a held arrow key, as the app-wide shortcuts do', async () => {
    mount()
    dialog().focus()
    expect(await fireEvent.keyDown(dialog(), { key: 'ArrowRight', repeat: true })).toBe(true)
    expect(screen.getByRole('heading', { name: TITLES[0] })).toBeTruthy()
  })

  it('puts focus back on the card after each step, so Enter keeps working', async () => {
    // Also what makes a screen reader read the new heading: the card is labelled by it.
    mount()
    await next()
    await waitFor(() => expect(document.activeElement).toBe(dialog()))
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(document.activeElement).toBe(dialog()))
  })

  it('wraps Tab rather than letting it out of an aria-modal dialog', async () => {
    mount()
    const controls = [...dialog().querySelectorAll('button')]
    const last = controls[controls.length - 1]
    last.focus()
    const claimed = !(await fireEvent.keyDown(last, { key: 'Tab' }))
    expect(claimed).toBe(true)
    expect(document.activeElement).toBe(controls[0])
  })

  it('wraps Shift+Tab off the card itself, which is what has focus on open', async () => {
    mount()
    const controls = [...dialog().querySelectorAll('button')]
    dialog().focus()
    const claimed = !(await fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey: true }))
    expect(claimed).toBe(true)
    expect(document.activeElement).toBe(controls[controls.length - 1])
  })

  it('leaves Escape to App, which owns the dismiss order', async () => {
    const onclose = vi.fn()
    mount({ onclose })
    expect(await fireEvent.keyDown(dialog(), { key: 'Escape' })).toBe(true)
    expect(onclose).not.toHaveBeenCalled()
  })
})
