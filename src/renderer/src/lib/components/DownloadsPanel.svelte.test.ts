import { render } from '@testing-library/svelte'
import { afterEach, describe, expect, it } from 'vitest'
import type { QueuedDownload } from '../../../../shared/schemas'
import { downloads } from '../stores/downloads'
import DownloadsPanel from './DownloadsPanel.svelte'

/**
 * jsdom applies no CSS, so where the panel sits (above the player bar, clear of the runtime
 * error strip) is a claim that rests on screenshots of the running app. What is pinnable is
 * what the panel says: every status the queue can report has a word, and the word is not the
 * enum.
 */

const item = (status: QueuedDownload['status'], percent: number | null = null): QueuedDownload => ({
  md5: `md5-${status}`,
  url: `https://example.invalid/${status}`,
  folderName: `Artist - Song (${status})`,
  status,
  percent,
  message: null,
  finalPath: null
})

afterEach(() => downloads.set([]))

describe('DownloadsPanel', () => {
  it('tells you where downloads come from when nothing is queued', () => {
    const { container } = render(DownloadsPanel, { props: { onclose: () => {} } })
    expect(container.querySelector('.empty')?.textContent).toBe(
      'No downloads yet. Pick charts in Explore and press Download.'
    )
  })

  it('labels every status in words rather than the enum it is stored as', () => {
    downloads.set([
      item('queued'),
      item('running', 42),
      item('done'),
      item('canceled'),
      item('error')
    ])
    const { container } = render(DownloadsPanel, { props: { onclose: () => {} } })
    const labels = [...container.querySelectorAll('.status')].map((el) => el.textContent?.trim())
    expect(labels).toEqual(['Queued', 'Downloading · 42%', 'Done', 'Canceled', 'Failed'])
    // None of the raw enum values reach the screen.
    for (const raw of ['queued', 'running', 'canceled', 'error']) {
      expect(labels).not.toContain(raw)
    }
  })

  it('offers Retry only to a failed item and Cancel only to a live one', () => {
    downloads.set([
      item('queued'),
      item('running', 10),
      item('done'),
      item('canceled'),
      item('error')
    ])
    const { container } = render(DownloadsPanel, { props: { onclose: () => {} } })
    const actions = [...container.querySelectorAll('.item')].map(
      (row) => row.querySelector('button')?.textContent?.trim() ?? null
    )
    expect(actions).toEqual(['Cancel', 'Cancel', null, null, 'Retry'])
  })
})
