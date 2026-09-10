import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PART_FILE_RE = /^[0-9a-f]{32}\.part$/i
const MAX_PART_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Best-effort cleanup of a library's download staging dir at startup.
 *
 * Keeps part files (md5-keyed resume points) younger than 7 days so downloads
 * killed by a crash or quit can resume across restarts; deletes aged-out parts
 * and any other leftover junk. Never throws, because cleanup must not block
 * startup.
 */
export function sweepTmpDir(tmpDir: string, now: number = Date.now()): void {
  let entries: string[]
  try {
    entries = readdirSync(tmpDir)
  } catch {
    return // Missing or unreadable dir: nothing to sweep.
  }
  for (const name of entries) {
    const fullPath = join(tmpDir, name)
    try {
      if (PART_FILE_RE.test(name) && now - statSync(fullPath).mtimeMs < MAX_PART_AGE_MS) continue
      rmSync(fullPath, { recursive: true, force: true })
    } catch {
      // Skip entries that vanish or resist deletion.
    }
  }
}
