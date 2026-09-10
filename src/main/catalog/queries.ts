import { ChartRecordSchema, type CatalogFilter, type ChartRecord } from '../../shared/schemas'
import type { CatalogDb } from './db'

/** The names of every boolean field on ChartRecord, so BOOL_COLUMNS cannot drift from the schema. */
type BoolKeys = {
  [K in keyof ChartRecord]-?: ChartRecord[K] extends boolean ? K : never
}[keyof ChartRecord]

const COLUMNS = [
  'path',
  'chartType',
  'name',
  'artist',
  'album',
  'genre',
  'year',
  'charter',
  'diffGuitar',
  'diffBass',
  'diffDrums',
  'diffKeys',
  'diffVocals',
  'songLength',
  'hasVideo',
  'hasBackground',
  'hasAlbumArt',
  'hasLyrics',
  'folderHash',
  'modifiedTime',
  'scanVersion',
  'albumArtMd5',
  'albumTrack',
  'diffBand',
  'diffBassGhl',
  'diffDrumsReal',
  'diffGuitarCoop',
  'diffGuitarCoopGhl',
  'diffGuitarGhl',
  'diffRhythm',
  'diffRhythmGhl',
  'drumType',
  'fiveLaneDrums',
  'has2xKick',
  'hasFlexLanes',
  'hasForcedNotes',
  'hasOpenNotes',
  'hasSoloSections',
  'hasTapNotes',
  'hasVocals',
  'icon',
  'instruments',
  'loadingPhrase',
  'maxNps',
  'modchart',
  'noteCounts',
  'playlistTrack',
  'previewStartTime',
  'proDrums',
  'chartHash',
  'tempoMapHash'
] as const satisfies readonly (keyof ChartRecord)[]

/**
 * Fails to compile if a ChartRecordSchema field is missing from COLUMNS, naming the offender.
 *
 * Without this a dropped column is invisible: it is absent from the generated upsert, so the
 * value is never written, and on read zod's .default() fills in null/false/[]. The row looks
 * plausible and every test still passes: the user just silently loses that field.
 */
type Uncovered = Exclude<keyof ChartRecord, (typeof COLUMNS)[number]>
const _allColumnsPersisted: Uncovered extends never ? true : Uncovered = true
void _allColumnsPersisted

const BOOL_COLUMNS = [
  'hasVideo',
  'hasBackground',
  'hasAlbumArt',
  'hasLyrics',
  'modchart',
  'proDrums',
  'fiveLaneDrums',
  'has2xKick',
  'hasSoloSections',
  'hasVocals',
  'hasOpenNotes',
  'hasTapNotes',
  'hasForcedNotes',
  'hasFlexLanes'
] as const satisfies readonly BoolKeys[]

/** Stored as JSON text: SQLite has no array type and these are read whole, never queried into. */
const JSON_COLUMNS = ['instruments', 'noteCounts', 'maxNps'] as const

/**
 * Decodes one JSON-text column, separating damaged user data from a caller mistake.
 *
 * Damaged data degrades to an empty list. fromRow() runs per row inside queryCharts() and
 * nothing between it and the IPC boundary catches, so a single unreadable value would
 * otherwise empty the user's entire library list instead of blanking one field on one chart.
 * Two cases count as damaged: text that will not parse, and JSON that decodes to something
 * other than an array. These columns are only ever written from arrays, so anything else
 * means the stored value is corrupt. Wrong-shaped ELEMENTS still reach the
 * ChartRecordSchema.parse() below and throw there; validating those here would mean
 * restating the schema in the decoder.
 *
 * A missing column is the caller's mistake, not corruption, and fails loudly instead: it can
 * only happen by selecting a subset of columns and handing the row to fromRow() anyway, and
 * quietly reporting every chart as having no instruments would bury that.
 */
function parseJsonColumn(column: string, value: unknown): unknown {
  if (typeof value !== 'string') throw new Error(`row is missing the ${column} column`)
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function toRow(record: ChartRecord): Record<string, unknown> {
  const row: Record<string, unknown> = { ...record }
  for (const col of BOOL_COLUMNS) row[col] = record[col] ? 1 : 0
  for (const col of JSON_COLUMNS) row[col] = JSON.stringify(record[col])
  return row
}

function fromRow(row: Record<string, unknown>): ChartRecord {
  const out: Record<string, unknown> = { ...row }
  for (const col of BOOL_COLUMNS) out[col] = row[col] === 1
  for (const col of JSON_COLUMNS) out[col] = parseJsonColumn(col, row[col])
  delete out.id
  return ChartRecordSchema.parse(out)
}

// Hoisted: cols/placeholders/updates are invariant, so build the SQL once at module load.
const UPSERT_COLS = COLUMNS.join(', ')
const UPSERT_PLACEHOLDERS = COLUMNS.map((c) => `@${c}`).join(', ')
const UPSERT_UPDATES = COLUMNS.filter((c) => c !== 'path')
  .map((c) => `${c} = @${c}`)
  .join(', ')
const UPSERT_SQL = `INSERT INTO charts (${UPSERT_COLS}) VALUES (${UPSERT_PLACEHOLDERS})
	 ON CONFLICT(path) DO UPDATE SET ${UPSERT_UPDATES}`

export function upsertChart(db: CatalogDb, record: ChartRecord): void {
  db.prepare(UPSERT_SQL).run(toRow(record))
}

/**
 * Quote each term so FTS5 operators in user input can't break the query.
 * Quotes and NUL bytes are stripped first: either would terminate the quoted
 * phrase early and make FTS5 throw "unterminated string".
 */
function ftsQuery(search: string): string {
  return search
    .split(/\s+/)
    .map((term) => term.replace(/["\0]/g, '').trim())
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(' ')
}

// Maps the filter's missing-asset kinds to catalog columns. Column names come
// from this closed map (kinds are zod-enum validated), never from user input,
// so interpolating them into SQL is safe.
const MISSING_COLUMN = {
  video: 'hasVideo',
  background: 'hasBackground',
  albumArt: 'hasAlbumArt',
  lyrics: 'hasLyrics'
} as const

/**
 * `AND hasX = 0` per requested missing kind (empty string when none).
 *
 * 'all' chains the conditions with AND: every listed asset must be absent. 'any' wraps
 * them in a single parenthesised OR, so one absent asset is enough; the parentheses matter
 * because this clause is concatenated onto a WHERE that already has other AND terms.
 */
function missingClause(filter: CatalogFilter, prefix = ''): string {
  const { missing, missingMode } = filter
  if (!missing?.length) return ''
  const conditions = missing.map((kind) => `${prefix}${MISSING_COLUMN[kind]} = 0`)
  return missingMode === 'any'
    ? ` AND (${conditions.join(' OR ')})`
    : conditions.map((c) => ` AND ${c}`).join('')
}

export function queryCharts(db: CatalogDb, filter: CatalogFilter): ChartRecord[] {
  const fts = ftsQuery(filter.search)
  const rows = fts
    ? db
        .prepare(
          `SELECT charts.* FROM charts_fts JOIN charts ON charts.id = charts_fts.rowid
				 WHERE charts_fts MATCH ?${missingClause(filter, 'charts.')} ORDER BY rank LIMIT ? OFFSET ?`
        )
        .all(fts, filter.limit, filter.offset)
    : db
        .prepare(
          `SELECT * FROM charts WHERE 1 = 1${missingClause(filter)}
				 ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`
        )
        .all(filter.limit, filter.offset)
  return (rows as Record<string, unknown>[]).map(fromRow)
}

export function countCharts(db: CatalogDb, filter: CatalogFilter): number {
  const fts = ftsQuery(filter.search)
  // The FTS count needs the charts join only when has-column constraints apply.
  const row = fts
    ? db
        .prepare(
          filter.missing?.length
            ? `SELECT count(*) AS n FROM charts_fts JOIN charts ON charts.id = charts_fts.rowid
						 WHERE charts_fts MATCH ?${missingClause(filter, 'charts.')}`
            : `SELECT count(*) AS n FROM charts_fts WHERE charts_fts MATCH ?`
        )
        .get(fts)
    : db.prepare(`SELECT count(*) AS n FROM charts WHERE 1 = 1${missingClause(filter)}`).get()
  return (row as { n: number }).n
}

export function getChartByPath(db: CatalogDb, path: string): ChartRecord | null {
  const row = db.prepare(`SELECT * FROM charts WHERE path = ?`).get(path)
  return row ? fromRow(row as Record<string, unknown>) : null
}

/** The two stored values a staleness comparison reads. */
export interface ChartFreshness {
  folderHash: string
  scanVersion: number
}

/**
 * Reads just the freshness stamps for a path, with no schema parse.
 *
 * Deliberately narrow rather than a getChartByPath() call: parsing the whole record would let
 * damaged data in a column the comparison never reads throw first. In the scanner that throw
 * is swallowed by per-chart error isolation, which skips the chart, so the row that most
 * needs rewriting becomes the one row a rescan can never reach. Reading only these two
 * columns keeps the check answerable no matter what else in the row is damaged.
 */
export function getChartFreshness(db: CatalogDb, path: string): ChartFreshness | null {
  const row = db.prepare(`SELECT folderHash, scanVersion FROM charts WHERE path = ?`).get(path)
  return (row as ChartFreshness | undefined) ?? null
}

export function deleteChartByPath(db: CatalogDb, path: string): void {
  db.prepare(`DELETE FROM charts WHERE path = ?`).run(path)
}

// Hoisted like UPSERT_SQL: built once at module load. NULL catalog columns
// never match: LOWER(NULL) IS NULL, and NULL = anything is not true in SQL.
const EXISTS_BY_META_SQL = `SELECT 1 FROM charts
	 WHERE LOWER(name) = LOWER(?) AND LOWER(artist) = LOWER(?) AND LOWER(charter) = LOWER(?)
	 LIMIT 1`

/**
 * For each key (in input order), returns true if any catalog row matches
 * name + artist + charter case-insensitively. A metadata match means "this
 * song by this charter is in your library", not this exact chart version.
 */
export function chartsExistByMeta(
  db: CatalogDb,
  keys: { name: string; artist: string; charter: string }[]
): boolean[] {
  const stmt = db.prepare(EXISTS_BY_META_SQL)
  return keys.map((k) => stmt.get(k.name, k.artist, k.charter) !== undefined)
}
