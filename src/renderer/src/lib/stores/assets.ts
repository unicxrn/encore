import { derived, writable } from 'svelte/store'
import type { JobProgress } from '../../../../shared/schemas'
import { encore } from './bridge'

/**
 * Map of jobId → latest JobProgress for all asset jobs.
 * Terminal states (done / error / canceled) are retained so the UI can
 * show the final percent/message after the job finishes.
 */
export const assetJobs = writable<Map<string, JobProgress>>(new Map())

export function initAssets(): () => void {
  return encore().onAssetProgress((raw) => {
    const p = raw as JobProgress
    assetJobs.update((map) => {
      const next = new Map(map)
      next.set(p.jobId, p)
      return next
    })
  })
}

/**
 * Returns true when the given jobId has a running (non-terminal) asset job.
 * Use this to disable Install/Update buttons while a job is in flight to
 * prevent concurrent-install races.
 */
export const isJobRunning = (jobId: string): ReturnType<typeof derived> =>
  derived(assetJobs, ($jobs) => {
    const job = $jobs.get(jobId)
    return job?.status === 'running'
  })
