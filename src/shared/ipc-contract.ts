export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  catalogQuery: 'catalog:query',
  catalogCount: 'catalog:count',
  catalogScan: 'catalog:scan',
  // Stops a running library scan. Unlike the issue scan there is no promise on the renderer's
  // side to reject (catalog:scan resolves once the scan has STARTED), so the cancel is announced
  // on ev:scan-progress instead, as a terminal `canceled` event carrying the percent reached.
  // Rows already written stay written; see LibraryScanCanceled in catalog/scanner.ts.
  catalogScanCancel: 'catalog:scan-cancel',
  catalogRescanCharts: 'catalog:rescan-charts',
  catalogExistsByMeta: 'catalog:exists-by-meta',
  // The distinct artists, genres, charters and years the catalog holds, for the Installed view's
  // filter pickers. Read on mount and again after a scan, never per keystroke.
  catalogFacets: 'catalog:facets',
  // What the library holds more than one copy of, grouped in SQL. Read from the catalog, not
  // from disk, so unlike the issue scan there is nothing to start and nothing to cancel: it is
  // one query and it answers immediately. It reports what is duplicated and where each copy is;
  // nothing in Encore removes a chart.
  catalogDuplicates: 'catalog:duplicates',
  downloadAdd: 'download:add',
  downloadCancel: 'download:cancel',
  downloadRetry: 'download:retry',
  downloadList: 'download:list',
  downloadClearFinished: 'download:clear-finished',
  chartReadFiles: 'chart:read-files',
  // Opens the system file manager on a chart, with the chart itself selected. The one thing the
  // duplicates report offers to do about a duplicate: show the user both copies so they can
  // decide on their own filesystem. Refused for a path outside the configured library folders.
  chartReveal: 'chart:reveal',
  chartLyricLines: 'chart:lyric-lines',
  windowControl: 'window:control',
  dialogPickFolder: 'dialog:pick-folder',
  sidecarStatus: 'sidecar:status',
  sidecarInstall: 'sidecar:install',
  sidecarUpdate: 'sidecar:update',
  videoSearch: 'video:search',
  videoDownload: 'video:download',
  videoCancel: 'video:cancel',
  artSearch: 'art:search',
  artDownload: 'art:download',
  lyricsSearch: 'lyrics:search',
  lyricsInject: 'lyrics:inject',
  assetWriteBackground: 'asset:write-background',
  assetCompleteCharts: 'asset:complete',
  assetBatchCancel: 'asset:cancel',
  libraryDetect: 'library:detect',
  issuesScan: 'issues:scan',
  // Stops a running scan. The scan's own invoke then rejects. It never resolves with the rows it
  // had reached, because a partial report is indistinguishable from a complete one on screen.
  issuesScanCancel: 'issues:scan-cancel',
  issuesLast: 'issues:last',
  // Fix actions. issuesFixable is asked once, before rows are rendered: it says which codes have
  // an action and, for one that cannot run, why, so the Issues tab can offer the ffmpeg install
  // rather than a button that fails 70 seconds into an encode.
  issuesFix: 'issues:fix',
  issuesFixable: 'issues:fixable',
  issuesFixCancel: 'issues:fix-cancel',
  // Undo. Every fix copies aside what it replaces (issues/backup-store.ts); these are the three
  // things a user can do with that afterwards: see what is undoable, undo one, or take the disk
  // space back. `backupsRestore` resolves with the chart's fresh rows, exactly as `issuesFix`
  // does, so the Issues tab can update that chart's section without a 3.4 s library re-scan.
  backupsList: 'backups:list',
  backupsRestore: 'backups:restore',
  backupsClear: 'backups:clear',
  saveTextFile: 'dialog:save-text',
  // Clone Hero's own play data, accumulated by watching the file the game rewrites after every
  // song. `playStatus` is the gate every consumer asks first: for most users there is no Clone
  // Hero install on this machine and the honest answer is "nothing to show", which is a state to
  // draw rather than an error (see shared/play.ts). `playSummaries` is the per-chart read a
  // Library row or detail panel makes, batched because the caller is a whole page of rows.
  // `playStats` is the one-call aggregate a stats view needs, and `playInsights` is the rest of
  // what the Stats tab draws: the history by day, how much of the library has been played, the
  // charters behind it, and the last few plays. Split from `playStats` because it also reads
  // `charts`, which a caller after a total should not pay for.
  playStatus: 'play:status',
  playSummaries: 'play:summaries',
  playStats: 'play:stats',
  playInsights: 'play:insights',
  // Clone Hero's OWN score files, which is a different source from the four above and covers a
  // different span of time: they hold a lifetime play count and a best score per chart, from
  // before Encore existed, and no dates at all. One channel answers with all three things a
  // screen needs at once, because they are read from the same tables in the same moment and a
  // caller splitting them across calls would have to explain why its total disagreed with its
  // rows. Lifetime numbers and observed ones are separately named in the payload: the lifetime
  // count already includes every play Encore watched, so adding them double counts.
  playLifetime: 'play:lifetime',
  // What a folder holds of Clone Hero's score files, so the setting that overrides the probe can
  // say what it found before anything is stored. An empty folder in the request means "report on
  // wherever you are reading now", which is how the probe's own answer reaches Settings without a
  // second channel. Reads names, never contents, and writes nothing.
  playScoreFolder: 'play:score-folder',
  // Asks Chorus whether it holds a different version of the given charts (all of them when the
  // list is empty). Never runs on its own: each request costs API budget against a 50-per-minute
  // limit, so it is always something the user asked for. updatesLast replays the session's
  // answers so a Library row can show a badge without re-checking.
  updatesCheck: 'updates:check',
  updatesLast: 'updates:last',
  updatesCancel: 'updates:cancel',
  // Updating Encore itself, which is a different thing from the three above: those ask Chorus
  // about chart versions. These four are the app's own GitHub releases, and they are deliberately
  // three separate steps rather than one. A check reports and stops, a download is the second
  // press, and the restart that applies it is the third. `appUpdateStatus` replays where that got
  // to, so a panel opened after the startup check shows its answer without asking GitHub again.
  appUpdateStatus: 'app-update:status',
  appUpdateCheck: 'app-update:check',
  appUpdateDownload: 'app-update:download',
  appUpdateInstall: 'app-update:install',
  // main -> renderer events
  evDownloadUpdate: 'ev:download-update',
  evScanProgress: 'ev:scan-progress',
  evAssetProgress: 'ev:asset-progress',
  evUpdateProgress: 'ev:update-progress',
  // Every app-update state change, including the ones nothing invoked: the startup check's
  // result, and the download progress that arrives between the invoke and its resolution.
  evAppUpdate: 'ev:app-update',
  // A play was just recorded. Carries nothing: the recipient re-reads whichever of the three
  // reads above it is drawing, and a payload would be a fourth shape of the same data to keep in
  // step. Fires only for a play that was NEW, never for the re-reads of an unchanged file that
  // make up almost every filesystem event the play watcher sees.
  evPlayRecorded: 'ev:play-recorded'
} as const
