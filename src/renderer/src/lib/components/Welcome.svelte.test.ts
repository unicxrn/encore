import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../../../shared/settings-defaults'
import { settings, settingsLoaded } from '../stores/settings'
import { scanProgress } from '../stores/scan'
import Welcome from './Welcome.svelte'

const SONGS = '/home/u/.clonehero/Songs'
const CANDIDATE = { path: SONGS, chartCount: 207, countCapped: false }

type Api = Record<string, ReturnType<typeof vi.fn>>

function stubEncore(over: Api = {}): Api {
  const api: Api = {
    libraryDetect: vi.fn().mockResolvedValue([CANDIDATE]),
    settingsSet: vi.fn().mockResolvedValue(undefined),
    catalogScan: vi.fn().mockResolvedValue(undefined),
    pickFolder: vi.fn().mockResolvedValue(null),
    ...over
  }
  vi.stubGlobal('encore', api)
  return api
}

afterEach(() => {
  vi.unstubAllGlobals()
  // `settings`, `settingsLoaded` and `scanProgress` are module-level writables shared by every
  // test in this file; a folder left behind by one test is a second folder in the next one's
  // settingsSet payload.
  settings.set(defaultSettings())
  settingsLoaded.set(false)
  scanProgress.set(null)
})

describe('Welcome', () => {
  it('offers the detected library by path and chart count', async () => {
    stubEncore()
    render(Welcome, { onNavigate: () => {} })

    expect(await screen.findByText(SONGS)).toBeTruthy()
    expect(screen.getByText('207 charts')).toBeTruthy()
    expect(screen.getByRole('button', { name: /use this folder/i })).toBeTruthy()
  })

  it('offers neither answer until the probe has answered', async () => {
    stubEncore({ libraryDetect: vi.fn().mockReturnValue(new Promise(() => {})) })
    render(Welcome, { onNavigate: () => {} })

    // The way past is there from the first frame; the offer is not, because "here is your
    // library" and "nothing found" contradict each other and the probe has said neither yet.
    expect(await screen.findByRole('button', { name: /explore/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /use this folder/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /choose a folder/i })).toBeNull()
  })

  it('renders a capped count as a floor, never as an exact total', async () => {
    stubEncore({
      libraryDetect: vi
        .fn()
        .mockResolvedValue([{ ...CANDIDATE, chartCount: 1000, countCapped: true }])
    })
    render(Welcome, { onNavigate: () => {} })

    expect(await screen.findByText('1000+ charts')).toBeTruthy()
    expect(screen.queryByText('1000 charts')).toBeNull()
  })

  it('says what the scan will cost before the user starts one', async () => {
    stubEncore()
    render(Welcome, { onNavigate: () => {} })

    // There is no spinner to set the expectation during the scan, so it is set in words before
    // the click. M13 changed what those words may claim: the scan no longer freezes the window,
    // so this asserts on the duration rather than on the old non-response warning.
    const warning = await screen.findByText(/five seconds/i)
    expect(warning.textContent).toMatch(/one-time scan/i)
  })

  it('saves the detected folder and scans it, then hands the view over', async () => {
    const api = stubEncore()
    render(Welcome, { onNavigate: () => {} })

    await fireEvent.click(await screen.findByRole('button', { name: /use this folder/i }))
    await waitFor(() => expect(api.catalogScan).toHaveBeenCalled())

    expect(api.settingsSet).toHaveBeenCalledWith(
      expect.objectContaining({ libraryFolders: [{ path: SONGS, isDefault: true }] })
    )
    // The gate that keeps the welcome on screen reads this store, so the folder landing in it
    // is what leaves the welcome.
    await waitFor(() =>
      expect(get(settings).libraryFolders).toEqual([{ path: SONGS, isDefault: true }])
    )
  })

  it('lets someone with no local library go straight to Explore', async () => {
    const onNavigate = vi.fn()
    const api = stubEncore()
    render(Welcome, { onNavigate })

    await fireEvent.click(await screen.findByRole('button', { name: /explore/i }))

    expect(onNavigate).toHaveBeenCalledWith('browse')
    // Nothing was configured on their behalf, and no folder picker stood in the way.
    expect(api.settingsSet).not.toHaveBeenCalled()
    expect(api.pickFolder).not.toHaveBeenCalled()
  })

  it('falls back to a folder picker when nothing is detected', async () => {
    const api = stubEncore({
      libraryDetect: vi.fn().mockResolvedValue([]),
      pickFolder: vi.fn().mockResolvedValue('/elsewhere/Songs')
    })
    render(Welcome, { onNavigate: () => {} })

    const choose = await screen.findByRole('button', { name: /choose a folder/i })
    expect(screen.queryByRole('button', { name: /use this folder/i })).toBeNull()

    await fireEvent.click(choose)
    await waitFor(() => expect(api.catalogScan).toHaveBeenCalled())
    expect(api.settingsSet).toHaveBeenCalledWith(
      expect.objectContaining({ libraryFolders: [{ path: '/elsewhere/Songs', isDefault: true }] })
    )
  })

  it('offers a detected folder that holds no charts without claiming it has any', async () => {
    stubEncore({
      libraryDetect: vi.fn().mockResolvedValue([{ ...CANDIDATE, chartCount: 0 }])
    })
    render(Welcome, { onNavigate: () => {} })

    // Configuring it is still the right move, since downloads land there, but there is nothing
    // to scan, so quoting a scan duration would be describing work that will not happen.
    expect(await screen.findByText(/no charts in it yet/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /use this folder/i })).toBeTruthy()
    expect(screen.queryByText(/five seconds/i)).toBeNull()
  })
})
