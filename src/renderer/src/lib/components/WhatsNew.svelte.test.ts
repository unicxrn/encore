import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import WhatsNew from './WhatsNew.svelte'
import { CHANGELOG } from '../changelog'
import { releasedOnly } from '../../../../shared/changelog'
import { APP_VERSION } from '../../../../shared/constants'

/**
 * The changelog on screen.
 *
 * jsdom applies no CSS, so nothing here says how the card looks; that is desktop QA. What it pins
 * is what the panel can and cannot claim. The bundled changelog is the same object the running app
 * reads, so a release entry that stops parsing fails here as well as in changelog.test.ts, and the
 * offered-version case is checked against a version no build could carry.
 */
function mount(props: Partial<{ version: string; offered: boolean }> = {}): void {
  render(WhatsNew, {
    version: APP_VERSION,
    offered: false,
    onclose: vi.fn(),
    ...props
  })
}

const dialog = (): HTMLElement => screen.getByRole('dialog')

describe('WhatsNew', () => {
  it('is a modal dialog named by its heading', () => {
    mount()
    const d = screen.getByRole('dialog', { name: "What's new" })
    expect(d.getAttribute('aria-modal')).toBe('true')
  })

  it('renders the changelog that was bundled into this build', () => {
    // Not a fixture: this is the real CHANGELOG.md, inlined by the `?raw` import in lib/changelog.
    expect(CHANGELOG.length).toBeGreaterThan(0)
    mount()
    for (const release of releasedOnly(CHANGELOG)) {
      expect(screen.getByRole('heading', { name: `Encore ${release.version}` })).toBeTruthy()
    }
  })

  it('leaves out the unreleased heading, which no build carries', () => {
    // Between releases CHANGELOG.md leads with `## [Unreleased]`, so a build from such a checkout
    // parses one. Drawing it would put a release nobody can install at the top of the panel, above
    // the version the user is actually running, dated nothing.
    mount()
    expect(screen.queryByRole('heading', { name: /Encore Unreleased/i })).toBeNull()
  })

  it('renders a release section as a heading over a list', () => {
    mount()
    const added = releasedOnly(CHANGELOG)[0].sections.find((s) => s.title === 'Added')
    expect(added).toBeTruthy()
    expect(screen.getAllByRole('heading', { name: 'Added' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(added?.items.length ?? 0)
  })

  it('draws a backticked run as code rather than printing the backticks', () => {
    // Read out of the changelog rather than written here, so this keeps testing the real entries
    // as they change instead of pinning one file name forever.
    const expected = releasedOnly(CHANGELOG).flatMap((release) =>
      release.sections.flatMap((section) =>
        section.items.flatMap((item) => item.filter((span) => span.code).map((span) => span.text))
      )
    )
    expect(expected.length).toBeGreaterThan(0)
    mount()
    const codes = [...dialog().querySelectorAll('code')].map((el) => el.textContent)
    expect(new Set(codes)).toEqual(new Set(expected))
    expect(dialog().textContent).not.toContain('`')
  })

  it('says which of the listed releases is the one running', () => {
    mount()
    const installed = [...dialog().querySelectorAll('*')].filter(
      (el) => el.textContent === 'INSTALLED' && el.children.length === 0
    )
    expect(installed.length).toBe(1)
  })

  it('shows no lead paragraph and no link when it has the entry it was opened on', () => {
    mount()
    expect(dialog().textContent).not.toContain('is available')
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('a version this build has no entry for', () => {
  /** What the Settings row does when the check reports a newer release. */
  const offered = (): void => mount({ version: '9.9.9', offered: true })

  it('says the release exists and that the notes are not in this build', () => {
    offered()
    expect(dialog().textContent).toContain('Encore 9.9.9 is available')
    expect(dialog().textContent).toContain(APP_VERSION)
  })

  it('offers the release page instead of drawing an empty release', () => {
    offered()
    const link = screen.getByRole('link', { name: /9\.9\.9/ })
    expect(link.getAttribute('href')).toBe('https://github.com/unicxrn/encore/releases/tag/v9.9.9')
    // target="_blank" is what main's setWindowOpenHandler turns into shell.openExternal, so the
    // page opens in the system browser and nothing remote is ever loaded inside Encore.
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.queryByRole('heading', { name: 'Encore 9.9.9' })).toBeNull()
  })

  it('still lists what this build does have', () => {
    offered()
    expect(screen.getByRole('heading', { name: `Encore ${APP_VERSION}` })).toBeTruthy()
  })
})

describe('WhatsNew keyboard and dismissal', () => {
  it('takes focus on open so a screen reader reads the dialog before its controls', () => {
    mount()
    expect(document.activeElement).toBe(dialog())
  })

  it('wraps Shift+Tab from the card round to the last control', async () => {
    mount()
    const card = dialog()
    const controls = [...card.querySelectorAll('button, [href]')] as HTMLElement[]
    await fireEvent.keyDown(card, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(controls[controls.length - 1])
  })

  it('closes from the close button and from Done', async () => {
    const onclose = vi.fn()
    render(WhatsNew, { version: APP_VERSION, offered: false, onclose })
    await fireEvent.click(screen.getByRole('button', { name: "Close what's new" }))
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onclose).toHaveBeenCalledTimes(2)
  })
})
