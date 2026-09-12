import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { ENCORE_TMP_DIR, ENCHOR_FILES_URL } from '../shared/constants'
import { IPC } from '../shared/ipc-contract'
import { resolveChartFolderName } from '../shared/naming'
import type { ChartRecord } from '../shared/schemas'
import { isUnderLibrary } from './assets/library-guard'
import { sweepOrphanArt } from './catalog/art-cache'
import { readChartFiles } from './catalog/chart-files'
import { readLyricLines } from './catalog/lyric-lines'
import { detectChartLibraries } from './catalog/detect-library'
import { openCatalog, type CatalogDb } from './catalog/db'
import { findDuplicates } from './catalog/duplicates'
import {
  chartFacets,
  chartsExistByMeta,
  countCharts,
  getChartByPath,
  queryCharts
} from './catalog/queries'
import { ScanRunner } from './catalog/scan-runner'
import { cancelLibraryScan, scanChart, scanLibrary, type ScanSummary } from './catalog/scanner'
import { cancelIssueScan, scanIssues, lastIssueReport } from './catalog/issues'
import { LibraryWatcher } from './catalog/watcher'
import { scoreDataPaths, scoreStatsPath } from './play/location'
import { chartPlaySummaries, countPlays, playInsights, playStats, recordPlay } from './play/store'
import {
  chartLifetimes,
  countScoreCharts,
  importScoreBests,
  lifetimeTotals
} from './play/score-store'
import { ScoreFileWatcher } from './play/score-watcher'
import { PlayWatcher } from './play/watcher'
import { runDownload } from './downloads/download'
import { DownloadManager } from './downloads/manager'
import { sweepTmpDir } from './downloads/sweep'
import { ART_CACHE_VERSION, encodeAlbumArt, encodeSquareAlbumArt } from './art-encode'
import { registerArtProtocol, registerArtScheme } from './art-protocol'
import { convertToWebm } from './ffmpeg/convert'
import { locateFfmpeg, type FfmpegLocation } from './ffmpeg/locate'
import { backupStoreBytes, clearBackups, listBackups } from './issues/backup-store'
import { cancelFix, fixableCodes, runFix, type VideoConverter } from './issues/fix'
import { restoreBackup } from './issues/restore'
import { registerIpc } from './ipc'
import { AppUpdateService } from './app-update/service'
import { detectUpdateTarget } from './app-update/target'
import { UpdateService } from './updates/service'
import { loadSettings, saveSettings } from './settings'
import type { JobProgress } from './shared-types'
import { downloadArt, searchAlbumArt } from './assets/art'
import { writeBackground } from './assets/background'
import { AssetJobQueue } from './assets/batch'
import { injectLyrics, searchLyrics } from './assets/lyrics'
import { defaultSidecarSources, SidecarManager } from './sidecars/manager'
import {
  cancelChartVideoDownload,
  downloadVideo,
  downloadVideoForChart,
  searchVideos
} from './sidecars/ytdlp'

/**
 * Why a located ffmpeg cannot be used, in words the Issues tab can show, or null when it can.
 *
 * The two reasons need different sentences because they need different actions from the user:
 * nothing installed is answered by the managed download, while an ffmpeg that runs but lacks
 * libvpx/libvorbis is a system build that will not be fixed by installing it again, so Encore's
 * own copy has to be used instead. Telling a user with a working ffmpeg on PATH that ffmpeg is
 * "not installed" would send them looking in the wrong place.
 *
 * Neither sentence names a tab any more. The Issues tab prints these beside an Install button, so
 * "install it from Settings → Tools" would be directing the user away from the answer they are
 * already looking at.
 */
function ffmpegUnavailableReason(location: FfmpegLocation): string | null {
  if (location.ok) return null
  return location.reason === 'missing-encoders'
    ? 'The ffmpeg on this system cannot encode VP8 or Vorbis, which Clone Hero needs. Encore can install its own copy, which can.'
    : 'Converting a video needs ffmpeg, which is not installed. Encore can download and verify its own copy.'
}

/**
 * Best-effort cleanup of download staging dirs left by a previous session.
 * Fresh .part files are kept so interrupted downloads resume across restarts.
 */
function sweepStaleTmpDirs(libraryFolders: { path: string }[]): void {
  for (const folder of libraryFolders) {
    sweepTmpDir(join(folder.path, ENCORE_TMP_DIR))
  }
}

/**
 * The `package-type` marker electron-builder writes into a packaged app's resources directory,
 * or null when there is none.
 *
 * Only its FpmTarget writes it, and only for the formats that target produces, so an AppImage and
 * a snap both come back null. This is the same file electron-updater reads to decide between
 * AppImageUpdater and DebUpdater; reading it here is what lets Settings say which of the two will
 * run before anything is downloaded.
 *
 * Never throws. A missing file is the normal answer for two of the four targets Encore builds,
 * and an unreadable one has to mean the same thing as a missing one: not deb.
 */
function readPackageTypeMarker(): string | null {
  try {
    return readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim()
  } catch {
    return null
  }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0a0a0e',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Where cached album art lives: written by the scanner, read by the encore-art protocol.
 *
 * One expression in one place. If the writer and the reader disagreed about the path, that would
 * present as covers that scan without error and then never appear anywhere in the UI.
 *
 * Versioned by the encode settings: nothing re-encodes a cover that is already cached, so
 * without that segment a change to ART_MAX_EDGE or ART_JPEG_QUALITY would leave every
 * already-scanned user on the old rendition, with no in-app way to refresh it.
 */
function artCacheDir(): string {
  return join(app.getPath('userData'), 'art', ART_CACHE_VERSION)
}

/**
 * Where the originals an issue fix replaces are kept, so a fix can be undone.
 *
 * Alongside the art cache and for the same reason: it is derived data about the user's library
 * that belongs to this installation, not to the library folder, and putting it inside the library
 * would put it in front of the scanner, the watcher and every backup tool the user points at their
 * charts.
 *
 * Deliberately NOT versioned the way `artCacheDir` is. A version segment there is what lets a
 * changed encoder re-render every cover; here it would strand the user's undo history in a
 * directory nothing lists and nothing sweeps. The manifest is validated on read instead
 * (`listBackups`), so a shape this build does not understand is skipped rather than orphaned.
 */
function fixBackupDir(): string {
  return join(app.getPath('userData'), 'fix-backups')
}

/**
 * Delete cached covers that no catalog row references any more.
 *
 * Runs after a scan because that is the only moment `keep` is authoritative: a chart deleted
 * from disk holds its cover in the cache until the scan that drops its row.
 *
 * Skipped when the scan found no charts at all. An unmounted library root walks to nothing,
 * scanLibrary then deletes every row under it, and `keep` would come back empty. Sweeping on
 * that would clear the whole cache because a drive was not plugged in. Nothing is lost
 * permanently either way (a rescan re-encodes every cover), but the re-encode is minutes of
 * work on a large library. The guard's own cost: a library that genuinely drops to zero charts
 * keeps its cached covers, and nothing else reclaims them. The partial case is not covered:
 * with two roots configured and one unmounted, that root's covers still go and come back on
 * its next scan.
 *
 * Never throws: the scan itself succeeded, and a failure to reclaim disk space must not be
 * reported to the renderer as a failed scan.
 */
function sweepArtCache(db: CatalogDb, artDir: string, summary: ScanSummary): void {
  if (summary.found === 0) return
  try {
    const rows = db
      .prepare('SELECT DISTINCT albumArtMd5 FROM charts WHERE albumArtMd5 IS NOT NULL')
      .all() as { albumArtMd5: string }[]
    sweepOrphanArt(artDir, new Set(rows.map((r) => r.albumArtMd5)))
  } catch (err) {
    console.error('Album art sweep failed:', err)
  }
}

function wireIpc(): {
  db: CatalogDb
  watcher: LibraryWatcher
  plays: PlayWatcher
  scoreFiles: ScoreFileWatcher
  appUpdates: AppUpdateService
} {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  const db = openCatalog(join(app.getPath('userData'), 'catalog.db'))
  const artDir = artCacheDir()
  sweepStaleTmpDirs(loadSettings(settingsPath).libraryFolders)

  const send = (channel: string, data: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, data)
  }

  // Never two scans at once, and never a lost one: a start arriving mid-scan queues a single
  // follow-up, so a download landing mid-scan still shows up without a manual rescan. A cancel
  // drops that queue. The rules, and why, are in catalog/scan-runner.ts, which is also where
  // they are tested (this function cannot be imported outside Electron).
  const scanner = new ScanRunner({
    run: () => {
      const folders = loadSettings(settingsPath).libraryFolders.map((f) => f.path)
      return (
        scanLibrary(db, folders, (p) => send(IPC.evScanProgress, p), {
          dir: artDir,
          encode: encodeAlbumArt
        })
          // Skipped on a cancel, which rejects instead of resolving: the sweep decides what to
          // delete from "no row references it", and a scan stopped partway has not finished
          // saying which rows there are.
          .then((summary) => sweepArtCache(db, artDir, summary))
      )
    },
    abort: () => cancelLibraryScan(),
    // A rejection before the per-chart loop would otherwise leave the renderer without a terminal
    // event (scan UI stuck at "discovering"). A cancel never lands here, because scanLibrary has
    // already sent its own terminal `canceled` event and ScanRunner filters it out.
    onError: (err: unknown) => {
      const progress: JobProgress = {
        jobId: 'scan',
        kind: 'scan',
        phase: 'error',
        percent: null,
        message: err instanceof Error ? err.message : String(err),
        status: 'error'
      }
      send(IPC.evScanProgress, progress)
    }
  })
  const runScan = (): void => scanner.start()

  // Concurrency is read once at startup; restart the app to apply a changed setting.
  const manager = new DownloadManager({
    concurrency: loadSettings(settingsPath).downloadConcurrency,
    runner: (input, onProgress, signal) => {
      const settings = loadSettings(settingsPath)
      const dest = settings.libraryFolders.find((f) => f.isDefault) ?? settings.libraryFolders[0]
      if (!dest) return Promise.reject(new Error('No library folder configured'))
      return runDownload(
        {
          url: input.url,
          folderName: input.folderName,
          format: settings.downloadFormat,
          destDir: dest.path,
          // Same volume as the library: renameSync stays atomic, no EXDEV.
          tmpDir: join(dest.path, ENCORE_TMP_DIR),
          tmpKey: input.md5,
          signal
        },
        onProgress
      )
    }
  })
  manager.onUpdate((items) => send(IPC.evDownloadUpdate, items))

  const watcher = new LibraryWatcher({ onChange: runScan })

  /**
   * Clone Hero's play data, watched wherever this platform keeps it.
   *
   * The path is resolved once at startup rather than per read: the user does not move their
   * Clone Hero install while Encore is open, and re-probing on every status call would put a
   * disk hit behind a call the UI makes on mount. `homedir()` and `process.platform` enter here
   * and nowhere else, the same arrangement detectChartLibraries uses, so the resolver stays
   * testable across platforms this machine is not.
   *
   * Nothing about this can fail loudly. A machine with no Clone Hero — which is most of them —
   * resolves a path that does not exist, watches nothing, and reports `available: false`. That
   * is a state the UI draws, not an error anyone has to see.
   */
  const plays = new PlayWatcher({
    path: scoreStatsPath(homedir(), process.platform, existsSync, app.getPath('documents')),
    record: (play) => recordPlay(db, play),
    onPlay: () => send(IPC.evPlayRecorded, undefined)
  })

  /**
   * Clone Hero's own score files, in Unity's data directory rather than the game's own.
   *
   * A second watcher rather than another job for the one above, because the two files live
   * somewhere else entirely (play/location.ts), say something else, and land in their own tables.
   * The import runs once here at startup, which is the only moment a play made while Encore was
   * closed can be picked up, and again whenever the game rewrites either file.
   *
   * It reuses evPlayRecorded rather than adding an event of its own. The event carries no payload
   * and means "the play data on screen is out of date, read it again", which is exactly what a
   * fresh import makes true; a second event would be a second thing every consumer has to
   * subscribe to in order to learn the same thing.
   */
  const scoreFiles = new ScoreFileWatcher({
    paths: scoreDataPaths(homedir(), process.platform, existsSync),
    importCharts: (charts) => importScoreBests(db, charts),
    onImport: () => send(IPC.evPlayRecorded, undefined)
  })

  // Named because two things need it: the sidecar manager installs into it, and locateFfmpeg
  // looks in it for the managed copy after PATH has been tried.
  const sidecarDir = join(app.getPath('userData'), 'sidecars')
  const sidecarManager = new SidecarManager({
    dir: sidecarDir,
    sources: defaultSidecarSources()
  })

  /**
   * The fix framework's video capability, wired to the real encoder.
   *
   * `issues/fix.ts` has never heard of ffmpeg; this is the only place the two meet. Located on
   * every call rather than once at startup: `locateFfmpeg` caches its own answer for the life of
   * the process and is invalidated after a managed install, so asking again is what lets a
   * just-installed ffmpeg be used without a restart.
   */
  const videoConverter: VideoConverter = {
    unavailableReason: async () => ffmpegUnavailableReason(await locateFfmpeg({ sidecarDir })),
    convert: async ({ input, output, signal, onProgress }) => {
      const located = await locateFfmpeg({ sidecarDir })
      if (!located.ok) throw new Error(ffmpegUnavailableReason(located) ?? 'ffmpeg is unavailable')
      await convertToWebm({ ffmpegPath: located.path, input, output, signal, onProgress })
    }
  }

  // Video features need the yt-dlp sidecar; a clear error lets the UI point
  // the user at Settings → Tools instead of surfacing a spawn ENOENT.
  const requireYtdlp = async (): Promise<string> => {
    const status = await sidecarManager.status('ytdlp')
    if (!status.installed) {
      throw new Error('yt-dlp is not installed. Install it in Settings, under Tools.')
    }
    return status.path
  }

  // Lyrics injection targets the chart FILE, but the catalog path (what the
  // renderer and the batch hold) is the chart FOLDER, so resolve notes.chart
  // inside it, preferring .chart. Explicit file paths (.chart/.mid) pass
  // through so injectLyrics can raise its own clear not-supported errors.
  //
  // A .sng needs no resolving: its catalog path IS the file injectLyrics opens, and it finds the
  // chart entry inside the archive itself. Decided by chartType rather than by the suffix, so
  // this agrees with the scanner instead of forming a second opinion.
  const resolveLyricsTarget = (chartPath: string, chartType: 'folder' | 'sng'): string => {
    if (chartType === 'sng') return chartPath
    if (/\.(chart|mid)$/i.test(chartPath)) return chartPath
    const files = readdirSync(chartPath)
    const notes =
      files.find((f) => /^notes\.chart$/i.test(f)) ?? files.find((f) => /^notes\.mid$/i.test(f))
    if (!notes) throw new Error('No notes.chart file found in the chart folder')
    return join(chartPath, notes)
  }

  // Batch "Complete missing" queue: video + art + lyrics only. Background
  // generation happens in the renderer (OffscreenCanvas), so it cannot run in
  // this main-process batch. It stays a per-chart UI action (UI chaining
  // after a batch is backlog).
  const assetQueue = new AssetJobQueue(
    {
      getChart: (path) => getChartByPath(db, path),
      searchVideos: async (query) => searchVideos(await requireYtdlp(), query),
      downloadVideo: async (chartPath, chartType, videoId, onProgress, signal) =>
        downloadVideo(
          await requireYtdlp(),
          videoId,
          chartPath,
          chartType,
          onProgress,
          signal,
          loadSettings(settingsPath).libraryFolders
        ),
      searchArt: (term) => searchAlbumArt(term),
      // The batch's writes keep what they replace exactly as the per-chart ones do, in the same
      // store the repairs use: a hundred covers replaced from iTunes is a hundred undos.
      downloadArt: (url, chartPath, chartType) =>
        downloadArt(
          url,
          chartPath,
          chartType,
          loadSettings(settingsPath).libraryFolders,
          fixBackupDir()
        ),
      searchLyrics: (artist, track) => searchLyrics(artist, track),
      injectLyrics: async (chartPath, chartType, lrc) =>
        injectLyrics(
          resolveLyricsTarget(chartPath, chartType),
          chartType,
          lrc,
          loadSettings(settingsPath).libraryFolders,
          fixBackupDir()
        ),
      ytdlpInstalled: async () => (await sidecarManager.status('ytdlp')).installed
    },
    (p: JobProgress) => send(IPC.evAssetProgress, p)
  )

  // Rows are read per sweep rather than captured here, so a scan that ran since the last check
  // is reflected. An empty `paths` is the whole library; anything else is the named charts, which
  // is how the Detail page checks one without spending the library's request budget.
  const updateService = new UpdateService({
    listCharts: (paths) =>
      paths.length === 0
        ? queryCharts(db, { search: '', offset: 0, limit: 500 })
        : paths.map((p) => getChartByPath(db, p)).filter((r): r is ChartRecord => r !== null),
    onProgress: (done, total) =>
      send(IPC.evUpdateProgress, {
        jobId: 'updates',
        kind: 'scan',
        phase: 'check',
        percent: total === 0 ? 100 : Math.round((done / total) * 100),
        message: `${done} of ${total}`,
        status: done === total ? 'done' : 'running'
      })
  })

  /**
   * Updating Encore itself.
   *
   * `autoUpdater` is a getter that constructs the right subclass on first access, so it is
   * touched here rather than at import time: the choice reads `process.resourcesPath` and the
   * app's own version, neither of which is settled before `whenReady`.
   *
   * Nothing about it is automatic despite the name. The service turns `autoDownload` and
   * `autoInstallOnAppQuit` off in its constructor, so a check reports and stops. The target is
   * probed once, here, because none of its inputs can change while the process runs.
   */
  const appUpdates = new AppUpdateService({
    updater: autoUpdater,
    target: detectUpdateTarget({
      platform: process.platform,
      packaged: app.isPackaged,
      env: process.env,
      readPackageType: readPackageTypeMarker
    }),
    currentVersion: app.getVersion(),
    onState: (status) => send(IPC.evAppUpdate, status),
    // The download's promise carries its outcome, but the percent between the two, and any error
    // electron-updater emits without rejecting, arrive only on its emitter.
    subscribe: ({ onProgress, onError }) => {
      autoUpdater.on('download-progress', (p) => onProgress(p.percent))
      autoUpdater.on('error', (err) => onError(err))
    }
  })

  registerIpc(ipcMain, {
    getSettings: () => loadSettings(settingsPath),
    setSettings: (s) => {
      const prev = loadSettings(settingsPath)
      saveSettings(settingsPath, s)
      // Restart the watcher if the library folders changed.
      const prevPaths = prev.libraryFolders.map((f) => f.path).sort()
      const nextPaths = s.libraryFolders.map((f) => f.path).sort()
      const foldersChanged =
        prevPaths.length !== nextPaths.length || prevPaths.some((p, i) => p !== nextPaths[i])
      if (foldersChanged) {
        watcher.start(s.libraryFolders.map((f) => f.path)).catch((err: unknown) => {
          console.error('LibraryWatcher restart failed:', err)
        })
      }
    },
    queryCharts: (f) => queryCharts(db, f),
    countCharts: (f) => countCharts(db, f),
    chartsExistByMeta: (keys) => chartsExistByMeta(db, keys),
    chartFacets: () => chartFacets(db),
    duplicateCharts: () => findDuplicates(db),
    // The library containment check is the same one the writers make, for a call that writes
    // nothing: the path arrives from the renderer, and `shell.showItemInFolder` hands it
    // straight to the desktop. `showItemInFolder` selects the chart inside its parent folder,
    // which is the useful view for both chart shapes: a folder chart's own folder, and a .sng
    // sitting among its neighbours.
    revealChart: (path) => {
      if (!isUnderLibrary(path, loadSettings(settingsPath).libraryFolders)) {
        throw new Error(`Refusing to open a path outside the library folders: ${path}`)
      }
      shell.showItemInFolder(path)
    },
    startScan: () => runScan(),
    cancelScan: () => scanner.cancel(),
    // Targeted re-index after an asset write. The alternative, waiting for the watcher's
    // debounce and then walking the whole library, is what the renderer used to guess a
    // delay for, and a guess that lands early shows the user "MISSING" on the asset they just
    // added. Going back through the scanner rather than patching flags in the renderer keeps
    // one definition of what hasVideo/hasAlbumArt/hasBackground/hasLyrics mean, and re-caches
    // the cover so a newly added album.png also gets a thumbnail.
    //
    // Failures are isolated per chart: a chart that no longer parses keeps whatever row it had,
    // exactly as it would in a full scan, and must not cost the other charts their refresh.
    rescanCharts: async (paths) => {
      const updated: ChartRecord[] = []
      for (const path of paths) {
        const row = getChartByPath(db, path)
        if (!row) continue
        try {
          await scanChart(
            db,
            { path, type: row.chartType },
            { dir: artDir, encode: encodeAlbumArt }
          )
        } catch (err) {
          console.error(`Rescan of ${path} failed:`, err)
        }
        updated.push(getChartByPath(db, path) ?? row)
      }
      return updated
    },
    addDownload: (r) => {
      const settings = loadSettings(settingsPath)
      return manager.add({
        md5: r.md5,
        url: `${ENCHOR_FILES_URL}/${r.md5}${
          r.hasVideoBackground && !settings.downloadVideos ? '_novideo' : ''
        }.sng`,
        folderName: resolveChartFolderName(settings.chartFolderName, r.meta)
      })
    },
    cancelDownload: (md5) => manager.cancel(md5),
    retryDownload: (md5) => manager.retry(md5),
    listDownloads: () => manager.list(),
    clearFinishedDownloads: () => manager.clearFinished(),
    readChartFiles: (path, chartType) => readChartFiles(path, chartType),
    readLyricLines: (path, chartType) => readLyricLines(path, chartType),
    pickFolder: async (sender) => {
      const win =
        BrowserWindow.fromWebContents(sender as Electron.WebContents) ??
        BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    windowControl: (action, sender) => {
      const win =
        BrowserWindow.fromWebContents(sender as Electron.WebContents) ??
        BrowserWindow.getFocusedWindow()
      if (!win) return
      if (action === 'minimize') win.minimize()
      else if (action === 'maximize') {
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
      } else win.close()
    },
    sidecarStatus: (name) => sidecarManager.status(name),
    sidecarInstall: (name) =>
      sidecarManager.install(name, (p: JobProgress) => send(IPC.evAssetProgress, p)),
    sidecarUpdate: (name) =>
      sidecarManager.update(name, (p: JobProgress) => send(IPC.evAssetProgress, p)),
    searchVideos: async (query) => {
      return searchVideos(await requireYtdlp(), query)
    },
    // downloadVideoForChart rather than downloadVideo: it files an AbortController under the
    // chart path so the cancel below has something to abort. The batch queue keeps supplying its
    // own signal (see its dep above), and its downloads are not the video button's to cancel.
    downloadVideo: async ({ chartPath, chartType, videoId }) => {
      const binPath = await requireYtdlp()
      return downloadVideoForChart(
        binPath,
        videoId,
        chartPath,
        chartType,
        (p: JobProgress) => send(IPC.evAssetProgress, p),
        loadSettings(settingsPath).libraryFolders
      )
    },
    cancelVideoDownload: (chartPath) => cancelChartVideoDownload(chartPath),
    searchAlbumArt: (term) => searchAlbumArt(term),
    // Every one of the three asset writers below keeps what it replaces in the repairs' store
    // (`fixBackupDir`), so the Issues tab can undo it. See assets/undoable-write.ts.
    downloadArt: ({ chartPath, chartType, url }) =>
      downloadArt(
        url,
        chartPath,
        chartType,
        loadSettings(settingsPath).libraryFolders,
        fixBackupDir()
      ),
    searchLyrics: ({ artist, track }) => searchLyrics(artist, track),
    // libraryFolders are read at call time so a settings change applies
    // without a restart (matches the art/video writers).
    // resolveLyricsTarget: the renderer sends the catalog (folder) path, but
    // injection needs the notes.chart file inside it.
    injectLyrics: async ({ chartPath, chartType, syncedLyrics }) =>
      injectLyrics(
        resolveLyricsTarget(chartPath, chartType),
        chartType,
        syncedLyrics,
        loadSettings(settingsPath).libraryFolders,
        fixBackupDir()
      ),
    // Renderer-generated background PNG bytes go through the same guarded writers as every
    // other asset. Awaited, not fire-and-forget: for a .sng this is a full repack, and
    // dropping the promise would resolve the renderer's invoke before the archive was rewritten,
    // reporting "BACKGROUND SAVED" over a write that could still fail.
    writeBackground: ({ chartPath, chartType, data }) =>
      writeBackground(
        chartPath,
        chartType,
        data,
        loadSettings(settingsPath).libraryFolders,
        fixBackupDir()
      ),
    assetCompleteCharts: (paths) => assetQueue.start(paths),
    assetBatchCancel: () => assetQueue.cancel(),
    // Issue scan: roots are resolved from settings at call time; progress
    // is forwarded over evAssetProgress (same channel as other asset jobs).
    scanIssues: () =>
      scanIssues(
        loadSettings(settingsPath).libraryFolders.map((f) => f.path),
        (p: JobProgress) => send(IPC.evAssetProgress, p)
      ),
    cancelIssueScan: () => cancelIssueScan(),
    // The one place the real home directory and platform enter the probe; detectChartLibraries
    // takes both as parameters so its tests can cover platforms this machine is not.
    // app.getPath('documents') goes through the Windows known-folder API, so a Documents folder
    // that OneDrive has redirected still resolves to where Clone Hero actually put the songs.
    detectLibraries: () =>
      detectChartLibraries(homedir(), process.platform, existsSync, app.getPath('documents')),
    lastIssues: () => lastIssueReport(),
    // Update checking. Rows come from the catalog at call time so a rescan since the last sweep
    // is picked up, and an empty `paths` means the whole library, the same "no payload means
    // everything" shape the issue scan uses.
    checkUpdates: (paths) => updateService.check(paths),
    lastUpdates: () => updateService.lastResults(),
    cancelUpdateCheck: () => updateService.cancel(),
    // One fix, on one chart. The invariant lives in applyFix: the chart is re-scanned afterwards
    // and this rejects rather than reporting success if the Clone Hero chart hash moved.
    // Progress reuses evAssetProgress rather than a second channel, so the renderer's existing
    // asset-progress plumbing carries it; the jobId is keyed by chart so two fixes cannot be
    // confused for one.
    fixIssue: async (row) => {
      const jobId = `fix:${row.chartPath}`
      const report = (
        phase: string,
        percent: number | null,
        status: JobProgress['status'] = 'running',
        message: string | null = null
      ): void =>
        send(IPC.evAssetProgress, { jobId, kind: 'asset', phase, percent, message, status })
      report('starting', null)
      try {
        const rows = await runFix(row, {
          libraryFolders: loadSettings(settingsPath).libraryFolders,
          // Every repair keeps what it replaces, so none of them is irreversible. See
          // issues/backup-store.ts; the undo itself is issues/restore.ts.
          backupDir: fixBackupDir(),
          video: videoConverter,
          image: encodeSquareAlbumArt,
          onProgress: (p) => report(p.phase, p.percent)
        })
        report('complete', 100, 'done')
        return rows
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // A cancel is not a failure, and the UI shows the two differently. The conversion path
        // is the only thing here that can be cancelled, and it says so in its message.
        const canceled = /cancell?ed/i.test(message)
        report('failed', null, canceled ? 'canceled' : 'error', message)
        throw err
      }
    },
    fixableIssueCodes: () =>
      fixableCodes({
        libraryFolders: loadSettings(settingsPath).libraryFolders,
        // Never read by an `availability` check, since none of them backs anything up, but the
        // field is required so a call site cannot silently mean "no undo" by omission.
        backupDir: fixBackupDir(),
        video: videoConverter,
        image: encodeSquareAlbumArt
      }),
    cancelIssueFix: (chartPath) => cancelFix(chartPath),
    listFixBackups: () => {
      const dir = fixBackupDir()
      return { backups: listBackups(dir), totalBytes: backupStoreBytes(dir) }
    },
    // Progress rides on evAssetProgress under a jobId keyed by the backup, exactly as a fix's does
    // under one keyed by chart, so the renderer's existing plumbing carries it and the undo button
    // says which of the three phases it is in rather than "Undoing…" for the length of a repack.
    // The terminal event matters as much as the running ones: without it a finished job would sit
    // in the renderer's store as permanently 'running'.
    // libraryFolders are read at call time, matching every other writer.
    restoreFixBackup: async (id) => {
      const jobId = `undo:${id}`
      const report = (
        phase: string,
        status: JobProgress['status'] = 'running',
        message: string | null = null
      ): void =>
        send(IPC.evAssetProgress, { jobId, kind: 'asset', phase, percent: null, message, status })
      try {
        const { backup, rows } = await restoreBackup(
          {
            storeDir: fixBackupDir(),
            libraryFolders: loadSettings(settingsPath).libraryFolders,
            onProgress: (p) => report(p.phase)
          },
          id
        )
        report('complete', 'done')
        return { chartPath: backup.chartPath, rows }
      } catch (err) {
        // A refusal ("this chart has changed since the repair") arrives here as an error and is
        // the designed answer rather than a fault, but the renderer shows it against the entry
        // either way. This event exists to clear the job, not to carry the message.
        report('failed', 'error', err instanceof Error ? err.message : String(err))
        throw err
      }
    },
    clearFixBackups: () => clearBackups(fixBackupDir()),
    // Encore's own releases. Every one of these is answered on any target: on a snap or a build
    // run from source the status carries the reason instead of an offer, and the check is a
    // no-op rather than a request that goes nowhere.
    appUpdateStatus: () => appUpdates.status(),
    appUpdateCheck: () => appUpdates.check(),
    appUpdateDownload: () => appUpdates.download(),
    appUpdateInstall: () => appUpdates.install(),
    // Clone Hero's play data. The status merges what the watcher knows (where it is looking, and
    // what its last read found) with what the table holds, because "available" has to mean
    // "there is something to show" rather than "a file exists": a scorestats.json holding one
    // play we already recorded reads fine and still leaves nothing new to draw.
    playStatus: () => {
      const playCount = countPlays(db)
      return {
        available: playCount > 0,
        reason: plays.reason,
        path: plays.watchedPath,
        playCount
      }
    },
    playSummaries: (checksums) => chartPlaySummaries(db, checksums),
    playStats: () => playStats(db),
    playInsights: () => playInsights(db),
    // The lifetime read, gated the same way and for the same reason: `available` has to mean
    // "there is something to show", so it is a count of imported charts and not the existence of
    // a file. A Clone Hero that has never recorded a score has both files and nothing in them.
    playLifetime: ({ checksums }) => ({
      status: {
        available: countScoreCharts(db) > 0,
        reason: scoreFiles.reason,
        scoreDataPath: scoreFiles.watchedPaths?.scoreData ?? null,
        scoresExtPath: scoreFiles.watchedPaths?.scoresExt ?? null,
        lastImportAt: scoreFiles.lastImportAt
      },
      totals: lifetimeTotals(db),
      charts: chartLifetimes(db, checksums)
    }),
    // saveTextFile: the user explicitly chose the destination path via the
    // system dialog, so we write there directly. There is no library containment
    // guard here: this is the intentional user-chosen exception to the write policy.
    saveTextFile: async ({ defaultName, content }, sender) => {
      const win =
        BrowserWindow.fromWebContents(sender as Electron.WebContents) ??
        BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: defaultName })
        : await dialog.showSaveDialog({ defaultPath: defaultName })
      if (result.canceled || !result.filePath) return null
      // No library guard: user chose this path explicitly via the system dialog.
      writeFileSync(result.filePath, content, 'utf8')
      return result.filePath
    }
  })

  return { db, watcher, plays, scoreFiles, appUpdates }
}

function bootstrap(): void {
  // A second instance would fight this one over the same catalog db and
  // .encore-tmp staging files; focus the existing window instead.
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('com.electron')

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Before createWindow(): a window that loads while encore-art is unhandled gets hard
    // failures for the covers on its first paint, and nothing retries them.
    registerArtProtocol(artCacheDir())

    const { db, watcher, plays, scoreFiles, appUpdates } = wireIpc()
    // Start the library watcher with the current folder paths.
    const initialFolders = loadSettings(
      join(app.getPath('userData'), 'settings.json')
    ).libraryFolders.map((f) => f.path)
    watcher.start(initialFolders).catch((err: unknown) => {
      console.error('LibraryWatcher start failed:', err)
    })
    // Unawaited, and with no error path to speak of, unlike the library watcher above. `start`
    // reads the score file once and then watches its directory, and it resolves rather than
    // rejecting on every case it can meet: no Clone Hero installed, no score yet, a platform
    // whose location is unknown. The catch is only for the watcher itself throwing, which would
    // otherwise be an unhandled rejection in main.
    void plays.start().catch((err: unknown) => {
      console.error('PlayWatcher start failed:', err)
    })
    // Unawaited for the same reasons, and with one of its own: its first act is to import the
    // score files, which is a read of a few kilobytes and a diff, and nothing on screen is
    // waiting for it. Every case it can meet resolves rather than rejecting.
    void scoreFiles.start().catch((err: unknown) => {
      console.error('ScoreFileWatcher start failed:', err)
    })
    // Close on clean exit so WAL checkpoints back into the main db file.
    app.on('will-quit', () => {
      db.close()
      void watcher.stop()
      void plays.stop()
      void scoreFiles.stop()
    })

    createWindow()

    // Startup check, deliberately after the window and deliberately unawaited. It is one HTTPS
    // request to GitHub, and nothing on screen depends on its answer: the Settings panel reads
    // the result from `appUpdateStatus` whenever it is opened, and the state arrives on
    // evAppUpdate if a window is already listening. `check()` resolves rather than rejecting on
    // every failure it knows about, so a machine that is offline at launch, or behind a captive
    // portal, ends the check in the `error` state nobody is looking at, and the window came up
    // at the same moment it always does. The `catch` is for the case the service itself throws,
    // which would otherwise be an unhandled rejection in the main process.
    void appUpdates.check().catch((err: unknown) => {
      console.error('Update check failed:', err)
    })

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

// Top level, not inside a ready handler: registerSchemesAsPrivileged is only honoured while the
// app is still starting up, so this is deliberately the earliest point in the process.
registerArtScheme()

if (app.requestSingleInstanceLock()) {
  bootstrap()
} else {
  app.quit()
}
