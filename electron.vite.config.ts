import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import pkg from './package.json'

/**
 * The directory that actually holds the installed packages, found by asking Node where
 * one of them is rather than assuming `./node_modules`. In a plain checkout that is
 * `<repo>/node_modules`; in a git worktree — which carries no node_modules of its own and
 * resolves up to the main checkout — it is the main checkout's. See `server.fs.allow`.
 */
const require = createRequire(import.meta.url)
const installedPackagesDir = path.resolve(
  require.resolve('@fontsource/archivo/package.json'),
  '../../..'
)

/**
 * package.json is the single source of truth for the app version — injected into every
 * bundle so `APP_VERSION` in src/shared/constants.ts can't drift from it. Mirrored in
 * vitest.config.ts, which builds the same modules outside electron-vite.
 */
const define = { __APP_VERSION__: JSON.stringify(pkg.version) }

export default defineConfig({
  main: { define },
  preload: { define },
  renderer: {
    define,
    plugins: [svelte()],
    /**
     * Vite's dev server only serves files beneath its own root, and the UI typefaces come
     * in through `@fontsource/*` imports resolved out of node_modules. In a plain checkout
     * those are the same tree and this changes nothing.
     *
     * In a git worktree they are not. A worktree carries no node_modules of its own and
     * resolves up to the main checkout, which sits outside the allow list — so every face
     * 404s with "outside of Vite serving allow list" and the whole UI renders in
     * `system-ui` instead of Archivo/JetBrains Mono. Measured before this existed: all 24
     * registered faces reported `status: error`, and `Archivo` measured to the pixel
     * against a deliberately nonexistent family — i.e. it was never being used.
     *
     * It fails silently, because a font fallback is not an error: nothing looks broken,
     * it simply isn't the typeface the app is designed in. That is worth pinning in config
     * rather than rediscovering.
     *
     * Vite's own default here is `searchForWorkspaceRoot()`, which does NOT solve this:
     * it walks up for a lockfile and this repo commits `package-lock.json`, so inside a
     * worktree it stops at the worktree — the one directory already allowed. Hence
     * resolving the package location directly above.
     *
     * Dev-server only. The production build inlines these faces and never reads `server`.
     */
    server: { fs: { allow: [process.cwd(), installedPackagesDir] } }
  }
})
