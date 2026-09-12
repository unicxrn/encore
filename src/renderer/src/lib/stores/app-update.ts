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
 * Subscribe to main's state changes for the life of the app, and read what it already decided.
 *
 * The subscription is needed because two states arrive unasked: the startup check's result, which
 * nothing in the renderer invoked, and the percent during a download, which arrives between the
 * invoke and the promise it resolves.
 *
 * The read is needed because the startup check can finish before this subscription exists. Main
 * begins it immediately after `createWindow()`, and the renderer has to load, mount and reach
 * here first; on a fast connection the push lands with nobody listening and is gone. Nothing then
 * set this store until Settings was opened, because its `onMount` was the only caller of
 * `refreshAppUpdate`, so the launch prompt appeared on a visit to Settings rather than at launch.
 * Asking main for its current state costs no network and cannot miss an answer that has already
 * happened.
 *
 * Whatever answers first wins. The read is dispatched after the subscription, so a push can land
 * while it is still in flight, and letting the older answer resolve on top of a newer one would
 * put a stale percent or a superseded verdict on screen.
 */
export function initAppUpdate(): () => void {
  const off = encore().onAppUpdate((raw) => appUpdate.set(raw as AppUpdateStatus))
  void (async () => {
    try {
      const current = await encore().appUpdateStatus()
      // Only if nothing has answered yet. This read is dispatched at mount and resolves a tick
      // or more later, by which time a push may have landed or a refresh may have run, and both
      // of those are newer than the state main held when this call was made. Filling the gap is
      // the whole job; overwriting an answer is not.
      if (get(appUpdate) === null) appUpdate.set(current)
    } catch {
      // A bridge without the method, or main mid-restart. The subscription is still live and
      // Settings still asks on its own, so there is nothing to report and nothing to undo.
    }
  })()
  return off
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
