import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Inspects what a real `electron-builder --linux dir` actually put in app.asar, rather than what
// electron-builder.yml says it should have. That distinction is the whole point of this file.
//
// `test/electron-builder-files.test.ts` asserted the *shape* of the config (no top-level `files`
// key, three platform lists in agreement, `.env` excluded), and every one of those assertions was
// green while the archive shipped 395 files the config meant to exclude: 355 of them three stale
// git worktrees nested inside the project (3.00 MiB, 253 of those under a nested `src/`), the rest
// documentation, tests, tool directories, `vitest.config.ts` and a dependency's `.env`. The
// `.env` assertion is the sharpest of them: it passed, and `node_modules/bottleneck/.env` shipped
// anyway, because the pattern it checked for was anchored at the project root. A config can be
// well-formed, self-consistent, and still wrong about the world. Only the archive knows.
//
// WHAT THIS FILE DOES NOT DO: it does not build. `npx electron-builder --linux dir` takes minutes,
// and a test that spent minutes on every `npm run test` would be deleted within the month. Note
// that it would also have to run `npm run build` first, because electron-builder packages
// whatever stale bundle is sitting in `out/` and does not build one itself. So these tests run
// only when someone has already produced the artifact, and are SKIPPED otherwise. The skip is
// declared in the suite name so a green run cannot be mistaken for a verified one.
//
// A STALE artifact is skipped too, and for the same reason. `dist/` outlives the code it was built
// from, so the failure mode this file most plausibly develops is not "never ran" but "kept passing
// against an archive from three commits ago", which reads as verification and is not. The
// freshness test is the archive's mtime against out/main/index.js, the bundle it should contain.
//
// The always-on half of the guard lives in `test/electron-builder-files.test.ts`, which evaluates
// the real glob patterns against a synthetic file list on every run. That catches the same class
// of regression from the config side in milliseconds; this file is what confirms the config and
// reality still agree. Run it before cutting a release:
//
//     npm run build && npx electron-builder --linux dir && npm run test
//
// Linux-specific on purpose: it reads dist/linux-unpacked, and its better-sqlite3 assertions name
// the prebuild family a Linux target keeps. Linux is the only target that has ever been built.

const ASAR = fileURLToPath(new URL('../dist/linux-unpacked/resources/app.asar', import.meta.url))
const MAIN_BUNDLE = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

/** True only for an archive that exists and is at least as new as the bundle it should contain. */
const BUILT =
  existsSync(ASAR) &&
  existsSync(MAIN_BUNDLE) &&
  statSync(ASAR).mtimeMs >= statSync(MAIN_BUNDLE).mtimeMs

/** One file inside the archive: an absolute-from-archive-root path and its byte size. */
interface Entry {
  path: string
  size: number
}

interface HeaderNode {
  files?: Record<string, HeaderNode>
  size?: number
}

/**
 * Every file in the archive, read out of the asar header.
 *
 * The header is a Chromium Pickle followed by JSON. Four little-endian uint32s precede it and only
 * the last is needed: [0]=4, the size of the field that follows; [4] and [8] are the pickle's own
 * framing; [12] is the byte length of the JSON, which starts at offset 16.
 *
 * Entries carrying `unpacked: true` still appear here, even though electron-builder moves every
 * *.node out to app.asar.unpacked. So this is the app's complete logical file tree and not just
 * the packed part of it. Verified against the better-sqlite3 prebuilds, which live on disk in
 * app.asar.unpacked and are listed here.
 */
function readEntries(asarPath: string): Entry[] {
  const buf = readFileSync(asarPath)
  const header = JSON.parse(
    buf.subarray(16, 16 + buf.readUInt32LE(12)).toString('utf8')
  ) as HeaderNode

  const entries: Entry[] = []
  const walk = (node: HeaderNode, prefix: string): void => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`
      if (child.files == null) entries.push({ path, size: child.size ?? 0 })
      else walk(child, path)
    }
  }
  walk(header, '')
  return entries
}

/**
 * The only things the app needs at runtime, and therefore the only top-level names permitted.
 *
 * `out` is electron-vite's bundle; `resources` holds icon.png, which the main bundle reaches by
 * path; `package.json` gives Electron `main` and `name`; `node_modules` is copied by a matcher of
 * its own that ignores the allow-list entirely. Anything else appearing here is something that
 * leaked out of the project directory.
 */
const ALLOWED_TOP_LEVEL = ['node_modules', 'out', 'package.json', 'resources']

// Skipping is spelled out in the suite name because a suite called "the asar contains no source"
// that quietly reports nothing is worse than having no suite at all.
describe.skipIf(!BUILT)(
  'packaged app.asar contents (skipped unless dist/linux-unpacked/ exists and is newer than out/)',
  () => {
    const entries = BUILT ? readEntries(ASAR) : []
    const paths = entries.map((entry) => entry.path)
    const outsideNodeModules = paths.filter((path) => !path.startsWith('/node_modules/'))

    it('has no top-level entry beyond the four the app actually loads', () => {
      const top = [...new Set(paths.map((path) => path.split('/')[1]))].sort()
      expect(
        top,
        'something outside the electron-builder.yml allow-list reached app.asar'
      ).toStrictEqual(ALLOWED_TOP_LEVEL)
    })

    // The regression this file was written for. `!src/*` anchored at the project root, so nested
    // copies of the tree (nested git worktrees, in this case) walked straight past it and
    // shipped source at whatever commit the working copy happened to be on at build time.
    // Asserted separately from the top-level check above because the two fail differently: that
    // one names the stray directory, this one names the thing that makes it serious.
    it('ships no first-party source: no src/ segment, no .ts or .svelte, outside node_modules', () => {
      const source = outsideNodeModules.filter(
        (path) => path.includes('/src/') || /\.(ts|tsx|svelte)$/.test(path)
      )
      expect(source, 'application source code is inside the shipped archive').toStrictEqual([])
    })

    it('ships no tooling, docs, test or config directories', () => {
      const internal = outsideNodeModules.filter((path) =>
        /^\/(\.worktrees|\.tooling|\.vscode|docs|test|build)\//.test(path)
      )
      expect(internal, 'internal planning docs or test fixtures are shipped').toStrictEqual([])
    })

    // node_modules/bottleneck/.env really did ship in every build before the exclusion grew its
    // `**/` anchor: the old rule was root-anchored and never looked inside a dependency. Its
    // contents were placeholder REDIS_HOST/REDIS_PORT lines rather than a real credential, which
    // is luck, not design.
    it('ships no .env, .npmrc or .vscode, anywhere, including inside dependencies', () => {
      const strays = paths.filter((path) => /\/(\.env(\..*)?|\.npmrc)$|\/\.vscode\//.test(path))
      expect(strays).toStrictEqual([])
    })

    // An allow-list fails closed: the risk it trades for is dropping something needed, which shows
    // up as a blank window or a crash on launch rather than as a diff. These are the four paths
    // the startup path touches, so a mistake in the allow-list is caught here and not by a user.
    it('still ships everything the app loads at startup', () => {
      for (const required of [
        '/package.json',
        '/out/main/index.js',
        '/out/preload/index.js',
        '/out/renderer/index.html',
        '/resources/icon.png'
      ]) {
        expect(paths, `${required} is missing from app.asar`).toContain(required)
      }
    })

    // The other half of the exclusion list, which the allow-list cannot express: node_modules is
    // copied by getNodeModuleFileMatcher, which keeps only patterns starting with "!".
    it('drops the better-sqlite3 sources and foreign prebuilds', () => {
      expect(paths.filter((path) => path.includes('/better-sqlite3/deps/'))).toStrictEqual([])

      const prebuilds = paths
        .filter((path) => path.includes('/better-sqlite3/prebuilds/'))
        .map((path) => path.split('/').at(-1))
        .sort()
      expect(
        prebuilds,
        'a Linux build should keep only the two glibc-Linux prebuilds; ' +
          'lib/binding.js resolves exactly one of them at runtime'
      ).toStrictEqual(['linux-arm64.node', 'linux-x64.node'])
    })
  }
)
