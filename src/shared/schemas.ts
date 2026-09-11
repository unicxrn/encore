import { z } from 'zod'
import { SETTINGS_DEFAULTS } from './settings-defaults'

export const LibraryFolderSchema = z.object({
  path: z.string(),
  isDefault: z.boolean()
})

// The default values live in settings-defaults.ts so the renderer can seed its
// store without pulling zod into its startup bundle; the test below pins
// SettingsSchema.parse({}) to defaultSettings() so the two cannot drift.
export const SettingsSchema = z.object({
  libraryFolders: z.array(LibraryFolderSchema).default([]),
  downloadFormat: z.enum(['sng', 'folder']).default(SETTINGS_DEFAULTS.downloadFormat),
  downloadConcurrency: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(SETTINGS_DEFAULTS.downloadConcurrency),
  downloadVideos: z.boolean().default(SETTINGS_DEFAULTS.downloadVideos),
  chartFolderName: z.string().default(SETTINGS_DEFAULTS.chartFolderName),
  previewVolume: z.number().min(0).max(100).default(SETTINGS_DEFAULTS.previewVolume),
  // A schema field, not a loose key: this object strips anything it does not name on both the
  // IPC boundary and the save, so a flag written anywhere else would not survive to disk.
  tourSeen: z.boolean().default(SETTINGS_DEFAULTS.tourSeen),
  lastSeenVersion: z.string().default(SETTINGS_DEFAULTS.lastSeenVersion)
})
export type Settings = z.infer<typeof SettingsSchema>
export { defaultSettings } from './settings-defaults'

export const ChartRecordSchema = z.object({
  path: z.string(),
  chartType: z.enum(['folder', 'sng']),
  name: z.string().nullable().default(null),
  artist: z.string().nullable().default(null),
  album: z.string().nullable().default(null),
  genre: z.string().nullable().default(null),
  year: z.number().int().nullable().default(null),
  charter: z.string().nullable().default(null),
  diffGuitar: z.number().int().nullable().default(null),
  diffBass: z.number().int().nullable().default(null),
  diffDrums: z.number().int().nullable().default(null),
  diffKeys: z.number().int().nullable().default(null),
  diffVocals: z.number().int().nullable().default(null),
  songLength: z.number().int().nullable().default(null),
  hasVideo: z.boolean().default(false),
  hasBackground: z.boolean().default(false),
  hasAlbumArt: z.boolean().default(false),
  hasLyrics: z.boolean().default(false),
  /**
   * MD5 of the chart's SOURCE cover image, which also names its file in the art cache.
   *
   * scan-chart hands the cover file back untouched, so the source is whatever the charter
   * shipped: PNG or JPEG, at any size. The cached file under this name holds our own
   * re-encoded rendition (see main/art-encode.ts), so this is deliberately not a hash of the
   * bytes it labels: hashing the source is what lets a rescan skip the decode for a cover the
   * cache already holds.
   */
  albumArtMd5: z.string().nullable().default(null),
  /** Instruments with more than zero notes. Distinguishes "unrated" from "not charted". */
  instruments: z.array(z.string()).default([]),
  /** Per instrument+difficulty note totals. This is the input diffMatrix() already expects. */
  noteCounts: z
    .array(z.object({ instrument: z.string(), difficulty: z.string(), count: z.number().int() }))
    .default([]),
  /** Peak notes-per-second per instrument+difficulty. */
  maxNps: z
    .array(z.object({ instrument: z.string(), difficulty: z.string(), nps: z.number() }))
    .default([]),
  diffBand: z.number().int().nullable().default(null),
  diffRhythm: z.number().int().nullable().default(null),
  diffGuitarCoop: z.number().int().nullable().default(null),
  diffDrumsReal: z.number().int().nullable().default(null),
  diffGuitarGhl: z.number().int().nullable().default(null),
  diffBassGhl: z.number().int().nullable().default(null),
  diffRhythmGhl: z.number().int().nullable().default(null),
  diffGuitarCoopGhl: z.number().int().nullable().default(null),
  /** Charter's chosen preview start, in ms. Used by the in-app preview. */
  previewStartTime: z.number().int().nullable().default(null),
  icon: z.string().nullable().default(null),
  loadingPhrase: z.string().nullable().default(null),
  albumTrack: z.number().int().nullable().default(null),
  playlistTrack: z.number().int().nullable().default(null),
  drumType: z.string().nullable().default(null),
  modchart: z.boolean().default(false),
  proDrums: z.boolean().default(false),
  fiveLaneDrums: z.boolean().default(false),
  has2xKick: z.boolean().default(false),
  hasSoloSections: z.boolean().default(false),
  hasVocals: z.boolean().default(false),
  hasOpenNotes: z.boolean().default(false),
  hasTapNotes: z.boolean().default(false),
  hasForcedNotes: z.boolean().default(false),
  hasFlexLanes: z.boolean().default(false),
  /**
   * scan-chart's hash of the chart file's bytes plus the seven gameplay ini keys that differ from
   * their defaults (`getChartHash`, scan-chart/dist/index.js:2572). It is the same value
   * api.enchor.us returns as `chartHash`, which is what makes the two comparable.
   *
   * Deliberately excludes audio, album art, video, background, lyrics and every metadata key
   * except those seven. That is why adding artwork to a chart, or letting a repair rewrite its
   * metadata, leaves this untouched: a customised chart still matches its Chorus original.
   */
  chartHash: z.string().nullable().default(null),
  /**
   * scan-chart's md5 over the chart's tempo markers and time signatures. Corroborates a
   * `chartHash` mismatch: a revision edits notes but almost never re-times the song, so an
   * unchanged tempo map is evidence that two differing charts are the same chart. Weak on its
   * own: a constant-tempo chart shares its map with every other constant-tempo chart.
   */
  tempoMapHash: z.string().nullable().default(null),
  /**
   * Clone Hero's own identity for this chart: MD5 over the bytes of `notes.mid`/`notes.chart`
   * alone, lower-hex. This is the value the game writes as `checksum` into scorestats.json, and
   * the only key that joins a recorded play to this row.
   *
   * Distinct from both hashes above and not derivable from either: `chartHash` is scan-chart's
   * base64 SHA-256 over the chart file plus seven song.ini keys. See main/catalog/chart-checksum.ts
   * for the derivation and the install it was verified against.
   *
   * Null for a chart with no readable chart file, which simply never matches a play.
   */
  cloneHeroChecksum: z.string().nullable().default(null),
  folderHash: z.string(),
  modifiedTime: z.number(),
  // Parsing-logic version that produced this row (see SCAN_VERSION in main/catalog/db.ts).
  // Rows below the current version are re-parsed even when their content is unchanged.
  scanVersion: z.number().int().default(0)
})
export type ChartRecord = z.infer<typeof ChartRecordSchema>

export const JobProgressSchema = z.object({
  jobId: z.string(),
  kind: z.enum(['scan', 'download', 'asset']),
  phase: z.string(),
  percent: z.number().min(0).max(100).nullable(),
  message: z.string().nullable(),
  status: z.enum(['running', 'done', 'error', 'canceled'])
})
export type JobProgress = z.infer<typeof JobProgressSchema>

export const CatalogFilterSchema = z.object({
  search: z.string().default(''),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
  // Each entry adds an "asset absent" constraint. The default (and omitted) mode is 'all':
  // a chart matches only when EVERY listed asset is missing. 'any' matches when at least one
  // is, which is how Asset Studio asks for "charts that still need work".
  missing: z.array(z.enum(['video', 'background', 'albumArt', 'lyrics'])).optional(),
  missingMode: z.enum(['all', 'any']).optional(),
  /**
   * When true, keep only charts with no recorded play.
   *
   * "No recorded play" is not "never played": the play history only covers the time Encore has
   * been watching Clone Hero's scorestats.json (see shared/play.ts), so a chart the user wore out
   * last year and has not touched since Encore was installed matches this. A UI offering it
   * should say so.
   *
   * A chart whose `cloneHeroChecksum` is null matches too, since nothing can ever join a play to
   * it. That is the right answer for the filter's purpose — it is in the "show me what I have not
   * got round to" pile — and it is also the only answer available.
   */
  neverPlayed: z.boolean().optional()
})
export type CatalogFilter = z.infer<typeof CatalogFilterSchema>

export const DownloadRequestSchema = z.object({
  md5: z.string().regex(/^[a-f0-9]{32}$/i),
  hasVideoBackground: z.boolean().default(false),
  meta: z.object({
    name: z.string().nullable().default(null),
    artist: z.string().nullable().default(null),
    charter: z.string().nullable().default(null)
  })
})
export type DownloadRequest = z.infer<typeof DownloadRequestSchema>

export interface QueuedDownload {
  md5: string
  url: string
  folderName: string
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled'
  percent: number | null
  message: string | null
  finalPath: string | null
}

export interface DownloadInput {
  md5: string
  url: string
  folderName: string
}
