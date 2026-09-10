import { fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type NowPlaying,
  nowPlaying,
  playerState,
  playerVolume,
  progress,
  registerViewport
} from '../stores/preview-controller'
import { settings } from '../stores/settings'
import PlayerBar from './PlayerBar.svelte'

/**
 * The controller's stores are module singletons, so a track left playing by one test would leak
 * into the next one's first paint. Reset them the way `closePreview()` does.
 */
afterEach(() => {
  nowPlaying.set(null)
  playerState.set('idle')
  progress.set(null)
  playerVolume.set(null)
  // The settings store is a singleton too, and the bar's slider follows `previewVolume` in it.
  settings.update((s) => ({ ...s, previewVolume: 50 }))
})

const ART_URL = 'encore-art://d4e5f6'

/**
 * A fresh object every call, which is what `openPreview()` publishes on every open, including a
 * replay of the chart that just failed. Identity, not field values, is what the bar keys its
 * failure on, so tests that need "the same chart again" must still get a new object.
 */
function track(overrides: Partial<NowPlaying> = {}): NowPlaying {
  return { title: 'YYZ', artist: 'Rush', artUrl: ART_URL, ...overrides }
}

/**
 * The cover is `alt=""` (decorative, the title next to it already names the track) so it has no
 * accessible role or name to query by; the tag itself is the only handle on it. Absence of the
 * element is the assertion that matters either way: it is what stops a broken-image glyph.
 */
const cover = (container: HTMLElement): HTMLImageElement | null =>
  container.querySelector('img.art')

describe('PlayerBar: the cover fallback', () => {
  // The art protocol answers 404 when a chart's md5 has no cached file and 400 when the md5 is
  // malformed; both land here as a failed load, and the bar has to swap in its own placeholder.
  it('replaces a cover that fails to load with the placeholder', async () => {
    nowPlaying.set(track())
    const { container } = render(PlayerBar)

    const img = cover(container)
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toBe(ART_URL)

    await fireEvent.error(img as HTMLImageElement)

    expect(cover(container)).toBeNull()
    // The placeholder is an empty styled div with no text, role or label, so its class is the
    // only evidence the bar drew a tile rather than collapsing the slot.
    expect(container.querySelector('.art.placeholder')).toBeTruthy()
  })

  // PlayerBar is mounted outside App's view chain, so it is never destroyed by navigation and a
  // sticky failure flag would outlive every route change for the rest of the session.
  it('tries a cover again when a different track starts playing', async () => {
    nowPlaying.set(track())
    const { container } = render(PlayerBar)
    await fireEvent.error(cover(container) as HTMLImageElement)
    expect(cover(container)).toBeNull()

    nowPlaying.set(track({ title: 'Tom Sawyer', artUrl: 'encore-art://a1b2c3' }))
    await tick()

    expect(cover(container)?.getAttribute('src')).toBe('encore-art://a1b2c3')
  })

  // The failure is pinned to the NowPlaying object, not to the URL, and this is the difference:
  // after a rescan repairs the cached file the user replays the same chart at the same art URL.
  // A URL-keyed (or plain boolean) flag would keep showing the placeholder until restart.
  it('tries a cover again when the same chart is replayed at the same url', async () => {
    nowPlaying.set(track())
    const { container } = render(PlayerBar)
    await fireEvent.error(cover(container) as HTMLImageElement)
    expect(cover(container)).toBeNull()

    nowPlaying.set(null)
    nowPlaying.set(track())
    await tick()

    expect(cover(container)?.getAttribute('src')).toBe(ART_URL)
  })
})

describe('PlayerBar: the volume slider', () => {
  const slider = (container: HTMLElement): HTMLInputElement | null =>
    container.querySelector('input[aria-label="Preview volume"]')

  // The preview element owns keyboard shortcuts (↑/↓/M) that call its own setVolume without
  // dispatching anything. `playerVolume` is the app's only view of them, and a slider that
  // ignored it would sit at the last value the user dragged to while the audio was elsewhere.
  it('follows a volume the preview changed on its own', async () => {
    nowPlaying.set(track())
    const { container } = render(PlayerBar)
    playerVolume.set(70)
    await tick()
    expect(slider(container)?.value).toBe('70')

    playerVolume.set(0)
    await tick()
    expect(slider(container)?.value).toBe('0')
  })

  // …and keeps following it after the user has taken over the slider, because a keyboard
  // shortcut is the same user acting through a different control.
  it('keeps following it after the user has dragged the slider', async () => {
    nowPlaying.set(track())
    const { container } = render(PlayerBar)
    await fireEvent.input(slider(container) as HTMLInputElement, { target: { value: '25' } })
    expect(slider(container)?.value).toBe('25')

    playerVolume.set(90)
    await tick()
    expect(slider(container)?.value).toBe('90')
  })

  // With PreviewPane mounted its slider sits beside this one, and until playback starts there is
  // no live volume to follow: each slider commits through the controller into settings, and that
  // store is the one truth. The bar has to keep following it after its own drag, or the two
  // sliders disagree until the next play snaps them together. The store is driven directly here
  // because `patchSettings` sets it synchronously before its IPC write, and that update is all
  // the bar can see of the pane's commit.
  it('keeps following the stored volume after the user has dragged the slider', async () => {
    const { container } = render(PlayerBar)
    await fireEvent.input(slider(container) as HTMLInputElement, { target: { value: '65' } })
    expect(slider(container)?.value).toBe('65')

    settings.update((s) => ({ ...s, previewVolume: 40 }))
    await tick()
    expect(slider(container)?.value).toBe('40')
  })
})

describe('PlayerBar: ceding the transport to PreviewPane', () => {
  // Registered the way PreviewPane does it, through the controller, rather than by poking the
  // store: the store is the controller's to set, and a test that set it directly would keep
  // passing after the controller stopped doing so. Unregistered here so a failed assertion
  // cannot leave the module-level container pointing at a detached div for the next test.
  let unregister: (() => void) | null = null
  afterEach(() => {
    unregister?.()
    unregister = null
  })

  const playButton = (): HTMLElement | null =>
    screen.queryByRole('button', { name: /^(play|pause) preview$/i })

  // The whole point: in Detail › Preview the pane has the only play/seek. The bar keeps what the
  // pane does not carry: the title, the volume slider, the downloads toggle.
  it('drops its play/pause while a preview viewport is mounted, keeping title, volume and downloads', () => {
    unregister = registerViewport(document.createElement('div'))
    nowPlaying.set(track())
    render(PlayerBar)

    expect(playButton()).toBeNull()
    expect(screen.getByText('YYZ')).toBeTruthy()
    expect(screen.getByLabelText('Preview volume')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'DOWNLOADS' })).toBeTruthy()
  })

  // The transport stays in the DOM (it fades rather than reflows, so the bar keeps its height),
  // which makes hiding it from the accessibility tree not enough on its own: it must also be
  // unreachable by Tab and by the pointer, which is what `inert` is for.
  it('makes the ceded transport inert, not merely invisible', () => {
    unregister = registerViewport(document.createElement('div'))
    const { container } = render(PlayerBar)

    const play = container.querySelector('button[aria-label="Play preview"]')
    expect(play).toBeTruthy()
    expect(inInertSubtree(play as HTMLElement)).toBe(true)
  })

  /**
   * Svelte writes `inert` as a DOM property, and only a real engine reflects that property to
   * the attribute. jsdom has no `inert` at all, so the property lands as a plain expando and
   * `[inert]` matches nothing. Checking either form up the ancestor chain is what makes this
   * assertion the same one in both places.
   */
  function inInertSubtree(el: HTMLElement): boolean {
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      if ((node as HTMLElement & { inert?: boolean }).inert === true) return true
      if (node.hasAttribute('inert')) return true
    }
    return false
  }

  // Any navigation unmounts the pane, and with it the only other transport: the bar's returns.
  it('brings its play/pause back once the viewport unmounts', async () => {
    unregister = registerViewport(document.createElement('div'))
    render(PlayerBar)
    expect(playButton()).toBeNull()

    unregister()
    unregister = null
    await tick()

    expect(playButton()).toBeTruthy()
  })

  // Nothing mounted: the ordinary case on every view but Detail › Preview.
  it('shows its play/pause when no viewport is mounted', () => {
    render(PlayerBar)
    expect(playButton()).toBeTruthy()
  })
})

describe('PlayerBar: the DOWNLOADS toggle', () => {
  const toggle = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector('button.dl')

  // The bar's toggle and the sidebar's Downloads row open the same panel, so they have to say
  // the same thing about it. `aria-expanded` is what the sidebar row already carries; the `open`
  // class is the hook the stylesheet hangs the shared open-state visual on. jsdom cannot see
  // the paint, so the class is the only evidence here.
  it('says the panel is closed until it is opened', () => {
    const { container } = render(PlayerBar)
    const button = toggle(container)
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(button?.classList.contains('open')).toBe(false)
    expect(container.querySelector('.panel')).toBeNull()
  })

  it('reflects the panel it opened, and closes it on the next press', async () => {
    const { container } = render(PlayerBar)
    const button = toggle(container) as HTMLButtonElement

    await fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.classList.contains('open')).toBe(true)
    expect(container.querySelector('.panel')).toBeTruthy()

    await fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.classList.contains('open')).toBe(false)
    expect(container.querySelector('.panel')).toBeNull()
  })

  it('follows the state App binds in, so the sidebar can open it too', () => {
    const { container } = render(PlayerBar, { open: true })
    const button = toggle(container) as HTMLButtonElement
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.classList.contains('open')).toBe(true)
    expect(container.querySelector('.panel')).toBeTruthy()
  })
})
