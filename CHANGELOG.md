# Changelog

What changed in each release of Encore, newest first.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions are
[semantic](https://semver.org/spec/v2.0.0.html).

This file is the one copy. The build bundles it, so Settings can show it offline and it always
describes the build that is running, and `scripts/release-notes.mjs` reads a version out of it to
write that release's notes on GitHub. See the contributing section of the README for how to cut a
release.

## [Unreleased]

### Added

- Explore loads the next page as you reach the bottom of the results, instead of asking you to
  press a button for each one. It appends on its own up to 500 charts, then leaves a button that
  fetches a page and raises the ceiling again, so a long browse stays a list you can still scroll
  and a fast one cannot spend the catalogue's whole rate limit. The button is a real control at the
  end of the list, so reaching more results never needs a scroll gesture.
- The charter, year, album and genre tags on a chart's page are buttons. Clicking one searches
  Explore for that exact value on that field, replacing whatever was filtered before rather than
  adding to it, and opens the advanced panel so the filter that changed the results is on screen
  and can be edited or dropped. The plain search box is cleared, because the advanced endpoint
  takes no search term.
- Advanced search in Explore, against the catalogue's own advanced endpoint. Search by name,
  artist, album, genre, year and charter, each of which can be matched exactly or excluded; by
  ranges of song length, intensity, average and peak notes per second, and year; and by what a
  chart contains, including solo sections, lyrics, vocals, open notes, tap notes, forced notes,
  roll lanes, 2x kick, a video background, known issues, and whether it is a modchart. The panel
  stays shut until you open it, and once filters are applied the button that opens it says how
  many, with a way to clear them.

### Changed

- Windows has now been run. The 0.1.0 notes below record that nothing had been, because at the
  time nothing had: the installer was cross-compiled and inspected rather than executed. It
  installs and runs. It is still not code signed, so SmartScreen warns once.

### Fixed

- Explore answered an advanced search that matched nothing with "Chorus Encore returned no charts
  at all. It may be having trouble." It now names the filters, which is what an exact charter or
  album taken from an installed chart runs into when that charter or album is not on Chorus.
- Explore only appended a page if the list had been scrolled, and on a window wider than about
  1600px the first 25 charts do not fill the results box, so there was nothing to scroll and no
  page after the first ever arrived on its own. It now fills the box on its own and keeps going
  as the end of the list stays in view, so the button at the bottom is there for the keyboard and
  for the 500 chart ceiling rather than for every page.
- Settings could hang on the two tools it manages. Reading yt-dlp's or ffmpeg's version waited on
  the binary forever, so one that never exited left both rows on their placeholder for the rest of
  the session, and `yt-dlp -U` on a stalled connection left the Update button disabled with
  nothing to press. The version check now gives up after 5 seconds and the self-update after 2
  minutes, stops the process either way, and says so. A tool that is installed but did not answer
  reads VERSION UNKNOWN rather than NOT INSTALLED, which is what it used to claim about a file
  sitting on disk next to an Update button.

## [0.2.0] - 2026-09-11

### Added

- Installed: a filter bar and a sort. Filter by artist, album, genre, charter, year range, song
  length range, and whether Encore has recorded a play. Sort by title, artist, length or year in
  either direction. Sorting runs in the database, so it orders the whole library rather than the
  page on screen. Rows now show album, genre and year beside the artist.
- Encore reads Clone Hero's own score file and records what you have played. A chart with no
  recorded play can be filtered for. Encore counts plays only from when it started watching, so a
  chart played before that counts as unrecorded, and the filter says so.
- What's new: the changelog is bundled into the build and readable from Settings at any time. It
  opens on the first launch after an update, and can be read before downloading one.

### Changed

- Every repair now asserts Clone Hero's own chart checksum as well as the one scan-chart derives,
  and both are recomputed from disk rather than read from the catalog. The guarantee that a repair
  cannot break multiplayer was previously checked against a model of the game's hash. It is now
  checked against a digest the game itself was observed to write.

### Fixed

- The Linux update manifest described the AppImage as it was before the static runtime was swapped
  in, so its recorded size and hash belonged to a file nobody would download. Every Linux update
  would have failed its checksum on a file that was perfectly good.

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
