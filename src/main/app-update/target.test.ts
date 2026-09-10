import { describe, expect, it, vi } from 'vitest'
import { targetCapability, type UpdateTarget } from '../../shared/app-update'
import { detectUpdateTarget, type UpdateTargetProbe } from './target'

/**
 * Which of electron-updater's paths a given install takes, and what Encore tells the user about
 * it.
 *
 * This is the half of app updating that can be tested honestly. Nothing here proves an update
 * applies; it proves that the sentence Encore prints matches the code that would run, which is
 * the thing that goes wrong silently. A snap offering a Download button, or a deb promising a
 * restart with no mention of the password prompt, would both look correct in a screenshot.
 */

function probe(over: Partial<UpdateTargetProbe> = {}): UpdateTargetProbe {
  return {
    platform: 'linux',
    packaged: true,
    env: {},
    readPackageType: () => null,
    ...over
  }
}

describe('detectUpdateTarget', () => {
  it('calls a dev run unpackaged, whatever it is running on', () => {
    // First, and before anything else is read: a dev run has no resources directory to find a
    // marker in, and no release its version could be an update to.
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(detectUpdateTarget(probe({ platform, packaged: false }))).toBe('unpackaged')
    }
  })

  it('does not read the package-type marker before it knows the app is packaged', () => {
    const readPackageType = vi.fn().mockReturnValue('deb')
    expect(detectUpdateTarget(probe({ packaged: false, readPackageType }))).toBe('unpackaged')
    expect(readPackageType).not.toHaveBeenCalled()
  })

  it('is nsis on Windows and macos on darwin, without looking at the packaging', () => {
    // Mirrors electron-updater's own main.js, which branches on platform first and only consults
    // the marker on Linux.
    expect(detectUpdateTarget(probe({ platform: 'win32' }))).toBe('nsis')
    expect(detectUpdateTarget(probe({ platform: 'darwin' }))).toBe('macos')
  })

  it('is snap when SNAP is set, before any marker is consulted', () => {
    // A snap carries no package-type marker, so this ordering changes no answer. It is what makes
    // the snap a named case with its own sentence rather than the leftover that falls through to
    // "unknown".
    const readPackageType = vi.fn().mockReturnValue(null)
    expect(detectUpdateTarget(probe({ env: { SNAP: '/snap/encore/12' }, readPackageType }))).toBe(
      'snap'
    )
  })

  it('is deb when the marker says deb', () => {
    expect(detectUpdateTarget(probe({ readPackageType: () => 'deb' }))).toBe('deb')
  })

  it('is appimage when the AppImage runtime named the running image', () => {
    expect(detectUpdateTarget(probe({ env: { APPIMAGE: '/home/u/encore-0.1.0.AppImage' } }))).toBe(
      'appimage'
    )
  })

  it('prefers the deb marker over an APPIMAGE left in the environment', () => {
    // The two never co-occur in a real install, but an AppImage that launched a .deb-installed
    // Encore would pass its own APPIMAGE down. The marker is the authority, exactly as it is for
    // electron-updater, which swaps in DebUpdater before AppImageUpdater ever reads the variable.
    expect(
      detectUpdateTarget(
        probe({ env: { APPIMAGE: '/tmp/other.AppImage' }, readPackageType: () => 'deb' })
      )
    ).toBe('deb')
  })

  it('refuses to claim a format Encore does not publish', () => {
    // electron-updater would hand an rpm or pacman install to RpmUpdater or PacmanUpdater, and
    // those would look for files no Encore release contains. Better to say nothing is known than
    // to offer a download that can only fail at the last step.
    for (const marker of ['rpm', 'pacman', 'freebsd', '']) {
      expect(detectUpdateTarget(probe({ readPackageType: () => marker }))).toBe('unknown')
    }
  })

  it('is unknown for a packaged Linux build that is none of the three', () => {
    expect(detectUpdateTarget(probe())).toBe('unknown')
  })

  it('is unknown on a platform Encore has never been built for', () => {
    expect(detectUpdateTarget(probe({ platform: 'freebsd' }))).toBe('unknown')
  })
})

const ALL: UpdateTarget[] = ['nsis', 'appimage', 'deb', 'snap', 'macos', 'unpackaged', 'unknown']

describe('targetCapability', () => {
  it('gives every target a sentence', () => {
    // The note is the whole answer on a target with no button, so an empty one would leave a
    // panel with nothing in it and no reason why.
    for (const target of ALL) {
      const { note } = targetCapability(target)
      expect(note.trim(), `${target} has no note`).not.toBe('')
      expect(note.endsWith('.'), `${target}'s note is not a sentence`).toBe(true)
    }
  })

  it('lets exactly the three targets electron-updater can replace apply an update', () => {
    expect(ALL.filter((t) => targetCapability(t).canApply)).toStrictEqual([
      'nsis',
      'appimage',
      'deb'
    ])
  })

  it('warns about the password prompt on the deb before anything is downloaded', () => {
    // DebUpdater shells out to dpkg or apt through pkexec/sudo, so the prompt is unavoidable and
    // arrives at the end of a download the user has already waited through. Saying so up front is
    // the difference between an expected prompt and one that reads as a failure.
    const { note } = targetCapability('deb')
    expect(note).toMatch(/administrator rights/i)
    expect(note).toMatch(/password/i)
    // And that apt can still refuse it, which is the one outcome Encore cannot do anything about.
    expect(note).toMatch(/releases page/i)
  })

  it('sends a snap user to the snap store rather than offering to do it', () => {
    const { canApply, note } = targetCapability('snap')
    expect(canApply).toBe(false)
    expect(note).toMatch(/snap refresh encore/)
  })
})
