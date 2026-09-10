import { derived, get, writable } from 'svelte/store'
import { patchSettings, settings, settingsLoaded } from './settings'

/**
 * Whether the welcome tour is on screen.
 *
 * Two reasons it can be, folded into one readable so App has one thing to render on:
 *
 * - **First run.** Settings have loaded and `tourSeen` is false. Gated on the load for the same
 *   reason `needsWelcome` is: the pre-load store value is the defaults, which look exactly like a
 *   first run, and a tour that opened on them would flash over every cold start.
 * - **Asked for.** Settings and the shortcut sheet both offer the tour again, at any time.
 *
 * Deliberately NOT a check on the library folder. The tour is about what the app does, and the
 * folder picker underneath it (Welcome) is gated on the folder separately, so reopening the tour
 * with a folder configured shows the tour and nothing else.
 */
const requested = writable(false)

export const tourOpen = derived(
  [requested, settings, settingsLoaded],
  ([$requested, $settings, $loaded]) => $requested || ($loaded && !$settings.tourSeen)
)

export function openTour(): void {
  requested.set(true)
}

/**
 * Close the tour, however it was left: Done, Skip, Escape or a click outside.
 *
 * All four mark it seen. Skipping is an answer, and the answer is "not now", which the next launch
 * should respect. The write is skipped when the flag is already on disk, so reopening the tour from
 * Settings and closing it again costs nothing.
 */
export function finishTour(): void {
  requested.set(false)
  if (!get(settings).tourSeen) void patchSettings({ tourSeen: true })
}
