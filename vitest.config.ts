import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import pkg from './package.json'

// Tests load src/shared/constants.ts without going through electron-vite, so the
// build-time version injection has to be mirrored here.
const define = { __APP_VERSION__: JSON.stringify(pkg.version) }

/**
 * Where the installed packages actually live, found by asking Node rather than assuming
 * `./node_modules` — see `server.fs.allow` on the renderer project below, and the matching
 * note in electron.vite.config.ts.
 *
 * Resolved from the setup entry itself rather than the package's `package.json`, which
 * `@testing-library/svelte` does not list in `exports` (ERR_PACKAGE_PATH_NOT_EXPORTED). The
 * resolved path is sliced at its last `node_modules` segment, so this holds however deeply
 * the package is nested.
 */
const require = createRequire(import.meta.url)
const setupEntry = require.resolve('@testing-library/svelte/vitest')
const installedPackagesDir = setupEntry.slice(
  0,
  setupEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + `${path.sep}node_modules`.length
)

export default defineConfig({
  define,
  test: {
    // Opens the single parent directory that `test/helpers/tmp.ts` creates every scratch
    // directory inside, and removes it when the run ends. Root-level rather than per-project so
    // both projects share one parent, and so an interrupted run leaves one directory, not many.
    globalSetup: ['./test/helpers/tmp.ts'],
    projects: [
      {
        define,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['src/**/*.svelte.test.ts'],
          // Vitest's default is 5 s, and two tests here sit inside 10% of it on an idle machine:
          // `sng-read-selective` writing a multi-megabyte entry (5142 ms measured) and
          // `bad-video` repacking one (5544 ms). Both build real multi-MiB fixtures on purpose —
          // the streaming paths they cover only differ from the buffered ones above a megabyte —
          // so they are slow by design, not hanging. On a loaded machine they crossed the line and
          // the suite went red with nothing wrong. Raised rather than shrinking the fixtures,
          // because a fixture small enough to be fast would stop exercising the thing.
          testTimeout: 30_000
        }
      },
      {
        plugins: [svelte({ hot: false })],
        define,
        resolve: { conditions: ['browser'] },
        /**
         * `setupFiles` below resolves into node_modules, and Vitest serves that file through
         * Vite, which only serves what is under its root. In a plain checkout the two are the
         * same tree and this is a no-op; in a git worktree — which has no node_modules of its
         * own and resolves up to the main checkout — it is not, and all 14 renderer test files
         * fail to collect with "Cannot find module .../@testing-library/svelte/src/vitest.js".
         * That is 164 tests silently absent from the run rather than red, which is the worse
         * failure mode: the suite reports green on a smaller suite.
         */
        server: { fs: { allow: [process.cwd(), installedPackagesDir] } },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.svelte.test.ts'],
          // Unmounts each render between tests. @testing-library/svelte only self-registers
          // cleanup when `afterEach` is a global, which it is not here — without this, two
          // renders in one file both stay in the document and getBy* throws "found multiple
          // elements". This entry point is the library's own, and imports its hooks explicitly.
          setupFiles: ['@testing-library/svelte/vitest']
        }
      }
    ]
  }
})
