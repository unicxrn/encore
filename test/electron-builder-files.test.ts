import { readFileSync } from 'node:fs'
// A deep import into a transitive dependency, on purpose: this is app-builder-lib's own pattern
// compiler, the same code the real build runs. Re-implementing its rules here (in particular
// that a pattern gets a companion `<pattern>/**/*` only when it contains no wildcard) would mean
// testing a copy of the thing instead of the thing, and it is precisely that rule that let the
// last regression through. If a future app-builder-lib moves the module, this import throws and
// the suite goes red; it cannot fail quietly.
import { FileMatcher } from 'app-builder-lib/out/fileMatcher'
import { describe, expect, it } from 'vitest'

// Guards the shape of electron-builder.yml's `files` configuration. The list is written out three
// times, once per platform block, and the temptation to hoist it into one top-level `files` key
// is strong and wrong.
//
// Shape only. These assertions were all green while the archive shipped 355 files it meant to
// exclude, which is why two further suites follow: one evaluating the patterns themselves, and
// `test/app-asar-contents.test.ts` reading a real artifact.
//
// app-builder-lib 26 normalises a top-level `files` array into a single FileSet object, which
// getFileMatchers pushes as a second FileMatcher. As soon as any platform block also declares
// `files`, the platform's matcher takes index 0 and receives electron-builder's default
// exclusions, while the top-level list is left at index 1 holding nothing but negations, where
// AppFileWalker.addAllPatternIfNeed prepends a bare `**/*` to it. That second matcher then walks
// the whole project directory filtered by those negations alone. Measured on this repo:
// app.asar went from 46 MB to 348 MB, with /dist, /.git, /src and /docs inside it. `.env` is on
// the list too, so the same mistake ships credentials, not just bytes.
//
// These assertions are cheap; recognising that regression by eye is not.

const YML = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
const LINES = YML.split('\n')
const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as Record<string, unknown>

const PLATFORMS = ['win', 'mac', 'linux'] as const

// Matches e.g. !**/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*.node
const PREBUILD_RULE = /^!\*\*\/better-sqlite3\/prebuilds\/\{([a-z0-9,]+)\}-\*\.node$/

/** The prebuild families each platform must drop: every one that is not its own. */
const FOREIGN_PREBUILDS: Record<(typeof PLATFORMS)[number], string[]> = {
  win: ['darwin', 'linux', 'linuxmusl'],
  mac: ['linux', 'linuxmusl', 'win32'],
  // linuxmusl is foreign to a glibc Linux build too: Electron's official binaries link against
  // glibc, so no Electron process exists that could load a musl prebuild.
  linux: ['darwin', 'linuxmusl', 'win32']
}

/** The patterns under `  files:` inside a top-level platform block, in order. */
function filesPatterns(platform: string): string[] {
  const start = LINES.indexOf(`${platform}:`)
  expect(start, `electron-builder.yml has no top-level \`${platform}:\` key`).toBeGreaterThan(-1)

  let end = LINES.length
  for (let i = start + 1; i < LINES.length; i++) {
    if (/^\S/.test(LINES[i])) {
      end = i
      break
    }
  }

  const filesAt = LINES.indexOf('  files:', start)
  expect(
    filesAt > -1 && filesAt < end,
    `the \`${platform}:\` block declares no \`files:\` list`
  ).toBe(true)

  const patterns: string[] = []
  for (let i = filesAt + 1; i < end; i++) {
    const line = LINES[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    // Quotes optional: prettier leaves them alone today, but an unquoted entry must not silently
    // truncate the list and leave every assertion below testing a shorter list than exists.
    const item = /^ {4}- (?:'(.*)'|(.+))$/.exec(line)
    if (item == null) break
    patterns.push(item[1] ?? item[2])
  }
  return patterns
}

describe('electron-builder file patterns', () => {
  it('declares no top-level files key', () => {
    const offender = LINES.findIndex((line) => /^files:/.test(line))
    expect(
      offender,
      'a top-level `files:` key silently voids itself once any platform block declares `files:`, ' +
        'and packs the entire project directory, including .git, dist and .env, into app.asar'
    ).toBe(-1)
  })

  it('repeats one identical exclusion list in every platform block', () => {
    const shared = PLATFORMS.map((platform) =>
      filesPatterns(platform).filter((pattern) => !PREBUILD_RULE.test(pattern))
    )
    expect(shared[0].length).toBeGreaterThan(0)
    expect(shared[1]).toStrictEqual(shared[0])
    expect(shared[2]).toStrictEqual(shared[0])
  })

  // The allow-list already keeps a project-root .env out of app.asar: it is not `out`,
  // `resources` or `package.json`. This rule earns its place somewhere else: `files` is read a
  // second time by getNodeModuleFileMatcher, which keeps only the patterns starting with "!" and
  // prepends `**/*`. Every allow-list entry is discarded there, so inside a dependency a
  // `**/`-anchored negation is the only thing standing between a package that ships its own .env
  // and a shipped credential. Losing the `**/` prefix would silently reduce it to the root case
  // the allow-list already covers, which is why the anchor is asserted and not just the name.
  it('keeps a **/-anchored .env exclusion on every platform, for node_modules', () => {
    for (const platform of PLATFORMS) {
      expect(
        filesPatterns(platform).some(
          (pattern) => pattern.startsWith('!**/') && pattern.includes('.env')
        ),
        `the \`${platform}:\` files list would pack a dependency's .env into app.asar`
      ).toBe(true)
    }
  })

  it('drops exactly the better-sqlite3 prebuilds the target cannot use', () => {
    for (const platform of PLATFORMS) {
      const rules = filesPatterns(platform)
        .map((pattern) => PREBUILD_RULE.exec(pattern))
        .filter((match) => match != null)
      expect(rules, `the \`${platform}:\` files list has no prebuild exclusion`).toHaveLength(1)
      expect(rules[0][1].split(',').sort()).toStrictEqual(FOREIGN_PREBUILDS[platform])
    }
  })

  // 10,257,577 bytes of SQLite C amalgamation, measured in app.asar.unpacked before it was
  // excluded. It is node-gyp input, `npmRebuild` is false so node-gyp never runs, and nothing
  // under better-sqlite3/lib references it. Asserted per platform because the shared-list check
  // above only proves the three agree. All three could lose it together.
  it('drops better-sqlite3 deps/ on every platform', () => {
    for (const platform of PLATFORMS) {
      expect(
        filesPatterns(platform),
        `the \`${platform}:\` files list ships better-sqlite3's SQLite C sources`
      ).toContain('!**/better-sqlite3/deps/**')
    }
  })

  // Every pattern that is not a negation, i.e. the allow-list itself. Asserted exactly, because
  // the value of an allow-list is entirely in it being short: one careless `'**/*'` or `'.'` added
  // here restores the deny-list's behaviour without changing a single other line of the config.
  it('allows exactly three roots, on every platform', () => {
    for (const platform of PLATFORMS) {
      const allowed = filesPatterns(platform).filter((pattern) => !pattern.startsWith('!'))
      expect(
        allowed,
        `the \`${platform}:\` files list is no longer a three-entry allow-list`
      ).toStrictEqual(['out', 'resources', 'package.json'])
    }
  })
})

// Runs the linux `files` patterns over a made-up file list using app-builder-lib's own matcher.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. It is not a build and it does not touch an artifact.
// `test/app-asar-contents.test.ts` does that, and only when one has been built. This is the cheap
// half that runs every time, and it is deliberately lopsided:
//
//  - "this path is excluded" is a SOUND conclusion. The model differs from a real build in two
//    ways and both point the same direction. It omits the patterns app-builder-lib injects
//    (`!**/node_modules/**`, `!build`, `!dist`, `!**/{.git,…}`, `!**/*.{d.ts,…}`), which only ever
//    remove files; and it tests each path on its own rather than walking, where AppFileWalker
//    prunes whole subtrees under a rejected directory, which also only removes files. The set
//    computed here is therefore a superset of what really ships, so anything excluded here is
//    excluded there.
//
//  - "this path is included" is NOT a sound conclusion, for exactly the same reasons: a real build
//    may still drop it. Those cases are asserted as a necessary condition (a tripwire for an
//    allow-list edited into uselessness), and the artifact test is what actually confirms them.
//
// Checked against history: the pre-allow-list config, replayed through this same harness, returns
// true for `.worktrees/x/src/main/index.ts`, `docs/`, `test/`, a tool directory and
// `vitest.config.ts`, the five things that were measured in the shipped 44.5 MiB app.asar.
describe('what the linux files patterns would let through (glob evaluation, not a build)', () => {
  /** app-builder-lib compiles patterns relative to the project dir; the root is arbitrary. */
  const ROOT = '/project'

  function linuxFilter(): (relative: string) => boolean {
    const matcher = new FileMatcher(ROOT, '/dest', (pattern: string) => pattern)
    for (const pattern of filesPatterns('linux')) matcher.addPattern(pattern)
    const filter = matcher.createFilter()
    // The walker hands the filter a real Stats; only isDirectory() is consulted, and every path
    // below is a file.
    return (relative) => filter(`${ROOT}/${relative}`, { isDirectory: () => false } as never)
  }

  const EXCLUDED = [
    // The regression, verbatim: nested git worktrees whose src/ trees `!src/*` never saw.
    '.worktrees/wt-a/src/main/index.ts',
    '.worktrees/wt-b/src/renderer/src/lib/components/Assets.svelte',
    '.worktrees/wt-c/electron-builder.yml',
    // A nesting depth nobody has hit yet. An allow-list does not care how deep it goes.
    'some/future/scratch/dir/src/main/index.ts',
    // Everything else that was measured in the shipped archive.
    'docs/milestone-1-plan.md',
    'test/electron-builder-files.test.ts',
    'test/fixtures/library/song/notes.chart',
    'vitest.config.ts',
    '.tooling/project.yml',
    '.tooling/skills/x/config.md',
    // First-party source and build config at the root, which the old list did exclude.
    'src/main/index.ts',
    'src/renderer/src/App.svelte',
    'electron.vite.config.ts',
    'svelte.config.mjs',
    'tsconfig.json',
    'eslint.config.mjs',
    'README.md',
    '.eslintcache',
    '.vscode/settings.json',
    // Directories that do not exist today. This is the case the deny-list could not express:
    // being excluded requires no one to have predicted the name.
    'coverage/lcov-report/index.html',
    'node_modules.bak/anything.js',
    // Credentials, at the root and inside a dependency.
    '.env',
    '.env.production',
    '.npmrc',
    'node_modules/some-package/.env',
    'node_modules/some-package/.npmrc'
  ]

  const INCLUDED = [
    'package.json',
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'out/renderer/assets/archivo-latin-400-normal-Bl602Mgc.woff',
    'resources/icon.png'
  ]

  it.each(EXCLUDED)('excludes %s', (relative) => {
    expect(
      linuxFilter()(relative),
      `${relative} would be packed into app.asar; a real build excludes strictly more, so this ` +
        'is a genuine leak and not a modelling artefact'
    ).toBe(false)
  })

  it.each(INCLUDED)('does not exclude %s (necessary, not sufficient)', (relative) => {
    expect(
      linuxFilter()(relative),
      `${relative} is rejected by the patterns outright, so no build can ship it. The app will ` +
        'not start'
    ).toBe(true)
  })
})

// The second, easily forgotten consumer of the same `files` list.
//
// getNodeModuleFileMatcher builds a matcher from the "!" patterns only and prepends `**/*`, and
// that matcher, not the main one, is what copies node_modules. Allow-list entries are dropped
// there, so this reconstructs it exactly to check the dependency-facing rules still bite.
describe('the node_modules matcher built from the same list', () => {
  const ROOT = '/project'

  function nodeModulesFilter(): (relative: string) => boolean {
    const matcher = new FileMatcher(ROOT, '/dest', (pattern: string) => pattern)
    for (const pattern of filesPatterns('linux')) {
      if (pattern.startsWith('!')) matcher.addPattern(pattern)
    }
    matcher.prependPattern('**/*')
    const filter = matcher.createFilter()
    return (relative) => filter(`${ROOT}/${relative}`, { isDirectory: () => false } as never)
  }

  // Measured against two real archives: without this rule, chart-preview, scan-chart and
  // fluent-ffmpeg put 8 .vscode files into app.asar between them.
  it("drops dependencies' editor settings and .env files", () => {
    const filter = nodeModulesFilter()
    for (const dead of [
      'node_modules/chart-preview/.vscode/settings.json',
      'node_modules/scan-chart/.vscode/extensions.json',
      'node_modules/bottleneck/.env',
      'node_modules/some-package/.npmrc'
    ]) {
      expect(filter(dead), `${dead} has no business inside a shipped app`).toBe(false)
    }
  })

  it('drops better-sqlite3 deps/ and the prebuilds a Linux target cannot load', () => {
    const filter = nodeModulesFilter()
    for (const dead of [
      'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c',
      'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
      'node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node',
      'node_modules/better-sqlite3/prebuilds/win32-x64.node'
    ]) {
      expect(filter(dead), `${dead} is dead weight on every Linux install`).toBe(false)
    }
  })

  it('keeps the prebuild lib/binding.js actually resolves, and the library itself', () => {
    const filter = nodeModulesFilter()
    for (const needed of [
      'node_modules/better-sqlite3/prebuilds/linux-x64.node',
      'node_modules/better-sqlite3/prebuilds/linux-arm64.node',
      'node_modules/better-sqlite3/lib/binding.js',
      'node_modules/zod/index.js'
    ]) {
      expect(
        filter(needed),
        `${needed} is required at runtime; dropping it breaks Database()`
      ).toBe(true)
    }
  })
})

// The identity keys are as destructive to get wrong as the files list, and just as invisible
// until someone launches the packaged app.
describe('packaged app identity', () => {
  it('keeps productName out of package.json', () => {
    // Electron sets app.name from `productName ?? name` in the packaged package.json, and
    // userData is derived from app.name. electron-builder does NOT copy its own productName
    // there, so app.name is "encore" and userData is ~/.config/encore. Adding productName here
    // would move it to ~/.config/Encore, where the user's catalog, settings and art cache are
    // not. That is a silent reset of the app, with the old data stranded under the old path.
    expect(
      Object.hasOwn(PACKAGE_JSON, 'productName'),
      'productName in package.json moves userData from ~/.config/encore to ~/.config/Encore'
    ).toBe(false)
    expect(PACKAGE_JSON.name).toBe('encore')
  })

  it('names the desktop entry, and names it what Electron already calls itself', () => {
    // Electron's browser init calls app.setDesktopName(pkg.desktopName) when the key is present
    // and `${app.name}.desktop` when it is not. Those agree only while this value stays
    // "<name>.desktop"; drift, and StartupWMClass in the installed entry stops matching the
    // running window's app_id, which is the association bug this replaced. desktopName never
    // reaches app.name, so unlike productName it cannot move userData.
    expect(PACKAGE_JSON.desktopName).toBe(`${String(PACKAGE_JSON.name)}.desktop`)
    expect(LINES).toContain('  syncDesktopName: true')
  })

  it('declares a license, so the deb does not ship one that reads "unknown"', () => {
    // FpmTarget passes package.json's `license` straight to fpm's --license; with no field, the
    // deb's control file says "License: unknown", which is not a statement anyone made.
    // GPL-3.0-or-later. Every runtime dependency is MIT, which is GPL-compatible, so nothing in
    // the tree constrained the choice. The LICENSE file has to agree: the deb quotes this field,
    // and a package whose control file and whose bundled text disagree is worse than one that
    // says nothing. The SPDX id is the whole value, so a stray "MIT" here would be a false claim
    // in every deb built from this tree.
    expect(PACKAGE_JSON.license).toBe('GPL-3.0-or-later')
  })
})
