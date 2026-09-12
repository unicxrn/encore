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

- Encore reads Clone Hero's own score files, `scoredata.bin` and `scoresext.bin`, so it knows what
  you played before Encore existed. They are the game's high score table: one record per chart, a
  lifetime play count and the best score, kept since long before Encore was installed. What they do
  not hold is dates, of any kind. Nothing read from them can be placed on a calendar or counted
  into a week, so they are stored apart from the plays Encore has watched happen and the two are
  reported separately: the lifetime count for a chart already includes every play Encore recorded,
  and adding them would count those twice. The import runs at startup, which is the only moment a
  play made while Encore was closed can be picked up, and again whenever the game rewrites either
  file. It is a read; nothing is ever written back to Clone Hero's files. Only the Linux location
  has been verified against a real install. The Windows and macOS paths follow Unity's own
  convention for where a game keeps this data and are probed rather than assumed.
- The "No plays recorded" filter in Installed now also consults Clone Hero's own record, so a chart
  you wore out last year and have not touched since Encore was installed is no longer in the list.
  It is still not a complete answer and does not claim to be: a chart played on another machine, or
  under a Clone Hero whose score files are not the ones Encore found, is unknown either way, and so
  is a chart Encore cannot compute a Clone Hero checksum for.

- A Stats tab, holding everything Encore knows about what you have played. Encore has been reading
  Clone Hero's own score file since 0.2.0 and keeping what it finds, and none of it reached the
  screen. The page shows plays recorded, charts played, accuracy, full combos, best score and
  longest streak; the history as a bar per day, week or longer, from your first recorded play to
  today; which instruments and difficulties those plays were on; the ten charts you have played
  most and the last few plays themselves, with what each one scored; and how much of your library
  has a play on record, with the charters behind it. Every figure is prefaced by the date the
  record starts, because Clone Hero's score file holds only the most recent play: Encore's history
  begins the first time it saw that file change, and nothing before that can be recovered. These
  are not lifetime totals and the page says so before it says anything else, and nowhere writes "no
  play on record" as "never played". When there is nothing yet it says which of the four reasons
  applies and where it looked, rather than drawing a page of zeroes. Reached from the sidebar or
  with Ctrl+5, which moves Issues to Ctrl+6 and Settings to Ctrl+7. Home, where the play panel used
  to sit, is back to being a landing page.
- A chart in Installed says how many times it has been played, when there is a play on record for
  it. The count is a batch read for each page of the list, and a chart with no record carries no
  badge at all: the list already distinguishes "no plays recorded" from "never played", and a zero
  would not.
- Issues reports what your library holds more than one copy of, in three kinds that are kept
  apart because they mean different things. The same chart file installed twice, where nothing is
  lost by keeping one. The same song by the same charter at more than one version, which is
  usually an update that landed beside the copy it was meant to replace. And the same song by
  different charters, which is not a problem at all and says so. Every copy can be opened in your
  file manager, and the whole report exports as CSV. Encore never deletes a chart: it says what is
  duplicated and where each copy is, and the removing is yours to do. It reads the catalogue
  rather than the disk, so it answers as soon as the tab opens and needs no scan first.

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

- Home reads a chart name as text too. It was the one view left drawing Clone Hero's
  markup, and a name that is nothing but markup now falls back to the folder it sits in
  rather than rendering as an empty line.

- A name written in Clone Hero's own styling markup read as the markup, everywhere Encore drew
  one. Charters colour their names in the game and song.ini and Chorus carry that verbatim, so one
  charter arrived as eight colour tags, one per letter. Installed, Explore, a chart's page, Asset
  Studio, the duplicates report, the preview and the player bar now read every title, artist,
  album and charter as text, and so do the accessible names beside them. What a chart says is
  untouched: the catalogue still keeps the markup exactly as the chart wrote it. The duplicates
  CSV shows the raw name, because it sits next to each copy's path and checksum and exists to be
  reconciled against a library.
- A name written in that markup could not be found by what it reads as, and sorted nowhere near
  it. Search and sort run over the catalogue, and the catalogue held only the raw string, so a
  charter who colours every letter of their name was a separate search term per letter and typing
  the name on screen found nothing, while typing `color` found every styled chart in the library.
  A title beginning with a tag sorted under `<`, which put it at the top of Installed. The
  catalogue now keeps a readable form of each chart's title, artist, album and charter beside the
  raw one, and search, sort and the Installed pickers read that. Pasting a line straight out of
  song.ini into the search box still finds its chart. Your library is not rescanned for this:
  Encore fills the new columns from what it has already stored, the first time this build opens
  your catalogue, measured at 0.13 seconds over a library of 20,000 charts, and the search index
  it rebuilds in the same pass comes out a fifth smaller than the one it replaces.
- One charter whose name is styled in one chart and plain in another was two entries in
  Installed's charter picker, each returning some of their charts. That is one entry now, under
  the name as it reads. Artists the same.
- A download of a chart whose name carries that markup landed in a folder named after the markup,
  because the only thing that touched it was the rule that strips characters a filename cannot
  hold. The tags come off first now, so the folder, and the line for it in the downloads queue,
  read as a name. Nothing already on disk is renamed.
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
- Typing in the title bar's search box while Explore had advanced filters applied changed the
  results without searching for what was typed: Chorus Encore's advanced endpoint takes no search
  term, so the term was discarded. Explore's own box knew this and turned itself off; the title
  bar's did not. Now a search term clears the applied filters instead, so both boxes do what they
  look like they do and neither is disabled. Explore says how many filters the search cleared and
  offers to put them back. The panel keeps every field either way, so they are one press of Search
  away whether or not the note is still on screen.

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
