import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus } from '../../../../shared/app-update'
import {
  appUpdate,
  checkAppUpdate,
  initAppUpdate,
  installAppUpdate,
  refreshAppUpdate
} from './app-update'

/**
 * The renderer's mirror of main's app-update state.
 *
 * Two things are worth pinning here. The store never invents a state: everything in it came from
 * main, so a button press that main refuses leaves the row where it was. And a call that never
 * reaches main still says something, because main answers a failed check with a state rather than
 * a rejection, so a rejection here means the bridge itself is missing and the row would otherwise
 * sit silent forever.
 */

const STATUS: AppUpdateStatus = {
  currentVersion: '0.1.0',
  target: 'appimage',
  canApply: true,
  note: 'Encore downloads the new AppImage and replaces this one when you restart.',
  state: { kind: 'idle' }
}

/**
 * The bridge as this store sees it. Assigned onto `globalThis.window` rather than through
 * `vi.stubGlobal('encore', ...)`, because these run in the node project, where there is no
 * `window` for a bare `encore` global to hang off and `bridge.ts` reads `window.encore`.
 */
function stubEncore(api: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>).window = { encore: api }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  appUpdate.set(null)
})

describe('appUpdate store', () => {
  it('starts null, which is not the same as up to date', () => {
    // The row draws a placeholder for it. Claiming "up to date" before main has answered would be
    // a statement about a check that has not happened.
    expect(get(appUpdate)).toBeNull()
  })

  it('takes what main sends without asking for it', () => {
    // The startup check's result and every download percent arrive this way, with nothing in the
    // renderer having invoked anything.
    let push: ((data: unknown) => void) | null = null
    stubEncore({
      onAppUpdate: (cb: (data: unknown) => void) => {
        push = cb
        return () => {}
      }
    })

    const off = initAppUpdate()
    push!({ ...STATUS, state: { kind: 'available', version: '0.2.0' } })

    expect(get(appUpdate)?.state).toStrictEqual({ kind: 'available', version: '0.2.0' })
    off()
  })

  it('reads main answer on refresh', async () => {
    stubEncore({ appUpdateStatus: () => Promise.resolve(STATUS) })
    await refreshAppUpdate()
    expect(get(appUpdate)).toStrictEqual(STATUS)
  })

  it('takes the failed check main reports, rather than treating it as an exception', async () => {
    const failed: AppUpdateStatus = {
      ...STATUS,
      state: {
        kind: 'error',
        message: 'Could not reach GitHub. Check your connection and try again.'
      }
    }
    stubEncore({ appUpdateCheck: () => Promise.resolve(failed) })

    await checkAppUpdate()

    expect(get(appUpdate)).toStrictEqual(failed)
  })

  it('says so when the call never reached main at all', async () => {
    // An older preload without the method, or main mid-restart. The row still has to say
    // something: without this it would sit on CHECKING… for the rest of the session.
    appUpdate.set(STATUS)
    stubEncore({ appUpdateCheck: () => Promise.reject(new Error('No handler registered')) })

    await checkAppUpdate()

    expect(get(appUpdate)?.state).toStrictEqual({
      kind: 'error',
      message: 'No handler registered'
    })
  })

  it('keeps what main last said about the target through a failed call', async () => {
    // The packaging did not stop being a snap because one invoke failed, and blanking the
    // explanation would swap a real answer for an empty one.
    const snap: AppUpdateStatus = {
      currentVersion: '0.1.0',
      target: 'snap',
      canApply: false,
      note: 'This copy came from the Snap Store, which updates it for you.',
      state: { kind: 'idle' }
    }
    appUpdate.set(snap)
    stubEncore({ appUpdateCheck: () => Promise.reject(new Error('gone')) })

    await checkAppUpdate()

    const now = get(appUpdate)
    expect(now?.target).toBe('snap')
    expect(now?.canApply).toBe(false)
    expect(now?.note).toBe(snap.note)
  })

  it('re-reads main state when an install found nothing staged', async () => {
    // In a real build the install call never resolves, because the app is closing. It resolving
    // at all means the button outlived the state it belonged to.
    const status = vi.fn().mockResolvedValue(STATUS)
    stubEncore({ appUpdateInstall: () => Promise.resolve(false), appUpdateStatus: status })

    await installAppUpdate()

    expect(status).toHaveBeenCalledTimes(1)
    expect(get(appUpdate)).toStrictEqual(STATUS)
  })
})
