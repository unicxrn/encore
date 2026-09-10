import { describe, expect, it, vi } from 'vitest'
import type { AppUpdateState, AppUpdateStatus, UpdateTarget } from '../../shared/app-update'
import {
  AppUpdateService,
  describeUpdateError,
  type Updater,
  type UpdaterHandlers
} from './service'

/**
 * The rules around electron-updater, without electron-updater.
 *
 * Nothing here downloads anything or replaces anything, because there is no honest way to unit
 * test code whose last act is to quit the process and run an installer. What is testable is
 * everything Encore decides on top of it: that a check reports rather than acting, that a target
 * which cannot apply an update never reaches the network, that a failure becomes a sentence
 * instead of an exception, and that the three steps stay in order however the buttons are pressed.
 */

class FakeUpdater implements Updater {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn<Updater['checkForUpdates']>().mockResolvedValue({
    isUpdateAvailable: false,
    updateInfo: { version: '0.1.0' }
  })
  downloadUpdate = vi.fn<Updater['downloadUpdate']>().mockResolvedValue(['/tmp/encore.AppImage'])
  quitAndInstall = vi.fn<Updater['quitAndInstall']>()
}

function build(over: { target?: UpdateTarget; updater?: FakeUpdater } = {}): {
  service: AppUpdateService
  updater: FakeUpdater
  states: AppUpdateState[]
  handlers: UpdaterHandlers
} {
  const updater = over.updater ?? new FakeUpdater()
  const states: AppUpdateState[] = []
  let handlers: UpdaterHandlers | null = null
  const service = new AppUpdateService({
    updater,
    target: over.target ?? 'appimage',
    currentVersion: '0.1.0',
    onState: (status: AppUpdateStatus) => states.push(status.state),
    subscribe: (h) => {
      handlers = h
    }
  })
  return { service, updater, states, handlers: handlers! }
}

/** electron-updater's own error shape: a message plus a `code` property, set by `newError`. */
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('AppUpdateService: nothing happens unasked', () => {
  it('turns off automatic downloading and installing on quit', () => {
    // Both default to true in electron-updater, and both are the behaviour this feature was
    // asked not to have: an app that fetches a new binary in the background, and one that runs an
    // installer because the user closed the window.
    const { updater } = build()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('starts idle, having asked nothing', () => {
    const { service, updater } = build()
    expect(service.status().state).toStrictEqual({ kind: 'idle' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('finding an update does not download it', async () => {
    const { service, updater } = build()
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.0' }
    })

    await service.check()

    expect(service.status().state).toStrictEqual({ kind: 'available', version: '0.2.0' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('downloading one does not install it', async () => {
    const { service, updater } = build()
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.0' }
    })

    await service.check()
    await service.download()

    expect(service.status().state).toStrictEqual({ kind: 'ready', version: '0.2.0' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('AppUpdateService: what a check reports', () => {
  it('goes through checking on the way to an answer', async () => {
    const { service, states } = build()
    await service.check()
    expect(states.map((s) => s.kind)).toStrictEqual(['checking', 'current'])
  })

  it('says up to date when the release is the running version', async () => {
    const { service } = build()
    await service.check()
    expect(service.status().state).toStrictEqual({ kind: 'current' })
  })

  it('names the version it found, not the one running', async () => {
    // The row prints this number, and printing the running version beside the word "available"
    // is the one way this display can be actively wrong.
    const { service, updater } = build()
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.4.2' }
    })

    const status = await service.check()

    expect(status.currentVersion).toBe('0.1.0')
    expect(status.state).toStrictEqual({ kind: 'available', version: '1.4.2' })
  })

  it('collapses concurrent checks into one request', async () => {
    // The startup check and a user pressing the button a moment later are the same question.
    // Two requests would also produce two state sequences for one answer.
    const { service, updater } = build()
    let release: (() => void) | null = null
    updater.checkForUpdates.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
      })
    )

    const first = service.check()
    const second = service.check()
    expect(service.status().state).toStrictEqual({ kind: 'checking' })
    release!()
    await Promise.all([first, second])

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('can be checked again after one finished', async () => {
    const { service, updater } = build()
    await service.check()
    await service.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})

describe('AppUpdateService: a failed check', () => {
  it('resolves with an error state rather than rejecting', async () => {
    // The startup check has nobody to catch it. A rejection there is an unhandled rejection in
    // the main process every time a laptop is opened away from a network.
    const { service, updater } = build()
    updater.checkForUpdates.mockRejectedValue(new Error('socket hang up'))

    const status = await service.check()

    expect(status.state).toStrictEqual({ kind: 'error', message: 'socket hang up' })
  })

  it('explains an empty releases page instead of quoting the stack', async () => {
    // Measured, not imagined. This is the error a real check from this app against this
    // repository produced: GitHubProvider reads the releases atom feed, asks XElement for its
    // first `<entry>`, and an empty feed throws from there. Note the code, which is the generic
    // XML one and NOT `ERR_UPDATER_NO_PUBLISHED_VERSIONS`. Matching on the code alone printed
    // the raw string on screen.
    const { service, updater } = build()
    updater.checkForUpdates.mockRejectedValue(
      coded('ERR_XML_MISSED_ELEMENT', 'No published versions on GitHub')
    )

    const status = await service.check()

    expect(status.state).toStrictEqual({
      kind: 'error',
      message: 'No release has been published yet, so there is nothing to update to.'
    })
  })

  it('explains it the same way through the other branch that reports it', async () => {
    // `GitHubProvider.getLatestTagName` raises the dedicated code for the same condition, and
    // `getBaseDownloadPath` raises a third message for a release that exists but has no assets.
    const { service, updater } = build()
    updater.checkForUpdates.mockRejectedValue(
      coded(
        'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
        'Unable to find latest version on GitHub (https://github.com/unicxrn/encore/releases.atom), please ensure a production release exists: Error: 404'
      )
    )

    const status = await service.check()

    expect(status.state).toStrictEqual({
      kind: 'error',
      message: 'No release has been published yet, so there is nothing to update to.'
    })
  })

  it('leaves the service usable, so the button works a second time', async () => {
    const { service, updater } = build()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('socket hang up'))
    await service.check()

    const status = await service.check()

    expect(status.state).toStrictEqual({ kind: 'current' })
  })

  it('reports a check that resolves with nothing, rather than calling it up to date', async () => {
    // isUpdaterActive() returning false after the probe said the target could apply an update is
    // a disagreement between two pieces of Encore, not something the user did. Drawing it as
    // "up to date" would be a lie that never resolves itself.
    const { service, updater } = build()
    updater.checkForUpdates.mockResolvedValue(null)

    const status = await service.check()

    expect(status.state.kind).toBe('error')
  })
})

describe('AppUpdateService: targets that cannot apply an update', () => {
  it('never asks GitHub on a snap', async () => {
    // electron-updater disables itself when SNAP is set, so the request would resolve to nothing
    // at all. The capability sentence is the whole answer.
    const { service, updater, states } = build({ target: 'snap' })

    const status = await service.check()

    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(status.canApply).toBe(false)
    expect(status.note).toMatch(/snap refresh encore/)
    // And it is not an error, so nothing red appears over something that is working correctly.
    expect(status.state).toStrictEqual({ kind: 'idle' })
    expect(states).toStrictEqual([])
  })

  it('never asks GitHub from a dev run', async () => {
    const { service, updater } = build({ target: 'unpackaged' })
    await service.check()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('still answers with a reason on every target that cannot update', async () => {
    for (const target of ['snap', 'macos', 'unpackaged', 'unknown'] as const) {
      const { service } = build({ target })
      const status = await service.check()
      expect(status.canApply, target).toBe(false)
      expect(status.note.trim(), target).not.toBe('')
    }
  })
})

describe('AppUpdateService: downloading', () => {
  /** A service whose last check found 0.2.0, which is the only state `download` acts from. */
  async function readyToDownload(): Promise<ReturnType<typeof build>> {
    const b = build()
    b.updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.0' }
    })
    await b.service.check()
    return b
  }

  it('refuses to download when no check has found anything', async () => {
    const { service, updater } = build()
    await service.download()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(service.status().state).toStrictEqual({ kind: 'idle' })
  })

  it('refuses to download twice', async () => {
    const b = await readyToDownload()
    await b.service.download()
    await b.service.download()
    expect(b.updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('reports percent while it runs, and carries the version through', async () => {
    const b = await readyToDownload()
    let finish: (() => void) | null = null
    b.updater.downloadUpdate.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve([])
      })
    )

    const running = b.service.download()
    expect(b.service.status().state).toStrictEqual({
      kind: 'downloading',
      version: '0.2.0',
      percent: null
    })
    b.handlers.onProgress(41.6)
    expect(b.service.status().state).toStrictEqual({
      kind: 'downloading',
      version: '0.2.0',
      percent: 42
    })
    finish!()
    await running

    expect(b.service.status().state).toStrictEqual({ kind: 'ready', version: '0.2.0' })
  })

  it('ignores progress arriving outside a download', async () => {
    // electron-updater emits from the differential downloader too. A percent landing on `ready`
    // would put the row back into a state it has already left.
    const b = await readyToDownload()
    await b.service.download()

    b.handlers.onProgress(3)

    expect(b.service.status().state).toStrictEqual({ kind: 'ready', version: '0.2.0' })
  })

  it('does not offer a restart when the download failed part way through', async () => {
    // The emitter reports the failure and the promise still resolves. Reporting `ready` here
    // would offer a restart into a file that was never finished.
    const b = await readyToDownload()
    b.updater.downloadUpdate.mockImplementation(() => {
      b.handlers.onError(new Error('ECONNRESET while writing'))
      return Promise.resolve([])
    })

    await b.service.download()

    expect(b.service.status().state.kind).toBe('error')
  })

  it('turns a rejected download into an error state', async () => {
    const b = await readyToDownload()
    b.updater.downloadUpdate.mockRejectedValue(new Error('no space left on device'))

    const status = await b.service.download()

    expect(status.state).toStrictEqual({ kind: 'error', message: 'no space left on device' })
  })
})

describe('AppUpdateService: installing', () => {
  it('refuses unless something is staged', () => {
    const { service, updater } = build()
    expect(service.install()).toBe(false)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('quits and installs once a download has finished', async () => {
    const { service, updater } = build()
    updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '0.2.0' }
    })
    await service.check()
    await service.download()

    expect(service.install()).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})

describe('AppUpdateService: errors from the updater emitter', () => {
  it('does not clobber a finished state', async () => {
    // electron-updater emits `error` as well as rejecting, so one of the two reports usually
    // arrives against a state that has already moved on. A user not waiting on anything should
    // not be shown a red line for it.
    const { service, handlers } = build()
    await service.check()

    handlers.onError(new Error('late'))

    expect(service.status().state).toStrictEqual({ kind: 'current' })
  })
})

describe('describeUpdateError', () => {
  it('turns a network failure into something to do about it', () => {
    expect(describeUpdateError(coded('ENOTFOUND', 'getaddrinfo ENOTFOUND github.com'))).toBe(
      'Could not reach GitHub. Check your connection and try again.'
    )
  })

  it('reads a code out of the message when it is not on the object', () => {
    // `newError` sets the property, but a rejection that has been serialised across a boundary
    // can arrive carrying only the text.
    expect(
      describeUpdateError(new Error('Error: ERR_UPDATER_LATEST_VERSION_NOT_FOUND at Object.<x>'))
    ).toBe('No release has been published yet, so there is nothing to update to.')
  })

  it('keeps an unrecognised message rather than replacing it with a guess', () => {
    expect(describeUpdateError(new Error('sha512 checksum mismatch'))).toBe(
      'sha512 checksum mismatch'
    )
  })

  it('always produces something to print', () => {
    for (const thrown of [new Error(''), '', null, undefined, { nope: 1 }]) {
      expect(describeUpdateError(thrown).trim()).not.toBe('')
    }
  })
})
