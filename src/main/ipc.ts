import type { IpcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../shared/ipc-contract'
import {
  CatalogFilter,
  CatalogFilterSchema,
  ChartRecord,
  DownloadRequest,
  DownloadRequestSchema,
  QueuedDownload,
  Settings,
  SettingsSchema
} from '../shared/schemas'
import type { AlbumArtResult } from './assets/art'
import type { LyricsSearchResult } from './assets/lyrics'
import type { LyricLinesResult } from './catalog/lyric-lines'
import type { LibraryCandidate } from './catalog/detect-library'
import type { ChartIssueRow } from './catalog/issues'
import type { FixBackup } from './issues/backup-store'
import type { FixableCode } from './issues/fix'
import type { ChartVerdict, UpdateCheckSummary } from '../shared/updates'
import { UpdateCheckRequestSchema } from '../shared/updates'
import type { SidecarName, SidecarStatus } from './sidecars/manager'
import { VIDEO_ID_RE, type VideoSearchResult } from './sidecars/ytdlp'

export interface IpcDeps {
  getSettings: () => Settings
  setSettings: (s: Settings) => void
  queryCharts: (f: CatalogFilter) => ChartRecord[]
  countCharts: (f: CatalogFilter) => number
  chartsExistByMeta: (keys: { name: string; artist: string; charter: string }[]) => boolean[]
  startScan: () => void
  /**
   * Abort the running library scan, if there is one. Resolves as soon as the signal has been
   * fired, not once the scan has unwound. Charts already in flight finish first.
   *
   * The outcome reaches the renderer on evScanProgress as a terminal `canceled` event, because
   * `startScan` never carried the scan's completion in the first place. Charts scanned before the
   * cancel keep their catalog rows: they were really read, and discarding them would leave an
   * existing library worse off than before the scan started.
   */
  cancelScan: () => void
  /**
   * Re-index the named charts and hand back their rows, for a caller that just changed them.
   *
   * Takes paths alone, with no chartType alongside them: unlike the asset writers, this is a
   * refresh of catalog rows that main has to look up regardless, so the chart's shape comes
   * from the row itself rather than from the renderer echoing it back. Paths with no row are
   * dropped, so the result can be shorter than the input and is matched up by path.
   */
  rescanCharts: (paths: string[]) => Promise<ChartRecord[]>
  addDownload: (r: DownloadRequest) => void
  cancelDownload: (md5: string) => void
  retryDownload: (md5: string) => void
  listDownloads: () => QueuedDownload[]
  clearFinishedDownloads: () => void
  windowControl: (action: 'minimize' | 'maximize' | 'close', sender: unknown) => void
  pickFolder: (sender: unknown) => Promise<string | null>
  readChartFiles: (
    path: string,
    chartType: 'folder' | 'sng'
  ) => Promise<{ fileName: string; data: Uint8Array }[]>
  /**
   * The chart's lyrics as timed lines for the preview overlay, or the reason it has none. Read
   * separately from `readChartFiles` rather than parsed out of the files that call already
   * copies across, so a .sng is read selectively and the renderer never parses a chart file.
   */
  readLyricLines: (path: string, chartType: 'folder' | 'sng') => Promise<LyricLinesResult>
  sidecarStatus: (name: SidecarName) => Promise<SidecarStatus>
  // Deps are pre-wired with a send callback so progress flows to the renderer.
  sidecarInstall: (name: SidecarName) => Promise<void>
  sidecarUpdate: (name: SidecarName) => Promise<void>
  searchVideos: (query: string) => Promise<VideoSearchResult[]>
  downloadVideo: (req: {
    chartPath: string
    chartType: 'folder' | 'sng'
    videoId: string
  }) => Promise<void>
  // Aborts the per-chart download running on that path, if there still is one. The download's
  // own invoke rejects with the abort; this one resolves as soon as the signal has been fired.
  cancelVideoDownload: (chartPath: string) => void
  searchAlbumArt: (term: string) => Promise<AlbumArtResult[]>
  downloadArt: (req: {
    chartPath: string
    chartType: 'folder' | 'sng'
    url: string
  }) => Promise<string>
  searchLyrics: (req: { artist: string; track: string }) => Promise<LyricsSearchResult[]>
  injectLyrics: (req: {
    chartPath: string
    chartType: 'folder' | 'sng'
    syncedLyrics: string
  }) => Promise<void>
  writeBackground: (req: {
    chartPath: string
    chartType: 'folder' | 'sng'
    data: Uint8Array
  }) => Promise<void>
  // Batch "Complete missing" pipeline: starts the sequential asset queue (may
  // throw when a batch is already running) / cancels the running batch.
  assetCompleteCharts: (paths: string[]) => void
  assetBatchCancel: () => void
  // First-run probe for a Clone Hero install the user already has. Synchronous and bounded
  // (see CHART_COUNT_CAP) because the welcome view awaits it before it can say anything useful.
  detectLibraries: () => LibraryCandidate[]
  // Issue scanning: scans all library folders; issuesLast returns the cached report.
  scanIssues: () => Promise<ChartIssueRow[]>
  // Aborts the running scan, if there is one. The scan's own invoke rejects with the
  // cancellation rather than resolving with a partial report; this one resolves as soon as the
  // signal has been fired. `lastIssues` is deliberately unaffected: the previous complete
  // report is still the last thing that was actually finished.
  cancelIssueScan: () => void
  lastIssues: () => ChartIssueRow[] | null
  // Fix actions. fixIssue repairs one row and resolves with that chart's fresh rows. It does
  // NOT re-run the library report, which takes 3.4 s and would say nothing the per-chart re-scan
  // has not already said. Progress rides on evAssetProgress under jobId `fix:<chartPath>`.
  fixIssue: (row: ChartIssueRow) => Promise<ChartIssueRow[]>
  fixableIssueCodes: () => Promise<FixableCode[]>
  // Aborts the fix running on that path, if there still is one. The fix's own invoke rejects
  // with the cancellation; this one resolves as soon as the signal has been fired.
  cancelIssueFix: (chartPath: string) => void
  /**
   * Ask Chorus whether it holds a different version of these charts; empty means the whole
   * library. Resolves once the sweep has finished, unlike the library scan, because the caller
   * needs the answers; progress arrives on evUpdateProgress meanwhile.
   */
  checkUpdates: (paths: string[]) => Promise<UpdateCheckSummary>
  /** The verdicts this session has accumulated, so a Library badge costs no API request. */
  lastUpdates: () => ChartVerdict[]
  cancelUpdateCheck: () => void
  /**
   * Undo. `listFixBackups` returns the whole manifest per entry rather than a trimmed summary:
   * every field on it is small (the bytes live in blobs the renderer never sees) and a second
   * shape would be a second thing to keep in step with the store.
   *
   * `restoreFixBackup` resolves with the chart it restored and that chart's fresh issue rows, so
   * the Issues tab can update in place. It rejects rather than restoring when the chart has
   * changed since the repair. See issues/restore.ts for the three checks it makes first.
   */
  listFixBackups: () => { backups: FixBackup[]; totalBytes: number }
  restoreFixBackup: (id: string) => Promise<{ chartPath: string; rows: ChartIssueRow[] }>
  clearFixBackups: () => void
  // Generic save dialog: shows a system save-file dialog and writes content
  // to the user-chosen path. Returns the path on success or null on cancel.
  // sender is passed so the dialog attaches to the correct window (same pattern as pickFolder).
  saveTextFile: (
    req: { defaultName: string; content: string },
    sender: unknown
  ) => Promise<string | null>
}

const WindowActionSchema = z.enum(['minimize', 'maximize', 'close'])
// Cap matches the renderer's realistic batch size (pages of 25); anything
// bigger is a bug or abuse, so reject at the boundary.
const ExistsByMetaSchema = z
  .array(z.object({ name: z.string(), artist: z.string(), charter: z.string() }))
  .max(250)
const ChartTypeSchema = z.enum(['folder', 'sng'])
const ChartReadFilesSchema = z.object({
  path: z.string(),
  chartType: ChartTypeSchema
})
// Both sidecars accept all three operations. install/update used to be narrowed to 'ytdlp'
// because ffmpeg ships as an archive and nothing could extract it; unzip.ts closed that hole.
const SidecarNameSchema = z.enum(['ytdlp', 'ffmpeg'])
const VideoSearchQuerySchema = z.string().min(1).max(200)
// videoId shape is re-validated in ytdlp.ts before spawning (defense in depth);
// chartPath containment is enforced by assertUnderLibrary at the write site.
// chartType picks the destination: a folder yt-dlp writes into directly, or a staged download
// repacked into the archive. Same provenance as artDownload's: the catalog row, echoed back.
const VideoDownloadSchema = z.object({
  chartPath: z.string(),
  chartType: ChartTypeSchema,
  videoId: z.string().regex(VIDEO_ID_RE)
})
const ArtSearchTermSchema = z.string().min(1).max(200)
// chartType selects the writer (sibling file vs. archive repack). It is the renderer echoing
// back the catalog row's own value, not an independent judgement about the path; a wrong one
// costs a failed write, never a write outside the library (assertUnderLibrary runs either way).
const ArtDownloadSchema = z.object({
  chartPath: z.string(),
  chartType: ChartTypeSchema,
  url: z.string().url()
})
// artist may be empty (LRCLIB tolerates it); track is required. chartPath
// containment is enforced by assertUnderLibrary inside injectLyrics; the
// lyrics size cap keeps a hostile payload from ballooning a .chart file.
const LyricsSearchSchema = z.object({
  artist: z.string().max(200),
  track: z.string().min(1).max(200)
})
// chartType selects where the chart text is read from and written back to (a notes.chart on
// disk vs. an entry inside the archive), on the same terms as artDownload above: the renderer
// echoes the catalog row's value, and a wrong one costs a failed write, never an escape from
// the library guard.
const LyricsInjectSchema = z.object({
  chartPath: z.string(),
  chartType: ChartTypeSchema,
  syncedLyrics: z.string().min(1).max(100_000)
})
// Zod v4 z.instanceof(Uint8Array) is not reliably preserved across the
// structured-clone boundary in real IPC (the buffer is cloned as a plain
// ArrayBuffer-backed Uint8Array but passes instanceof). For the fake-IPC
// tests it works too.  We validate the type manually after a passthrough
// schema so the boundary stays honest and the size cap is always enforced.
const BG_MAX_BYTES = 20 * 1024 * 1024 // 20 MB
// Batch size cap matches the UI's "first 100" batching; per-path containment
// is enforced by assertUnderLibrary inside each asset writer.
const AssetCompleteSchema = z.array(z.string()).min(1).max(100)
// Same cap as the batch above, because the batch is the caller with the most paths to refresh.
// Nothing here writes, so a path outside the library costs a lookup that finds no row.
const RescanChartsSchema = z.array(z.string()).min(1).max(100)
const WriteBackgroundSchema = z.object({ chartPath: z.string(), chartType: ChartTypeSchema })
/**
 * One issue row, as the renderer sends it back to be fixed.
 *
 * Annotated with the main-process type rather than merely resembling it, so a field added to
 * `ChartIssueRow` that this forgets fails to compile instead of arriving as `undefined` at an
 * action that reads it. The description is validated because `badVideo`'s action reads the file
 * name out of it (see actions/bad-video.ts); its length cap is generous because a `scanFailed`
 * row carries whatever an exception said. There is no path containment check here, because
 * every write inside a fix goes through `assertUnderLibrary`, and a path outside it finds no
 * chart to scan.
 */
const IssueRowSchema: z.ZodType<ChartIssueRow> = z.object({
  chartPath: z.string().min(1),
  kind: z.enum(['folder', 'metadata', 'chart']),
  code: z.string().min(1).max(200),
  description: z.string().max(10_000)
})
// defaultName must not contain path separators or ".." to prevent path-traversal
// confusion (the user's chosen path is always used, so this is belt-and-suspenders).
// content is capped at 10 MB (generous for any CSV we'd ever produce).
const SaveTextFileSchema = z.object({
  defaultName: z
    .string()
    .min(1)
    .max(120)
    .refine((s) => !s.includes('/') && !s.includes('\\') && !s.includes('..'), {
      message: 'defaultName must not contain path separators or ".."'
    }),
  content: z.string().max(10_000_000)
})

export function registerIpc(ipcMain: IpcMain, deps: IpcDeps): void {
  ipcMain.handle(IPC.settingsGet, () => deps.getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, raw) => deps.setSettings(SettingsSchema.parse(raw)))
  ipcMain.handle(IPC.catalogQuery, (_e, raw) =>
    deps.queryCharts(CatalogFilterSchema.parse(raw ?? {}))
  )
  ipcMain.handle(IPC.catalogCount, (_e, raw) =>
    deps.countCharts(CatalogFilterSchema.parse(raw ?? {}))
  )
  ipcMain.handle(IPC.catalogScan, () => deps.startScan())
  ipcMain.handle(IPC.catalogScanCancel, () => deps.cancelScan())
  ipcMain.handle(IPC.catalogRescanCharts, (_e, raw) =>
    deps.rescanCharts(RescanChartsSchema.parse(raw))
  )
  ipcMain.handle(IPC.catalogExistsByMeta, (_e, raw) =>
    deps.chartsExistByMeta(ExistsByMetaSchema.parse(raw))
  )
  ipcMain.handle(IPC.downloadAdd, (_e, raw) => deps.addDownload(DownloadRequestSchema.parse(raw)))
  ipcMain.handle(IPC.downloadCancel, (_e, raw) => deps.cancelDownload(z.string().parse(raw)))
  ipcMain.handle(IPC.downloadRetry, (_e, raw) => deps.retryDownload(z.string().parse(raw)))
  ipcMain.handle(IPC.downloadList, () => deps.listDownloads())
  ipcMain.handle(IPC.downloadClearFinished, () => deps.clearFinishedDownloads())
  ipcMain.handle(IPC.windowControl, (e, raw) =>
    deps.windowControl(WindowActionSchema.parse(raw), e.sender)
  )
  ipcMain.handle(IPC.dialogPickFolder, (e) => deps.pickFolder(e.sender))
  ipcMain.handle(IPC.chartReadFiles, (_e, raw) => {
    const { path, chartType } = ChartReadFilesSchema.parse(raw)
    return deps.readChartFiles(path, chartType)
  })
  // Same payload as chart:read-files: the preview names a chart the same way for both.
  ipcMain.handle(IPC.chartLyricLines, (_e, raw) => {
    const { path, chartType } = ChartReadFilesSchema.parse(raw)
    return deps.readLyricLines(path, chartType)
  })
  ipcMain.handle(IPC.sidecarStatus, (_e, raw) => deps.sidecarStatus(SidecarNameSchema.parse(raw)))
  ipcMain.handle(IPC.sidecarInstall, (_e, raw) => deps.sidecarInstall(SidecarNameSchema.parse(raw)))
  ipcMain.handle(IPC.sidecarUpdate, (_e, raw) => deps.sidecarUpdate(SidecarNameSchema.parse(raw)))
  ipcMain.handle(IPC.videoSearch, (_e, raw) => deps.searchVideos(VideoSearchQuerySchema.parse(raw)))
  ipcMain.handle(IPC.videoDownload, (_e, raw) => deps.downloadVideo(VideoDownloadSchema.parse(raw)))
  // Only ever a map lookup in main, so no containment check: a path with no download registered
  // under it cancels nothing. The non-empty check is here to catch a caller sending nothing at
  // all, which would otherwise silently mean "cancel the chart at ''".
  ipcMain.handle(IPC.videoCancel, (_e, raw) =>
    deps.cancelVideoDownload(z.string().min(1).parse(raw))
  )
  ipcMain.handle(IPC.artSearch, (_e, raw) => deps.searchAlbumArt(ArtSearchTermSchema.parse(raw)))
  ipcMain.handle(IPC.artDownload, (_e, raw) => deps.downloadArt(ArtDownloadSchema.parse(raw)))
  ipcMain.handle(IPC.lyricsSearch, (_e, raw) => deps.searchLyrics(LyricsSearchSchema.parse(raw)))
  ipcMain.handle(IPC.lyricsInject, (_e, raw) => deps.injectLyrics(LyricsInjectSchema.parse(raw)))
  ipcMain.handle(IPC.assetWriteBackground, (_e, raw) => {
    const { chartPath, chartType } = WriteBackgroundSchema.parse(raw)
    // Validate the data field manually: z.instanceof is schema-correct but a
    // plain runtime check is clearer for the size guard.
    const data: unknown = (raw as Record<string, unknown>).data
    if (!(data instanceof Uint8Array)) {
      throw new Error('asset:write-background: data must be a Uint8Array')
    }
    if (data.byteLength > BG_MAX_BYTES) {
      throw new Error(`asset:write-background: data exceeds 20 MB limit (${data.byteLength} bytes)`)
    }
    return deps.writeBackground({ chartPath, chartType, data })
  })
  ipcMain.handle(IPC.assetCompleteCharts, (_e, raw) =>
    deps.assetCompleteCharts(AssetCompleteSchema.parse(raw))
  )
  ipcMain.handle(IPC.assetBatchCancel, () => deps.assetBatchCancel())
  // No payload: home and platform are main's to decide, not the renderer's.
  ipcMain.handle(IPC.libraryDetect, () => deps.detectLibraries())
  // No payload: always scans the settings' library folders (roots resolved in main/index.ts via dep).
  ipcMain.handle(IPC.issuesScan, () => deps.scanIssues())
  // No payload: there is only ever one library-wide scan, so there is nothing to identify.
  ipcMain.handle(IPC.issuesScanCancel, () => deps.cancelIssueScan())
  ipcMain.handle(IPC.issuesLast, () => deps.lastIssues())
  ipcMain.handle(IPC.issuesFix, (_e, raw) => deps.fixIssue(IssueRowSchema.parse(raw)))
  // No payload: which codes have an action, and whether the tools they need are present, are
  // both main's to know.
  ipcMain.handle(IPC.issuesFixable, () => deps.fixableIssueCodes())
  // Only ever a map lookup in main, so no containment check: a path with no fix registered
  // under it cancels nothing. The non-empty check catches a caller sending nothing at all,
  // which would otherwise mean "cancel the chart at ''".
  ipcMain.handle(IPC.issuesFixCancel, (_e, raw) =>
    deps.cancelIssueFix(z.string().min(1).parse(raw))
  )
  ipcMain.handle(IPC.updatesCheck, (_e, raw) =>
    deps.checkUpdates(UpdateCheckRequestSchema.parse(raw ?? {}).paths)
  )
  ipcMain.handle(IPC.updatesLast, () => deps.lastUpdates())
  // No payload: there is only ever one sweep in flight, the same as the issue scan.
  ipcMain.handle(IPC.updatesCancel, () => deps.cancelUpdateCheck())
  // No payload: the store is main's, and there is only one of it.
  ipcMain.handle(IPC.backupsList, () => deps.listFixBackups())
  // The id becomes a directory name inside userData, so the shape is checked here as well as in
  // `backupDirPath`, which is what actually refuses to resolve anything that is not one. The cap
  // is generous against the 20-odd characters `newBackupId` produces.
  ipcMain.handle(IPC.backupsRestore, (_e, raw) =>
    deps.restoreFixBackup(z.string().min(1).max(100).parse(raw))
  )
  // No payload: clearing is all or nothing, which is what the Settings panel offers.
  ipcMain.handle(IPC.backupsClear, () => deps.clearFixBackups())
  ipcMain.handle(IPC.saveTextFile, (e, raw) => {
    const { defaultName, content } = SaveTextFileSchema.parse(raw)
    return deps.saveTextFile({ defaultName, content }, e.sender)
  })
}
