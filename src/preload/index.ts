import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-contract'
import type {
  CatalogFacets,
  CatalogFilter,
  ChartRecord,
  DownloadRequest,
  QueuedDownload,
  Settings
} from '../shared/schemas'
import type { DuplicateReport } from '../shared/duplicates'
import type { AlbumArtResult } from '../main/assets/art'
import type { LibraryCandidate } from '../main/catalog/detect-library'
import type { ChartIssueRow } from '../main/catalog/issues'
import type { FixBackup } from '../main/issues/backup-store'
import type { FixableCode } from '../main/issues/fix'
import type { LyricsSearchResult } from '../main/assets/lyrics'
import type { LyricLinesResult } from '../main/catalog/lyric-lines'
import type { SidecarName, SidecarStatus } from '../main/sidecars/manager'
import type { VideoSearchResult } from '../main/sidecars/ytdlp'
import type { ChartVerdict, UpdateCheckSummary } from '../shared/updates'
import type { AppUpdateStatus } from '../shared/app-update'
import type { ChartPlaySummary, PlayDataStatus, PlayStats } from '../shared/play'

type Unsubscribe = () => void

const subscribe =
  (channel: string) =>
  (callback: (data: unknown) => void): Unsubscribe => {
    const listener = (_e: unknown, data: unknown): void => callback(data)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }

const api = {
  settingsGet: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
  settingsSet: (s: Settings): Promise<void> => ipcRenderer.invoke(IPC.settingsSet, s),
  catalogQuery: (f: Partial<CatalogFilter>): Promise<ChartRecord[]> =>
    ipcRenderer.invoke(IPC.catalogQuery, f),
  catalogCount: (f: Partial<CatalogFilter>): Promise<number> =>
    ipcRenderer.invoke(IPC.catalogCount, f),
  catalogScan: (): Promise<void> => ipcRenderer.invoke(IPC.catalogScan),
  // Stops the running library scan. Resolves once main has fired the abort, not once the scan has
  // unwound. Charts already open finish first. Unlike issuesScanCancel there is no scan promise
  // to reject, because catalogScan resolved back when the scan STARTED; watch onScanProgress for
  // the terminal `canceled` event instead. Charts scanned before the cancel keep their rows, so
  // the catalog is left partial, never wrong: running the scan again fills in the rest.
  catalogScanCancel: (): Promise<void> => ipcRenderer.invoke(IPC.catalogScanCancel),
  // Re-index the named charts now and hand back their fresh rows, instead of waiting on the
  // library watcher's debounced full scan. Asset writes go through this so the state a user is
  // looking at stops being a guess about how long a rescan takes. Rows for paths the catalog
  // does not know are omitted, so results are matched to the input by path, not by index.
  rescanCharts: (paths: string[]): Promise<ChartRecord[]> =>
    ipcRenderer.invoke(IPC.catalogRescanCharts, paths),
  existsByMeta: (keys: { name: string; artist: string; charter: string }[]): Promise<boolean[]> =>
    ipcRenderer.invoke(IPC.catalogExistsByMeta, keys),
  // The distinct artists, genres, charters and years the catalog holds, so the Installed view's
  // pickers can only offer a value some chart actually has. Describes the whole catalog, not the
  // current filter: narrowing the lists as filters are applied would take options away the moment
  // they were used.
  catalogFacets: (): Promise<CatalogFacets> => ipcRenderer.invoke(IPC.catalogFacets),
  // What the library holds more than one copy of, in three separate relationships: the same
  // chart file installed twice, several versions of one charter's chart, and the same song by
  // different charters. The third is not a fault and is labelled so. Read straight out of the
  // catalog, so it answers in a few tens of milliseconds on a library of any size and needs no
  // scan first; charts the scanner has not reached are simply not in it.
  catalogDuplicates: (): Promise<DuplicateReport> => ipcRenderer.invoke(IPC.catalogDuplicates),
  downloadAdd: (r: DownloadRequest): Promise<void> => ipcRenderer.invoke(IPC.downloadAdd, r),
  downloadCancel: (md5: string): Promise<void> => ipcRenderer.invoke(IPC.downloadCancel, md5),
  downloadRetry: (md5: string): Promise<void> => ipcRenderer.invoke(IPC.downloadRetry, md5),
  downloadList: (): Promise<QueuedDownload[]> => ipcRenderer.invoke(IPC.downloadList),
  clearFinished: (): Promise<void> => ipcRenderer.invoke(IPC.downloadClearFinished),
  windowControl: (action: 'minimize' | 'maximize' | 'close'): Promise<void> =>
    ipcRenderer.invoke(IPC.windowControl, action),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.dialogPickFolder),
  // Structured clone copies the file buffers across the IPC boundary, which is fine at
  // chart scale (tens of MB worst case).
  chartReadFiles: (req: {
    path: string
    chartType: 'folder' | 'sng'
  }): Promise<{ fileName: string; data: Uint8Array }[]> =>
    ipcRenderer.invoke(IPC.chartReadFiles, req),
  // Opens the system file manager with this chart selected. Changes nothing on disk. Rejects
  // for a path outside the configured library folders.
  chartReveal: (path: string): Promise<void> => ipcRenderer.invoke(IPC.chartReveal, path),
  chartLyricLines: (req: {
    path: string
    chartType: 'folder' | 'sng'
  }): Promise<LyricLinesResult> => ipcRenderer.invoke(IPC.chartLyricLines, req),
  sidecarStatus: (name: SidecarName): Promise<SidecarStatus> =>
    ipcRenderer.invoke(IPC.sidecarStatus, name),
  sidecarInstall: (name: SidecarName): Promise<void> =>
    ipcRenderer.invoke(IPC.sidecarInstall, name),
  sidecarUpdate: (name: SidecarName): Promise<void> => ipcRenderer.invoke(IPC.sidecarUpdate, name),
  videoSearch: (query: string): Promise<VideoSearchResult[]> =>
    ipcRenderer.invoke(IPC.videoSearch, query),
  // Progress arrives on onAssetProgress (jobId `video:<chartPath>`); the invoke itself only
  // resolves at the end of the job, and rejects with an abort message when videoCancel stops it.
  // chartType comes off the catalog row, as it does for artDownload: for a .sng the download
  // is staged next to the archive and repacked in, so the job stays 'running' through the
  // repack and only reports 'done' once the archive has been replaced.
  videoDownload: (req: {
    chartPath: string
    chartType: 'folder' | 'sng'
    videoId: string
  }): Promise<void> => ipcRenderer.invoke(IPC.videoDownload, req),
  // Stops the download running on that chart, keyed by chart path because that is all the two
  // calls share. Resolves once main has fired the abort, not once the download has unwound.
  // The download's own promise is where that lands.
  videoCancel: (chartPath: string): Promise<void> => ipcRenderer.invoke(IPC.videoCancel, chartPath),
  artSearch: (term: string): Promise<AlbumArtResult[]> => ipcRenderer.invoke(IPC.artSearch, term),
  // chartType comes straight off the chart's catalog row and picks the writer in main
  // (sibling file for a folder chart, archive repack for a .sng).
  artDownload: (req: {
    chartPath: string
    chartType: 'folder' | 'sng'
    url: string
  }): Promise<string> => ipcRenderer.invoke(IPC.artDownload, req),
  lyricsSearch: (req: { artist: string; track: string }): Promise<LyricsSearchResult[]> =>
    ipcRenderer.invoke(IPC.lyricsSearch, req),
  // .chart charts only. A .mid is rejected by main with a clear message, whether it sits in a
  // folder or inside a .sng. chartType comes off the catalog row, as it does for artDownload.
  lyricsInject: (req: {
    chartPath: string
    chartType: 'folder' | 'sng'
    syncedLyrics: string
  }): Promise<void> => ipcRenderer.invoke(IPC.lyricsInject, req),
  // Generated background PNG bytes produced by the renderer canvas are sent
  // to main for guarded writing into the chart.
  writeBackground: (req: {
    chartPath: string
    chartType: 'folder' | 'sng'
    data: Uint8Array
  }): Promise<void> => ipcRenderer.invoke(IPC.assetWriteBackground, req),
  // Batch "Complete missing": fills video/art/lyrics for up to 100 charts
  // sequentially in main. Progress arrives on onAssetProgress (jobId
  // 'asset-batch'); the invoke resolves as soon as the batch is queued and
  // rejects when a batch is already running.
  assetCompleteCharts: (paths: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.assetCompleteCharts, paths),
  assetBatchCancel: (): Promise<void> => ipcRenderer.invoke(IPC.assetBatchCancel),
  // Looks for a Clone Hero install the user already has, so a first run can offer their existing
  // songs folder by path instead of asking them to find it. Returns [] when there is nothing to
  // offer, including on platforms whose Clone Hero location has not been established.
  // A returned candidate may have chartCount 0: the folder is there but holds no charts.
  libraryDetect: (): Promise<LibraryCandidate[]> => ipcRenderer.invoke(IPC.libraryDetect),
  // Issue scanning: scans all configured library folders; progress arrives on
  // onAssetProgress. issuesLast returns the cached result from the last scan.
  issuesScan: (): Promise<ChartIssueRow[]> => ipcRenderer.invoke(IPC.issuesScan),
  // Stops the running scan. Resolves once main has fired the abort, not once the scan has
  // unwound. The scan's own promise is where that lands, and it REJECTS rather than resolving
  // with the rows it had reached. Treat that rejection as the cancel you asked for, not as a
  // failure; `issuesLast` still holds the previous complete report.
  issuesScanCancel: (): Promise<void> => ipcRenderer.invoke(IPC.issuesScanCancel),
  issuesLast: (): Promise<ChartIssueRow[] | null> => ipcRenderer.invoke(IPC.issuesLast),
  // Repairs one issue row and resolves with THAT CHART's fresh rows. The library-wide report is
  // not re-run. Every fix re-scans the chart afterwards and refuses to report success if the
  // Clone Hero chart hash moved, so a resolved promise means the chart is still playable with
  // everyone who has the original. Progress arrives on onAssetProgress under jobId
  // `fix:<chartPath>`; a video conversion takes 35-70 s, so expect to show it.
  issuesFix: (row: ChartIssueRow): Promise<ChartIssueRow[]> =>
    ipcRenderer.invoke(IPC.issuesFix, row),
  // Which issue codes Encore can repair, and for one it currently cannot, why, so a row can
  // offer the ffmpeg install instead of a button that fails. Ask once, before rendering rows.
  issuesFixable: (): Promise<FixableCode[]> => ipcRenderer.invoke(IPC.issuesFixable),
  // Stops the fix running on that chart. Resolves once main has fired the abort, not once the
  // fix has unwound. The fix's own promise is where that lands.
  issuesFixCancel: (chartPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.issuesFixCancel, chartPath),
  // What can still be undone, and what the undo history costs on disk. Every fix copies aside
  // what it replaces, so this is one entry per repair that has not yet been undone or cleared.
  // Newest first. `totalBytes` is what Settings shows beside the button that clears the lot.
  backupsList: (): Promise<{ backups: FixBackup[]; totalBytes: number }> =>
    ipcRenderer.invoke(IPC.backupsList),
  // Puts one repair's original back and resolves with that chart's fresh rows, exactly as
  // issuesFix does. It REJECTS rather than restoring when the chart has changed since the repair
  // That is the designed answer, not a failure to work around: writing the original over a file
  // something else has since replaced would be a second irreversible loss. Progress arrives on
  // onAssetProgress under jobId `undo:<id>`.
  backupsRestore: (id: string): Promise<{ chartPath: string; rows: ChartIssueRow[] }> =>
    ipcRenderer.invoke(IPC.backupsRestore, id),
  // Deletes every backup. After this nothing that has been repaired can be undone, which is why
  // the UI asks first.
  backupsClear: (): Promise<void> => ipcRenderer.invoke(IPC.backupsClear),
  // Shows a system save-file dialog pre-filled with defaultName, then writes
  // content to the chosen path. Returns the path on success or null if canceled.
  saveTextFile: (req: { defaultName: string; content: string }): Promise<string | null> =>
    ipcRenderer.invoke(IPC.saveTextFile, req),
  // Asks Chorus whether it holds a different version of these charts; [] means the whole
  // library. This is never automatic, because each chart can cost a request against a
  // 50-per-minute limit, so it belongs behind something the user pressed. Progress arrives on
  // onUpdateProgress; the promise resolves with the finished verdicts.
  updatesCheck: (paths: string[] = []): Promise<UpdateCheckSummary> =>
    ipcRenderer.invoke(IPC.updatesCheck, { paths }),
  // The verdicts gathered so far this session, so a Library badge costs nothing. Not persisted:
  // it describes a remote index that moves, and a badge restored from disk could point at an
  // offer that no longer exists.
  updatesLast: (): Promise<ChartVerdict[]> => ipcRenderer.invoke(IPC.updatesLast),
  // Stops the running sweep. The sweep's own promise rejects with the abort.
  updatesCancel: (): Promise<void> => ipcRenderer.invoke(IPC.updatesCancel),
  // Updating Encore itself, which is not what the three calls above do: those ask Chorus about
  // chart versions. `appUpdateStatus` is a read of what main already knows and costs no network,
  // so a panel can mount on it and see the startup check's answer.
  appUpdateStatus: (): Promise<AppUpdateStatus> => ipcRenderer.invoke(IPC.appUpdateStatus),
  // Asks GitHub. Resolves with the finished status rather than rejecting, because a failed check
  // is one of the states the row draws. On a snap, or a build run from source, it resolves
  // straight back with the status saying why, without a request.
  appUpdateCheck: (): Promise<AppUpdateStatus> => ipcRenderer.invoke(IPC.appUpdateCheck),
  // Downloads the release the last check found; resolves once it is staged on disk, with
  // progress arriving on onAppUpdate meanwhile. Refused, by resolving unchanged, unless a check
  // found something to download.
  appUpdateDownload: (): Promise<AppUpdateStatus> => ipcRenderer.invoke(IPC.appUpdateDownload),
  // Quits Encore and applies the staged update. Resolves with false when nothing is staged; when
  // something is, the app is closing and the promise has nowhere to resolve to. On the deb this
  // is the point the system asks for a password.
  appUpdateInstall: (): Promise<boolean> => ipcRenderer.invoke(IPC.appUpdateInstall),
  // Clone Hero's own play data. `playStatus` is the gate: ask it before drawing anything, since
  // `available: false` is the ordinary answer for a user with no Clone Hero on this machine and
  // is a state to render rather than an error.
  playStatus: (): Promise<PlayDataStatus> => ipcRenderer.invoke(IPC.playStatus),
  // Summaries for the charts named by Clone Hero checksum (`cloneHeroChecksum` on ChartRecord).
  // A checksum with no play is omitted from the result rather than returned as zeroes, so the
  // result can be shorter than the input and is matched up by checksum.
  playSummaries: (checksums: string[]): Promise<ChartPlaySummary[]> =>
    ipcRenderer.invoke(IPC.playSummaries, checksums),
  // Every aggregate a stats view needs, in one call.
  playStats: (): Promise<PlayStats> => ipcRenderer.invoke(IPC.playStats),
  onDownloadUpdate: subscribe(IPC.evDownloadUpdate),
  onScanProgress: subscribe(IPC.evScanProgress),
  onAssetProgress: subscribe(IPC.evAssetProgress),
  onUpdateProgress: subscribe(IPC.evUpdateProgress),
  onAppUpdate: subscribe(IPC.evAppUpdate),
  // Fires when a NEW play is recorded, never for the repeated reads of an unchanged file. Carries
  // no payload: re-read whichever of the three calls above you are drawing.
  onPlayRecorded: subscribe(IPC.evPlayRecorded)
}

export type EncoreApi = typeof api

contextBridge.exposeInMainWorld('encore', api)
