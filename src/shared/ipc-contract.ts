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
  downloadAdd: 'download:add',
  downloadCancel: 'download:cancel',
  downloadRetry: 'download:retry',
  downloadList: 'download:list',
  downloadClearFinished: 'download:clear-finished',
  chartReadFiles: 'chart:read-files',
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
  evAppUpdate: 'ev:app-update'
} as const
