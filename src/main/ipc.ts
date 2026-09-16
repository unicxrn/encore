import type { IpcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../shared/ipc-contract'
import {
  CatalogFacets,
  CatalogFilter,
  CatalogFilterSchema,
  ChartRecord,
  DownloadRequest,
  DownloadRequestSchema,
  QueuedDownload,
  Settings,
  SettingsSchema
} from '../shared/schemas'
import type { ChartRemoval } from '../shared/chart-removal'
import type { Favourite } from '../shared/favourites'
import { EDITABLE_INI_KEYS } from '../shared/metadata-fields'
import type {
  ChartMetadataRead,
  ChartMetadataSaved,
  ChartMetadataWriteRequest
} from './metadata/edit'
import type { DuplicateReport } from '../shared/duplicates'
import type { AlbumArtResult } from './assets/art'
import type { LyricsSearchResult } from './assets/lyrics'
import type { LyricLinesResult } from './catalog/lyric-lines'
import type { LibraryCandidate } from './catalog/detect-library'
import type { ChartIssueRow } from './catalog/issues'
import type { FixBackup } from './issues/backup-store'
import type { FixableCode } from './issues/fix'
import type { AppUpdateStatus } from '../shared/app-update'
import {
  LifetimeScoreRequestSchema,
  PlaySummaryRequestSchema,
  ScoreFolderRequestSchema,
  type ChartPlaySummary,
  type LifetimeScoreRequest,
  type LifetimeScores,
  type PlayDataStatus,
  type PlayInsights,
  type PlayStats,
  type ScoreFolderRequest
} from '../shared/play'
import type { ScoreFolderReport } from '../shared/score-folder'
import type { GameExecutableReport } from '../shared/game-launch'
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
  /** Every chart the user hearted, newest first. See shared/favourites.ts on what that keys on. */
  listFavourites: () => Favourite[]
  /**
   * Heart a chart or un-heart it, answering with the list as it now stands.
   *
   * The key arrives as the three fields a chart names itself by and is normalised in main, so a
   * renderer that sent the raw `song.ini` text and one that stripped it first store the same row.
   * Idempotent both ways: the row is a PRIMARY KEY, and un-hearting what was never hearted is not
   * an error to report to anybody.
   */
  setFavourite: (req: FavouriteWriteRequest) => Favourite[]
  /** Distinct values for the Installed view's filter pickers. Takes no arguments by design:
   * the lists describe the whole catalog, so narrowing them by the filter currently applied
   * would take options away as soon as they were used. */
  chartFacets: () => CatalogFacets
  /**
   * What the library holds more than one copy of, in three separate relationships that are not
   * equally interesting (see shared/duplicates.ts). Synchronous: it is two grouped queries over
   * the catalog, so there is no job to start, nothing to cancel and no progress to report.
   *
   * Takes no arguments, and deliberately returns the whole report rather than a page of it. The
   * caller is drawing a summary of the library as a whole, and a paged answer could not say how
   * many groups there are without a second call that asks the same question again.
   */
  duplicateCharts: () => DuplicateReport
  /**
   * Show one chart in the system file manager. The only thing the duplicates report offers to
   * DO about a duplicate, and it is deliberately the smallest such thing: it opens a window,
   * changes nothing, and hands the decision to the user in the place where they can act on it.
   *
   * Refuses a path outside the configured library folders, on the same containment check the
   * writers use. A reveal cannot damage anything, but the path arrives from the renderer, and
   * handing an arbitrary one to the desktop shell is not a thing to do on trust.
   */
  revealChart: (path: string) => void
  /**
   * Move one chart to the OS Trash and drop its catalog row, in that order.
   *
   * The only thing in Encore that takes something away, so the shape of the answer matters as
   * much as the action: it resolves with what happened (`trashed`, or `already-gone` for a chart
   * that had already left the disk) and rejects when the trash itself failed, which is the case
   * where the chart is still there and the user has to be told rather than reassured.
   *
   * Refuses a path outside the configured library folders, on the same containment check the
   * writers and `revealChart` use. One path per call by design; see removeChart in
   * catalog/remove-chart.ts for the ordering argument.
   */
  removeChart: (path: string) => Promise<ChartRemoval>
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
  /**
   * The file picker behind the Clone Hero setting. Separate from `pickFolder` because it opens
   * on a file, and because the filter it offers is per platform: a `.exe` on Windows, anything on
   * Linux, where the game arrives as an AppImage or as an extension-less binary. `sender` is
   * passed for the reason `pickFolder` takes it, so the dialog attaches to the right window.
   */
  pickExecutable: (sender: unknown) => Promise<string | null>
  /**
   * What one path is, in the terms the setting needs before it stores anything.
   *
   * The Clone Hero half of what `scoreFolderReport` does for the score files, and it exists for
   * the same reason: a path stored without being checked fails silently, and the failure looks
   * exactly like the bug the setting was added to fix. An empty path asks about whatever is
   * stored, which is how the Settings row describes itself on mount.
   */
  gameExecutableReport: (req: { path: string }) => GameExecutableReport
  /**
   * Start Clone Hero, detached, and let go of it.
   *
   * Takes nothing: the path is the stored setting rather than something the renderer names, so
   * there is no payload to trust. It is re-inspected here before anything is spawned, because a
   * program that was checked when it was chosen can have been uninstalled since, and rejects with
   * the same sentence Settings would have shown rather than resolving on a launch that did not
   * happen.
   */
  launchGame: () => Promise<void>
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
  /**
   * The six editable `song.ini` fields as the file or the archive header actually holds them,
   * plus the seven gameplay keys the editor shows and refuses to touch.
   *
   * `chartType` is the renderer echoing the catalog row's own value back, exactly as
   * `readChartFiles` and the asset writers take it, so the read and the write that follows it
   * agree about the chart's shape without sniffing the path twice.
   */
  readChartMetadata: (path: string, chartType: 'folder' | 'sng') => Promise<ChartMetadataRead>
  /**
   * Write what the user typed into one chart, then re-index it.
   *
   * The field names are parsed against `EDITABLE_INI_KEYS` at this boundary and refused again in
   * `writeChartMetadata`, which also refuses any of the seven keys Clone Hero matches charts by
   * and re-scans the chart afterwards to prove neither identity moved. Resolves with what
   * changed and the chart's fresh catalog row; rejects, with a sentence the UI can show, on a
   * chart that has moved, a `.sng` that packs its own `song.ini`, a failed write, and a write
   * that landed as something other than what was asked for.
   */
  writeChartMetadata: (req: ChartMetadataWriteRequest) => Promise<ChartMetadataSaved>
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
  /**
   * Updating Encore itself. Three steps, each one something the user pressed.
   *
   * `appUpdateStatus` is the read: it never touches the network, so a panel can mount on it.
   * `appUpdateCheck` asks GitHub and resolves with the finished status; it does not reject, since
   * a failed check is a state the row has to draw rather than an exception. `appUpdateDownload`
   * fetches the release the last check found and resolves once it is staged, with progress
   * arriving on evAppUpdate meanwhile.
   *
   * `appUpdateInstall` quits the app, so it resolves with false when there is nothing staged and
   * otherwise does not resolve at all in a real build. On a target that cannot apply an update at
   * all, all four are still answered: the status says why, and the check is a no-op.
   */
  appUpdateStatus: () => AppUpdateStatus
  appUpdateCheck: () => Promise<AppUpdateStatus>
  appUpdateDownload: () => Promise<AppUpdateStatus>
  appUpdateInstall: () => boolean
  // Generic save dialog: shows a system save-file dialog and writes content
  // to the user-chosen path. Returns the path on success or null on cancel.
  // sender is passed so the dialog attaches to the correct window (same pattern as pickFolder).
  saveTextFile: (
    req: { defaultName: string; content: string },
    sender: unknown
  ) => Promise<string | null>
  /**
   * Clone Hero's own play data. All five are synchronous reads of the local catalog file, so
   * none of them returns a promise and none can fail in a way the caller has to handle.
   *
   * `playStatus` is the gate: it answers "is there anything here at all", and its `available:
   * false` is an ordinary state for most users rather than an error (see shared/play.ts). A
   * consumer that skips it and calls the others on a machine with no Clone Hero gets an empty
   * array and a zeroed stats object, which is correct but indistinguishable from "installed and
   * never played" — hence the gate.
   *
   * `playSummaries` takes checksums rather than chart paths: the checksum is what the play table
   * is keyed by, it is on every ChartRecord already, and taking paths would make this a second
   * place that has to know how a chart is identified. `playLifetime` takes them for the same
   * reason, and carries its own gate rather than sharing `playStatus`: the two sources are found
   * in different places and either can be present without the other.
   *
   * `playInsights` is the Stats tab's second read, and the only one of the four that also
   * touches `charts`: the history by day, how much of the library has a play on record, the
   * charters behind those plays, and the last few plays themselves.
   */
  playStatus: () => PlayDataStatus
  playSummaries: (checksums: string[]) => ChartPlaySummary[]
  playStats: () => PlayStats
  playInsights: () => PlayInsights
  /**
   * What Clone Hero's own score files say: a lifetime play count and a best score per chart, and
   * the totals over all of them. A read of the same catalog file, and equally unable to fail.
   *
   * One call rather than a status call, a totals call and a rows call, because all three come out
   * of the same two tables in the same moment and a screen showing a total that disagreed with
   * the rows under it would be worse than a slightly larger payload. `checksums` narrows the rows
   * to a rendered page; the totals ignore it on purpose (see shared/play.ts).
   */
  playLifetime: (req: LifetimeScoreRequest) => LifetimeScores
  /**
   * What a folder holds of Clone Hero's score files, by name.
   *
   * The setting that overrides the probe is stored only after this has said the folder is of some
   * use, which is the whole reason the call exists: a stored path that holds nothing would fail
   * silently for as long as the user left it there. An empty `folder` asks about wherever Encore
   * is reading now, so the same call answers "where are you looking" for a user who has not
   * overridden anything.
   */
  scoreFolderReport: (req: ScoreFolderRequest) => ScoreFolderReport
}

const WindowActionSchema = z.enum(['minimize', 'maximize', 'close'])
// Cap matches the renderer's realistic batch size (pages of 25); anything
// bigger is a bug or abuse, so reject at the boundary.
const ExistsByMetaSchema = z
  .array(z.object({ name: z.string(), artist: z.string(), charter: z.string() }))
  .max(250)
/**
 * A heart, as the renderer is allowed to name it.
 *
 * The same 400-character cap the metadata write uses, and here for the same reason: this is the
 * one channel that writes text of the renderer's choosing into the catalog, and a chart's three
 * names are nowhere near that long (96 characters is the longest `name` in the reference library).
 * The fields are nullish because a chart record carries null for a field its `song.ini` does not
 * set, and a chart with no artist and no charter is ordinary and still favouritable. What is not
 * optional is a name, and `isFavouritable` is where that is refused, after normalisation, because
 * a name of nothing but markup strips to '' and is the same case.
 */
const FavouriteWriteSchema = z.object({
  name: z.string().max(400).nullish(),
  artist: z.string().max(400).nullish(),
  charter: z.string().max(400).nullish(),
  favourite: z.boolean()
})
export type FavouriteWriteRequest = z.infer<typeof FavouriteWriteSchema>
const ChartTypeSchema = z.enum(['folder', 'sng'])
const ChartReadFilesSchema = z.object({
  path: z.string(),
  chartType: ChartTypeSchema
})
/**
 * A metadata save, as the renderer is allowed to name it.
 *
 * `fields` is a closed record: a key outside `EDITABLE_INI_KEYS` does not reach main at all, so
 * the seven keys `getChartHash` mixes in cannot be smuggled through this channel even before
 * `assertKeyIsNotHashed` refuses them at the writer. A partial object is the point rather than a
 * convenience: the form sends only what the user changed, and a key that is absent here is a
 * line the ini editor never looks at.
 *
 * The 400-character cap is well past anything real (the longest `name` in the reference library
 * is 96 characters) and is here so one channel cannot be used to grow a chart's ini without
 * bound. `min(1)` on the path catches a caller naming no chart at all.
 */
const ChartMetadataWriteSchema = z.object({
  path: z.string().min(1),
  chartType: ChartTypeSchema,
  fields: z.partialRecord(z.enum(EDITABLE_INI_KEYS), z.string().max(400))
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
/**
 * The path Settings asks about before storing it.
 *
 * Capped at a length no filesystem accepts anyway (Linux caps a path at 4096 bytes, Windows at
 * 32,767 with the extended prefix), so a hostile caller cannot turn one `stat` into a megabyte of
 * string. Empty is allowed and means "the stored one", the same shape `ScoreFolderRequestSchema`
 * uses. There is no containment check and there cannot be one: the whole point of the setting is
 * that Clone Hero lives outside every folder Encore knows about. Nothing is opened, nothing is
 * written, and the answer is metadata about a path the user picked themselves.
 */
const GameExecutableSchema = z.object({ path: z.string().max(32_767) })
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
  ipcMain.handle(IPC.catalogFacets, () => deps.chartFacets())
  // No payload: the list describes the whole table, and a renderer holding it as a set has
  // nothing to narrow it by.
  ipcMain.handle(IPC.favouritesList, () => deps.listFavourites())
  ipcMain.handle(IPC.favouritesSet, (_e, raw) => deps.setFavourite(FavouriteWriteSchema.parse(raw)))
  // No payload: the report describes the whole catalog. There is nothing here for the renderer
  // to name and so nothing to validate.
  ipcMain.handle(IPC.catalogDuplicates, () => deps.duplicateCharts())
  // The path goes to the desktop shell, so it is checked for containment in main before it gets
  // there (see `revealChart` in index.ts). The non-empty check catches a caller sending nothing
  // at all, which would otherwise mean "open the file manager on ''".
  ipcMain.handle(IPC.chartReveal, (_e, raw) => deps.revealChart(z.string().min(1).parse(raw)))
  // Same shape of payload and the same non-empty check, for a call that does rather more than
  // open a window. The containment check that actually protects anything is in main (see
  // `removeChart` in index.ts); this one only refuses a caller that named no chart at all.
  ipcMain.handle(IPC.chartRemove, (_e, raw) => deps.removeChart(z.string().min(1).parse(raw)))
  ipcMain.handle(IPC.downloadAdd, (_e, raw) => deps.addDownload(DownloadRequestSchema.parse(raw)))
  ipcMain.handle(IPC.downloadCancel, (_e, raw) => deps.cancelDownload(z.string().parse(raw)))
  ipcMain.handle(IPC.downloadRetry, (_e, raw) => deps.retryDownload(z.string().parse(raw)))
  ipcMain.handle(IPC.downloadList, () => deps.listDownloads())
  ipcMain.handle(IPC.downloadClearFinished, () => deps.clearFinishedDownloads())
  ipcMain.handle(IPC.windowControl, (e, raw) =>
    deps.windowControl(WindowActionSchema.parse(raw), e.sender)
  )
  ipcMain.handle(IPC.dialogPickFolder, (e) => deps.pickFolder(e.sender))
  // No payload, exactly as the folder picker has none: which filters a file dialog offers is
  // decided in main from the platform, so there is nothing here for the renderer to name.
  ipcMain.handle(IPC.dialogPickExecutable, (e) => deps.pickExecutable(e.sender))
  // An absent payload is the ordinary "tell me about the stored one" call, so undefined is parsed
  // as an empty path rather than rejected. Same shape, and same reason, as play:score-folder.
  ipcMain.handle(IPC.gameExecutable, (_e, raw) =>
    deps.gameExecutableReport(GameExecutableSchema.parse(raw ?? { path: '' }))
  )
  // No payload: the path this runs is the stored setting, not the renderer's to supply. A channel
  // that took one would be a channel for running an arbitrary program, which is the one thing
  // this feature must not become.
  ipcMain.handle(IPC.gameLaunch, () => deps.launchGame())
  ipcMain.handle(IPC.chartReadFiles, (_e, raw) => {
    const { path, chartType } = ChartReadFilesSchema.parse(raw)
    return deps.readChartFiles(path, chartType)
  })
  // Same payload as chart:read-files: the preview names a chart the same way for both.
  ipcMain.handle(IPC.chartLyricLines, (_e, raw) => {
    const { path, chartType } = ChartReadFilesSchema.parse(raw)
    return deps.readLyricLines(path, chartType)
  })
  // And again for the metadata read, which names a chart with the same two values. Reading is
  // safe on any path the user can open, so the containment check lives on the write below, where
  // it protects something.
  ipcMain.handle(IPC.chartReadMetadata, (_e, raw) => {
    const { path, chartType } = ChartReadFilesSchema.parse(raw)
    return deps.readChartMetadata(path, chartType)
  })
  // The field names are narrowed to `EDITABLE_INI_KEYS` here, so a renderer cannot name one of
  // the seven keys Clone Hero matches charts by even before the writer refuses it. Containment
  // is `assertUnderLibrary` at the write site, which both chart shapes go through.
  ipcMain.handle(IPC.chartWriteMetadata, (_e, raw) =>
    deps.writeChartMetadata(ChartMetadataWriteSchema.parse(raw))
  )
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
  // No payload on any of the four: which release channel this build belongs to, and how far a
  // check has got, are main's to know. There is nothing here for the renderer to name, so there
  // is nothing to validate, and a schema over `undefined` would be ceremony rather than a
  // boundary. The three that act are ordered, not independent: a download is refused unless a
  // check found something, and an install unless a download finished, both decided in the
  // service rather than by whichever button happens to be on screen.
  ipcMain.handle(IPC.appUpdateStatus, () => deps.appUpdateStatus())
  ipcMain.handle(IPC.appUpdateCheck, () => deps.appUpdateCheck())
  ipcMain.handle(IPC.appUpdateDownload, () => deps.appUpdateDownload())
  ipcMain.handle(IPC.appUpdateInstall, () => deps.appUpdateInstall())
  // No payload on the status or the aggregate: which file is watched and what is in the table
  // are main's to know, and there is nothing here for the renderer to name.
  ipcMain.handle(IPC.playStatus, () => deps.playStatus())
  // The only one of the four that takes anything. Each entry is checked to be a 32-character
  // hex digest and the list is capped at PLAY_SUMMARY_MAX, so a hostile or buggy caller cannot
  // turn one page render into an unbounded IN clause.
  ipcMain.handle(IPC.playSummaries, (_e, raw) =>
    deps.playSummaries(PlaySummaryRequestSchema.parse(raw))
  )
  ipcMain.handle(IPC.playStats, () => deps.playStats())
  ipcMain.handle(IPC.playInsights, () => deps.playInsights())
  // Same checksum validation as play:summaries, and the same cap, for the same reason: the
  // caller with the most to name is one rendered page of chart rows. An absent payload is the
  // ordinary "give me everything" call, so undefined is parsed as an empty request rather than
  // rejected.
  ipcMain.handle(IPC.playLifetime, (_e, raw) =>
    deps.playLifetime(LifetimeScoreRequestSchema.parse(raw ?? {}))
  )
  // A path from the renderer, and the one thing done with it is a directory listing. Nothing
  // here opens a file, and nothing anywhere writes into the folder: see play/read-only.test.ts.
  ipcMain.handle(IPC.playScoreFolder, (_e, raw) =>
    deps.scoreFolderReport(ScoreFolderRequestSchema.parse(raw ?? { folder: '' }))
  )
  ipcMain.handle(IPC.saveTextFile, (e, raw) => {
    const { defaultName, content } = SaveTextFileSchema.parse(raw)
    return deps.saveTextFile({ defaultName, content }, e.sender)
  })
}
