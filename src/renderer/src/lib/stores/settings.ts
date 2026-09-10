import { derived, get, writable } from 'svelte/store'
// A dedicated `import type` (not an inline `type` modifier, which still emits a
// side-effect import) so the schemas module, and with it the whole zod runtime,
// stays out of the renderer's startup bundle.
import type { Settings } from '../../../../shared/schemas'
import { defaultSettings } from '../../../../shared/settings-defaults'
import { encore } from './bridge'

export const settings = writable<Settings>(defaultSettings())

/**
 * False until the first `settingsGet` has come back, true forever after.
 *
 * `settings` starts at `defaultSettings()`, whose `libraryFolders` is `[]`. The store cannot
 * tell "not loaded yet" from "genuinely nothing configured" on its own, and anything keyed off
 * the empty list would fire on every cold start before the real settings arrived.
 */
export const settingsLoaded = writable(false)

/**
 * Set when the user answers the welcome with "Explore charts instead".
 *
 * Session-scoped on purpose, and deliberately **not** a `Settings` field. "Explore instead"
 * answers "right now", not "ever": the next launch of an app that still has no library folder
 * is best opened on onboarding, and a persisted flag would replace that with a Home whose every
 * local row is empty. Within the session it does need to hold, because bouncing the user back
 * into onboarding when they click Home would make the sidebar lie about where it leads. Task 3 is
 * what makes that safe: Home's empty rows now name the folder, the scan, and where both live,
 * so nobody lands on a dead end.
 */
export const welcomeDismissed = writable(false)

/**
 * Whether to show the first-run welcome instead of Home.
 *
 * The condition is "no library folder configured", not "no charts": a user whose library folder
 * is empty, or whose scan found nothing, has already made the choice this view exists to ask
 * for, and sending them back through onboarding on every launch would be worse than the empty
 * state they get instead.
 */
export const needsWelcome = derived(
  [settings, settingsLoaded, welcomeDismissed],
  ([$settings, $loaded, $dismissed]) =>
    $loaded && !$dismissed && $settings.libraryFolders.length === 0
)

/**
 * Whether a library folder is configured: the renderer's one answer to "is there anything to open".
 *
 * The same list `needsWelcome` reads, behind the same load gate, minus the session-only
 * dismissal: "Explore instead" hides the picker but sets no folder, and a door into Installed
 * or Issues would still open on nothing. Read by the welcome tour to decide whether each view
 * screen may open its view.
 */
export const hasLibrary = derived(
  [settings, settingsLoaded],
  ([$settings, $loaded]) => $loaded && $settings.libraryFolders.length > 0
)

export async function initSettings(): Promise<void> {
  try {
    settings.set(await encore().settingsGet())
  } finally {
    // Released even on failure. A view gated on this would otherwise stay blank for the whole
    // session; falling through to the welcome with default settings is recoverable, because the
    // user can still point it at a folder.
    settingsLoaded.set(true)
  }
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const next = { ...get(settings), ...patch }
  settings.set(next)
  await encore().settingsSet(next)
}
