import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FixBackup } from '../../../../main/issues/backup-store'
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

function stubEncore(over: Record<string, unknown> = {}): void {
  vi.stubGlobal('encore', {
    settingsGet: () => Promise.resolve({ libraryFolders: [] }),
    sidecarStatus: () => Promise.resolve(SIDECAR),
    backupsList: (): Promise<{ backups: FixBackup[]; totalBytes: number }> =>
      Promise.resolve({ backups: [], totalBytes: 0 }),
    backupsClear: () => Promise.resolve(),
    ...over
  })
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
