import { writable } from 'svelte/store'
import type { JobProgress } from '../../../../shared/schemas'
import { encore } from './bridge'

export const scanProgress = writable<JobProgress | null>(null)

export function initScan(): () => void {
  return encore().onScanProgress((p) => scanProgress.set(p as JobProgress))
}

export async function startScan(): Promise<void> {
  scanProgress.set(null)
  await encore().catalogScan()
}

/**
 * Ask main to stop the running scan.
 *
 * Resolves once the abort has been fired, which is not the same as the scan having stopped:
 * charts already open finish first. This writes nothing to `scanProgress` on purpose. The
 * terminal `canceled` event is main's to send, and it carries the percent the scan actually
 * reached. Setting a guess here would either erase that number or announce a stop that has not
 * happened yet.
 */
export async function cancelScan(): Promise<void> {
  await encore().catalogScanCancel()
}
