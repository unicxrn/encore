import { fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHORTCUTS, SHORTCUT_VIEWS, renderKeys } from '../shortcuts'
import Sidebar from './Sidebar.svelte'

/**
 * What these can and cannot check.
 *
 * jsdom applies no stylesheet, so how the two lit rows LOOK (the accent bar on the page row,
 * the violet glyph and chevron on the open Downloads row) rests on screenshots of the running
 * app. What is pinnable is which row carries which class and which state attribute, and that
 * the two never coincide: the class is the hook the stylesheet hangs the visual on, so a row
 * carrying the wrong one is the bug, whether or not a test can see the paint.
 */

beforeEach(() => {
  // The status card probes the yt-dlp sidecar on mount; the answer is not under test here.
  vi.stubGlobal('encore', {
    sidecarStatus: vi.fn().mockResolvedValue({ installed: false, version: null })
  })
})

afterEach(() => vi.unstubAllGlobals())

const noop = (): void => {}

function renderSidebar(
  over: Partial<{ view: 'tools' | 'settings'; downloadsOpen: boolean }> = {}
): {
  onNavigate: ReturnType<typeof vi.fn>
  onToggleDownloads: ReturnType<typeof vi.fn>
} {
  const onNavigate = vi.fn()
  const onToggleDownloads = vi.fn()
  render(Sidebar, {
    view: 'tools',
    downloadsOpen: false,
    onNavigate,
    onToggleDownloads,
    onShowShortcuts: noop,
    ...over
  })
  return { onNavigate, onToggleDownloads }
}

const row = (name: string): HTMLElement => screen.getByRole('button', { name })

describe('Sidebar: the page row and the panel row', () => {
  it('marks the current view as the page, and nothing else', () => {
    renderSidebar({ view: 'tools' })
    expect(row('Issues').getAttribute('aria-current')).toBe('page')
    expect(row('Issues').classList.contains('active')).toBe(true)
    for (const other of ['Home', 'Explore', 'Installed', 'Asset Studio', 'Stats', 'Settings']) {
      expect(row(other).getAttribute('aria-current')).toBeNull()
      expect(row(other).classList.contains('active')).toBe(false)
    }
  })

  // The audit's finding: with the panel open on Issues, two rows lit the same way and nothing
  // told a sighted user which was the page. The panel row must never borrow the page's class.
  it('lights the Downloads row as expanded while the panel is open, never as the page', () => {
    renderSidebar({ view: 'tools', downloadsOpen: true })
    const downloads = row('Downloads')
    expect(downloads.getAttribute('aria-expanded')).toBe('true')
    expect(downloads.getAttribute('aria-current')).toBeNull()
    expect(downloads.classList.contains('open')).toBe(true)
    expect(downloads.classList.contains('active')).toBe(false)
    // The page row is untouched by the panel.
    expect(row('Issues').getAttribute('aria-current')).toBe('page')
    expect(row('Issues').classList.contains('active')).toBe(true)
    expect(row('Issues').classList.contains('open')).toBe(false)
  })

  it('drops the expanded state with the panel', () => {
    renderSidebar({ view: 'settings', downloadsOpen: false })
    const downloads = row('Downloads')
    expect(downloads.getAttribute('aria-expanded')).toBe('false')
    expect(downloads.classList.contains('open')).toBe(false)
    expect(downloads.classList.contains('active')).toBe(false)
  })

  it('never puts `open` on a view row, whatever the panel is doing', () => {
    renderSidebar({ view: 'tools', downloadsOpen: true })
    for (const name of [
      'Home',
      'Explore',
      'Installed',
      'Asset Studio',
      'Stats',
      'Issues',
      'Settings'
    ]) {
      expect(row(name).classList.contains('open')).toBe(false)
      expect(row(name).getAttribute('aria-expanded')).toBeNull()
    }
  })

  it('routes a view row to onNavigate and the Downloads row to onToggleDownloads', async () => {
    const { onNavigate, onToggleDownloads } = renderSidebar()
    await fireEvent.click(row('Settings'))
    expect(onNavigate).toHaveBeenCalledWith('settings')
    expect(onToggleDownloads).not.toHaveBeenCalled()

    await fireEvent.click(row('Downloads'))
    expect(onToggleDownloads).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })
})

/**
 * `Mod+1…7` is the sidebar read top to bottom, and nothing else says so.
 *
 * `SHORTCUT_VIEWS` is a list in shortcuts.ts and the nav is a list in this component, and the
 * digits only mean what the sheet says they mean while the two are in the same order. Adding
 * the Stats row is what made this worth pinning: a row inserted higher up moves every digit
 * below it, and the only symptom would be a help sheet quietly describing the wrong keys.
 */
describe('Sidebar order and the view shortcuts', () => {
  it('lists the views in the order the digits follow', () => {
    renderSidebar()
    // The Downloads row opens a panel rather than going anywhere: it carries aria-expanded and
    // no view, so it takes no digit and is not part of this ordering.
    const rows = [...document.querySelectorAll('nav .section button')]
      .filter((button) => button.getAttribute('aria-expanded') === null)
      .map((button) => button.textContent?.trim())

    const labels = SHORTCUT_VIEWS.map((view) =>
      SHORTCUTS.find((spec) => spec.id === `go:${view}`)?.what.replace('Go to ', '')
    )
    expect(rows).toEqual(labels)
  })

  it('gives the Stats row the digit its position in that list earns', () => {
    const spec = SHORTCUTS.find((s) => s.id === 'go:stats')
    expect(spec?.what).toBe('Go to Stats')
    expect(renderKeys(spec?.keys ?? '', 'Linux x86_64')).toEqual(['Ctrl', '5'])
  })
})
