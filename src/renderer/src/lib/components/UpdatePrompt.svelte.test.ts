import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import UpdatePrompt from './UpdatePrompt.svelte'
import { targetCapability } from '../../../../shared/app-update'

/**
 * The launch prompt for a newer Encore.
 *
 * jsdom applies no CSS and computes no layout, so nothing here says how the card looks or where
 * it sits; that is desktop QA. What it pins is what the prompt may claim and what it may offer:
 * the install control exists only where Encore can actually install, the target's sentence is
 * always on screen, and every control calls out rather than acting on its own.
 *
 * The notes are the target's real sentences, read from `targetCapability`, so a prompt that
 * started printing something else would fail here as well as in the shared module's own tests.
 */
const handlers = (): { onskip: () => void; oninstall: () => void; onnotes: () => void } => ({
  onskip: vi.fn(),
  oninstall: vi.fn(),
  onnotes: vi.fn()
})

function mount(
  over: Partial<{ version: string; currentVersion: string; canApply: boolean; note: string }> = {},
  on = handlers()
): typeof on {
  render(UpdatePrompt, {
    version: '0.4.0',
    currentVersion: '0.3.0',
    canApply: true,
    note: targetCapability('appimage').note,
    ...on,
    ...over
  })
  return on
}

const dialog = (): HTMLElement => screen.getByRole('dialog')
const install = (): HTMLElement | null =>
  screen.queryByRole('button', { name: /^Download and install Encore/ })

describe('UpdatePrompt when Encore can install the release', () => {
  it('is a modal dialog named by its heading', () => {
    mount()
    expect(
      screen.getByRole('dialog', { name: 'Update available' }).getAttribute('aria-modal')
    ).toBe('true')
  })

  it('names the release found and the one running', () => {
    mount()
    expect(dialog().textContent).toContain('Encore 0.4.0 is available')
    expect(dialog().textContent).toContain('You are running 0.3.0')
  })

  it('says what this packaging does about it', () => {
    mount({ note: targetCapability('nsis').note })
    expect(dialog().textContent).toContain('Encore downloads the installer and runs it when you')
  })

  it('warns about the deb password prompt before the button is pressed', () => {
    // The deb install shells out through pkexec or sudo, so the desktop asks for a password. That
    // is the difference between an expected prompt and one that looks like something went wrong,
    // and it has to be said on the card that starts it, not only in Settings.
    mount({ note: targetCapability('deb').note })
    expect(dialog().textContent).toContain('asks for your password')
    // Still installable: unlike the snap, this one Encore can do, it just cannot do it silently.
    expect(install()).toBeTruthy()
  })

  it('offers the install, naming both halves of what it does', () => {
    // Not "Install": the press starts a download and the update lands on the next restart, which
    // is what the note beside it says. A label naming only the half that has not happened yet
    // would be describing a different button.
    mount()
    expect(install()?.textContent?.trim()).toBe('Download and install')
  })

  it('hands the install off rather than doing anything itself', async () => {
    const on = mount()
    await fireEvent.click(install() as HTMLElement)
    expect(on.oninstall).toHaveBeenCalledTimes(1)
    expect(on.onskip).not.toHaveBeenCalled()
  })

  it('offers the release notes before the install, not after it', async () => {
    const on = mount()
    const controls = [...dialog().querySelectorAll('button')].map((b) =>
      b.getAttribute('aria-label')
    )
    expect(controls.indexOf('What is new in Encore 0.4.0')).toBeLessThan(
      controls.indexOf('Download and install Encore 0.4.0')
    )
    await fireEvent.click(screen.getByRole('button', { name: 'What is new in Encore 0.4.0' }))
    expect(on.onnotes).toHaveBeenCalledTimes(1)
  })

  it('drops the running version rather than printing an empty one', () => {
    // What the renderer's store builds when a call never reached main and nothing was known
    // before it. "You are running ." would be worse than saying nothing.
    mount({ currentVersion: '' })
    expect(dialog().textContent).toContain('Encore 0.4.0 is available')
    expect(dialog().textContent).not.toContain('You are running')
  })
})

describe('UpdatePrompt on a copy Encore cannot update', () => {
  /** A snap: the Snap Store owns the install, so `snap refresh encore` is the whole answer. */
  const snap = (): ReturnType<typeof handlers> =>
    mount({ canApply: false, note: targetCapability('snap').note })

  it('offers no install control at all', () => {
    // The rule this component exists to keep: a button that cannot work is worse than no button.
    snap()
    expect(install()).toBeNull()
    expect(dialog().textContent).not.toContain('Download and install')
  })

  it('says what does update it instead', () => {
    snap()
    expect(dialog().textContent).toContain('snap refresh encore')
  })

  it('still offers the notes and the dismissal', async () => {
    const on = snap()
    await fireEvent.click(screen.getByRole('button', { name: 'What is new in Encore 0.4.0' }))
    await fireEvent.click(
      screen.getByRole('button', { name: 'Skip this update until the next launch' })
    )
    expect(on.onnotes).toHaveBeenCalledTimes(1)
    expect(on.onskip).toHaveBeenCalledTimes(1)
  })
})

describe('UpdatePrompt dismissal', () => {
  it('says that skipping is not the same as never, before it is pressed', () => {
    mount()
    expect(dialog().textContent).toContain('back the next time Encore starts')
  })

  it('skips from the button and from a click outside', async () => {
    const on = mount()
    await fireEvent.click(
      screen.getByRole('button', { name: 'Skip this update until the next launch' })
    )
    const backdrop = document.querySelector('button.backdrop')
    expect(backdrop).toBeTruthy()
    await fireEvent.click(backdrop as HTMLElement)
    expect(on.onskip).toHaveBeenCalledTimes(2)
  })

  it('handles no key itself, so App keeps the one dismiss order', async () => {
    // Escape belongs to App, which resolves it against everything layered on screen. A second
    // listener here would race that order rather than joining it.
    const on = mount()
    await fireEvent.keyDown(dialog(), { key: 'Escape' })
    expect(on.onskip).not.toHaveBeenCalled()
  })
})

describe('UpdatePrompt keyboard', () => {
  it('takes focus on open so a screen reader reads the dialog before its controls', () => {
    mount()
    expect(document.activeElement).toBe(dialog())
  })

  it('wraps Shift+Tab from the card round to the last control', async () => {
    mount()
    const card = dialog()
    const controls = [...card.querySelectorAll('button')] as HTMLElement[]
    await fireEvent.keyDown(card, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(controls[controls.length - 1])
  })

  it('leaves every key but Tab alone, so nothing typed into the app is swallowed', async () => {
    mount()
    const card = dialog()
    const before = document.activeElement
    await fireEvent.keyDown(card, { key: 'a' })
    expect(document.activeElement).toBe(before)
  })
})
