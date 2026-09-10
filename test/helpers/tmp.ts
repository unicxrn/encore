import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The env var carrying the per-run parent directory from the Vitest main process into the test
 * workers. Vitest spawns workers after `globalSetup` has run, and they inherit `process.env` at
 * spawn time, so assigning it in `setup()` below is enough to reach every worker, without any
 * `provide()` plumbing.
 */
const ROOT_ENV = 'ENCORE_TEST_TMP'

/**
 * Create a scratch directory that the suite cannot forget to delete.
 *
 * Every one of these used to be `mkdtempSync(join(tmpdir(), 'encore-thing-'))` written straight
 * into the system temp directory, and nothing ever removed them. On a machine where /tmp is a
 * 16 GB tmpfs shared with other work that is not a tidiness problem: a leftover count in the
 * hundred-thousands filled the filesystem, and the resulting write failures surfaced as
 * `UNKNOWN: unknown error, write` in tests that had nothing to do with the ones leaking.
 *
 * The fix is placement, not bookkeeping. Directories are made inside one per-run parent that
 * `teardown()` removes wholesale, so no call site has to register a cleanup and no cleanup can be
 * omitted by a test that throws, times out, or is skipped mid-flight. Two properties follow that
 * an `afterEach`-registration helper would not have given us:
 *
 *   - Nothing is deleted while the run is in progress. Several tests here deliberately look at a
 *     directory after the code under test has moved or emptied it (sng-asset's replace path,
 *     art-cache's temp-file probes), and per-test cleanup would have had to be reasoned about at
 *     every one of those sites. Deferring all removal to the end of the run cannot affect them.
 *   - A crashed or killed run leaks exactly one directory instead of several hundred, and the
 *     next run's leftovers are trivially distinguishable from live ones.
 *
 * `prefix` is a short tag for the test, not a path: `tmpDir('walk')` yields `<parent>/walk-XXXXXX`.
 * It only exists to make a directory identifiable while debugging a failure.
 */
export function tmpDir(prefix: string): string {
  const root = process.env[ROOT_ENV]
  if (root === undefined) {
    // Reaching this means the directory would land straight in the system temp with nothing
    // arranged to remove it, which is the exact bug this helper exists to close. Failing loudly
    // is the only option that cannot leak: silently falling back to `tmpdir()` would restore the
    // old behaviour for whichever runner missed the config, and hide it.
    throw new Error(
      `${ROOT_ENV} is not set, so test temp directories have nowhere to go. This helper needs the ` +
        `globalSetup in vitest.config.ts to have run; a runner that bypasses that config cannot ` +
        `use tmpDir().`
    )
  }
  return mkdtempSync(join(root, `${prefix}-`))
}

/**
 * Grant the owner write+execute on every directory under `dir`, so a following remove can descend.
 *
 * Only ever called after a removal has already failed. Tests that drop a directory to a read-only
 * mode to exercise a write failure (`art-cache.test.ts` uses 0o500) restore it in a `finally`, so
 * the normal path never needs this. But a test killed between the chmod and the restore would
 * otherwise wedge cleanup permanently, turning the leak fix into a new source of red runs.
 *
 * Non-directories are left alone deliberately: `issues.test.ts` and `scanner.test.ts` chmod
 * *files* to 0o000, and unlinking those only needs write permission on the parent directory, which
 * the recursion below has already restored by the time the entry is reached.
 */
function forceWritable(dir: string): void {
  let entries: string[]
  try {
    chmodSync(dir, 0o700)
    entries = readdirSync(dir)
  } catch {
    // Unreadable even after the chmod (a mount point, someone else's file). Nothing further to
    // try here; the caller's retry will report the real error.
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    try {
      // lstat, not stat: a symlink to a directory must not be followed, or a fixture that links
      // outside the parent (scanner.test.ts links to the repo's checked-in fixture library) would
      // have its target chmodded.
      if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true) forceWritable(path)
    } catch {
      // Broken link or a race with the test process; the retry will surface anything that matters.
    }
  }
}

/**
 * Where the per-run parent lives. Under `node_modules` by default, not `os.tmpdir()`.
 *
 * On this machine `/tmp` is a tmpfs with a per-user quota, and any other process filling it
 * turns the whole suite red with `EDQUOT` in places that have nothing to do with the change
 * under test (239 failures were measured from one such fill). `node_modules` is already ignored
 * by git and prettier, sits on the large home volume, and is removed wholesale by `teardown`,
 * so nothing about the leak guarantee changes; only the disk the scratch lands on.
 *
 * `ENCORE_TEST_TMP` overrides it for a CI runner or a machine where `node_modules` is read-only.
 */
function runParent(): string {
  const override = process.env.ENCORE_TEST_TMP
  if (override !== undefined && override !== '') return override
  return fileURLToPath(new URL('../../node_modules/.encore-tests', import.meta.url))
}

/** Vitest `globalSetup`: open the parent directory that every `tmpDir()` call writes into. */
export function setup(): void {
  const parent = runParent()
  mkdirSync(parent, { recursive: true })
  process.env[ROOT_ENV] = mkdtempSync(join(parent, 'encore-tests-'))
}

/** Vitest `globalSetup` teardown: drop the whole parent, and everything the run put in it. */
export function teardown(): void {
  const root = process.env[ROOT_ENV]
  if (root === undefined) return
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // `force` covers ENOENT, not EACCES: a directory left non-writable by an interrupted test
    // blocks the descent. Repair the modes and retry once. Still best-effort: a failure to
    // clean up must not fail an otherwise green run, and leaks one directory, not hundreds.
    try {
      forceWritable(root)
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* empty */
    }
  }
}
