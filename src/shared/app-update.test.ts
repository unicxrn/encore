import { describe, expect, it } from 'vitest'
import {
  offeredUpdate,
  targetCapability,
  type AppUpdateState,
  type AppUpdateStatus,
  type UpdateTarget
} from './app-update'

/**
 * The rule the launch prompt is built on: which states are worth interrupting a launch about.
 *
 * Here rather than in the component, because it is the same question main answers and the same
 * question Settings reads, and a boolean that only exists inside a Svelte file cannot be checked
 * against every state the union has.
 */
function status(state: AppUpdateState, over: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  const target: UpdateTarget = over.target ?? 'appimage'
  const { canApply, note } = targetCapability(target)
  return {
    currentVersion: '0.3.0',
    target,
    canApply,
    note,
    state,
    ...over
  }
}

/** Every state the union has, so a new one cannot be added without deciding what it means here. */
const STATES: AppUpdateState[] = [
  { kind: 'idle' },
  { kind: 'checking' },
  { kind: 'current' },
  { kind: 'available', version: '0.4.0' },
  { kind: 'downloading', version: '0.4.0', percent: 40 },
  { kind: 'ready', version: '0.4.0' },
  { kind: 'error', message: 'Could not reach GitHub. Check your connection and try again.' }
]

describe('offeredUpdate', () => {
  it('offers the release a check found, and names it beside the running one', () => {
    expect(offeredUpdate(status({ kind: 'available', version: '0.4.0' }))).toEqual({
      version: '0.4.0',
      currentVersion: '0.3.0',
      canApply: true,
      note: targetCapability('appimage').note
    })
  })

  it('offers nothing before main has answered', () => {
    expect(offeredUpdate(null)).toBeNull()
  })

  it('offers nothing in any state but available', () => {
    for (const state of STATES) {
      if (state.kind === 'available') continue
      expect(offeredUpdate(status(state)), state.kind).toBeNull()
    }
  })

  it('carries a target that cannot apply the release through rather than hiding it', () => {
    // The snap's sentence is the whole answer for that install, and a prompt that dropped it
    // would have nothing to say. Refusing the install control is the component's job, not this
    // function's; see UpdatePrompt.svelte.test.ts.
    const offer = offeredUpdate(status({ kind: 'available', version: '0.4.0' }, { target: 'snap' }))
    expect(offer?.canApply).toBe(false)
    expect(offer?.note).toContain('snap refresh encore')
  })

  it('passes the running version through empty rather than inventing one', () => {
    // `failedStatus` in the renderer's store builds exactly this when a call never reached main
    // and nothing was known before it. The prompt prints what it is given.
    const offer = offeredUpdate(
      status({ kind: 'available', version: '0.4.0' }, { currentVersion: '' })
    )
    expect(offer?.currentVersion).toBe('')
  })
})
