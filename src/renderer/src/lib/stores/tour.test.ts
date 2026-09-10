import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../../../shared/settings-defaults'

/**
 * When the welcome tour is on screen, and what closing it writes.
 *
 * Node project, same window stub as stores.test.ts: the store reads nothing but other stores and
 * the bridge, so there is no DOM to need.
 */

function stubEncore(over: Record<string, unknown> = {}): { settingsSet: ReturnType<typeof vi.fn> } {
  const api = {
    settingsGet: vi.fn().mockResolvedValue(defaultSettings()),
    settingsSet: vi.fn().mockResolvedValue(undefined),
    ...over
  }
  ;(globalThis as Record<string, unknown>).window = { encore: api }
  return api
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.resetModules()
})

describe('tour store', () => {
  it('stays closed until settings have loaded', async () => {
    stubEncore()
    const { tourOpen } = await import('./tour')
    // The pre-load store value has tourSeen false, exactly like a real first run. Opening on it
    // would put the tour over every cold start for a moment, including for users who finished it
    // months ago.
    expect(get(tourOpen)).toBe(false)
  })

  it('opens on its own once settings load with the tour unseen', async () => {
    stubEncore()
    const { initSettings } = await import('./settings')
    const { tourOpen } = await import('./tour')
    await initSettings()
    expect(get(tourOpen)).toBe(true)
  })

  it('stays closed when the tour was seen on an earlier launch', async () => {
    stubEncore({
      settingsGet: vi.fn().mockResolvedValue({ ...defaultSettings(), tourSeen: true })
    })
    const { initSettings } = await import('./settings')
    const { tourOpen } = await import('./tour')
    await initSettings()
    expect(get(tourOpen)).toBe(false)
  })

  it('finishing closes it and remembers, whether the user finished or skipped', async () => {
    const api = stubEncore()
    const { initSettings, settings } = await import('./settings')
    const { tourOpen, finishTour } = await import('./tour')
    await initSettings()
    expect(get(tourOpen)).toBe(true)

    finishTour()

    expect(get(tourOpen)).toBe(false)
    expect(get(settings).tourSeen).toBe(true)
    expect(api.settingsSet).toHaveBeenCalledWith(expect.objectContaining({ tourSeen: true }))
  })

  it('reopens on request after it was seen, and closing again writes nothing', async () => {
    const api = stubEncore({
      settingsGet: vi.fn().mockResolvedValue({ ...defaultSettings(), tourSeen: true })
    })
    const { initSettings } = await import('./settings')
    const { tourOpen, openTour, finishTour } = await import('./tour')
    await initSettings()

    openTour()
    expect(get(tourOpen)).toBe(true)

    finishTour()
    expect(get(tourOpen)).toBe(false)
    // Already on disk as seen; a second write would only be a disk write for nothing.
    expect(api.settingsSet).not.toHaveBeenCalled()
  })

  it('a request while it is already open on first run is not a second copy', async () => {
    stubEncore()
    const { initSettings } = await import('./settings')
    const { tourOpen, openTour, finishTour } = await import('./tour')
    await initSettings()
    openTour()
    expect(get(tourOpen)).toBe(true)
    // One finish closes it: the request and the first-run gate are not two separate reasons
    // that each need dismissing.
    finishTour()
    expect(get(tourOpen)).toBe(false)
  })
})
