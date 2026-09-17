# Changelog

What changed in each release of Encore, newest first.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions are
[semantic](https://semver.org/spec/v2.0.0.html).

This file is the one copy. The build bundles it, so Settings can show it offline and it always
describes the build that is running, and `scripts/release-notes.mjs` reads a version out of it to
write that release's notes on GitHub. See the contributing section of the README for how to cut a
release.

## [0.4.0] - 2026-09-18

### Added

- A third column, to the right of whatever you are looking at, holding the chart you last
  clicked. Its cover, name, artist, album, year, genre and charter; a note highway you can play
  it in, labelled with the track it plays; the instrument and difficulty that highway uses; what
  that track is made of; and what the chart is missing. It keeps its chart while you go to
  Settings or Stats rather than emptying out, the same way the player bar under it already does.
  Below a window width of 1120px it is not drawn, because the columns either side leave it too
  little room to be worth the space.
- The column says what the track you picked is made of, in eight figures: its notes, the
  intensity its charter rated it at, its notes per second on average and at its fastest, how many
  difficulties it carries, how many tracks the chart has, how long the song runs, and whether it
  marks out solo sections. Four of those follow the instrument and difficulty above them and four
  describe the chart. Anything nothing measured reads as a dash and never as a zero, so a chart
  scanned before Encore stored note counts says it does not know rather than claiming the chart is
  empty. A drum chart needing a double pedal says so, beside the drums and nowhere else.
- What a chart is missing is a score in a ring with the checklist beside it. The score counts only
  the checks something actually looked at: a chart in your library is scored out of five, and one
  on Chorus Encore out of the three a search answer covers, because a still background and a
  lyrics track are not in that answer and calling either missing would be a guess. It moves one
  whole check at a time, and the card says what the number is a fraction of rather than leaving it
  to be assumed.
- A bar over the Explore results: how many charts the answer holds, a Hide owned toggle, and,
  once anything is ticked, how many are ticked and one button that queues all of them. Hide owned
  works a chart at a time rather than a song at a time, so owning one version of a song still
  shows you the others, and it says how many it is leaving out rather than quietly showing a
  shorter list. Anything it hides loses its tick, because a ticked row you cannot see is a
  download you did not ask for.
- Issues opens with the state of your library instead of with a list. Two cards on Linux and three
  elsewhere count the charts that are broken, the charts scan-chart has something to say about,
  and, where an mp4 background plays, the charts carrying one that would not play on Linux. Each
  counts across the whole report rather than what is on screen, and each is the control that puts
  its own rows in the list below. One chart can be counted by two of them, and the line under the
  cards says so rather than leaving the numbers to be added up wrongly.
- The two findings Encore will not repair now say why on the row, because a missing button is
  otherwise read as an oversight. It will not delete a chart file, since which one Clone Hero
  reads is what it matches charts by, and removing the wrong one costs that chart its multiplayer
  and its play history. It cannot fill in a difficulty rating either, and neither can Chorus: a
  chart matched there by hash is the same upload and carries the same blank.
- Launch Clone Hero and My library, in the title bar beside the search field. Launch starts the
  game and lets go of it, so closing Encore does not close Clone Hero; My library opens the folder
  downloads land in. With no game chosen yet, Launch takes you to the setting rather than failing,
  and when the game refuses to start the reason appears under the button instead of nowhere.
- Settings asks where Clone Hero is, under Library. Encore does not look for this one: the game is
  installed wherever you put it, so a wrong guess would be worse than asking. On Linux that is the
  AppImage or the extracted binary, and a file nothing can start is refused with what to do about
  it rather than stored; on Windows it is the .exe. Launching is not offered on macOS, which
  nobody has been able to test.
- Installed marks a chart Encore's own issue scan found problems in, the same dot Explore draws
  for a chart Chorus found problems in: nothing on a clean chart, a hollow dot for charting notes
  that do not stop it playing, a filled one for a chart that is broken. It reads the report the
  last scan left rather than reading your charts again, so it costs nothing and shows nothing
  until you have run that scan once.
- The sidebar carries what it had nowhere to say before: which game the library belongs to, two
  quick actions, which source Explore searches, and whether a newer Encore exists. Some of those
  offer more than Encore can do yet and say so on the control rather than looking live.
- The download folder template shows what it would produce, on the settings the queue would
  actually run with, so the one control written in a syntax no longer has to be proved by a
  download. The example follows the field as you type; the setting is still stored when you leave
  it, not on every keystroke.

- Setlists: your own running orders, built from the button beside the heart in the chart column and
  read in a section of their own, with what each one adds up to and which of its charts your library
  still has. A setlist is Encore's own and the screen says so, because Clone Hero groups charts by
  the folders they sit in and has no setlist file to write to, so nothing here moves a chart or
  reaches the game. Like a favourite, a setlist holds the chart rather than the folder it is in, so
  it survives the chart moving, being re-downloaded or being removed, and one chart can sit in two
  setlists at once.
- Favourites. The chart column draws a heart beside its action, for a chart in your library and for
  one on Chorus Encore alike, and Installed has a Favourites filter that narrows the whole library
  rather than the page on screen. A favourite is kept for the chart rather than for the copy of it on
  your disk, so it survives the chart moving, being re-downloaded as a different version, or your
  catalog being rebuilt from scratch, and a chart you heart on Chorus is already hearted when you
  download it.
- A metadata editor, for the blanks Chart issues finds and will not repair. Correct a chart's title,
  artist, album, genre, year or charter in place, on a folder chart or a `.sng` archive, keeping the
  rest of `song.ini` byte for byte. It refuses to report a save unless both of the values Clone Hero
  identifies the chart by are unchanged, and the seven gameplay values it matches charts between
  players by are shown and never edited.
- Surprise me, in the sidebar: five charts you do not have, drawn at random from the whole Chorus
  Encore catalog and shown in Explore. It leaves out the ones with no download, no notes, or a
  problem Clone Hero would trip over, and says so when it ran out of candidates before five.
- The player bar can loop what it is playing, from a repeat toggle beside the volume slider. It
  stays on across charts until you turn it off. There is no shuffle and no skip beside it, because
  Encore previews the one chart you pointed it at rather than a queue.

### Changed

- The window is a three by three frame rather than a stack of bars: a sidebar running the full
  height beside a top bar, the view, the new chart column and the player bar, with the nav grouped
  under two headings rather than three. Nothing a view does has changed, and `Ctrl+1` to `Ctrl+7`
  still reach the same seven views in the same order.
- The palette has depth it did not have: six steps of ground where there were two, and four steps
  of shadow, so a dialog, a popover, a card and a row each sit somewhere distinct rather than
  sharing one plane. Every instrument has a colour, rhythm included, and a co-op or six-fret track
  takes the colour of the part it plays, since which controller it is for is already in the label
  beside it. The dimmest text colour is lighter and now clears the contrast floor on every surface
  the app draws it on, which it did not on the darkest of them before.
- An Explore row says what a chart holds for five instruments rather than three: guitar, bass,
  drums, keys and vocals, each drawn as its own instrument in a ring over the pips that count how
  hard it was rated. The ring is lit for a part the chart has, so a part nobody rated still reads
  as present and a part that is not there still reads as missing. Ratings run past the six Clone
  Hero's scale draws, and a chart rated higher fills every pip while the number read out is the
  real one. The row also carries the real album cover at 52px and a band of badges holding what
  used to sit in columns of its own; the three flags that survived are the uncommon ones that
  change a decision, a background video, a double kick pedal and a modchart.
- Clicking a result in Explore fills that column instead of opening the chart page. The list, the
  filters, the order and your place in it all stay where they are, so comparing three versions of
  a song costs three clicks rather than three round trips through a page. "All details" in the
  column is the way to the chart page. Below 1120px, where the column is not drawn, a click opens
  the chart page as it always did.
- Explore marks a chart Chorus found problems in before you download it: nothing at all on a chart
  with nothing wrong, which is most of them, a hollow dot for charting notes, a filled one for a
  chart that is broken. Hovering says what was found. Chorus runs the same checks Encore's Issues
  view runs, so this costs no extra request.
- Explore's filter header asks three questions rather than two. Instrument is which of the ten
  parts Chorus Encore can filter to, difficulty is which charted difficulties exist, and intensity
  is how hard the chart is, which is the same number the rows draw as pips. Intensity is off until
  an instrument is chosen, because a chart is rated one instrument at a time. There is no Vocals
  filter: Chorus Encore refuses one, though a chart's vocal difficulty still shows on its row.
  The results can be put in eleven orders, reaching all eight fields Chorus Encore sorts by,
  including the charts changed most recently, which nothing surfaced before. There is no download
  or popularity order, because Chorus Encore does not keep one.
- Explore's advanced panel speaks the same language as the filter row it drops out of, and reads
  as the header getting taller rather than as a card that landed on the list. Exact and Exclude
  are pressed pills like the chart features beside them, instead of twelve checkboxes asking one
  kind of question a second way, and the fields are grouped by what they ask. It no longer takes
  the results off the screen: it takes what the window has spare and scrolls itself, with Search
  and Clear always in reach. In place of a count the Advanced button already carries, it now says
  when the boxes hold something nothing has been searched for yet.
- Installed's rows say what Explore's rows say, and in the same order: a larger cover, the title,
  the artist with the album, the year and the genre under it, the charter, the difficulty and the
  health mark. They also fold as the window narrows, which they never did before. That fixes a
  real failure rather than making room: at the narrowest the view column ever gets, every title in
  the list was squeezed to nothing and read as a bare ellipsis. A row announces itself to a screen
  reader as the chart it opens rather than reading out everything printed on it, which would have
  been eighteen difficulty bars and a paragraph about the chart's problems.
- Installed and Home draw the difficulty the way an Explore row does, an instrument in a ring over
  the pips that rate it, in place of a letter with its bars beside it. Both keep three instruments
  where Explore shows five: an Explore row can move the difficulty onto a line of its own when its
  column is narrow and these two cannot, so five here would come off the chart's name at every
  width. The ring is the narrower drawing of the two, so both rows give their names room back
  instead.
- Home opens on the state of your library rather than on a title: how many charts you have, how
  many are still missing album art, a background, a video or lyrics, and how many charts Chorus
  Encore has to search. The middle figure links into the Asset Studio, which is the view that acts
  on it. A scan running says so there, with its percent and the way to stop it.
- Home's chart rows are the row Explore draws, six a section with See all for the rest, and
  clicking one fills the chart column the way an Explore result does. The library rows carry no
  problem mark, because nothing has looked inside those charts: the Issues report is not kept
  between launches, so a mark there would be missing more often than it was right. Home with
  nothing in it reads as a step not taken rather than as a failure, and says which step: no folder
  yet points at Settings, a folder with nothing read yet offers the scan, and a scan that came
  back empty says what a chart folder has to contain.
- The first-run screen leads with what it is asking for rather than with the app's name, and when
  no Clone Hero folder is found it is headed "Choose your songs folder" rather than "No Clone Hero
  folder found". Nothing has gone wrong at that point, and it is the one screen a new user cannot
  walk past. The welcome tour has a screen for Stats, and its Installed and Explore screens
  describe those views as they are now.
- The chart page answers what the new column cannot, and stops repeating what it already does.
  Its four stat cards are gone, and in their place it carries the whole of what a chart says about
  its parts: every instrument the catalog stores a rating for, each with its rating as pips and as
  the number the charter wrote, and every difficulty square carrying its note count and that
  track's fastest stretch. It tells apart the three things a chart can say about a part, including
  a rating in song.ini with no notes to match, which is a Rock Band conversion artifact the grid
  now names in words rather than drawing as an empty row. It says where a chart lives and what
  identifies it, folder or `.sng` archive, its path, when it was scanned, the key Clone Hero
  writes beside a score and the hash the version check compares; it reports what the chart is made
  of as yes, no or unknown, because a row nobody has scanned carries flags that were never
  measured; and for a chart on Chorus Encore it lists what scan-chart found, which the row's
  single dot cannot say. None of that costs a request.
- The Issues view scrolls as one thing. The duplicate report used to sit in the half of the screen
  that does not scroll, so a report with twenty-five sets in it squeezed the issue list underneath
  to nothing with no way to scroll the report out of the way. The cards, the report and the rows
  now share one scroller, and the category chips stick to the top of it so the control for the
  list is still there once the cards have scrolled past.
- The duplicate report is one of those cards rather than a panel wedged above them. What it says
  about the three kinds of duplicate has not moved: the same chart installed twice is the only one
  that offers to remove a copy, the same song at two versions is listed and not judged, and the
  same song by two charters still opens by saying nothing is wrong. A video Clone Hero cannot play
  on Linux is one card on the machines where that is a note rather than a fault, where it used to
  be a filter chip and a separate panel counting the same charts twice.
- Stats opens with what you came for rather than with the first of seven cards. One block at the
  top carries how much you have played, how well, and how much of your library you have played at
  all, each labelled with the record it came from. No figure is drawn twice: the three in that
  block are taken out of the sections below rather than repeated into them. How much of the
  library has been played is a pair of bars, one per record against one total and never one inside
  the other, because the two counts come from tables nothing joins. Stats draws the instruments
  you play in the same colours the difficulty pips use.
- Settings answers four questions rather than listing seven sections: where your songs are, what
  happens when Encore downloads, which Encore this is and where a new one comes from, and what the
  repairs are costing you on disk. yt-dlp and ffmpeg moved out of the update section and in with
  the downloading they serve, since one fetches video backgrounds and the other converts them. The
  library folders sit in a well of their own and their paths wrap rather than being cut off in the
  middle, because three folders differing only in their last segment are three identical rows once
  a path is ellipsised, and that list is the highest-consequence setting in the app: Encore scans
  those folders, downloads into the one you pick, and refuses to write to a chart outside them.
  Removing one now says so.

- Duplicate charts are their own section rather than a card inside Issues, and the sidebar counts
  what it can honestly count: the size of your library, downloads still to come, spare copies, and
  broken charts once a scan has looked. A count is drawn only when there is something to count,
  because a zero would as often mean nothing has looked yet. There are ten views and nine digits
  now, so `Ctrl+1` to `Ctrl+9` run down the sidebar as far as the metadata editor and Settings has
  no shortcut, which it can afford: it is the row with its own link in the footer under it. Stats is
  called Statistics.
- Explore asks difficulty as four dots, one per difficulty Chorus Encore takes, and pressing the lit
  one goes back to any. Genre, Year, Length, Charter and Album are chips under the search box, each
  showing what it is set to, and the Year chip fills a decade in one press. They edit the same fields
  the advanced panel holds rather than a second copy of them.
- The sidebar is drawn at the weight the rest of the app is: the mark and the wordmark, the two game
  tiles, the quick actions with their descriptions, and an update card that lights when there is
  something to install. What a control cannot do yet is said in words on a recessed plane rather
  than by fading it out.
- Installed and Home draw their rows the way Explore does: a 52px cover, and the charter and the
  song's length as chips in a band under the artist rather than as columns of grey text at the far
  end of the row. The rows are 16px taller and one or two fewer fit on screen, and the chart's name
  gets between 90px and 190px more room at every window width.
- The chart column draws a note highway while nothing is playing, instead of an empty black frame,
  and the preview plays on that same lane rather than the preview library's: the violet highway,
  accent rails and outlined frets you see before you press Play keep going once you do. The still
  lane uses the preview's own camera, so nothing changes size when a preview starts. The note sprites
  are unchanged, so a chart still reads the way Clone Hero draws it.
- The player bar names the chart and the track it is previewing rather than showing the word ENCORE,
  and says what it is waiting for when there is nothing loaded.

### Fixed

- Narrowing the window under 1120px while the chart column was playing something left the chart
  playing behind the hidden column, with the player bar still handing it the transport and nothing
  on screen able to stop it. The column now gives the preview back as it goes.
- Opening the advanced panel took the results off the screen. It never fitted the window: the form
  was taller than the window at a common size and the list under it came back a single pixel.
- A chart whose notes were read and found to carry none was told to run a library scan, which is
  the one instruction that could not help it. The scan is offered only to a chart nothing has read
  yet; a measured zero now says it was measured.
- Stats left a charter's name almost no room at the width where the chart column appears and the
  view is at its narrowest, and put its most-played and recently-played lists side by side long
  before there was room for a song title in either.
- The version buttons in a chart's detail panel have the border they were written to have, and a
  version note reporting an error is red rather than grey. Both have asked since 0.1.0 for a
  colour the stylesheet never defined, so one drew no border at all and the other fell back to the
  colour of ordinary text.
- The selected row in the Asset Studio no longer fades out through a hardcoded copy of an accent
  colour that has since moved. It looked the same and would have stopped looking the same the
  first time anyone touched it.

- One of the three chart sources in the sidebar was squeezed to a 2px sliver whenever the column
  overflowed, which was both window heights most people use, and the other two had their names cut
  short. All three are full rows in a recessed box now.
- The YARG tile's reason for being unavailable was drawn at 3.2:1 against its background, under the
  contrast floor the rest of the app is held to. Unavailability is carried by the surface and the
  words now rather than by fading the text.
- A charter credit longer than its column pushed the chart's name out of its cell in Installed,
  clipped, with no ellipsis to say so. Two style rules tied on specificity and the one that stopped
  it shrinking won.

## [0.3.1] - 2026-09-13

### Changed

- A chart carrying a `video.mp4`, `.avi` or `.mpeg` background is no longer counted as a fault on
  Windows. scan-chart raises this because Clone Hero on Linux cannot play those containers, and
  Encore repeated the finding identically on Windows, where those containers are the ones Unity's
  Windows video backend is built around. Calling that broken, and offering a VP8 re-encode to
  repair it, is an accusation Encore cannot back. Such charts are now left out of the Windows
  issue count and out of the categories the broken ones sit in, with their own chip for reading
  them, and the conversion keeps its place under a heading that says what it buys, a background
  that also plays on Linux, and what it costs, time and some image quality. Linux is unchanged:
  there it is breakage, it is counted as breakage, and converting is the repair. On macOS, and on
  any other platform Node reports, nobody here has checked what Clone Hero does with an mp4, so
  the row says exactly that and is not counted as a fault either. Every platform reads the rows
  the last scan already produced, so none of this needs re-scanning.

### Added

- Encore can now remove a chart. Installed carries a Remove beside every row, and the duplicate
  report offers one on the copies whose Clone Hero checksum is identical. Both ask first, by name,
  and both say where the chart goes: the system Trash, which is the whole of the recovery path.
  Encore keeps no copy of its own and there is no permanent delete behind either of them, so a
  Trash that refuses the move leaves the chart on disk and in your library and says so. Your play
  history is kept either way, because a play is recorded against the chart rather than its folder,
  and the Stats page goes on naming charts the library no longer holds.
- Each copy in the duplicate report now says what it holds and how big it is, and the removal is
  offered only where that is the whole story. Two copies with one checksum are the same notes byte
  for byte, and the checksum covers nothing else: one of them can be the only copy with the album
  art, the background video or the synced lyrics. Each copy lists what it has, and the one holding
  something none of the others do says so, on the row and again in the confirmation. Nothing is
  preselected and nothing is recommended. Removal is not offered on the other two tiers: an old
  version is a different chart whose scores are recorded against it, and a song charted by two
  people is not waste at all.

### Fixed

- Adding lyrics to a chart destroyed every byte of the chart file that was not valid UTF-8. Encore
  read `notes.chart` through a decode that turns an undecodable byte into the replacement
  character and then wrote that reading back, so a chart written in Latin-1 came back with three
  bytes of nothing where each of its accents had been, and one Complete missing pass did that to
  every affected chart in the library at once. Nothing caught it, because a lyric injection is
  expected to move both of the numbers Clone Hero matches charts by, and the assertions that hold
  every other chart write to leaving them alone are therefore off for this one. Encore now reads
  the chart file's encoding off its own bytes and writes back the one it read, so a byte the
  injection did not come for goes back as itself.
- Lyrics a chart's encoding cannot hold are now refused for that chart, with a message naming the
  characters that stopped them, rather than written at the cost of the rest of the file. A chart
  file that is not valid UTF-8 is read and written as Latin-1, which has no byte for a curly
  apostrophe or for anything outside its 256 characters; the only way to write one would be to
  re-encode the whole file and change every non-ASCII byte the chart already had. Re-saving the
  chart as UTF-8 is what makes those lyrics fit. A UTF-16 chart file is refused for the same
  reason `song.ini` editing already refuses one.
- The duplicate report grouped on the raw `song.ini` text, so a chart whose title or charter is
  written in Clone Hero's colour tags was a group of its own. Two versions by one charter, one of
  them styled, were reported as two people having charted the song, which is the one tier the
  report says is not a problem. It now groups on the name a chart reads as.
- Clone Hero's score files were read as a pair, and a chart that listed the same score row twice
  in `scoredata.bin` and once in `scoresext.bin` was accepted instead of refused. The import that
  followed failed on the two rows sharing one key, and because the game rewrites both files after
  every song, it failed again every time a song finished. Such a pair is now refused the way every
  other mismatch between the two files already was.
- An import that failed reported itself as having worked: the status said the scores were read,
  and stamped no time against them, over tables nothing had been written to. A failed import now
  says so, and it can no longer take Encore down with it.
- Changing the score folder in Settings while a read of the old one was still running let the old
  folder's scores land afterwards and replace the new folder's, while the status named the new
  folder and said all was well. Nothing re-read until a file changed or Encore restarted. A read
  that a later one has overtaken is now thrown away, which covers the same hazard between two
  ordinary reads of one folder.
- Encore had one sentence for two states of Clone Hero's score files: a file it could not decode,
  and two files it decoded perfectly and could not match to each other. Only the first is worth
  going to look at an install for. The second now says that it is a pair Encore cannot read
  together rather than a damaged install, since Encore matches the two files on a field that has
  never been decoded and a healthy pair shaped unlike the one it was read from would land there.
- Explore's advanced Length range was sent to Chorus Encore multiplied by 60. The service counts
  length in minutes, not seconds, so a search for 3 to 6 minutes asked for 3 to 6 hours and
  answered with 16 charts, and a maximum on its own matched 95,284 of the 95,299 charts there are.
  The numbers now go out in the minutes the boxes are labelled in.
- Typing in Explore's search box waits 300ms before it searches, and everything about the new
  query was already in place for those 300ms while the previous query's rows were still on screen.
  Reaching the end of the list in that window, or pressing Load more, skipped the new query's
  first page entirely: its top 25 matches never loaded and two requests went to page 2. It could
  also append a page of unfiltered results under a page of filtered ones, in one list. A search
  that has been asked for now happens all at once, and Load more waits for it.
- Pressing Enter in Explore's advanced panel with nothing filled in threw away the search term and
  searched for everything instead, with nothing on screen to say where the term had gone. An empty
  panel now leaves the term alone.
- Explore stopped paging before the end of a search. A page carries every version of the songs it
  lists while the result count counts songs, so the extra rows added up until the list looked
  longer than the answer and the Load more button disappeared. On a search for "metallica" that
  left 36 of its 511 songs unreachable.
- Clearing the advanced filters from the chip beside the Advanced button left the open panel still
  showing every field, and one keystroke anywhere in it put all of them back. The panel now
  empties with the filters.

## [0.3.0] - 2026-09-13

### Added

- Encore now says so on screen when a newer release exists. The check has run at every launch
  since 0.1.0, but the only place its answer appeared was the Updates row in Settings, which
  nobody opens to find out about something they do not know is waiting. A newer release now opens
  a prompt over whatever the app started on: it names the release and the one running, says what
  this particular install does about updates, and offers the release notes, Skip, and Download and
  install. Skip means not now and not never. Nothing is written down, so the next launch asks
  again, and the prompt says as much before the button is pressed. Download and install starts the
  same download the Updates row starts and puts you in front of that row, where the percent and
  the Restart button already are, so there is still one update flow and one place the per-platform
  rules are written. On a copy Encore cannot replace, a snap being the one most people will meet,
  there is no install button at all and the sentence in its place is the one that does work:
  `snap refresh encore`. Reading the notes does not count as declining. The panel opens over the
  prompt and the prompt is waiting underneath when it closes.
- Three things can now want the screen the moment Encore starts: the first-run tour, the what's
  new panel after an update, and the update prompt. They share one layer and only one of them is
  ever drawn. The update prompt is last in that order and yields the whole launch rather than
  queueing behind, so dismissing the tour or the changelog never hands you a second card, and a
  fresh install is never told about an update by the copy that was just installed. The decision is
  made once, after the settings have loaded, which is the moment the other two decide, so a check
  that answers quickly wins nothing it would not otherwise have won.
- Encore reads Clone Hero's own score files, `scoredata.bin` and `scoresext.bin`, so it knows what
  you played before Encore existed. They are the game's high score table: one record per chart, a
  lifetime play count and the best score, kept since long before Encore was installed. What they do
  not hold is dates, of any kind. Nothing read from them can be placed on a calendar or counted
  into a week, so they are stored apart from the plays Encore has watched happen and the two are
  reported separately: the lifetime count for a chart already includes every play Encore recorded,
  and adding them would count those twice. The import runs at startup, which is the only moment a
  play made while Encore was closed can be picked up, and again whenever the game rewrites either
  file. It is a read; nothing is ever written back to Clone Hero's files. The Linux and
  Windows locations have both been verified against a real install. The macOS path follows
  Unity's own convention for where a game keeps this data and is probed rather than assumed. What it finds is
  on the Stats tab, as its own block, and on the play count a chart carries in Installed. Settings
  shows where Encore looked, and lets you point it at the folder yourself when the search is
  wrong, which is also the answer for a portable install or a Clone Hero on another drive. A
  folder with no score files in it is refused there and then, naming what was looked for and what
  was in the folder instead, rather than being stored to go on finding nothing. Encore never
  writes into that folder, whoever chose it.
- When one of Clone Hero's score files refuses to parse, Encore reads the copy the game keeps
  beside it rather than reporting nothing, and says when the figures came from one: a backup is a
  save behind by definition, so it is only ever read when the live file cannot be, and a readable
  pair is never passed over for older numbers. The files Clone Hero has renamed as damaged are
  never read at all, because the game renamed them precisely because it could not read them.
- The "No plays recorded" filter in Installed now also consults Clone Hero's own record, so a chart
  you wore out last year and have not touched since Encore was installed is no longer in the list.
  It is still not a complete answer and does not claim to be: a chart played on another machine, or
  under a Clone Hero whose score files are not the ones Encore found, is unknown either way, and so
  is a chart Encore cannot compute a Clone Hero checksum for. The sentence beside the list says
  which records actually answered, so a machine where the score files could not be read is told the
  list is only what Encore itself has seen rather than left to assume otherwise.

- A Stats tab, holding everything Encore knows about what you have played, out of both records it
  has. From Clone Hero's own score table: your lifetime play count, how many charts you have ever
  played and how many of them you still have, and your best score. From Encore's own log: plays
  recorded, accuracy, full combos, best score and longest streak; the history as a bar per day,
  week or longer, from your first recorded play to today; which instruments and difficulties those
  plays were on; the ten charts you have played most and the last few plays themselves, with what
  each one scored; and how much of your library has a play on record, with the charters behind it.
  The two reach back different distances and the page never lets that go unsaid: every block is
  labelled with the record it was drawn from, ALL TIME or the date Encore's own record starts, and
  the sentence under the title says which is which. The lifetime count already includes every play
  Encore watched, so the page says so where the two sit closest and never adds them. Where a chart
  carries a score Encore cannot read, the play count still stands and only the score is left out,
  said plainly and not as a fault in your files. Nowhere writes "no play on record" as "never
  played". With one record, or with neither, the page says which of the reasons applies and where
  it looked, rather than drawing a page of zeroes. Reached from the sidebar or with Ctrl+5, which
  moves Issues to Ctrl+6 and Settings to Ctrl+7. Home, where the play panel used to sit, is back to
  being a landing page.
- A chart in Installed says how many times it has been played, when there is a play on record for
  it. It is Clone Hero's own lifetime count where the game has one, so a chart you wore out years
  before Encore existed now says so, and Encore's own count where it does not. One badge either
  way, never two: the lifetime count already contains what Encore watched, and two numbers side by
  side invite the one sum that means nothing. The counts are a batch read for each page of the
  list, and a chart with no record in either place carries no badge at all: the list already
  distinguishes "no plays recorded" from "never played", and a zero would not.
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

[0.4.0]: https://github.com/unicxrn/encore/releases/tag/v0.4.0
[0.3.1]: https://github.com/unicxrn/encore/releases/tag/v0.3.1
[0.3.0]: https://github.com/unicxrn/encore/releases/tag/v0.3.0
[0.2.0]: https://github.com/unicxrn/encore/releases/tag/v0.2.0
[0.1.0]: https://github.com/unicxrn/encore/releases/tag/v0.1.0
