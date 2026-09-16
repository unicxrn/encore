import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedDownload } from '../../../../shared/schemas'
import { SHORTCUTS, SHORTCUT_VIEWS, renderKeys } from '../shortcuts'
import { appUpdate } from '../stores/app-update'
import { downloads } from '../stores/downloads'
import { duplicates } from '../stores/duplicates'
import { issueTally } from '../stores/issue-tally'
import { scanProgress } from '../stores/scan'
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

/** The bridge the sidebar actually uses: the sidecar probe, and the library count. */
function stubBridge(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    // The status card probes the yt-dlp sidecar on mount; the answer is not under test here.
    sidecarStatus: vi.fn().mockResolvedValue({ installed: false, version: null }),
    // An empty catalog, which is what leaves the Installed row carrying no figure at all.
    catalogCount: vi.fn().mockResolvedValue(0),
    ...over
  }
  vi.stubGlobal('encore', api)
  return api
}

beforeEach(() => {
  stubBridge()
})

afterEach(() => {
  vi.unstubAllGlobals()
  // All three are module state that would otherwise be the next test's starting point.
  downloads.set([])
  duplicates.set(null)
  issueTally.set(null)
  scanProgress.set(null)
})

const noop = (): void => {}

function renderSidebar(
  over: Partial<{ view: 'tools' | 'settings'; downloadsOpen: boolean }> = {}
): {
  onNavigate: ReturnType<typeof vi.fn>
  onToggleDownloads: ReturnType<typeof vi.fn>
  onSurprise: ReturnType<typeof vi.fn>
} {
  const onNavigate = vi.fn()
  const onToggleDownloads = vi.fn()
  const onSurprise = vi.fn()
  render(Sidebar, {
    view: 'tools',
    downloadsOpen: false,
    onNavigate,
    onToggleDownloads,
    onShowShortcuts: noop,
    onSurprise,
    ...over
  })
  return { onNavigate, onToggleDownloads, onSurprise }
}

const row = (name: string): HTMLElement => screen.getByRole('button', { name })

describe('Sidebar: the page row and the panel row', () => {
  it('marks the current view as the page, and nothing else', () => {
    renderSidebar({ view: 'tools' })
    expect(row('Issues').getAttribute('aria-current')).toBe('page')
    expect(row('Issues').classList.contains('active')).toBe(true)
    for (const other of [
      'Home',
      'Explore',
      'Installed',
      'Asset Studio',
      'Statistics',
      'Duplicates',
      'Settings'
    ]) {
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
      'Statistics',
      'Issues',
      'Duplicates',
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
 * `Mod+1…8` is the sidebar read top to bottom, and nothing else says so.
 *
 * `SHORTCUT_VIEWS` is a list in shortcuts.ts and the nav is a list in this component, and the
 * digits only mean what the sheet says they mean while the two are in the same order. Adding
 * the Duplicates row is what made this worth pinning again: a row inserted higher up moves every
 * digit below it, and the only symptom would be a help sheet quietly describing the wrong keys.
 */
describe('Sidebar order and the view shortcuts', () => {
  it('lists the views in the order the digits follow', () => {
    renderSidebar()
    // The Downloads row opens a panel rather than going anywhere: it carries aria-expanded and
    // no view, so it takes no digit and is not part of this ordering.
    const rows = [...document.querySelectorAll('nav .section button')]
      .filter((button) => button.getAttribute('aria-expanded') === null)
      .map((button) => button.querySelector('.label')?.textContent?.trim())

    const labels = SHORTCUT_VIEWS.map((view) =>
      SHORTCUTS.find((spec) => spec.id === `go:${view}`)?.what.replace('Go to ', '')
    )
    expect(rows).toEqual(labels)
  })

  it('gives the Statistics row the digit its position in that list earns', () => {
    const spec = SHORTCUTS.find((s) => s.id === 'go:stats')
    expect(spec?.what).toBe('Go to Statistics')
    expect(renderKeys(spec?.keys ?? '', 'Linux x86_64')).toEqual(['Ctrl', '5'])
  })

  // Duplicates went in beside Issues, which is what moved Settings off the seventh digit. Both
  // are pinned, because the cost of the insert is exactly that Settings moved.
  it('gives Duplicates the seventh digit, the editor the eighth and Settings the ninth', () => {
    const digitOf = (id: string): string[] =>
      renderKeys(SHORTCUTS.find((s) => s.id === id)?.keys ?? '', 'Linux x86_64')
    expect(digitOf('go:duplicates')).toEqual(['Ctrl', '7'])
    expect(digitOf('go:metadata')).toEqual(['Ctrl', '8'])
    expect(digitOf('go:settings')).toEqual(['Ctrl', '9'])
  })
})

/**
 * The three new blocks above the nav, and the one thing they must not do.
 *
 * Two of the three offer something Encore cannot yet deliver: a YARG library and two chart
 * sources it does not search. The failure mode worth testing for is a control that looks live
 * and is not, so what is pinned is that each of those is disabled and carries a reason, and
 * that the reason is also said once in text rather than only in tooltips nobody hovers.
 */
describe('Sidebar: the switchers above the nav', () => {
  it('selects Clone Hero and offers YARG as unavailable rather than unselected', () => {
    renderSidebar()
    const clonehero = screen.getByRole('radio', { name: /Clone Hero/ })
    const yarg = screen.getByRole('radio', { name: /YARG/ })
    expect(clonehero.getAttribute('aria-checked')).toBe('true')
    expect(yarg.getAttribute('aria-checked')).toBe('false')
    expect((yarg as HTMLButtonElement).disabled).toBe(true)
    expect((clonehero as HTMLButtonElement).disabled).toBe(false)
  })

  it('leaves Chorus Encore the only live source, and says so', () => {
    renderSidebar()
    const group = screen.getByRole('radiogroup', { name: 'Chart source' })
    const segs = [...group.querySelectorAll('button')]
    expect(segs.map((b) => b.textContent?.trim())).toEqual(['Chorus Encore', 'RhythmVerse', 'Both'])
    expect(segs[0].getAttribute('aria-checked')).toBe('true')
    expect(segs[0].disabled).toBe(false)
    for (const dead of segs.slice(1)) {
      expect(dead.disabled).toBe(true)
      expect(dead.getAttribute('title')).toContain('Not connected yet')
    }
    // Once in text, not three times in tooltips: a tooltip is no answer for someone who never
    // hovers, and two dead segments need one reason between them.
    expect(screen.getByText(/Not connected yet\. Encore searches Chorus Encore\./)).toBeTruthy()
  })

  // Was both quick actions. Surprise me is built now, and the pair is deliberately split rather
  // than dropped: the reason Import playlist is still disabled is the reason it is still drawn.
  it('leaves Import playlist as a control that is not ready, not as a live button', () => {
    renderSidebar()
    const button = screen.getByRole('button', { name: 'Import playlist' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('title')).toContain('not built yet')
  })

  it('offers Surprise me as a live control that says where it goes', () => {
    const { onSurprise } = renderSidebar()
    const button = screen.getByRole('button', { name: 'Surprise me' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    // A quick action that changes the view has to say so before it is pressed.
    expect(button.getAttribute('title')).toContain('Opens Explore')
    expect(button.getAttribute('title')).not.toContain('not built yet')
    void fireEvent.click(button)
    expect(onSurprise).toHaveBeenCalledTimes(1)
  })

  it('groups the nav under Library and Tools', () => {
    renderSidebar()
    expect([...document.querySelectorAll('.section-header')].map((el) => el.textContent)).toEqual([
      'LIBRARY',
      'TOOLS'
    ])
  })
})

/**
 * The footer's update line.
 *
 * `appUpdate` is cast from the bridge rather than parsed, so a payload whose state is not one of
 * the seven the union names is reachable. The line has to say something either way: it measured
 * as the empty string in the offscreen frame run before the fallback existed, which is a footer
 * with a blank row in it and no way to tell that from a row that had not answered yet.
 */
describe('Sidebar: the update state in the footer', () => {
  afterEach(() => appUpdate.set(null))

  it('says nothing has answered yet before the first state arrives', () => {
    renderSidebar()
    expect(screen.getByText('UPDATE …')).toBeTruthy()
  })

  it('names the version a release offers', () => {
    appUpdate.set({
      currentVersion: '0.3.1',
      target: 'appimage',
      canApply: true,
      note: 'note',
      state: { kind: 'available', version: '0.4.0' }
    })
    renderSidebar()
    expect(screen.getByText('UPDATE 0.4.0 AVAILABLE')).toBeTruthy()
  })

  it('reports a percent while one is downloading, and the state without one before that', () => {
    const base = {
      currentVersion: '0.3.1',
      target: 'appimage' as const,
      canApply: true,
      note: 'note'
    }
    appUpdate.set({ ...base, state: { kind: 'downloading', version: '0.4.0', percent: null } })
    const { unmount } = render(Sidebar, {
      props: {
        view: 'tools' as const,
        downloadsOpen: false,
        onNavigate: noop,
        onToggleDownloads: noop,
        onShowShortcuts: noop,
        onSurprise: noop
      }
    })
    expect(screen.getByText('DOWNLOADING UPDATE')).toBeTruthy()
    unmount()

    appUpdate.set({ ...base, state: { kind: 'downloading', version: '0.4.0', percent: 42 } })
    renderSidebar()
    expect(screen.getByText('DOWNLOADING 42%')).toBeTruthy()
  })

  it('says so rather than going blank on a state it does not recognise', () => {
    appUpdate.set({
      currentVersion: '0.3.1',
      target: 'appimage',
      canApply: true,
      note: 'note',
      // Exactly what the measurement script's fake bridge was answering: a bare string where
      // the union has an object.
      state: 'idle'
    } as never)
    renderSidebar()
    expect(screen.getByText('UPDATE STATE UNKNOWN')).toBeTruthy()
  })
})

/**
 * The figures beside the nav items, and the one rule they all share.
 *
 * **Nothing here ever draws a zero.** Each of these four numbers has a state where zero and "not
 * checked" are the same reading: an unscanned catalog counts no charts, a launch where nobody
 * opened Issues has no report, a duplicate query over a catalog with no chart IDs in it finds no
 * identical copies. A figure that could mean either is a figure the sidebar has no business
 * drawing, so the row draws none and claims nothing.
 *
 * jsdom applies no stylesheet and computes no layout, so nothing here says what happens when a
 * five-digit figure meets the longest label in a 238px column. That is measured, in
 * scripts/measure-sidebar.mjs, and the classes these tests pin are the hooks those rules hang on.
 */
const figure = (label: string): string | null =>
  screen.getByRole('button', { name: new RegExp(`^${label}`) }).querySelector('.count')
    ?.textContent ?? null

const queued = (md5: string, status: QueuedDownload['status']): QueuedDownload => ({
  md5,
  url: `https://example.invalid/${md5}`,
  folderName: md5,
  status,
  percent: null,
  message: null,
  finalPath: null
})

const withCopies = (n: number): void =>
  duplicates.set({
    identical: [
      {
        checksum: 'a'.repeat(32),
        copies: Array.from({ length: n + 1 }, (_, i) => ({
          path: `/library/song (${i})`,
          chartType: 'folder' as const,
          name: 'YYZ',
          artist: 'Rush',
          charter: 'Ann',
          album: null,
          songLength: 300_000,
          modifiedTime: 1,
          cloneHeroChecksum: 'a'.repeat(32),
          hasAlbumArt: false,
          hasVideo: false,
          hasBackground: false,
          hasLyrics: false,
          sizeBytes: null
        }))
      }
    ],
    versions: [],
    alternates: [],
    totalCharts: n + 1,
    unidentifiedCharts: 0
  })

describe('Sidebar: the figures on the nav items', () => {
  it('draws the size of the library beside Installed, grouped and read out in words', async () => {
    stubBridge({ catalogCount: vi.fn().mockResolvedValue(1204) })
    renderSidebar()

    await waitFor(() => expect(figure('Installed')).toBe('1,204'))
    // The name carries the unit. "Installed 1,204" alone is a number attached to a word that is
    // not a noun, which is what a screen reader would otherwise read out.
    expect(screen.getByRole('button', { name: 'Installed, 1,204 charts' })).toBeTruthy()
  })

  it('asks for the count the way Home asks for it, once, over the whole catalog', async () => {
    const api = stubBridge({ catalogCount: vi.fn().mockResolvedValue(9) })
    renderSidebar()

    await waitFor(() => expect(api.catalogCount).toHaveBeenCalledTimes(1))
    expect(api.catalogCount).toHaveBeenCalledWith({})
  })

  it('asks again when a scan stops, because the catalog has moved under the number', async () => {
    const api = stubBridge({ catalogCount: vi.fn().mockResolvedValue(9) })
    renderSidebar()
    await waitFor(() => expect(api.catalogCount).toHaveBeenCalledTimes(1))

    scanProgress.set({
      jobId: 'scan-1',
      kind: 'scan',
      phase: 'scanning',
      percent: 100,
      message: null,
      status: 'done'
    })

    await waitFor(() => expect(api.catalogCount).toHaveBeenCalledTimes(2))
  })

  it('draws no figure at all when the count fails, rather than an empty library', async () => {
    stubBridge({ catalogCount: vi.fn().mockRejectedValue(new Error('no ipc')) })
    renderSidebar()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Installed' })).toBeTruthy())
    expect(figure('Installed')).toBeNull()
  })

  it('counts the downloads still to come and not the ones that are over', () => {
    downloads.set([
      queued('a', 'running'),
      queued('b', 'queued'),
      queued('c', 'queued'),
      queued('d', 'done'),
      queued('e', 'error'),
      queued('f', 'canceled')
    ])
    renderSidebar()

    expect(figure('Downloads')).toBe('3')
    expect(screen.getByRole('button', { name: 'Downloads, 3 still to download' })).toBeTruthy()
  })

  it('leaves the Downloads row bare once the queue has drained', () => {
    downloads.set([queued('d', 'done'), queued('e', 'error')])
    renderSidebar()

    expect(figure('Downloads')).toBeNull()
  })

  it('counts the spare copies beside Duplicates, in copies rather than sets', () => {
    withCopies(4)
    renderSidebar()

    expect(figure('Duplicates')).toBe('4')
    expect(screen.getByRole('button', { name: 'Duplicates, 4 spare copies' })).toBeTruthy()
  })

  it('says copy rather than copies when there is one of them', () => {
    withCopies(1)
    renderSidebar()

    expect(screen.getByRole('button', { name: 'Duplicates, 1 spare copy' })).toBeTruthy()
  })

  /**
   * The count that cannot be asked for.
   *
   * Main's issue report is a cache that is null until a scan completes in this launch, so on a
   * launch where nobody opens Issues there is nothing to draw and nothing is drawn. A pill
   * reading 0 over a library full of broken charts is the failure this shape exists to prevent.
   */
  it('draws nothing beside Issues until something in this launch has scanned', () => {
    renderSidebar()

    expect(figure('Issues')).toBeNull()
    expect(screen.getByRole('button', { name: 'Issues' })).toBeTruthy()
  })

  it('draws the broken charts as a warning once a scan has published them', () => {
    issueTally.set({ brokenCharts: 33 })
    renderSidebar()

    expect(figure('Issues')).toBe('33')
    expect(screen.getByRole('button', { name: 'Issues, 33 charts are broken' })).toBeTruthy()
    // The one figure of the four that is a report of something wrong, and the only one drawn as
    // a warning. What `pill` looks like is a stylesheet jsdom never reads; this pins the hook.
    const pill = screen.getByRole('button', { name: /^Issues/ }).querySelector('.count')
    expect(pill?.classList.contains('pill')).toBe(true)
  })

  it('draws nothing beside Issues when the scan that ran found nothing broken', () => {
    issueTally.set({ brokenCharts: 0 })
    renderSidebar()

    expect(figure('Issues')).toBeNull()
  })

  it('keeps the other three figures quiet rather than warnings', () => {
    stubBridge({ catalogCount: vi.fn().mockResolvedValue(12) })
    downloads.set([queued('a', 'running')])
    withCopies(2)
    renderSidebar()

    for (const label of ['Downloads', 'Duplicates']) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^${label}`) }).querySelector('.count.pill')
      ).toBeNull()
    }
  })

  it('keeps the figure out of the label, which is what lets the label give way', () => {
    downloads.set([queued('a', 'running')])
    renderSidebar()

    const downloadsRow = screen.getByRole('button', { name: /^Downloads/ })
    expect(downloadsRow.querySelector('.label')?.textContent).toBe('Downloads')
    expect(downloadsRow.querySelector('.count')?.textContent).toBe('1')
  })
})
