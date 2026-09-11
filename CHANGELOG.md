# Changelog

What changed in each release of Encore, newest first.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions are
[semantic](https://semver.org/spec/v2.0.0.html).

This file is the one copy. The build bundles it, so Settings can show it offline and it always
describes the build that is running, and `scripts/release-notes.mjs` reads a version out of it to
write that release's notes on GitHub. See the contributing section of the README for how to cut a
release.

## [0.1.0] - 2026-09-10

The first release.

### Added

- Installed: the charts Encore has scanned, as a list with a filter box, showing per-instrument
  difficulty tiers and album art. Opening one shows its details and plays a preview that renders
  the note highway.
- Explore: search Chorus Encore as a grid of covers or as a dense list, filter by instrument and
  difficulty, tick several charts and download them together.
- Issues: scan the library for charting and metadata problems, grouped by severity and exportable
  as CSV. Four of them can be repaired in place: a video Clone Hero cannot play on Linux, an
  oversized cover, a `diff_*` rating for an instrument the chart does not contain, and stray `.ini`
  files.
- Every repair re-scans the chart it wrote and refuses to report success unless the hash Clone Hero
  pairs players by is byte-identical, so a repair cannot quietly break multiplayer.
- Undo: repairs, art downloads, background writes and lyrics injection all copy aside what they
  replaced, and the restore puts the original bytes back. Settings shows what that store costs and
  clears it.
- Asset Studio: add album art, a background image or video, and synced lyrics to charts that lack
  them, one chart at a time or as a batch.
- Downloads: a parallel queue that can be cancelled, retried and resumed.
- Charts are read and written both as plain folders and as `.sng` archives. A `.sng` write repacks
  the archive by streaming byte ranges, so peak memory does not follow the archive size.
- yt-dlp and ffmpeg install from the row that needs them, checked against a pinned checksum before
  Encore runs them. Encore uses the ffmpeg already on your `PATH` when it can encode VP8 and
  Vorbis.
- A welcome tour on first run, and a shortcut sheet on `?`.
- Updates: Encore checks its own releases at startup and from Settings, and says what this build
  can do about one. Windows and the AppImage update in place, the deb installs through your package
  manager, and the snap is left to the Snap Store. Nothing downloads or installs on its own.
- Builds for Windows (a per-user NSIS installer), and for Linux as an AppImage, a deb and a snap.
  The AppImage carries a statically linked runtime, so it runs without `libfuse2`.

### Known limits

- Neither installer is code signed. SmartScreen warns once on Windows.
- Nothing has been run on Windows. The installer was cross-compiled from Linux and inspected, not
  executed.
- The deb and the snap were inspected, not installed.
- x86_64 only.

[0.1.0]: https://github.com/unicxrn/encore/releases/tag/v0.1.0
