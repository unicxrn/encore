import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { get } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../../../shared/settings-defaults'
import ShortcutSheet from './ShortcutSheet.svelte'
import { SHORTCUTS, renderKeys } from '../shortcuts'
import { settings } from '../stores/settings'
import { finishTour, tourOpen } from '../stores/tour'

describe('ShortcutSheet contents', () => {
  it('prints every binding, so the sheet cannot go stale against them', () => {
    render(ShortcutSheet, { onclose: vi.fn() })
    for (const spec of SHORTCUTS) expect(screen.getByText(spec.what)).toBeTruthy()
  })

  it('prints each chord as key caps', () => {
    render(ShortcutSheet, { onclose: vi.fn() })
    const kbds = [...document.querySelectorAll('kbd')].map((el) => el.textContent)
    // jsdom reports navigator.platform as '', which renderKeys reads as not-macOS.
    for (const cap of renderKeys('Mod K', navigator.platform)) expect(kbds).toContain(cap)
  })

  it('is a named modal dialog, which is what makes App stand down while it is up', () => {
    render(ShortcutSheet, { onclose: vi.fn() })
    expect(
      screen.getByRole('dialog', { name: 'Keyboard shortcuts' }).getAttribute('aria-modal')
    ).toBe('true')
  })

  it('closes from the ✕', async () => {
    const onclose = vi.fn()
    render(ShortcutSheet, { onclose })
    await fireEvent.click(screen.getByRole('button', { name: 'Close keyboard shortcuts' }))
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('closes from a click on the backdrop, which is a pointer affordance only', async () => {
    const onclose = vi.fn()
    const { container } = render(ShortcutSheet, { onclose })
    const backdrop = container.querySelector('.backdrop')
    // Deliberately not reachable by role: it is aria-hidden and out of the tab
    // order, because ✕ and Escape are the keyboard ways out and a second
    // unnamed "close" would only be something extra to tab past.
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop?.getAttribute('tabindex')).toBe('-1')

    await fireEvent.click(backdrop!)
    expect(onclose).toHaveBeenCalledOnce()
  })
})

describe('ShortcutSheet focus', () => {
  it('takes focus on open and hands it back on close', async () => {
    // The opener has to be a real focused element for there to be anything to
    // restore; this is the case that fails silently otherwise.
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = render(ShortcutSheet, { onclose: vi.fn() })
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
      )
    )

    unmount()

    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('wraps Tab rather than letting it out of an aria-modal dialog', async () => {
    render(ShortcutSheet, { onclose: vi.fn() })
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    const controls = [...dialog.querySelectorAll('button')]
    const last = controls[controls.length - 1]
    last.focus()

    // jsdom does not move focus on Tab, so what is asserted is the handler's own
    // work: claim the event, put focus on the first control.
    const claimed = !(await fireEvent.keyDown(last, { key: 'Tab' }))

    expect(claimed).toBe(true)
    expect(document.activeElement).toBe(controls[0])
  })

  it('wraps Shift+Tab backwards off the first control', async () => {
    render(ShortcutSheet, { onclose: vi.fn() })
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    const controls = [...dialog.querySelectorAll('button')]
    controls[0].focus()

    const claimed = !(await fireEvent.keyDown(controls[0], { key: 'Tab', shiftKey: true }))

    expect(claimed).toBe(true)
    expect(document.activeElement).toBe(controls[controls.length - 1])
  })

  it('wraps Shift+Tab off the card itself, which is what has focus on open', async () => {
    render(ShortcutSheet, { onclose: vi.fn() })
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    const controls = [...dialog.querySelectorAll('button')]
    dialog.focus()

    const claimed = !(await fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }))

    expect(claimed).toBe(true)
    expect(document.activeElement).toBe(controls[controls.length - 1])
  })

  it('leaves every other key to the app, including Escape', async () => {
    const onclose = vi.fn()
    render(ShortcutSheet, { onclose })
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })

    // App owns the dismiss order; a second Escape listener here would race it.
    expect(await fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(true)
    expect(onclose).not.toHaveBeenCalled()
  })
})

describe('ShortcutSheet and the welcome tour', () => {
  it('offers the tour, and closes itself to make room for it', async () => {
    const onclose = vi.fn()
    render(ShortcutSheet, { onclose })

    await fireEvent.click(screen.getByRole('button', { name: 'Show the welcome tour' }))

    expect(onclose).toHaveBeenCalledOnce()
    expect(get(tourOpen)).toBe(true)
    // Module state; put it back without a write, for the tests after this one.
    settings.set({ ...defaultSettings(), tourSeen: true })
    finishTour()
  })
})
