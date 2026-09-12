import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * The library containment check lives in its own module, below every writer.
 *
 * It used to sit in `write.ts`, which made `write.ts` and `sng-asset.ts` import each other, a
 * cycle that only resolved because both sides were hoisted function declarations. The first
 * module-level initializer added to either file would have made it load-order-sensitive. Nothing
 * here imports a writer, so the guard cannot be dragged back into a cycle.
 */

/**
 * Resolve a path to its canonical form even when the tail does not exist yet:
 * realpath the deepest existing ancestor (following symlinks), then re-append
 * the non-existent remainder. `..` segments are collapsed by resolve() first,
 * so they cannot survive into the comparison.
 *
 * Exported because the per-chart write lock (`write.ts`) keys on it: two spellings of one
 * chart (a relative path, a `..` detour, a symlinked library folder) must hash to one lock
 * or the lock does not serialise the writes it exists to serialise. Same reason the guard
 * canonicalizes before comparing, applied to a different question about the same path.
 */
export function canonicalize(path: string): string {
  let existing = resolve(path)
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return join(existing, ...missing) // hit the root
    missing.unshift(basename(existing))
    existing = parent
  }
  return join(realpathSync(existing), ...missing)
}

/** Separator-safe containment: `/lib-evil` is not under `/lib`. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Whether the canonicalized target lives inside one of the configured library folders.
 *
 * The question `assertUnderLibrary` asks, without the answer it gives. Split out for the one
 * caller that is not a write: `chart:reveal` hands a path to the system file manager, and it has
 * to refuse the same paths for the same reason while saying so in words that are true. "Refusing
 * to write" on a call that was never going to write is the kind of sentence that sends a user
 * looking for damage that did not happen.
 */
export function isUnderLibrary(targetPath: string, libraryFolders: { path: string }[]): boolean {
  const target = canonicalize(targetPath)
  return libraryFolders.some((f) => isUnder(target, canonicalize(f.path)))
}

/**
 * Throws unless the canonicalized target lives inside one of the configured
 * library folders. Every asset writer MUST call this before touching disk:
 * it is the single guard between renderer-supplied paths and the filesystem.
 */
export function assertUnderLibrary(targetPath: string, libraryFolders: { path: string }[]): void {
  if (!isUnderLibrary(targetPath, libraryFolders)) {
    throw new Error(`Refusing to write outside the library folders: ${targetPath}`)
  }
}
