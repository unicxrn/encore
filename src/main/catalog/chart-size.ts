import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DuplicateCopy, DuplicateReport } from '../../shared/duplicates'

/**
 * Bytes a chart occupies: the file itself for a .sng, the sum of the tree for a folder chart.
 *
 * Null rather than 0 for anything that cannot be read, which covers the chart that has left the
 * disk since the last scan as well as the one behind a permission the user does not have. Zero
 * would be a claim ("this copy is empty, take it") about a directory nobody could open.
 *
 * Apparent size, not blocks: what is summed is `size`, so two copies of one chart report the
 * same number whatever the filesystem has done about sparseness or tail packing underneath. The
 * number is there to be compared between copies, and a figure that moved with the allocator
 * would make identical copies look different for a reason the user could not see.
 */
export function chartSizeOnDisk(path: string): number | null {
  try {
    const stat = statSync(path)
    if (!stat.isDirectory()) return stat.size
    return folderSize(path)
  } catch {
    return null
  }
}

/**
 * Sum of the regular files under `dir`, recursively.
 *
 * `withFileTypes` answers each entry's kind from the directory read itself, which also settles
 * what happens to a symlink: it is neither a file nor a directory here, so it is skipped rather
 * than followed. A chart holding a link into the rest of the library must not report somebody
 * else's bytes as its own.
 */
function folderSize(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) total += folderSize(child)
    else if (entry.isFile()) total += statSync(child).size
  }
  return total
}

/**
 * Fill in `sizeBytes` for the copies in the identical tier, and only those.
 *
 * Kept out of `findDuplicates`, which is two SQL statements and a walk over their rows and does
 * not open, stat or even name a file. Sizing every copy in the report would put a filesystem
 * walk per chart behind a query that currently answers in tens of milliseconds, and the other
 * two tiers have no removal to inform: what they need to say about a copy is on the row already.
 *
 * Bounded by the number of byte-identical copies, which is exactly the number the report has
 * just called spare. `sizeOf` is a parameter so a test can count the calls.
 */
export function withCopySizes(
  report: DuplicateReport,
  sizeOf: (path: string) => number | null = chartSizeOnDisk
): DuplicateReport {
  const sized = (copy: DuplicateCopy): DuplicateCopy => ({ ...copy, sizeBytes: sizeOf(copy.path) })
  return {
    ...report,
    identical: report.identical.map((group) => ({ ...group, copies: group.copies.map(sized) }))
  }
}
