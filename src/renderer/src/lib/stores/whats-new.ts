import { get, writable, type Readable } from 'svelte/store'
import { APP_VERSION } from '../../../../shared/constants'
import { whatsNewOnLaunch } from '../../../../shared/changelog'
import { patchSettings, settings, settingsLoaded } from './settings'

/**
 * Which version the "what's new" panel is open on, and why.
 *
 * Null when it is closed. Modelled on `stores/tour.ts`, which solves the same shape of problem:
 * something that opens itself once, and can also be asked for at any time from Settings.
 */
export interface WhatsNewRequest {
  /** The version the panel leads with. */
  version: string
  /**
   * True when this is a version the updater is offering rather than the one running.
   *
   * The distinction changes what the panel can honestly say. A build ships the changelog it was
   * built from, so it has an entry for itself and for everything before it, and no entry at all
   * for a release that came out afterwards. Flagging the case lets the panel say so and point at
   * the release page, instead of drawing an empty section that reads like a release with nothing
   * in it.
   */
  offered: boolean
}

const request = writable<WhatsNewRequest | null>(null)

/** What App renders on. Read-only to everything outside this module. */
export const whatsNew: Readable<WhatsNewRequest | null> = { subscribe: request.subscribe }

/** Open it on the running build, which is what the Settings button does. */
export function openWhatsNew(version: string = APP_VERSION): void {
  request.set({ version, offered: false })
}

/** Open it on a release the updater has found, before anything is downloaded. */
export function openOfferedWhatsNew(version: string): void {
  request.set({ version, offered: true })
}

export function closeWhatsNew(): void {
  request.set(null)
}

/**
 * Decide once per launch whether the panel opens itself, and record the version either way.
 *
 * Gated on the settings load rather than run straight from `onMount`, for the same reason the
 * tour and the welcome are: before the load, `settings` holds the defaults, whose `lastSeenVersion`
 * is empty, and acting on that would show the panel on every cold start and then write the flag
 * that hides it forever.
 *
 * The write goes through `patchSettings`, so it lands on disk through the same path every other
 * setting does. It is not awaited: nothing on screen waits for it, and a failed save means the
 * panel appears once more on the next launch, which is a better failure than a panel that is
 * suppressed by a write nobody checked.
 *
 * Returns the unsubscribe, to match the other `init*` functions App calls on mount.
 */
export function initWhatsNew(): () => void {
  let decided = false
  return settingsLoaded.subscribe((loaded) => {
    if (!loaded || decided) return
    decided = true
    const { lastSeenVersion, tourSeen } = get(settings)
    const verdict = whatsNewOnLaunch({
      currentVersion: APP_VERSION,
      lastSeenVersion,
      tourSeen
    })
    if (verdict === 'nothing') return
    if (verdict === 'show') openWhatsNew()
    void patchSettings({ lastSeenVersion: APP_VERSION })
  })
}
