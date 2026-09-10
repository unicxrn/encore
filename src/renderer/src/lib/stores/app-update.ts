import { get, writable, type Writable } from 'svelte/store'
import type { AppUpdateStatus } from '../../../../shared/app-update'
import { encore } from './bridge'

/**
 * What main knows about Encore's own next release.
 *
 * Null until the first answer arrives, which is a third state and not the same as "up to date":
 * the panel draws a dash for it, exactly as the sidecar rows do before their status lands. Main
 * owns the real state, this is a mirror of it, and every write here comes from main rather than
 * from a local guess about what a button press will do.
 *
 * Not to be confused with `stores/updates.ts`, which mirrors chart verdicts from Chorus.
 */
export const appUpdate: Writable<AppUpdateStatus | null> = writable(null)

/**
 * Subscribe to main's state changes for the life of the app.
 *
 * Needed as well as `refreshAppUpdate` because two of the states arrive unasked: the startup
 * check's result, which nothing in the renderer invoked, and the percent during a download, which
 * arrives between the invoke and the promise it resolves.
 */
export function initAppUpdate(): () => void {
  return encore().onAppUpdate((raw) => appUpdate.set(raw as AppUpdateStatus))
}

/**
 * A call that never reached main, turned into the same state a failed check produces.
 *
 * Main answers a failed check with an `error` state rather than a rejection, so a rejection here
 * means the bridge itself did not carry the call: an older preload without the method, or main
 * mid-restart. The row still has to say something, and this is the same kind of thing it would
 * say, so it goes in the same place instead of being left to the runtime error bar.
 *
 * Whatever main last said about the target is kept. That part does not stop being true because
 * one call failed, and blanking it would swap a real explanation for an empty one.
 */
function failedStatus(err: unknown, previous: AppUpdateStatus | null): AppUpdateStatus {
  return {
    currentVersion: previous?.currentVersion ?? '',
    target: previous?.target ?? 'unknown',
    canApply: previous?.canApply ?? false,
    note: previous?.note ?? '',
    state: { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

async function run(call: () => Promise<AppUpdateStatus>): Promise<void> {
  const previous = get(appUpdate)
  try {
    appUpdate.set(await call())
  } catch (err) {
    appUpdate.set(failedStatus(err, previous))
  }
}

/** Read main's current answer. No network, so it is safe on every mount. */
export const refreshAppUpdate = (): Promise<void> => run(() => encore().appUpdateStatus())

/** Ask GitHub. Resolves once the check has finished, whatever it concluded. */
export const checkAppUpdate = (): Promise<void> => run(() => encore().appUpdateCheck())

/** Fetch the release the last check found. Progress arrives on the subscription, not here. */
export const downloadAppUpdate = (): Promise<void> => run(() => encore().appUpdateDownload())

/**
 * Quit and apply the staged update.
 *
 * In a real build this never resolves, because the app is closing. It resolves with false when
 * there is nothing staged, which can only be a button that outlived the state it belonged to, so
 * the answer there is to re-read main's state rather than to report anything.
 */
export async function installAppUpdate(): Promise<void> {
  const previous = get(appUpdate)
  try {
    await encore().appUpdateInstall()
  } catch (err) {
    appUpdate.set(failedStatus(err, previous))
    return
  }
  await refreshAppUpdate()
}
