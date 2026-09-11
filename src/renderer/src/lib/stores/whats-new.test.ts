import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '../../../../shared/schemas'
import { APP_VERSION } from '../../../../shared/constants'

/**
 * The launch path, end to end: what main last saved, through the settings load, to whether the
 * panel is on screen and what got written back.
 *
 * `whatsNewOnLaunch` is unit-tested in shared/changelog.test.ts. What is tested here is the part
 * that decides once and only once: the store subscribes to the settings load, acts on the first
 * true it sees, and patches the version back through the same path every other setting takes. A
 * rule that is right and a store that runs it twice would still show the panel on every launch.
 */
function stubEncore(saved: Partial<Settings>): { settingsSet: ReturnType<typeof vi.fn> } {
  const settingsSet = vi.fn().mockResolvedValue(undefined)
  const api = {
    settingsGet: vi.fn().mockResolvedValue({ ...defaultSettings(), ...saved }),
    settingsSet
  }
  ;(globalThis as Record<string, unknown>).window = { encore: api }
  return { settingsSet }
}

/** One launch. Subscribes first, then loads, which is the order App's `onMount` uses. */
async function launch(saved: Partial<Settings>): Promise<{
  open: { version: string; offered: boolean } | null
  written: Partial<Settings> | null
}> {
  const { settingsSet } = stubEncore(saved)
  const store = await import('./whats-new')
  const { initSettings } = await import('./settings')
  const off = store.initWhatsNew()
  await initSettings()
  // The patch is fired without being awaited, so let the microtask queue drain before reading it.
  await Promise.resolve()
  const open = get(store.whatsNew)
  off()
  const call = settingsSet.mock.calls[0]?.[0] as Settings | undefined
  return { open, written: call ? { lastSeenVersion: call.lastSeenVersion } : null }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.resetModules()
})

describe('the what is new panel on launch', () => {
  it('opens once on the first launch after an update, and records the version', async () => {
    const first = await launch({ tourSeen: true, lastSeenVersion: '0.0.9' })
    expect(first.open).toEqual({ version: APP_VERSION, offered: false })
    expect(first.written).toEqual({ lastSeenVersion: APP_VERSION })
  })

  it('stays closed on the launch after that', async () => {
    // Exactly what the run above wrote to disk, read back.
    const second = await launch({ tourSeen: true, lastSeenVersion: APP_VERSION })
    expect(second.open).toBeNull()
    // And writes nothing, so an idle launch does not touch settings.json.
    expect(second.written).toBeNull()
  })

  it('stays closed on a fresh install, but records the version so the next update shows it', async () => {
    const fresh = await launch({ tourSeen: false, lastSeenVersion: '' })
    expect(fresh.open).toBeNull()
    expect(fresh.written).toEqual({ lastSeenVersion: APP_VERSION })
  })

  it('opens for an upgrade off a build that recorded no version at all', async () => {
    const upgraded = await launch({ tourSeen: true, lastSeenVersion: '' })
    expect(upgraded.open).toEqual({ version: APP_VERSION, offered: false })
  })
})

describe('opening it by hand', () => {
  it('opens on the running build from Settings', async () => {
    stubEncore({})
    const store = await import('./whats-new')
    store.openWhatsNew()
    expect(get(store.whatsNew)).toEqual({ version: APP_VERSION, offered: false })
    store.closeWhatsNew()
    expect(get(store.whatsNew)).toBeNull()
  })

  it('opens on a version the updater offered, flagged as offered', async () => {
    stubEncore({})
    const store = await import('./whats-new')
    store.openOfferedWhatsNew('9.9.9')
    expect(get(store.whatsNew)).toEqual({ version: '9.9.9', offered: true })
  })
})
