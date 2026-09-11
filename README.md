<div align="center">

<img src="build/logo/icon-128.png" width="96" alt="">

# Encore

**A desktop app for the Clone Hero library you already have.**

Find what is broken and fix it. Fill in the art, video and lyrics that charts ship without.
Search and download new ones without leaving the app.

[![Electron](https://img.shields.io/badge/Electron-39-2b2e3a?style=flat-square)](https://electronjs.org)
[![Svelte](https://img.shields.io/badge/Svelte-5-ff3e00?style=flat-square)](https://svelte.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square)](https://typescriptlang.org)
[![License](https://img.shields.io/badge/License-GPL--3.0--or--later-8b5cf6?style=flat-square)](LICENSE)

</div>

---

## What it does

Encore reads the chart folders you already have, in both shapes Clone Hero uses: plain folders and
`.sng` archives. Everything below works on either.

|                  |                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Installed**    | Your scanned library, with per-instrument difficulty tiers, album art and a preview player that renders the note highway.                                 |
| **Explore**      | Search the Chorus Encore catalogue as a grid of covers or a dense list. Filter by instrument and difficulty, tick several charts, download them together. |
| **Issues**       | Scan for charting and metadata problems, grouped by severity and exportable as CSV. Four kinds it can repair in place.                                    |
| **Asset Studio** | Add missing album art, background video, backgrounds and synced lyrics, one chart at a time or as a batch.                                                |
| **Downloads**    | A parallel, resumable, cancellable queue with retry.                                                                                                      |

### Repairs that cannot break multiplayer

Clone Hero pairs players by a hash of the chart file's bytes plus a handful of `song.ini` gameplay
keys. Not the video, not the cover, not the album or the year, not the file names.

Every repair re-scans the chart it just wrote and **refuses to report success unless that hash is
byte-identical**. A repair that got this wrong fails loudly instead of quietly making a chart
unplayable with everyone else who has it.

| Issue                             | What the fix does                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `badVideo`                        | Converts `video.mp4`/`.avi`/`.mpeg` to a VP8 + Vorbis `video.webm` and removes the original. |
| `albumArtSize`                    | Re-encodes the cover to exactly 512x512, centre-cropped, same name and format.               |
| `extraValue`                      | Deletes a `diff_*` rating for an instrument the chart does not contain.                      |
| `invalidIni` / `multipleIniFiles` | Removes the `.ini` files Clone Hero is not reading, keeping the one it is.                   |

Two issues that look fixable are deliberately left alone. `multipleChart` would have to delete a
`notes.mid` or `notes.chart`, which is exactly the data the hash covers. `missingValue` cannot be
filled from Chorus, because an exact hash match means Chorus ingested the same upload and its entry
holds the same blanks.

**Every write can be undone.** Repairs, art downloads, background writes and lyrics injection all
record what they replaced before touching anything, and the restore puts the original bytes back.

## Requirements

Nothing, to browse and scan.

**ffmpeg** is needed only to convert a video. Encore uses the one on your `PATH` if it can encode
VP8 and Vorbis, and offers to install its own copy from the row that needs it if not. **yt-dlp** is
needed only to download a video from a URL, and installs the same way.

## Install

Download a build from Releases.

- **Linux.** The `.AppImage` runs anywhere. `chmod +x` it and run it. There is a `.deb` and a
  `.snap` for Debian and Ubuntu. The AppImage ships a statically linked runtime, so it does not
  need `libfuse2` installed the way most AppImages do.
- **Windows.** The `.exe` is a per-user installer and needs no administrator rights. It is not code
  signed, so SmartScreen will warn once. Choose **More info**, then **Run anyway**.

Encore keeps its catalogue, settings and cached art under your platform's app-data directory
(`~/.config/encore` on Linux). Your chart library is only ever read from, except by the repairs and
asset writes you ask for.

### Updates

Encore checks Releases once at startup and whenever you press **Check** in Settings, under
Updates. It never downloads or installs anything on its own: a check tells you a version exists,
and downloading and restarting are two more things you choose.

- **Windows and the AppImage** update in place. Encore fetches the release and applies it when you
  restart.
- **The `.deb`** updates through `dpkg`, so your system asks for your password at the end. If your
  package manager refuses the unsigned package, install the `.deb` from Releases yourself.
- **The `.snap`** cannot be updated by Encore. The Snap Store owns that install; run
  `snap refresh encore` to update it now. Settings says so rather than offering a button.

The changelog is built into the app. Settings, under Updates, opens it at any time, and the first
launch after an update opens it once to show what changed. When a check finds a newer release,
Encore links to that release's notes rather than guessing at them: a build ships the changelog it
was built from and cannot describe one published later.

## Build from source

```bash
npm install
npm run dev          # dev server with HMR, against your real data
npm run dev:isolated # the same, against .dev-userdata/ instead
```

Gates, all of which must pass:

```bash
npm run test         # vitest: a node project and a jsdom renderer project
npm run lint
npm run typecheck    # tsc for main/preload/shared, svelte-check for the renderer
npm run build        # typecheck + electron-vite build into out/
npx prettier --check .
```

Installers:

```bash
npm run build:linux  # AppImage, snap and deb
npm run build:win    # NSIS installer, cross-compiles from Linux through wine
```

If `/tmp` is small, point `TMPDIR` somewhere with room. The `.deb` target stages the whole package
through it and pipes it to `tar -J`, and on a full or quota-limited tmpfs that fails as
`tar failed (exit code 2)`, which reads like a packaging error and is not one.

```bash
TMPDIR="$PWD/.build-tmp" npm run build:linux
```

## How it is put together

```
src/main       Electron main process: the catalogue, the scanner, chart IO, IPC
src/preload    the bridge, one typed surface the renderer may call
src/renderer   Svelte 5 UI, runes throughout
src/shared     types, schemas and text used on both sides of the bridge
test           fixtures and the packaging checks
```

Chart data is kept in SQLite through `better-sqlite3`, with FTS5 for search. Charts are parsed with
`scan-chart` and `.sng` archives with `parse-sng`. A `.sng` write repacks the archive by streaming
byte ranges, so peak memory does not scale with the archive.

## Contributing

Issues and pull requests are welcome.

**Before you open a PR**, run the five gates above. They are the same ones CI would run, and a red
one is the fastest way for a change to stall.

A few conventions that make review quick:

- **Tests come with behaviour.** New behaviour gets a test that fails without it. A test that cannot
  fail is not protecting anything.
- **Comments explain why, not what.** The code already says what it does. A comment that asserts
  something untrue is treated as a defect in review, because the next person will believe it.
- **Measure before you claim.** "Faster", "smaller" and "safe" are all things this project has been
  wrong about until someone put a number on them.
- **Anything touching a chart is guilty until proven innocent.** A user's library has no backup.
  Writes go through the existing locked, verify-before-swap path, and anything that changes a chart
  asserts the multiplayer hash afterwards.
- **The UI has no automated eye.** jsdom applies no CSS and computes no layout, so a visual change
  needs a screenshot or a measurement, and saying which parts were only reasoned about is expected.

Commits are plain prose in the imperative: what changed and why it had to.

### Cutting a release

`CHANGELOG.md` is the source, and everything else is a copy of it. It is written by hand in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style, the renderer bundles it with a
`?raw` import (`src/renderer/src/lib/changelog.ts`), and the GitHub release body is generated out
of it. That direction, and not the other, because the changelog is the one of the two that ships
inside the build: a release body typed into the browser afterwards can never get back into a build
that already exists. What that buys is an app that can show what changed with no network, and a
release page that says the same thing it does.

1. Write the entry, under a `## [x.y.z] - yyyy-mm-dd` heading at the top of `CHANGELOG.md`, with
   the tag link at the foot of the file. Bullets, `###` sections, and backticks for file names.
   No other markdown: the panel renders backticks and text, and `src/shared/changelog.test.ts`
   fails on anything else.
2. Bump `version` in `package.json` to match. `test/release-notes.test.ts` fails if the newest
   changelog entry is not the version about to be built, so a release with no notes cannot be cut
   by accident.
3. Run the five gates, then build the installers.
4. Generate the notes and publish:

   ```bash
   node scripts/release-notes.mjs 0.2.0 > notes.md
   gh release create v0.2.0 --title "Encore 0.2.0" --notes-file notes.md dist/encore-*
   ```

   The script prints the changelog entry followed by the download paragraph, which is packaging
   rather than history and so lives in the script rather than in the changelog.

Users meet the entry in two places: Settings, under Updates, has a button for it at any time, and
the first launch after an update opens it once on its own. `lastSeenVersion` in settings is what
makes that once rather than every launch.

## Licence

[GPL-3.0-or-later](LICENSE).

Fork it, change it, share it. What the licence asks in return is that anything you distribute,
modified or not, comes with its corresponding source under the same terms, so the next person has
the freedoms you had.

**The name and the mark are not covered by it.** "Encore" and the logo belong to unicxrn, and no
licence grants trademark rights. A fork is welcome; a fork calling itself Encore or shipping the
mark is not. Give yours its own name.

Encore is not affiliated with Clone Hero or with Chorus Encore.
