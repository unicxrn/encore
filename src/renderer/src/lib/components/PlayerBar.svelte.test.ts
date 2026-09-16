import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type NowPlaying,
  nowPlaying,
  playerRepeat,
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
  // Repeat is deliberately NOT reset by `closePreview()`, which is the point of it: a mode
  // outlives the chart. That makes it the one store here a test has to put back by hand.
  playerRepeat.set(false)
})

const ART_URL = 'encore-art://d4e5f6'

/**
 * A fresh object every call, which is what `openPreview()` publishes on every open, including a
 * replay of the chart that just failed. Identity, not field values, is what the bar keys its
 * failure on, so tests that need "the same chart again" must still get a new object.
 */
function playing(overrides: Partial<NowPlaying> = {}): NowPlaying {
  return { title: 'YYZ', artist: 'Rush', artUrl: ART_URL, track: 'Expert Guitar', ...overrides }
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
    nowPlaying.set(playing())
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
    nowPlaying.set(playing())
    const { container } = render(PlayerBar)
    await fireEvent.error(cover(container) as HTMLImageElement)
    expect(cover(container)).toBeNull()

    nowPlaying.set(playing({ title: 'Tom Sawyer', artUrl: 'encore-art://a1b2c3' }))
    await tick()

    expect(cover(container)?.getAttribute('src')).toBe('encore-art://a1b2c3')
  })

  // The failure is pinned to the NowPlaying object, not to the URL, and this is the difference:
  // after a rescan repairs the cached file the user replays the same chart at the same art URL.
  // A URL-keyed (or plain boolean) flag would keep showing the placeholder until restart.
  it('tries a cover again when the same chart is replayed at the same url', async () => {
    nowPlaying.set(playing())
    const { container } = render(PlayerBar)
    await fireEvent.error(cover(container) as HTMLImageElement)
    expect(cover(container)).toBeNull()

    nowPlaying.set(null)
    nowPlaying.set(playing())
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
    nowPlaying.set(playing())
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
    nowPlaying.set(playing())
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
    nowPlaying.set(playing())
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

describe('PlayerBar: the transport controls', () => {
  const button = (name: RegExp | string): HTMLElement | null =>
    screen.queryByRole('button', { name })

  /**
   * The decision this bar makes about the design, pinned so it is a decision and not a slip.
   *
   * The design draws shuffle, previous, play, next and repeat. Encore has one preview and no
   * list behind it: the rail or the chart page points the controller at a chart, `openPreview`
   * replaces whatever was playing, and pointing it somewhere new closes the old one. Shuffle,
   * previous and next all need a sequence, so none of them is drawn, and none is drawn disabled
   * either: a disabled control is a promise, and these would promise a play queue.
   */
  it('draws no shuffle, previous or next, because there is no sequence to move through', () => {
    nowPlaying.set(playing())
    const { container } = render(PlayerBar)

    expect(button(/shuffle/i)).toBeNull()
    expect(button(/previous/i)).toBeNull()
    expect(button(/next/i)).toBeNull()
    // Not hidden behind `disabled` or a tooltip either: nothing in the bar answers to the words.
    expect(screen.queryByTitle(/shuffle|previous|next/i)).toBeNull()
    // Play and repeat, and nothing else that could be mistaken for a transport.
    const controls = [...container.querySelectorAll('.transport button, .right button')].map((b) =>
      b.getAttribute('aria-label')
    )
    expect(controls).toEqual(['Play preview', 'Repeat', null])
  })

  it('puts repeat with the controls that stay rather than in the transport', () => {
    // Measured, not assumed: `scripts/measure-player-bar.mjs` finds the transport ceded in every
    // state where the bar has a chart in it, at all five widths and from both surfaces that can
    // start a preview. Drawn in there, repeat would be reachable only while nothing was playing.
    nowPlaying.set(playing())
    const { container } = render(PlayerBar)

    expect(container.querySelector('.transport .repeat')).toBeNull()
    expect(container.querySelector('.right .repeat')).toBeTruthy()
  })

  it('keeps repeat while the transport is ceded, and can be armed there', async () => {
    const unregister = registerViewport(document.createElement('div'))
    try {
      nowPlaying.set(playing())
      render(PlayerBar)
      expect(button('Play preview')).toBeNull()

      const repeat = button('Repeat') as HTMLButtonElement
      await fireEvent.click(repeat)
      expect(repeat.getAttribute('aria-pressed')).toBe('true')
    } finally {
      unregister()
    }
  })

  describe('repeat', () => {
    it('starts off and says so', () => {
      nowPlaying.set(playing())
      render(PlayerBar)
      expect(button('Repeat')?.getAttribute('aria-pressed')).toBe('false')
    })

    it('turns on and off again, and says which it is', async () => {
      nowPlaying.set(playing())
      render(PlayerBar)
      const repeat = button('Repeat') as HTMLButtonElement

      await fireEvent.click(repeat)
      expect(repeat.getAttribute('aria-pressed')).toBe('true')

      await fireEvent.click(repeat)
      expect(repeat.getAttribute('aria-pressed')).toBe('false')
    })

    it('follows the store, so a second transport cannot disagree with it', async () => {
      // PreviewPane's transport sits beside this one on the chart page, and both read the same
      // mode. A button that only followed its own clicks would drift the moment anything else
      // set it.
      nowPlaying.set(playing())
      render(PlayerBar)
      playerRepeat.set(true)
      await tick()
      expect(button('Repeat')?.getAttribute('aria-pressed')).toBe('true')
    })

    it('stays pressable with nothing playing, unlike the play button', async () => {
      // A mode, not an action: it outlives the chart it was armed on, and arming it before
      // pressing Play in the rail is a thing to do.
      render(PlayerBar)
      const repeat = button('Repeat') as HTMLButtonElement
      expect(repeat.disabled).toBe(false)

      await fireEvent.click(repeat)
      expect(repeat.getAttribute('aria-pressed')).toBe('true')
    })

    it('keeps its state across the track it was armed on', async () => {
      // closePreview runs on every navigation and clears `nowPlaying`. The mode is not track
      // state and must not go with it.
      nowPlaying.set(playing())
      render(PlayerBar)
      await fireEvent.click(button('Repeat') as HTMLButtonElement)

      nowPlaying.set(null)
      await tick()
      expect(button('Repeat')?.getAttribute('aria-pressed')).toBe('true')

      nowPlaying.set(playing({ title: 'Limelight' }))
      await tick()
      expect(button('Repeat')?.getAttribute('aria-pressed')).toBe('true')
    })
  })
})

/**
 * The left group, which is the bar at rest and the bar with a song in it.
 *
 * jsdom applies no CSS and computes no layout, so nothing here can see the 240px box or which
 * half of the second line gives way first. `scripts/measure-player-bar.mjs` prints both, at every
 * width the shell supports, against the longest title measured on api.enchor.us. What is pinnable
 * is what the group SAYS, and that it says it in the same three slots either way.
 */
describe('PlayerBar: the name group', () => {
  const slots = (container: HTMLElement): string[] =>
    [...(container.querySelector('.now')?.children ?? [])].map((el) => el.className.split(' ')[0])

  /**
   * The bar used to answer "nothing is previewing" with the word ENCORE, which named the app in
   * the one place nobody needs telling and left two thirds of the group blank. Two states, one
   * shape: a tile, a name and a line under it, whether or not there is a chart to put in them.
   */
  it('is composed with nothing playing, rather than a wordmark in an empty box', () => {
    const { container } = render(PlayerBar)

    expect(container.querySelector('.wordmark')).toBeNull()
    expect(container.textContent).not.toContain('ENCORE')
    expect(screen.getByText('Nothing previewing')).toBeTruthy()
    expect(screen.getByText('Press play on a chart')).toBeTruthy()
    expect(slots(container)).toEqual(['art', 'meta'])
  })

  it('keeps that shape when a chart arrives, so nothing in the bar jumps', () => {
    nowPlaying.set(playing())
    const { container } = render(PlayerBar)

    expect(slots(container)).toEqual(['art', 'meta'])
    expect(container.querySelector('.now .title')?.textContent).toBe('YYZ')
  })

  /**
   * The track, which is the one thing on this line the rest of the bar does not already say.
   *
   * It is not derived here from `instrument` and `difficulty`: those are the chart format's keys
   * ('guitarghl', 'expert') and the surface that opened the preview is the one holding the label
   * list. The controller carries the words across, so the bar names the track in the words the
   * rail's badge and the pane's selects use.
   */
  it('names the chart and the track being previewed', () => {
    nowPlaying.set(playing({ artist: 'Rush', track: 'Hard Bass' }))
    const { container } = render(PlayerBar)

    expect(container.querySelector('.now .title')?.textContent).toBe('YYZ')
    expect(container.querySelector('.now .artist')?.textContent).toBe('Rush')
    expect(container.querySelector('.now .track')?.textContent).toBe('Hard Bass')
  })

  it('still names the track for a chart that credits no artist', () => {
    nowPlaying.set(playing({ artist: '', track: 'Expert Drums' }))
    const { container } = render(PlayerBar)

    expect(container.querySelector('.now .artist')?.textContent).toBe('')
    expect(container.querySelector('.now .track')?.textContent).toBe('Expert Drums')
  })

  /**
   * Two rules jsdom cannot compute, read out of the source instead, because both are decisions
   * rather than defaults and both fail silently.
   *
   * The track is pinned beside the artist and never shrinks: the title above already carries the
   * song, so a long artist crowding out which instrument and difficulty are playing would lose
   * the only new thing on the line. And the separator belongs to the track rather than to the
   * artist, so a chart with no artist gets the track with nothing in front of it rather than a
   * middot floating at the start of the line.
   */
  it('declares the two rules on that line that jsdom cannot show', () => {
    const source = readFileSync(join(__dirname, 'PlayerBar.svelte'), 'utf8')
    const styles = (/<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    )

    expect(/\.track\s*\{[^}]*flex:\s*none/.test(styles)).toBe(true)
    // The artist is the half that gives way, through the ellipsis rule it shares with the title.
    expect(/\.title,\s*\n\s*\.artist\s*\{[^}]*text-overflow:\s*ellipsis/.test(styles)).toBe(true)
    expect(/\.artist\s*\{[^}]*min-width:\s*0/.test(styles)).toBe(true)
    expect(/\.artist:not\(:empty\)\s*\+\s*\.track::before\s*\{[^}]*content:/.test(styles)).toBe(
      true
    )
  })
})

/**
 * The scrubber. Reachable only while nothing is playing, which is the whole of the second fact
 * this bar is built around: a preview can only live inside a registered viewport, and the
 * transport is ceded for as long as one is registered. It is still drawn the way the design draws
 * it, because it is the same control the rail and the chart page carry, where it IS reached.
 */
describe('PlayerBar: the scrubber', () => {
  it('draws a fill and a handle, both off the same number', async () => {
    nowPlaying.set(playing())
    progress.set({ percent: 42, currentMs: 42_000, totalMs: 100_000 })
    const { container } = render(PlayerBar)
    await tick()

    const fill = container.querySelector('.seek .fill') as HTMLElement
    const knob = container.querySelector('.seek .knob') as HTMLElement
    expect(fill.style.getPropertyValue('--p')).toBe('0.42')
    expect(knob.style.getPropertyValue('--p')).toBe('0.42')
    expect([...container.querySelectorAll('.transport .time')].map((el) => el.textContent)).toEqual(
      ['0:42', '1:40']
    )
  })
})
