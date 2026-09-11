import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { readable } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings-defaults'
import { APP_VERSION } from '../../shared/constants'
import { ChartRecordSchema, type Settings } from '../../shared/schemas'
import App from './App.svelte'
import { settings, settingsLoaded } from './lib/stores/settings'
import { runtimeError } from './lib/stores/runtime-errors'
import { finishTour } from './lib/stores/tour'

/**
 * The Tools view, replaced by something that throws while Svelte renders it.
 *
 * A Svelte 5 component is a function the compiler calls to build its DOM, so a function that
 * throws instead is a component that fails to render, which is exactly the situation
 * `<svelte:boundary>` exists for, reached without shipping a deliberately broken component in
 * `src/`. `remaining` lets a test make the failure transient, which is the only honest way to
 * check that Try again really re-renders rather than merely clearing the message.
 */
const boom = vi.hoisted(() => ({ remaining: Infinity }))

vi.mock('./lib/components/Tools.svelte', () => ({
  default: (): void => {
    if (boom.remaining <= 0) return
    boom.remaining -= 1
    throw new Error('Tools exploded')
  }
}))

// Home's latest-charts row fetches from the Enchor API on mount. Stubbed at the store, as
// Home's own tests do, so the downloads-panel tests below can render Home without a network.
vi.mock('./lib/stores/latest-charts', () => ({
  latestCharts: readable({ charts: [], loading: false, error: null, total: null }),
  loadLatestCharts: (): Promise<void> => Promise.resolve()
}))

/**
 * The settings a returning user has: no folder yet, but the tour already seen and the running
 * version already recorded.
 *
 * `lastSeenVersion` for the same reason as `tourSeen`: leaving it empty on a user who HAS seen the
 * tour is the one combination that means "upgraded from a build before the field existed", and
 * App opens the what's new panel on it. That is correct behaviour and it is tested where it
 * belongs (stores/whats-new.test.ts); here it would be a modal holding every shortcut below.
 */
const seenSettings = (): Settings => ({
  ...defaultSettings(),
  tourSeen: true,
  lastSeenVersion: APP_VERSION
})

function stubEncore(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    // `tourSeen: true`, not the bare defaults: the bare defaults are a first run, and a first run
    // opens the welcome tour, which is modal and would hold every shortcut the tests below press.
    // The tour's own tests hand in the bare defaults deliberately.
    settingsGet: vi.fn().mockResolvedValue(seenSettings()),
    settingsSet: vi.fn().mockResolvedValue(undefined),
    // Welcome, underneath the tour on a first run, probes for a library on mount.
    libraryDetect: vi.fn().mockResolvedValue([]),
    pickFolder: vi.fn().mockResolvedValue(null),
    downloadList: vi.fn().mockResolvedValue([]),
    onDownloadUpdate: vi.fn(() => () => {}),
    onScanProgress: vi.fn(() => () => {}),
    onAssetProgress: vi.fn(() => () => {}),
    // Subscribed for the life of the app, so that the startup check's result and any download
    // percent are not missed while Settings is closed.
    onAppUpdate: vi.fn(() => () => {}),
    appUpdateStatus: vi.fn().mockResolvedValue({
      currentVersion: '0.1.0',
      target: 'unpackaged',
      canApply: false,
      note: 'This copy runs from source rather than from an installed build, so there is nothing for Encore to replace.',
      state: { kind: 'idle' }
    }),
    catalogQuery: vi.fn().mockResolvedValue([]),
    catalogCount: vi.fn().mockResolvedValue(0),
    sidecarStatus: vi.fn().mockResolvedValue({ installed: false, version: null }),
    windowControl: vi.fn().mockResolvedValue(undefined),
    backupsList: vi.fn().mockResolvedValue({ backups: [], totalBytes: 0 }),
    ...over
  }
  vi.stubGlobal('encore', api)
  return api
}

/**
 * Click a sidebar entry by its exact accessible name.
 *
 * Exact, not a regex: the fallback's own "Go to Home" would otherwise match a search for the
 * sidebar's "Home" and the test would be asserting against the wrong button.
 */
async function navigate(name: string): Promise<void> {
  await fireEvent.click(screen.getByRole('button', { name }))
}

beforeEach(() => {
  boom.remaining = Infinity
  stubEncore()
  // `settingsLoaded` false leaves Home deliberately empty, which is the quietest starting
  // point: nothing else in the pane can throw while a boundary test is running.
  settings.set(defaultSettings())
  settingsLoaded.set(false)
  runtimeError.set(null)
})

afterEach(() => {
  // Before the unstub: the tour's request flag is module state, and a test that opened the tour
  // and stopped there would leave it open over the next test. Finishing writes through the still
  // stubbed bridge when the tour had not been seen.
  finishTour()
  vi.unstubAllGlobals()
  runtimeError.set(null)
})

describe('App error boundaries', () => {
  it('shows a fallback instead of a blank window when a view throws', async () => {
    render(App)
    await navigate('Issues')

    // The alert is the message itself: that is what a screen reader hears, not the stack beneath.
    expect((await screen.findByRole('alert')).textContent?.trim()).toBe('Tools exploded')
  })

  it('keeps the sidebar alive, so a broken view is not a trap', async () => {
    render(App)
    await navigate('Issues')
    await screen.findByRole('alert')

    // The whole reason the boundary is around the pane and not the window.
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
  })

  it('clears the fallback when the user navigates away', async () => {
    // A boundary that has failed keeps rendering its fallback until it is reset; without the
    // {#key} in App this navigation would leave the Tools crash on screen.
    render(App)
    await navigate('Issues')
    await screen.findByRole('alert')

    await navigate('Settings')

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('Go to Home leaves the broken view without touching the sidebar', async () => {
    render(App)
    await navigate('Issues')
    await screen.findByRole('alert')

    await fireEvent.click(screen.getByRole('button', { name: 'Go to Home' }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('Try again re-renders the view, and it comes back when the error was transient', async () => {
    boom.remaining = 1
    render(App)
    await navigate('Issues')
    await screen.findByRole('alert')

    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('fails again on Try again when the error is deterministic, which is why Go to Home exists', async () => {
    render(App)
    await navigate('Issues')
    await screen.findByRole('alert')

    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect((await screen.findByRole('alert')).textContent?.trim()).toBe('Tools exploded')
  })

  it('names the broken view in the report, not just the stack', async () => {
    render(App)
    await navigate('Issues')
    await screen.findByRole('alert')

    // "Issues view", the sidebar's own word for it. The view id "tools" appears nowhere on
    // screen and would not help whoever reads the report.
    expect(screen.getByText(/Encore \d.*Issues view/)).toBeTruthy()
  })
})

describe('App background-error strip', () => {
  it('stays out of the way while nothing has gone wrong', () => {
    render(App)
    expect(screen.queryByText('BACKGROUND ERROR')).toBeNull()
  })

  it('surfaces an unhandled rejection, which no boundary can catch', async () => {
    render(App)

    runtimeError.set({
      context: 'unhandled promise rejection',
      value: new Error('catalog:query rejected')
    })

    expect(await screen.findByText('catalog:query rejected')).toBeTruthy()
  })

  it('can be dismissed', async () => {
    render(App)
    runtimeError.set({ context: 'unhandled error', value: new Error('transient') })
    await screen.findByText('transient')

    await fireEvent.click(screen.getByRole('button', { name: /dismiss background error/i }))

    await waitFor(() => expect(screen.queryByText('transient')).toBeNull())
  })
})

/**
 * Fire a key at the window listener the way the browser would, from a given target.
 *
 * The target matters more than usual here: the typing guard and the play/pause
 * guard both read it, so a helper that always fired at `window` would make every
 * one of those tests pass for the wrong reason.
 */
function press(target: Element | Window, init: Partial<KeyboardEventInit> & { key: string }): void {
  fireEvent.keyDown(target, { code: '', ...init })
}

/** The sidebar entry for a view, so its `aria-current` can be read back. */
function navItem(name: string): HTMLElement {
  return screen.getByRole('button', { name })
}

describe('App keyboard shortcuts', () => {
  beforeEach(() => {
    // These tests navigate into Issues, which the mock at the top of this file
    // otherwise blows up on purpose.
    boom.remaining = 0
  })

  it('marks the current view, which is how these assertions read the destination', () => {
    render(App)
    expect(navItem('Home').getAttribute('aria-current')).toBe('page')
    expect(navItem('Explore').getAttribute('aria-current')).toBeNull()
  })

  it.each([
    ['Digit1', 'Home'],
    ['Digit2', 'Explore'],
    ['Digit3', 'Installed'],
    ['Digit4', 'Asset Studio'],
    ['Digit5', 'Issues'],
    ['Digit6', 'Settings']
  ])('Ctrl+%s goes to %s', async (code, label) => {
    render(App)
    press(document.body, { key: 'x', code, ctrlKey: true })
    await waitFor(() => expect(navItem(label).getAttribute('aria-current')).toBe('page'))
  })

  it('focuses the search field on Ctrl+K', async () => {
    render(App)
    const search = screen.getByRole('textbox', { name: 'Search charts' })
    expect(document.activeElement).not.toBe(search)

    press(document.body, { key: 'k', code: 'KeyK', ctrlKey: true })

    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('opens the shortcut sheet on ?', async () => {
    render(App)
    press(document.body, { key: '?', shiftKey: true })
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy()
  })

  it('closes the shortcut sheet on Escape', async () => {
    render(App)
    press(document.body, { key: '?', shiftKey: true })
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })

    press(document.body, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('opens the same sheet from the sidebar, because ? is not discoverable', async () => {
    render(App)
    await fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy()
  })

  it('closes the downloads panel on Escape', async () => {
    render(App)
    await fireEvent.click(navItem('Downloads'))
    expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('true')

    press(document.body, { key: 'Escape' })

    await waitFor(() => expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('false'))
  })

  it('leaves a bare key alone while the user is typing, which is the whole point of the guard', async () => {
    render(App)
    const search = screen.getByRole('textbox', { name: 'Search charts' })

    press(search, { key: '?', shiftKey: true })

    // Nothing to wait for, so a settle is forced before asserting the absence.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('still takes Ctrl+K from inside a field, which is the point of exempting combos', async () => {
    render(App)
    const search = screen.getByRole('textbox', { name: 'Search charts' })
    await fireEvent.click(navItem('Explore'))

    press(search, { key: 'k', code: 'KeyK', ctrlKey: true })

    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('stands down entirely while a modal dialog owns the keyboard', async () => {
    // The Issues repair confirmation is one of these and handles its own Escape.
    // Faked rather than driven through Tools, because what is under test is App's
    // guard, not that view.
    render(App)
    await fireEvent.click(navItem('Downloads'))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    try {
      press(document.body, { key: 'x', code: 'Digit2', ctrlKey: true })
      press(document.body, { key: 'Escape' })

      await waitFor(() => expect(navItem('Home').getAttribute('aria-current')).toBe('page'))
      expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('true')
    } finally {
      dialog.remove()
    }
  })
})

/**
 * The welcome tour, as App wires it: when it opens on its own, what closing writes, and how it
 * sits in the dismiss order with the shortcut sheet.
 */
describe('App welcome tour', () => {
  const TOUR = 'What Encore does'
  const SHEET = 'Keyboard shortcuts'

  beforeEach(() => {
    boom.remaining = 0
  })

  it('opens on first run, over the folder picker rather than instead of it', async () => {
    stubEncore({ settingsGet: vi.fn().mockResolvedValue(defaultSettings()) })
    render(App)

    expect(await screen.findByRole('dialog', { name: TOUR })).toBeTruthy()
    // Welcome is underneath and already probing, so the picker is ready the moment the tour goes.
    expect(await screen.findByRole('button', { name: /choose a folder/i })).toBeTruthy()
  })

  it('skipping lands on the folder picker and is remembered as seen', async () => {
    const api = stubEncore({ settingsGet: vi.fn().mockResolvedValue(defaultSettings()) })
    render(App)
    await screen.findByRole('dialog', { name: TOUR })

    await fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({ tourSeen: true }))
    expect(screen.getByRole('button', { name: /choose a folder/i })).toBeTruthy()
  })

  it('does not come back on a later launch once seen', async () => {
    render(App)
    await screen.findByRole('button', { name: /choose a folder/i })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape through App, and that counts as seen too', async () => {
    const api = stubEncore({ settingsGet: vi.fn().mockResolvedValue(defaultSettings()) })
    render(App)
    await screen.findByRole('dialog', { name: TOUR })

    press(document.body, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({ tourSeen: true }))
  })

  it('reopens from Settings with a folder set, without the picker and without a second write', async () => {
    const api = stubEncore({
      settingsGet: vi.fn().mockResolvedValue({
        ...seenSettings(),
        libraryFolders: [{ path: '/songs', isDefault: true }]
      })
    })
    render(App)
    await navigate('Settings')

    await fireEvent.click(
      await screen.findByRole('button', { name: 'Show the welcome tour again' })
    )
    expect(await screen.findByRole('dialog', { name: TOUR })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Still on Settings; the folder picker never appeared, because a folder is configured.
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /choose a folder|use this folder/i })).toBeNull()
    expect(api.settingsSet).not.toHaveBeenCalled()
  })

  it('reopens from the shortcut sheet, which closes to make room', async () => {
    stubEncore()
    render(App)
    press(document.body, { key: '?', shiftKey: true })
    await screen.findByRole('dialog', { name: SHEET })

    await fireEvent.click(screen.getByRole('button', { name: 'Show the welcome tour' }))

    expect(await screen.findByRole('dialog', { name: TOUR })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: SHEET })).toBeNull()
  })

  it('lets ? open the sheet over it, and Escape closes the sheet first', async () => {
    // The last screen says ? works any time. It has to be true while that sentence is on screen.
    stubEncore({ settingsGet: vi.fn().mockResolvedValue(defaultSettings()) })
    render(App)
    await screen.findByRole('dialog', { name: TOUR })

    press(document.body, { key: '?', shiftKey: true })
    expect(await screen.findByRole('dialog', { name: SHEET })).toBeTruthy()

    press(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: SHEET })).toBeNull())
    expect(screen.getByRole('dialog', { name: TOUR })).toBeTruthy()

    press(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('holds the view shortcuts while it is open, like any other modal', async () => {
    stubEncore({ settingsGet: vi.fn().mockResolvedValue(defaultSettings()) })
    render(App)
    await screen.findByRole('dialog', { name: TOUR })

    press(document.body, { key: 'x', code: 'Digit2', ctrlKey: true })

    await waitFor(() => expect(navItem('Home').getAttribute('aria-current')).toBe('page'))
    expect(navItem('Explore').getAttribute('aria-current')).toBeNull()
  })
})

/**
 * The downloads panel as App wires it: which sidebar row it lights and how, that the bar's
 * toggle and the sidebar's row agree, and that going anywhere else closes it.
 *
 * jsdom applies no CSS, so what the open row LOOKS like (no accent bar, a violet glyph and a
 * chevron) rests on screenshots of the running app. What is pinned here is the class and the
 * state attribute each control carries, which is what the stylesheet keys the visual on.
 */
describe('App downloads panel', () => {
  // The panel's own empty-state sentence: the one string that is on screen only while the panel
  // is, since "DOWNLOADS" is also the bar's toggle and "Close" is also the window control.
  const PANEL = /No downloads yet/
  const barToggle = (): HTMLElement => screen.getByRole('button', { name: 'DOWNLOADS' })
  const panelOpen = (): boolean => screen.queryByText(PANEL) !== null

  /** Settings that render Home rather than Welcome: a folder configured, the tour seen. */
  const homeSettings = (): Settings => ({
    ...seenSettings(),
    libraryFolders: [{ path: '/songs', isDefault: true }]
  })
  const record = ChartRecordSchema.parse({
    path: '/songs/Rush - YYZ',
    name: 'YYZ',
    artist: 'Rush',
    chartType: 'folder',
    folderHash: 'yyz',
    modifiedTime: 0
  })

  beforeEach(() => {
    boom.remaining = 0
  })

  it('lights the panel row as expanded and leaves the page row the only aria-current', async () => {
    render(App)
    await navigate('Issues')
    await fireEvent.click(navItem('Downloads'))
    expect(await screen.findByText(PANEL)).toBeTruthy()

    // The page row: unchanged by the panel.
    expect(navItem('Issues').getAttribute('aria-current')).toBe('page')
    expect(navItem('Issues').classList.contains('active')).toBe(true)
    // The panel row: expanded, and never wearing the page's marker.
    const downloads = navItem('Downloads')
    expect(downloads.getAttribute('aria-expanded')).toBe('true')
    expect(downloads.getAttribute('aria-current')).toBeNull()
    expect(downloads.classList.contains('open')).toBe(true)
    expect(downloads.classList.contains('active')).toBe(false)
  })

  it('keeps the bar toggle and the sidebar row on one state, whichever one was pressed', async () => {
    render(App)
    expect(barToggle().getAttribute('aria-expanded')).toBe('false')
    expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('false')

    await fireEvent.click(navItem('Downloads'))
    await waitFor(() => expect(barToggle().getAttribute('aria-expanded')).toBe('true'))
    expect(barToggle().classList.contains('open')).toBe(true)
    expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('true')
    expect(panelOpen()).toBe(true)

    await fireEvent.click(barToggle())
    await waitFor(() => expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('false'))
    expect(barToggle().getAttribute('aria-expanded')).toBe('false')
    expect(barToggle().classList.contains('open')).toBe(false)
    expect(panelOpen()).toBe(false)
  })

  it('closes when the sidebar navigates', async () => {
    render(App)
    await navigate('Issues')
    await fireEvent.click(navItem('Downloads'))
    await screen.findByText(PANEL)

    await navigate('Settings')

    await waitFor(() => expect(panelOpen()).toBe(false))
    expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('false')
    expect(barToggle().getAttribute('aria-expanded')).toBe('false')
    expect(navItem('Settings').getAttribute('aria-current')).toBe('page')
  })

  it('closes on a view shortcut', async () => {
    render(App)
    await fireEvent.click(navItem('Downloads'))
    await screen.findByText(PANEL)

    press(document.body, { key: 'x', code: 'Digit2', ctrlKey: true })

    await waitFor(() => expect(navItem('Explore').getAttribute('aria-current')).toBe('page'))
    await waitFor(() => expect(panelOpen()).toBe(false))
    expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when a Home link navigates', async () => {
    stubEncore({ settingsGet: vi.fn().mockResolvedValue(homeSettings()) })
    render(App)
    const explore = await screen.findByRole('button', { name: 'Explore charts' })
    await fireEvent.click(navItem('Downloads'))
    await screen.findByText(PANEL)

    await fireEvent.click(explore)

    await waitFor(() => expect(navItem('Explore').getAttribute('aria-current')).toBe('page'))
    await waitFor(() => expect(panelOpen()).toBe(false))
  })

  it('closes when a chart opens', async () => {
    stubEncore({
      settingsGet: vi.fn().mockResolvedValue(homeSettings()),
      catalogQuery: vi.fn().mockResolvedValue([record])
    })
    render(App)
    const card = await screen.findByRole('button', { name: /YYZ/ })
    await fireEvent.click(navItem('Downloads'))
    await screen.findByText(PANEL)

    await fireEvent.click(card)

    expect(await screen.findByRole('heading', { name: 'YYZ' })).toBeTruthy()
    await waitFor(() => expect(panelOpen()).toBe(false))
    expect(navItem('Downloads').getAttribute('aria-expanded')).toBe('false')
  })

  it('does not close for a toggle of its own, which is not a navigation', async () => {
    // The closer keys on the view changing. Opening the panel does not change it, and
    // reopening on the same view must not be answered by an immediate close.
    render(App)
    await navigate('Issues')
    await fireEvent.click(navItem('Downloads'))
    await screen.findByText(PANEL)
    await fireEvent.click(navItem('Downloads'))
    await waitFor(() => expect(panelOpen()).toBe(false))

    await fireEvent.click(navItem('Downloads'))

    expect(await screen.findByText(PANEL)).toBeTruthy()
    expect(navItem('Issues').getAttribute('aria-current')).toBe('page')
  })

  it('still yields to Escape before the chart underneath, so the dismiss order holds', async () => {
    stubEncore({
      settingsGet: vi.fn().mockResolvedValue(homeSettings()),
      catalogQuery: vi.fn().mockResolvedValue([record])
    })
    render(App)
    await fireEvent.click(await screen.findByRole('button', { name: /YYZ/ }))
    await screen.findByRole('heading', { name: 'YYZ' })
    await fireEvent.click(navItem('Downloads'))
    await screen.findByText(PANEL)

    press(document.body, { key: 'Escape' })

    await waitFor(() => expect(panelOpen()).toBe(false))
    // The chart is still open: Escape took the panel and stopped.
    expect(screen.getByRole('heading', { name: 'YYZ' })).toBeTruthy()

    press(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'YYZ' })).toBeNull())
  })
})
