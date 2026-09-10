import { writable } from 'svelte/store'
import type { QueuedDownload } from '../../../../shared/schemas'
import { encore } from './bridge'

export const downloads = writable<QueuedDownload[]>([])

export function initDownloads(): () => void {
  let seeded = false
  const unsub = encore().onDownloadUpdate((items) => {
    seeded = true
    downloads.set(items as QueuedDownload[])
  })
  void encore()
    .downloadList()
    .then((items) => {
      if (!seeded) downloads.set(items)
    })
  return unsub
}
