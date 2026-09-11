import Bottleneck from 'bottleneck'
import { createHash } from 'node:crypto'
import { Dirent, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { drumTypes, scanChartFolder, type DrumType } from 'scan-chart'
import { ENCORE_TMP_DIR } from '../../shared/constants'
import { ChartRecordSchema, type JobProgress } from '../../shared/schemas'
import { isParsedByScanChart, readSngEntriesForScan } from '../downloads/sng-read-selective'
import { writeAlbumArt } from './art-cache'
import { cloneHeroChecksum } from './chart-checksum'
import { SCAN_VERSION, type CatalogDb } from './db'
import { ALBUM_ART_RE, VIDEO_RE } from './media-re'
import { deleteChartByPath, getChartFreshness, upsertChart, type ChartFreshness } from './queries'

/**
 * Where cached covers go, and how to encode them.
 *
 * Both are injected rather than resolved here. The directory lives under Electron's userData,
 * and the real encoder (src/main/art-encode.ts) builds on `nativeImage`, which only exists
 * inside the Electron runtime. Under vitest that module still imports and loads, since
 * `electron` resolves to a CJS stub exporting the binary path, but `nativeImage` is `undefined`,
 * so calling encodeAlbumArt throws. Injection is what lets scanner.test.ts substitute an encoder
 * that can actually run.
 */
export interface ArtCacheOptions {
  dir: string
  encode: (data: Uint8Array) => Uint8Array
}

export interface FoundChart {
  path: string
  type: 'folder' | 'sng'
}

const CHART_FILES = /^(notes\.(chart|mid)|song\.ini)$/i

/** Resolve an entry's effective type, following symlinks. Broken links resolve to null. */
function entryType(dir: string, entry: Dirent): 'dir' | 'file' | null {
  if (entry.isDirectory()) return 'dir'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) {
    try {
      const stat = statSync(join(dir, entry.name))
      if (stat.isDirectory()) return 'dir'
      if (stat.isFile()) return 'file'
    } catch {
      return null
    }
  }
  return null
}

/**
 * Walk `root` and return every chart under it.
 *
 * `limit` caps the walk itself, not the array it returns at the end: once that many charts are
 * in hand the walk stops. That suits callers that need a number quickly more than they need an
 * exact one. The first-run library probe (detect-library.ts) is the reason it exists: it runs before the window
 * has drawn, and walking an unbounded tree there costs a blank screen. A scan passes no limit and
 * sees the whole tree.
 *
 * A caller cannot tell a capped result from a complete one by looking at it, so `length === limit`
 * is the only signal: it means "at least this many", since a tree holding exactly `limit` charts
 * also stops there.
 */
export function findChartPaths(root: string, limit = Infinity): FoundChart[] {
  const found: FoundChart[] = []
  // Symlinked directories are followed; guard against cycles via real paths.
  const visited = new Set<string>()
  const walk = (dir: string): void => {
    if (found.length >= limit) return
    let entries: Dirent[]
    try {
      const real = realpathSync(dir)
      if (visited.has(real)) return
      visited.add(real)
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const types = entries.map((e) => ({ entry: e, type: entryType(dir, e) }))
    const isChartFolder = types.some(
      ({ entry, type }) => type === 'file' && CHART_FILES.test(entry.name)
    )
    if (isChartFolder) {
      found.push({ path: dir, type: 'folder' })
      return
    }
    for (const { entry, type } of types) {
      if (found.length >= limit) return
      if (entry.name === ENCORE_TMP_DIR) continue
      if (type === 'dir') walk(join(dir, entry.name))
      else if (type === 'file' && entry.name.toLowerCase().endsWith('.sng')) {
        found.push({ path: join(dir, entry.name), type: 'sng' })
      }
    }
  }
  walk(root)
  return found
}

const BACKGROUND_RE = /^background\.(png|jpe?g)$/i

/**
 * The abort handle of the library scan currently running, or null.
 *
 * A single slot, on the same reasoning as the issue scan's (catalog/issues.ts): only one library
 * scan exists at a time, and `ScanRunner` is what enforces that: a `startScan` arriving mid-scan
 * queues a rescan rather than starting a second one. Held at module level rather than passed in
 * because the canceller is an IPC handler, which has no way to hold state between two invocations.
 */
let activeScan: AbortController | null = null

/**
 * Stop the running library scan. A no-op when there is none.
 *
 * What "stop" can promise: nothing further is opened. Charts already handed to the limiter run to
 * completion. Up to `SCAN_CONCURRENCY` of them can be in flight, and neither a `scanChartFolder`
 * parse nor one large `.sng` read is interruptible partway, so this is "stop now" rather than
 * "stop this instant".
 *
 * What it deliberately does NOT do is undo anything. See `LibraryScanCanceled`.
 */
export function cancelLibraryScan(): void {
  activeScan?.abort()
}

/**
 * What `scanLibrary` rejects with when it was cancelled.
 *
 * A rejection rather than a short `ScanSummary`, because both of this scan's consumers read a
 * resolved summary as "the library has been walked": main/index.ts hands it to the album-art
 * sweep, whose whole guard is `found === 0`, and the renderer treats the terminal progress event
 * as the moment the catalog is authoritative. A partial scan is authoritative about neither.
 *
 * Rows already written are KEPT. Three reasons, in order of weight. They are true: each one is a
 * chart that really was read off disk this run, and no later scan would produce anything different.
 * Rolling them back would mean a rescan of an existing library replacing good rows with nothing the
 * moment the user pressed Cancel, which is strictly worse than the state that existed before the
 * scan started. And "cancelled" is a request to stop working, not to undo work; a partial catalog
 * is what an interrupted scan means, and the next scan fills the rest in (the freshness check then
 * skips everything this one did reach, so it is also the cheap half).
 *
 * The one thing a partial catalog must never do is claim to be complete, which is why the
 * terminal event carries `canceled` and the reached percent rather than `done` and 100.
 */
export class LibraryScanCanceled extends Error {
  constructor() {
    super('Library scan canceled')
    this.name = 'LibraryScanCanceled'
  }
}

/**
 * Now that M13 has cut the reads, this overlaps 0.25 s of I/O across a 3.9 s scan, and a serial
 * loop measures the same wall clock on a warm page cache; see scanLibrary. It is kept because
 * the case it exists for is the one that measurement cannot see: a first run reads cold, off
 * whatever disk the user keeps a song library on, and that is where overlapping reads pays.
 */
const SCAN_CONCURRENCY = 20

/**
 * Read a chart folder for parsing: every file named, bytes only for the ones scan-chart parses.
 *
 * This used to skip files whose NAME said "media" and read everything else whole, which missed
 * the files that actually cost. Clone Hero users turn a background video off by renaming it, and
 * `video.mp4.disabled` is not media by name: three such files are 2.36 GiB of the 2.38 GiB this
 * function read across the reference library's 45 folder charts. Asking what scan-chart parses
 * instead of what looks like media brings that to 22.0 MiB, or 0.92%, and is the same rule the
 * `.sng` branch reads by, so the two chart types no longer disagree about what a scan needs.
 *
 * Symlinked files are still included; entryType follows links.
 *
 * The empty entries are not a compromise. scan-chart decides `noAudio`, `multipleAudio`,
 * `invalidAudio`, `badVideo`, `multipleVideo` and `hasVideoBackground` from names, and its audio
 * scanner returns the same nulls whether it collected any bytes or not. What DOES change is that
 * audio and video are now listed at all where the old filter dropped them, so a folder chart
 * with audio stops scanning as `noAudio` and `playable: false`, and one with a `video.webm`
 * reports `hasVideoBackground`. All three are corrections, and none of the three is stored:
 * scannedFields carries no such field, and mediaFlags settles hasVideo from the directory
 * listing rather than from anything scan-chart returns.
 */
function readFolder(dir: string): { fileName: string; data: Uint8Array }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => entryType(dir, e) === 'file')
    .map((e) => ({
      fileName: e.name,
      data: isParsedByScanChart(e.name)
        ? new Uint8Array(readFileSync(join(dir, e.name)))
        : new Uint8Array(0)
    }))
}

/** Media presence flags from a file-name listing alone, so media contents are never inspected. */
function mediaFlags(names: string[]): {
  hasVideo: boolean
  hasBackground: boolean
  hasAlbumArt: boolean
} {
  return {
    hasVideo: names.some((n) => VIDEO_RE.test(n)),
    hasBackground: names.some((n) => BACKGROUND_RE.test(n)),
    hasAlbumArt: names.some((n) => ALBUM_ART_RE.test(n))
  }
}

/**
 * song.ini writes -1 for an instrument that has no difficulty rating, and scan-chart passes
 * that sentinel straight through. Stored as-is it reaches the UI as a literal "G-1", so it
 * is normalized to null here, the one place every chart's difficulties are written.
 */
function rating(value: number | null | undefined): number | null {
  return value == null || value < 0 ? null : value
}

/**
 * The song.ini "unset" sentinels that are not -1: 16000 for both track numbers, 0 for
 * song_length.
 *
 * scan-chart copies its whole `defaultMetadata` object onto the result whenever a song.ini
 * exists, so an omitted key arrives as its default rather than as `undefined` and `?? null`
 * never fires. Stored raw, a chart that is not on an album carries 16000 as if it were a real
 * track number, and a chart with no length renders as "0:00", because msToTime only dashes out
 * null and negatives.
 */
function ordinal(value: number | null | undefined, unset: number): number | null {
  return value == null || value === unset ? null : value
}

/** Same story for the two free-text fields, whose "unset" default is the empty string. */
function phrase(value: string | null | undefined): string | null {
  return value ? value : null
}

/**
 * scan-chart's DrumType is the numeric enum 0|1|2 while drumType is a TEXT column, so the
 * value is stored under scan-chart's own name for it. Storing the number instead makes
 * ChartRecordSchema.parse reject the entire record, and the per-chart isolation in scanLibrary
 * then swallows the throw, so every drums chart would vanish from the catalog as an
 * unexplained scan failure.
 */
const DRUM_TYPE_NAMES: Record<DrumType, string> = {
  [drumTypes.fourLane]: 'fourLane',
  [drumTypes.fourLanePro]: 'fourLanePro',
  [drumTypes.fiveLane]: 'fiveLane'
}

/**
 * Maps a scan-chart result to the ChartRecord metadata fields shared by both chart types.
 *
 * Explicit return type omitted deliberately: the shape is long, and restating it here is a
 * second place to update every time a field is added. ChartRecordSchema.parse() at the call
 * site is what actually validates it.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- see above
function scannedFields(scanned: ReturnType<typeof scanChartFolder>) {
  const notes = scanned.notesData
  return {
    name: scanned.name ?? null,
    artist: scanned.artist ?? null,
    album: scanned.album ?? null,
    genre: scanned.genre ?? null,
    year: scanned.year ? parseInt(scanned.year, 10) || null : null,
    charter: scanned.charter ?? null,
    diffGuitar: rating(scanned.diff_guitar),
    diffBass: rating(scanned.diff_bass),
    diffDrums: rating(scanned.diff_drums),
    diffKeys: rating(scanned.diff_keys),
    diffVocals: rating(scanned.diff_vocals),
    diffBand: rating(scanned.diff_band),
    diffRhythm: rating(scanned.diff_rhythm),
    diffGuitarCoop: rating(scanned.diff_guitar_coop),
    diffDrumsReal: rating(scanned.diff_drums_real),
    diffGuitarGhl: rating(scanned.diff_guitarghl),
    diffBassGhl: rating(scanned.diff_bassghl),
    diffRhythmGhl: rating(scanned.diff_rhythm_ghl),
    diffGuitarCoopGhl: rating(scanned.diff_guitar_coop_ghl),
    songLength: ordinal(scanned.song_length, 0),
    // -1 here is the same "unset" sentinel as on the difficulties, in milliseconds.
    previewStartTime: rating(scanned.preview_start_time),
    icon: phrase(scanned.icon),
    loadingPhrase: phrase(scanned.loading_phrase),
    albumTrack: ordinal(scanned.album_track, 16_000),
    playlistTrack: ordinal(scanned.playlist_track, 16_000),
    modchart: scanned.modchart ?? false,
    proDrums: scanned.pro_drums ?? false,
    fiveLaneDrums: scanned.five_lane_drums ?? false,
    drumType: notes?.drumType == null ? null : DRUM_TYPE_NAMES[notes.drumType],
    instruments: notes?.instruments ?? [],
    noteCounts: notes?.noteCounts ?? [],
    maxNps: notes?.maxNps ?? [],
    has2xKick: notes?.has2xKick ?? false,
    hasSoloSections: notes?.hasSoloSections ?? false,
    hasVocals: notes?.hasVocals ?? false,
    hasOpenNotes: notes?.hasOpenNotes ?? false,
    hasTapNotes: notes?.hasTapNotes ?? false,
    hasForcedNotes: notes?.hasForcedNotes ?? false,
    hasFlexLanes: notes?.hasFlexLanes ?? false,
    hasLyrics: notes?.hasLyrics ?? false,
    // Both come out of the parse the scan already ran, so storing them costs nothing beyond the
    // column. They are what main/updates matches a local chart against api.enchor.us with; see
    // ChartRecordSchema for what each one covers.
    chartHash: scanned.chartHash ?? null,
    tempoMapHash: notes?.tempoMapHash ?? null
  }
}

/**
 * The cached-cover md5 for a scan result, or null.
 *
 * `scanned.albumArt` is typed `AlbumArt | null` but scan-chart only ever assigns the property
 * when a cover was found, so a chart without one hands us `undefined`. writeAlbumArt's null
 * check would miss that and dereference it, and the throw lands outside its try, costing the
 * chart the catalog row that writeAlbumArt is explicitly written never to cost it.
 */
function cachedArtMd5(
  scanned: ReturnType<typeof scanChartFolder>,
  art: ArtCacheOptions
): string | null {
  return writeAlbumArt(art.dir, scanned.albumArt ?? null, art.encode)
}

/** Cheap change-detection hash: file names + sizes + mtimes, no content reads. */
function folderHash(dir: string): string {
  const hash = createHash('md5')
  for (const e of readdirSync(dir).sort()) {
    const s = statSync(join(dir, e))
    hash.update(`${e}:${s.size}:${s.mtimeMs};`)
  }
  return hash.digest('hex')
}

/**
 * A row may be skipped only when the chart's content is unchanged AND it was produced by
 * the current parsing logic. The version half is what lets an improved scanner reach rows
 * whose files never change. Without it the content check matches forever and the old,
 * worse metadata is stuck in the catalog permanently.
 *
 * `hash` is the branch's content stamp: the folder digest for folders, the mtime for .sng.
 *
 * Takes the narrow freshness probe, not a full ChartRecord: a row that fails to parse must
 * still be able to answer "are you stale?", or a rescan can never overwrite it.
 */
function isUpToDate(existing: ChartFreshness | null, hash: string): boolean {
  return existing?.folderHash === hash && existing.scanVersion === SCAN_VERSION
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Index one chart, unless its content stamp and scan version say the stored row already
 * reflects what is on disk.
 *
 * Split out of scanLibrary's loop so a single chart can be re-indexed on its own. This function
 * is the only place the cached cover and the asset flags the UI reads (hasVideo, hasAlbumArt,
 * hasBackground, hasLyrics) are decided, so an asset write that never comes back through here
 * leaves the catalog claiming the asset the user just added is still missing.
 *
 * The freshness check is not bypassed for that caller, because every asset write moves the
 * stamp it compares: a folder chart gains or resizes a file (folderHash covers names, sizes and
 * mtimes), and a repacked `.sng` is a wholly rewritten file with a new mtime. A skip here
 * therefore means the row already matches disk, which is the answer the caller wanted anyway.
 *
 * Throws on a chart it cannot parse. scanLibrary's per-chart catch is what keeps that from
 * aborting a whole scan.
 */
export async function scanChart(
  db: CatalogDb,
  chart: FoundChart,
  art: ArtCacheOptions
): Promise<void> {
  if (chart.type === 'folder') {
    const hash = folderHash(chart.path)
    if (isUpToDate(getChartFreshness(db, chart.path), hash)) return
    const files = readFolder(chart.path)
    // includeMd5: false skips scan-chart's whole-folder content md5, which we discard.
    const scanned = scanChartFolder(files, { includeMd5: false, includeBTrack: false })
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path: chart.path,
        chartType: 'folder',
        ...scannedFields(scanned),
        ...mediaFlags(readdirSync(chart.path)),
        // Costs nothing: readFolder has already read the chart file's bytes, because
        // scan-chart parses it. See chart-checksum.ts for why this is not either hash above.
        cloneHeroChecksum: cloneHeroChecksum(files),
        albumArtMd5: cachedArtMd5(scanned, art),
        folderHash: hash,
        modifiedTime: Date.now(),
        scanVersion: SCAN_VERSION
      })
    )
    return
  }
  const s = statSync(chart.path)
  if (isUpToDate(getChartFreshness(db, chart.path), String(s.mtimeMs))) return
  // Reads the header plus the handful of files scan-chart parses, not the archive. Measured
  // across the reference library's 162 archives: 2,928.8 MiB the old way, 49.0 MiB this way, or
  // 1.67%, with all 162 producing an identical ScannedChart through both paths.
  //
  // Every audio and video file still arrives, named and empty, where the old path dropped audio
  // from the list entirely. That is a correction, not a regression: a .sng holding audio used to
  // scan as `noAudio` and `playable: false`. Neither reaches the catalog: scannedFields stores
  // neither, and mediaFlags reads names, which is what it now gets more of.
  const { entries } = await readSngEntriesForScan(chart.path)
  const scanned = scanChartFolder(entries, { includeMd5: false, includeBTrack: false })
  upsertChart(
    db,
    ChartRecordSchema.parse({
      path: chart.path,
      chartType: 'sng',
      ...scannedFields(scanned),
      ...mediaFlags(entries.map((e) => e.fileName)),
      // The selective read decrypts the chart file because scan-chart parses it, and those
      // decoded bytes are what Clone Hero hashes — not the archive on disk. This is the case the
      // checksum was verified against; see chart-checksum.ts.
      cloneHeroChecksum: cloneHeroChecksum(entries),
      albumArtMd5: cachedArtMd5(scanned, art),
      folderHash: String(s.mtimeMs),
      modifiedTime: Date.now(),
      scanVersion: SCAN_VERSION
    })
  )
}

/** What one scan saw. Returned because the progress stream only carries strings. */
export interface ScanSummary {
  /**
   * Charts discovered under `roots`.
   *
   * 0 means the walk found nothing. That is an empty library, but equally a root that could not
   * be read, since findChartPaths swallows the readdir error and returns []. Callers that treat
   * the catalog's post-scan state as authoritative need to know the difference: see the art
   * sweep in src/main/index.ts.
   */
  found: number
  /** Charts that threw during parse. Each kept whatever row it already had. */
  failed: number
}

/**
 * Scan every chart under `roots` into the catalog.
 *
 * **This runs on the main process, and M13 decided to leave it there.** The decision is recorded
 * here because this is where someone would come to undo it.
 *
 * Measured on the reference library (207 charts, 162 `.sng` and 45 folders) after M13 cut the
 * bytes read from 5,309.4 MiB to 71.5 MiB: the whole scan is 3.9-4.2 s, peak RSS 390-470 MiB. Of
 * that wall clock ~3.1 s is synchronous `scanChartFolder` parsing and 0.25 s is awaitable I/O. So
 * there is real main-thread CPU here and a worker could genuinely move it. The reason not to is
 * the shape of that time, and the price of moving it.
 *
 * It is not one three-second block. The loop turns between charts, and the longest uninterruptible
 * stretch is one chart's parse: 156-183 ms at worst across runs, 10 ms median, 1 chart of the 207
 * over 100 ms. Event-loop delay across the scan measures mean 18-21 ms, p99 50-100 ms. The window
 * drops frames for four seconds on a first run; it does not stop answering.
 *
 * Against that, a worker is permanent structure. `better-sqlite3` handles cannot cross threads, so
 * every upsert and every freshness probe becomes a message round trip; and `nativeImage`, which
 * encodes album art, exists only in the main process, so art would have to be shipped back as bytes
 * to be encoded, re-introducing a copy of the exact bytes M13 went to the trouble of not moving.
 *
 * The cheaper alternative was measured rather than assumed: a serial loop that yields to the event
 * loop before each chart. It is indistinguishable from this one. Run both in a single process and
 * whichever goes SECOND wins by ~0.4 s, whichever one that is. The gap is JIT and page-cache
 * warm-up rather than the loop shape. Neither moves the worst delay, because the worst delay is one
 * `scanChartFolder` call and no yield can interrupt a synchronous callee.
 *
 * Re-open this on a measurement. The number that would justify a worker is the per-chart parse
 * cost, because that is the only part of this a thread would take away.
 */
export async function scanLibrary(
  db: CatalogDb,
  roots: string[],
  onProgress: (p: JobProgress) => void,
  art: ArtCacheOptions
): Promise<ScanSummary> {
  const report = (
    phase: string,
    percent: number | null,
    status: JobProgress['status'] = 'running',
    message: string | null = null
  ): void => onProgress({ jobId: 'scan', kind: 'scan', phase, percent, message, status })

  const controller = new AbortController()
  activeScan = controller
  const { signal } = controller
  try {
    report('discovering', null)
    // Wrapped rather than point-free: flatMap passes the index as a second argument, which
    // findChartPaths now reads as `limit`, so the first root would be capped at 0 charts.
    const found = roots.flatMap((root) => findChartPaths(root))
    const foundPaths = new Set(found.map((f) => f.path))

    // Remove vanished charts (only those under the scanned roots).
    //
    // Not guarded by the abort signal, because no abort can have arrived yet: everything from the
    // top of this function to the `await` below runs in the turn scanLibrary was called in, and
    // `controller.abort()` cannot be delivered until control returns to the event loop. This pass
    // is therefore all-or-nothing regardless of a cancel, which is what keeps the catalog from
    // holding half a deletion. Anything that moves it after an await has to think about that.
    const known = db.prepare(`SELECT path FROM charts`).all() as { path: string }[]
    db.transaction(() => {
      for (const { path } of known) {
        if (roots.some((r) => isUnder(path, r)) && !foundPaths.has(path))
          deleteChartByPath(db, path)
      }
    })()

    const limiter = new Bottleneck({ maxConcurrent: SCAN_CONCURRENCY })
    const failures: { path: string; message: string }[] = []
    let done = 0
    let percent = 0
    await Promise.all(
      found.map((chart) =>
        limiter.schedule(async () => {
          // Checked when the job STARTS, not when it was queued: everything Bottleneck has not
          // reached yet lands here and returns without opening a file or touching the catalog,
          // which is what makes a cancel take effect within one chart rather than one library.
          if (signal.aborted) return
          try {
            await scanChart(db, chart, art)
          } catch (err) {
            // Per-chart isolation: one unreadable/corrupt chart must not abort the whole scan.
            failures.push({
              path: chart.path,
              message: err instanceof Error ? err.message : String(err)
            })
          } finally {
            done++
            percent = Math.round((done / found.length) * 100)
            // Still reported after a cancel: the charts already in flight are genuinely being
            // finished, and a progress line frozen at the moment of the click would read as a
            // hang. The terminal event below is what says the scan stopped.
            report('scanning', percent)
          }
        })
      )
    )
    const failureMessage =
      failures.length > 0
        ? `${failures.length} chart${failures.length === 1 ? '' : 's'} failed to scan`
        : null

    if (signal.aborted) {
      // The percent reached, not 100, and `canceled`, not `done`. The renderer decides a scan
      // has finished from this event alone. There is no promise on its side, since catalog:scan
      // resolves as soon as the scan has STARTED, so this is the only thing standing between a
      // partial catalog and a UI that presents it as the whole library.
      report('canceled', percent, 'canceled', failureMessage)
      throw new LibraryScanCanceled()
    }

    report('complete', 100, 'done', failureMessage)
    return { found: found.length, failed: failures.length }
  } finally {
    // Only ever clear our own entry, on the same reasoning as the issue scan's: a scan started
    // after this one has already replaced the slot, and dropping it would leave the newer scan
    // uncancellable.
    if (activeScan === controller) activeScan = null
  }
}
