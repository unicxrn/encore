import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus } from '../../../../shared/app-update'
import type { FixBackup } from '../../../../main/issues/backup-store'
import { appUpdate } from '../stores/app-update'
import { closeWhatsNew, whatsNew } from '../stores/whats-new'
import { APP_VERSION } from '../../../../shared/constants'
import { finishTour, tourOpen } from '../stores/tour'
import Settings from './Settings.svelte'

/**
 * The Settings tab's undo-history panel.
 *
 * jsdom applies no CSS and computes no layout, so nothing here says anything about how the panel
 * looks or where it sits; that is desktop QA. What it does pin down is the behaviour that keeps
 * "we keep backups forever" honest: the cost is stated, the control that reclaims it exists, and
 * it takes two presses because it is the one action in Encore that makes a completed repair
 * permanent.
 */

const SIDECAR = { installed: false, version: null, path: '/s/bin' }

const APPIMAGE_STATUS: AppUpdateStatus = {
  currentVersion: '0.1.0',
  target: 'appimage',
  canApply: true,
  note: 'Encore downloads the new AppImage and replaces this one when you restart.',
  state: { kind: 'idle' }
}

function stubEncore(over: Record<string, unknown> = {}): void {
  vi.stubGlobal('encore', {
    settingsGet: () => Promise.resolve({ libraryFolders: [] }),
    sidecarStatus: () => Promise.resolve(SIDECAR),
    backupsList: (): Promise<{ backups: FixBackup[]; totalBytes: number }> =>
      Promise.resolve({ backups: [], totalBytes: 0 }),
    backupsClear: () => Promise.resolve(),
    appUpdateStatus: () => Promise.resolve(APPIMAGE_STATUS),
    appUpdateCheck: () => Promise.resolve(APPIMAGE_STATUS),
    appUpdateDownload: () => Promise.resolve(APPIMAGE_STATUS),
    appUpdateInstall: () => Promise.resolve(false),
    ...over
  })
}

/**
 * Put the store where main would have put it, and render.
 *
 * The panel reads main's state rather than owning one, so this is how every state below is set
 * up: the component's job is to draw what it is given, and nothing here should be reachable only
 * by driving it through a real check.
 */
function renderWith(status: AppUpdateStatus, over: Record<string, unknown> = {}): void {
  stubEncore({ appUpdateStatus: () => Promise.resolve(status), ...over })
  render(Settings)
  appUpdate.set(status)
}

function backupFor(id: string): FixBackup {
  return {
    id,
    createdAt: 1_700_000_000_000,
    chartPath: '/library/Rush - YYZ',
    chartType: 'folder',
    code: 'badVideo',
    actionCode: 'badVideo',
    describe: 'Convert video.mp4 to video.webm and remove video.mp4.',
    chartHash: 'abc123',
    files: [{ fileName: 'video.mp4', blob: '0.bin', byteLength: 1_500_000, sha256: 'aa' }],
    remove: ['video.webm'],
    metadata: [],
    guard: { chartType: 'folder', files: [] },
    sizeBytes: 1_500_000
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  appUpdate.set(null)
  closeWhatsNew()
})

/**
 * The sidecar rows' third state.
 *
 * `installed` and `version` are separate answers, and a binary that is on disk but did not answer
 * the version probe (non-zero exit, no output, or killed for running past the probe's timeout)
 * is both installed and version-less. That used to render as NOT INSTALLED, beside an Update
 * button that only exists because it is installed.
 *
 * jsdom applies no CSS, so this says nothing about where the line sits or how it reads next to
 * the row; it pins the text and which button is offered.
 */
describe('Settings: sidecar version states', () => {
  const statusFor = (over: Record<string, unknown>): Record<string, unknown> => ({
    installed: true,
    version: null,
    path: '/s/bin',
    ...over
  })

  it('names an installed tool that did not answer the version probe', async () => {
    stubEncore({
      sidecarStatus: (name: string) =>
        Promise.resolve(statusFor(name === 'ytdlp' ? {} : { version: 'ffmpeg version 6.1' }))
    })
    render(Settings)

    expect(await screen.findAllByText('VERSION UNKNOWN')).toHaveLength(1)
    // Still installed, so the button that acts on an installed tool is the one offered.
    expect(screen.queryByRole('button', { name: 'Install yt-dlp' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Update yt-dlp' })).toBeTruthy()
  })

  it('still says NOT INSTALLED when the file is genuinely absent', async () => {
    stubEncore({ sidecarStatus: () => Promise.resolve(statusFor({ installed: false })) })
    render(Settings)

    expect(await screen.findAllByText('NOT INSTALLED')).toHaveLength(2)
    expect(screen.queryByText('VERSION UNKNOWN')).toBeNull()
  })
})

describe('Settings: undo history', () => {
  it('says there is nothing to undo, and offers no button, on a fresh install', async () => {
    stubEncore()
    render(Settings)

    expect(await screen.findByText('NOTHING TO UNDO')).toBeTruthy()
    // A Clear button over an empty store is a control that can only disappoint.
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('states what the history costs, in the same units the Issues tab uses', async () => {
    stubEncore({
      backupsList: () =>
        Promise.resolve({
          backups: [backupFor('a'), backupFor('b')],
          totalBytes: 3_000_000
        })
    })
    render(Settings)

    expect(await screen.findByText('2 UNDOABLE · 2.9 MB')).toBeTruthy()
  })

  it('needs a second press, on a button that says what it will do, before it deletes anything', async () => {
    const clear = vi.fn(() => Promise.resolve())
    stubEncore({
      backupsList: vi
        .fn()
        .mockResolvedValueOnce({ backups: [backupFor('a')], totalBytes: 1_500_000 })
        .mockResolvedValue({ backups: [], totalBytes: 0 }),
      backupsClear: clear
    })
    render(Settings)

    await fireEvent.click(await screen.findByRole('button', { name: 'Clear' }))

    // Armed, not fired: the label is the confirmation, and it names the consequence rather than
    // asking "are you sure?".
    expect(clear).not.toHaveBeenCalled()
    const armed = screen.getByRole('button', { name: 'Delete them permanently' })

    await fireEvent.click(armed)

    expect(clear).toHaveBeenCalledTimes(1)
    // And the panel re-reads the store rather than assuming it emptied.
    await waitFor(() => {
      expect(screen.getByText('NOTHING TO UNDO')).toBeTruthy()
    })
  })

  it('offers Clear over a store holding bytes it cannot undo', async () => {
    // A backup interrupted between its files and its manifest is not undoable and is not listed,
    // and the ones most likely to be interrupted are the large ones. A button keyed on the count
    // would leave a gigabyte with no way to reclaim it.
    stubEncore({ backupsList: () => Promise.resolve({ backups: [], totalBytes: 50_000_000 }) })
    render(Settings)

    expect(await screen.findByText('0 UNDOABLE · 48 MB')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
  })

  it('shows no Clear button when the store could not be listed', async () => {
    // An unknown store is not an empty one. Offering to clear something whose contents could not
    // be read is the one case where the button is actively dangerous.
    stubEncore({ backupsList: () => Promise.reject(new Error('no ipc')) })
    render(Settings)

    expect(await screen.findByText('NOTHING TO UNDO')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })
})

describe('Settings: welcome tour', () => {
  it('can bring the tour back for someone who skipped it', async () => {
    stubEncore({ settingsSet: () => Promise.resolve() })
    render(Settings)

    await fireEvent.click(screen.getByRole('button', { name: 'Show the welcome tour again' }))

    expect(get(tourOpen)).toBe(true)
    finishTour()
  })
})

/**
 * The Updates row.
 *
 * Nothing an updater does can be exercised here, and nothing tries to. What these pin down is
 * the promise the row makes: that it never says something the state does not support, and that
 * an install which cannot update itself says so instead of showing a button that does nothing.
 * Both of those failures look perfectly fine in a screenshot.
 */
describe('Settings: updating Encore', () => {
  it('offers a check, and names the running version, before anything has been asked', async () => {
    renderWith(APPIMAGE_STATUS)
    expect(await screen.findByRole('button', { name: 'Check for an Encore update' })).toBeTruthy()
    expect(screen.getByText('0.1.0')).toBeTruthy()
  })

  it('shows a placeholder rather than a verdict before main has answered', async () => {
    // Not the same as up to date. A panel opened in the first moment of a session is genuinely in
    // this state, and the sidecar rows above it draw the same placeholder for the same reason.
    stubEncore({ appUpdateStatus: () => new Promise<never>(() => {}) })
    render(Settings)
    // Three rows in this panel show a status; the two sidecars are unknown at this point too.
    await waitFor(() => {
      expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    })
    expect(screen.queryByRole('button', { name: 'Check for an Encore update' })).toBeNull()
  })

  it('says it is checking, and does not offer a second press', async () => {
    renderWith({ ...APPIMAGE_STATUS, state: { kind: 'checking' } })
    expect(await screen.findByText('CHECKING…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check for an Encore update' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Checking for an Encore update' })).toHaveProperty(
      'disabled',
      true
    )
  })

  it('says up to date against the version that is running', async () => {
    renderWith({ ...APPIMAGE_STATUS, state: { kind: 'current' } })
    expect(await screen.findByText('0.1.0 · UP TO DATE')).toBeTruthy()
  })

  it('names the version it found, and offers to download that one', async () => {
    renderWith({ ...APPIMAGE_STATUS, state: { kind: 'available', version: '0.2.0' } })
    expect(await screen.findByText('0.2.0 AVAILABLE')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download Encore 0.2.0' })).toBeTruthy()
  })

  it('asks main to download, rather than deciding anything itself', async () => {
    const download = vi.fn().mockResolvedValue({
      ...APPIMAGE_STATUS,
      state: { kind: 'downloading', version: '0.2.0', percent: null }
    })
    renderWith(
      { ...APPIMAGE_STATUS, state: { kind: 'available', version: '0.2.0' } },
      { appUpdateDownload: download }
    )

    await fireEvent.click(await screen.findByRole('button', { name: 'Download Encore 0.2.0' }))

    expect(download).toHaveBeenCalledTimes(1)
  })

  it('shows download progress in the same place the sidecars show theirs', async () => {
    renderWith({
      ...APPIMAGE_STATUS,
      state: { kind: 'downloading', version: '0.2.0', percent: 42 }
    })

    // Twice, exactly as the yt-dlp and ffmpeg rows do it: in the status line, and on the button
    // that has become the in-flight guard. The second one is what stops a user pressing Download
    // again into a job that is already running.
    await waitFor(() => {
      expect(screen.getAllByText('42%')).toHaveLength(2)
    })
    expect(screen.getByRole('button', { name: 'Downloading Encore 0.2.0' })).toHaveProperty(
      'disabled',
      true
    )
  })

  it('says a restart is what applies it, and does not claim it is installed', async () => {
    renderWith({ ...APPIMAGE_STATUS, state: { kind: 'ready', version: '0.2.0' } })

    expect(await screen.findByText('0.2.0 READY')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart Encore to finish the update' })).toBeTruthy()
    expect(
      screen.getByText(
        'The update is downloaded. Encore stays on this version until you restart it.'
      )
    ).toBeTruthy()
  })

  it('prints a failed check where it can be read, not in a console', async () => {
    renderWith({
      ...APPIMAGE_STATUS,
      state: {
        kind: 'error',
        message: 'No release has been published yet, so there is nothing to update to.'
      }
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'No release has been published yet, so there is nothing to update to.'
    )
    // And the row still offers the retry, because the next check may say something different.
    expect(screen.getByRole('button', { name: 'Check for an Encore update' })).toBeTruthy()
  })

  it('offers a snap no button at all, and says where its updates come from', async () => {
    // The failure this replaces is a Check button that calls into an updater which has disabled
    // itself, reports nothing, and leaves the row exactly as it was.
    renderWith({
      currentVersion: '0.1.0',
      target: 'snap',
      canApply: false,
      note: 'This copy came from the Snap Store, which updates it for you. To update it now, run snap refresh encore.',
      state: { kind: 'idle' }
    })

    expect(
      await screen.findByText(
        'This copy came from the Snap Store, which updates it for you. To update it now, run snap refresh encore.'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check for an Encore update' })).toBeNull()
  })

  it('warns the deb about the password prompt before the download, not after it', async () => {
    renderWith({
      currentVersion: '0.1.0',
      target: 'deb',
      canApply: true,
      note: 'Installing the update needs administrator rights, so your system asks for your password. If the package manager refuses it, install the deb from the releases page yourself.',
      state: { kind: 'idle' }
    })

    expect(await screen.findByText(/administrator rights/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check for an Encore update' })).toBeTruthy()
  })
})

/**
 * The two doors into the changelog.
 *
 * Settings does not draw the panel; App does. What these pin down is that both doors exist and
 * that each asks for the right version, because the offered one is the case that can quietly go
 * wrong: a button that opened the changelog on the RUNNING version while a user was deciding
 * whether to download a different one would look right and answer the wrong question.
 */
describe('Settings: what is new', () => {
  it('offers the changelog for the running build at any time', async () => {
    renderWith(APPIMAGE_STATUS)

    await fireEvent.click(
      await screen.findByRole('button', { name: `What's new in Encore ${APP_VERSION}` })
    )

    expect(get(whatsNew)).toEqual({ version: APP_VERSION, offered: false })
  })

  it('offers the notes for a found release before the download, not after it', async () => {
    renderWith({ ...APPIMAGE_STATUS, state: { kind: 'available', version: '0.2.0' } })

    const read = await screen.findByRole('button', { name: 'What is new in Encore 0.2.0' })
    const download = screen.getByRole('button', { name: 'Download Encore 0.2.0' })
    // Reading comes first in the row, because it comes first in the decision.
    expect(read.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await fireEvent.click(read)

    // Flagged as offered: the panel needs to know this is a version the build cannot describe.
    expect(get(whatsNew)).toEqual({ version: '0.2.0', offered: true })
  })

  it('does not offer a release button when there is no release to read about', async () => {
    renderWith({ ...APPIMAGE_STATUS, state: { kind: 'current' } })
    await screen.findByText('0.1.0 · UP TO DATE')
    expect(screen.queryByRole('button', { name: /What is new in Encore/ })).toBeNull()
  })
})
