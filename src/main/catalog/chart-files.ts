import { Dirent, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { extractSngEntries } from '../downloads/sng'
import { VIDEO_RE } from './media-re'

/**
 * Resolve an entry's effective type, following symlinks. Broken links resolve to null.
 * Minimal replica of scanner.ts's unexported entryType helper.
 */
function entryType(dir: string, entry: Dirent): 'dir' | 'file' | null {
  if (entry.isDirectory()) return 'dir'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) {
    try {
      const stat = statSync(join(dir, entry.name))
      if (stat.isDirectory()) return 'dir'
      if (stat.isFile()) return 'file'
    } catch {
      return null
    }
  }
  return null
}

/**
 * Read a chart's files for the in-app preview.
 *
 * Unlike the scan, which reads only what scan-chart parses, this returns real bytes, because
 * the preview plays the audio. Video is still excluded: previews don't render it and it dwarfs
 * everything else in the chart.
 *
 * Errors propagate to the caller; over IPC they surface as a rejected invoke.
 */
export async function readChartFiles(
  path: string,
  chartType: 'folder' | 'sng'
): Promise<{ fileName: string; data: Uint8Array }[]> {
  if (chartType === 'folder') {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => entryType(path, e) === 'file' && !VIDEO_RE.test(e.name))
      .map((e) => ({ fileName: e.name, data: new Uint8Array(readFileSync(join(path, e.name))) }))
  }
  const entries = await extractSngEntries(new Uint8Array(readFileSync(path)))
  return entries.filter((e) => !VIDEO_RE.test(e.fileName))
}
