import {
  ChartRecordSchema,
  type CatalogFacets,
  type CatalogFilter,
  type CatalogSortField,
  type ChartRecord
} from '../../shared/schemas'
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
  'tempoMapHash',
  'cloneHeroChecksum'
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
 * One fragment of a WHERE clause, with the values its placeholders stand for.
 *
 * Constraints carry parameters now that they compare against user-supplied text, so they cannot
 * be plain strings any more. Every clause builder below returns this shape and `constraintClause`
 * concatenates them, which is what keeps the SQL and the parameter list in the same order: get
 * them out of step and better-sqlite3 binds the artist into the album's placeholder.
 */
interface Clause {
  sql: string
  params: unknown[]
}

const NO_CLAUSE: Clause = { sql: '', params: [] }

function joinClauses(clauses: Clause[]): Clause {
  return {
    sql: clauses.map((c) => c.sql).join(''),
    params: clauses.flatMap((c) => c.params)
  }
}

/**
 * `AND hasX = 0` per requested missing kind (empty string when none).
 *
 * 'all' chains the conditions with AND: every listed asset must be absent. 'any' wraps
 * them in a single parenthesised OR, so one absent asset is enough; the parentheses matter
 * because this clause is concatenated onto a WHERE that already has other AND terms.
 */
function missingClause(filter: CatalogFilter, prefix = ''): Clause {
  const { missing, missingMode } = filter
  if (!missing?.length) return NO_CLAUSE
  const conditions = missing.map((kind) => `${prefix}${MISSING_COLUMN[kind]} = 0`)
  return {
    sql:
      missingMode === 'any'
        ? ` AND (${conditions.join(' OR ')})`
        : conditions.map((c) => ` AND ${c}`).join(''),
    params: []
  }
}

/**
 * `AND` the chart has no play recorded against it (empty string when the filter does not ask).
 *
 * A chart with no `cloneHeroChecksum` matches, and must: nothing can ever join a play to it, so
 * excluding it would hide it from both halves of a played/unplayed split. The NOT EXISTS handles
 * the other side; written as a correlated subquery rather than a LEFT JOIN so it composes with
 * both query shapes below without changing either one's column list or its `charts.*` select.
 *
 * See CatalogFilterSchema on what "never played" can and cannot mean here: the play table only
 * covers the time Encore has been watching, not the user's whole history with the game.
 */
function neverPlayedClause(filter: CatalogFilter, prefix = ''): Clause {
  if (!filter.neverPlayed) return NO_CLAUSE
  return {
    sql: ` AND (${prefix}cloneHeroChecksum IS NULL OR NOT EXISTS (
		SELECT 1 FROM plays WHERE plays.checksum = ${prefix}cloneHeroChecksum))`,
    params: []
  }
}

/**
 * `AND LOWER(col) = LOWER(?)`, or nothing for an absent or blank value.
 *
 * Blank counts as absent so a picker reset to its "any" option (which posts an empty string)
 * clears the filter instead of asking for charts whose artist is literally "". NULL columns
 * never match, which they should not: an unknown artist is not the artist you picked.
 *
 * The column name is a literal from the call sites below, never user input.
 */
function exactTextClause(column: string, value: string | undefined, prefix: string): Clause {
  const trimmed = value?.trim()
  if (!trimmed) return NO_CLAUSE
  return { sql: ` AND LOWER(${prefix}${column}) = LOWER(?)`, params: [trimmed] }
}

/**
 * Escape the wildcards LIKE would otherwise read as syntax.
 *
 * Without this, a user searching for an album with an underscore in it gets a single-character
 * wildcard, and one containing '%' matches the whole library. The backslash has to be escaped
 * first or it would escape the escapes added after it.
 */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/** `AND LOWER(album) LIKE %value%`. See CatalogFilterSchema on why album is a substring match. */
function albumClause(filter: CatalogFilter, prefix = ''): Clause {
  const value = filter.album?.trim()
  if (!value) return NO_CLAUSE
  return {
    sql: ` AND LOWER(${prefix}album) LIKE LOWER(?) ESCAPE '\\'`,
    params: [likeContains(value)]
  }
}

/**
 * Inclusive `>=` / `<=` bounds on a numeric column, either end optional.
 *
 * A NULL column fails both comparisons in SQL, so a chart with no year or no stored length drops
 * out as soon as either bound is set. That is deliberate: an unknown value cannot be shown to be
 * inside the range the user asked for, and quietly including it would put three-hour charts in a
 * "under four minutes" list.
 */
function rangeClause(
  column: string,
  min: number | undefined,
  max: number | undefined,
  prefix: string
): Clause {
  const parts: Clause[] = []
  if (min !== undefined) parts.push({ sql: ` AND ${prefix}${column} >= ?`, params: [min] })
  if (max !== undefined) parts.push({ sql: ` AND ${prefix}${column} <= ?`, params: [max] })
  return joinClauses(parts)
}

/** Every non-search constraint, in the order they are ANDed onto a WHERE that already has a term. */
function constraintClause(filter: CatalogFilter, prefix = ''): Clause {
  return joinClauses([
    missingClause(filter, prefix),
    neverPlayedClause(filter, prefix),
    exactTextClause('artist', filter.artist, prefix),
    exactTextClause('genre', filter.genre, prefix),
    exactTextClause('charter', filter.charter, prefix),
    albumClause(filter, prefix),
    rangeClause('year', filter.yearMin, filter.yearMax, prefix),
    rangeClause('songLength', filter.lengthMinMs, filter.lengthMaxMs, prefix)
  ])
}

/**
 * Whether an FTS query has to join `charts` to answer this filter.
 *
 * The FTS table carries only the four indexed text columns, so any constraint reading a real
 * chart column needs the join. Adding a constraint without adding it here costs a SQL error on
 * the search path only, which is exactly the path the cheaper count was written to avoid.
 *
 * Written as "is the constraint clause empty" rather than as a second list of the filter's
 * fields, because the second list is the one that gets forgotten.
 */
function needsChartsJoin(filter: CatalogFilter): boolean {
  return constraintClause(filter, 'charts.').sql !== ''
}

/**
 * The catalog column each sort option orders by, and whether it sorts as text.
 *
 * A closed map keyed by the zod enum, so the ORDER BY is always built from a literal here and
 * never from anything that crossed the IPC boundary. `satisfies` is what makes a new enum member
 * a compile error rather than an undefined column name spliced into SQL.
 */
const SORT_COLUMN = {
  title: 'name',
  artist: 'artist',
  album: 'album',
  charter: 'charter',
  year: 'year',
  length: 'songLength'
} as const satisfies Record<CatalogSortField, keyof ChartRecord>

/** The sorts whose column holds text, and so need the case-insensitive collation. */
const TEXT_SORTS: readonly CatalogSortField[] = ['title', 'artist', 'album', 'charter']

/**
 * The ORDER BY body for a page of this filter.
 *
 * Three things are going on, and all three are about paging rather than about one screen:
 *
 * - Nulls always sort last, in both directions (`col IS NULL` first in the key). SQLite puts
 *   them first ascending, so "by year, oldest first" would otherwise open on the six charts
 *   whose year nobody knows.
 * - `path` ends every key. It is UNIQUE, so the order is total. Without a tiebreaker SQLite may
 *   return tied rows in any order it likes, and it need not pick the same one twice: with
 *   LIMIT/OFFSET paging that loses rows off the end of one page and repeats them on the next.
 *   Ninety-two of a real 222-chart library share an artist with something else, so ties are the
 *   normal case for every sort but length.
 * - No sort named keeps what each query shape did before: relevance for a search, title order
 *   for the plain list.
 */
function orderClause(filter: CatalogFilter, prefix: string, fallback: string): string {
  const sort = filter.sort
  if (!sort) return fallback
  const column = `${prefix}${SORT_COLUMN[sort]}`
  const collate = TEXT_SORTS.includes(sort) ? ' COLLATE NOCASE' : ''
  const direction = filter.direction === 'desc' ? 'DESC' : 'ASC'
  return `${column} IS NULL, ${column}${collate} ${direction}, ${prefix}name COLLATE NOCASE, ${prefix}path`
}

export function queryCharts(db: CatalogDb, filter: CatalogFilter): ChartRecord[] {
  const fts = ftsQuery(filter.search)
  const rows = fts
    ? ((): unknown[] => {
        const constraint = constraintClause(filter, 'charts.')
        const order = orderClause(filter, 'charts.', 'rank')
        return db
          .prepare(
            `SELECT charts.* FROM charts_fts JOIN charts ON charts.id = charts_fts.rowid
				 WHERE charts_fts MATCH ?${constraint.sql} ORDER BY ${order} LIMIT ? OFFSET ?`
          )
          .all(fts, ...constraint.params, filter.limit, filter.offset)
      })()
    : ((): unknown[] => {
        const constraint = constraintClause(filter)
        const order = orderClause(filter, '', 'name COLLATE NOCASE, path')
        return db
          .prepare(
            `SELECT * FROM charts WHERE 1 = 1${constraint.sql}
				 ORDER BY ${order} LIMIT ? OFFSET ?`
          )
          .all(...constraint.params, filter.limit, filter.offset)
      })()
  return (rows as Record<string, unknown>[]).map(fromRow)
}

export function countCharts(db: CatalogDb, filter: CatalogFilter): number {
  const fts = ftsQuery(filter.search)
  // The FTS count needs the charts join only when has-column constraints apply.
  let row: unknown
  if (fts) {
    const constraint = constraintClause(filter, 'charts.')
    row = needsChartsJoin(filter)
      ? db
          .prepare(
            `SELECT count(*) AS n FROM charts_fts JOIN charts ON charts.id = charts_fts.rowid
						 WHERE charts_fts MATCH ?${constraint.sql}`
          )
          .get(fts, ...constraint.params)
      : db.prepare(`SELECT count(*) AS n FROM charts_fts WHERE charts_fts MATCH ?`).get(fts)
  } else {
    const constraint = constraintClause(filter)
    row = db
      .prepare(`SELECT count(*) AS n FROM charts WHERE 1 = 1${constraint.sql}`)
      .get(...constraint.params)
  }
  return (row as { n: number }).n
}

/**
 * The distinct values behind the Installed view's pickers.
 *
 * Read from the catalog rather than from a fixed list, so a picker can only ever offer a choice
 * that some chart actually has and every option returns at least one row. Grouped case-insensitively
 * because the filters match that way: two rows spelling one charter differently would otherwise
 * be two entries that return the same charts.
 *
 * Blank and whitespace-only values are dropped. song.ini carries plenty of `genre = ` lines, and
 * an empty option in a dropdown is a choice nobody can read.
 *
 * No album list, by design: see CatalogFacets.
 */
export function chartFacets(db: CatalogDb): CatalogFacets {
  const distinctText = (column: 'artist' | 'genre' | 'charter'): string[] =>
    (
      db
        .prepare(
          `SELECT ${column} AS v FROM charts
					 WHERE ${column} IS NOT NULL AND TRIM(${column}) <> ''
					 GROUP BY ${column} COLLATE NOCASE
					 ORDER BY ${column} COLLATE NOCASE`
        )
        .all() as { v: string }[]
    ).map((r) => r.v)
  const years = (
    db
      .prepare(`SELECT DISTINCT year AS v FROM charts WHERE year IS NOT NULL ORDER BY year DESC`)
      .all() as { v: number }[]
  ).map((r) => r.v)
  return {
    artists: distinctText('artist'),
    genres: distinctText('genre'),
    charters: distinctText('charter'),
    years
  }
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
