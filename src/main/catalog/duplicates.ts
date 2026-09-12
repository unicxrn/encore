import type {
  AlternateGroup,
  DuplicateCopy,
  DuplicateReport,
  IdenticalGroup,
  VersionGroup
} from '../../shared/duplicates'
import type { CatalogDb } from './db'

/**
 * Find what a library holds more than one copy of, entirely in SQL.
 *
 * Two statements, each one pass over `charts`, and both hand back only rows that are already in a
 * group of two or more. Everything after that is a walk over those rows in first-seen order, so
 * the cost is the two scans plus the groups themselves, never a comparison of every chart against
 * every other chart. That distinction is the feature: the naive version looks identical on a
 * 200-chart fixture and is 400 million comparisons on a real 20,000-chart library.
 *
 * Nothing here writes, opens or even stats a file. The catalog is the whole input, which is also
 * the honest limit of the answer: a chart the scanner has not reached is not in it, and a chart
 * whose row predates scan version 7 has no `cloneHeroChecksum` and cannot be compared byte for
 * byte. `unidentifiedCharts` on the report is how the second of those reaches the user.
 */

/** The columns a duplicate row needs. Shared by both statements so the mapping below is one. */
const COPY_COLUMNS = `path, chartType, name, artist, album, charter, songLength, modifiedTime,
	cloneHeroChecksum`

/**
 * Tier 1: every chart whose Clone Hero checksum is shared with at least one other chart.
 *
 * The inner GROUP BY and the outer IN both read `charts_checksum`, the index that already exists
 * for the play join (see `migrate` in db.ts), so neither half sorts the table. Ordering by the
 * checksum is what lets the grouping below be a single walk: rows of one group arrive together.
 */
const IDENTICAL_SQL = `SELECT ${COPY_COLUMNS} FROM charts
	 WHERE cloneHeroChecksum IS NOT NULL AND cloneHeroChecksum IN (
		 SELECT cloneHeroChecksum FROM charts
		 WHERE cloneHeroChecksum IS NOT NULL
		 GROUP BY cloneHeroChecksum HAVING COUNT(*) > 1
	 )
	 ORDER BY cloneHeroChecksum, path`

/**
 * Tiers 2 and 3: every chart that shares an artist and a title with at least one other chart.
 *
 * One window function does the grouping, so the whole thing is a scan plus a sort, and the WHERE
 * on `copies` throws away the vast majority of the library before any row crosses back into
 * JavaScript. Charter is deliberately NOT part of this partition: both remaining tiers are about
 * one song, and which of them a row belongs to is decided by splitting the song group on charter
 * afterwards, where it costs a pass over a handful of rows rather than a second query.
 *
 * Blank and null artists or titles are dropped first. Without that, every chart whose song.ini
 * has no `artist` would be grouped with every other one, and a library's untagged charts would be
 * reported as several hundred versions of one song.
 *
 * `LOWER` and `TRIM` are what make the key case and whitespace insensitive, matching how the rest
 * of the catalog compares these columns (`chartsExistByMeta`, the filter clauses in queries.ts).
 * SQLite's LOWER only folds ASCII, so two spellings of an accented artist that differ in case
 * stay two groups. That is a miss, never a false claim: the tier it costs is a listing, not an
 * accusation.
 */
const SONG_SQL = `SELECT ${COPY_COLUMNS}, songKey FROM (
		 SELECT ${COPY_COLUMNS},
			 LOWER(TRIM(artist)) || CHAR(31) || LOWER(TRIM(name)) AS songKey,
			 COUNT(*) OVER (PARTITION BY LOWER(TRIM(artist)), LOWER(TRIM(name))) AS copies
		 FROM charts
		 WHERE name IS NOT NULL AND TRIM(name) <> ''
			 AND artist IS NOT NULL AND TRIM(artist) <> ''
	 )
	 WHERE copies > 1
	 ORDER BY songKey, path`

interface CopyRow {
  path: string
  chartType: string
  name: string | null
  artist: string | null
  album: string | null
  charter: string | null
  songLength: number | null
  modifiedTime: number
  cloneHeroChecksum: string | null
}

function toCopy(row: CopyRow): DuplicateCopy {
  return {
    path: row.path,
    // The column is written from a 'folder' | 'sng' union and is NOT NULL, so anything else means
    // a hand-edited database. Reading it as a folder chart is the harmless of the two guesses:
    // this report only ever displays the value.
    chartType: row.chartType === 'sng' ? 'sng' : 'folder',
    name: row.name,
    artist: row.artist,
    album: row.album,
    charter: row.charter,
    songLength: row.songLength,
    modifiedTime: row.modifiedTime,
    cloneHeroChecksum: row.cloneHeroChecksum
  }
}

/**
 * Split rows that arrive in key order into runs of equal key.
 *
 * The whole reason both statements carry an ORDER BY on their key: a group is a contiguous run,
 * so finding all of them is one pass and no row is ever compared with a row outside its own
 * group.
 */
function runs<T>(rows: T[], keyOf: (row: T) => string): T[][] {
  const out: T[][] = []
  let current: T[] = []
  let key: string | null = null
  for (const row of rows) {
    const rowKey = keyOf(row)
    if (rowKey !== key) {
      if (current.length > 0) out.push(current)
      current = []
      key = rowKey
    }
    current.push(row)
  }
  if (current.length > 0) out.push(current)
  return out
}

/** Charter as the sub-grouping key: case and whitespace folded, blank staying blank. */
function charterKey(copy: DuplicateCopy): string {
  return (copy.charter ?? '').trim().toLowerCase()
}

/** The first non-blank spelling of a field in a group, for display. Falls back to the first row. */
function displayValue(copies: DuplicateCopy[], field: 'artist' | 'name' | 'charter'): string {
  for (const copy of copies) {
    const value = copy[field]?.trim()
    if (value) return value
  }
  return ''
}

/**
 * How many copies in this group share a checksum with another copy in it.
 *
 * Counted so a version group can say out loud which of its copies are also in the identical list.
 * Groups here are two to a handful of rows, so the map costs nothing worth avoiding.
 */
function identicalCopyCount(copies: DuplicateCopy[]): number {
  const seen = new Map<string, number>()
  for (const copy of copies) {
    if (copy.cloneHeroChecksum === null) continue
    seen.set(copy.cloneHeroChecksum, (seen.get(copy.cloneHeroChecksum) ?? 0) + 1)
  }
  let total = 0
  for (const count of seen.values()) if (count > 1) total += count
  return total
}

/**
 * Turn one song's rows into whichever of tiers 2 and 3 they belong to. A song can produce both:
 * two charters, one of whom the user has two versions from.
 */
function classifySong(
  copies: DuplicateCopy[],
  versions: VersionGroup[],
  alternates: AlternateGroup[]
): void {
  const byCharter = new Map<string, DuplicateCopy[]>()
  for (const copy of copies) {
    const key = charterKey(copy)
    const bucket = byCharter.get(key)
    if (bucket === undefined) byCharter.set(key, [copy])
    else bucket.push(copy)
  }

  for (const [key, bucket] of byCharter) {
    // A blank charter cannot support the claim tier 2 makes. Two untitled-charter copies of one
    // song may be by two different people, so calling them versions of one chart would be an
    // assertion the catalog does not hold. They stay visible through tier 1 when they really are
    // the same file.
    if (key === '' || bucket.length < 2) continue
    const known = new Set<string>()
    let unknownCount = 0
    for (const copy of bucket) {
      if (copy.cloneHeroChecksum === null) unknownCount += 1
      else known.add(copy.cloneHeroChecksum)
    }
    // One known checksum and nothing unknown means every copy here is the same chart file, which
    // is tier 1 and only tier 1. Repeating it as "different versions" would be false.
    if (known.size < 2 && unknownCount === 0) continue
    versions.push({
      artist: displayValue(bucket, 'artist'),
      name: displayValue(bucket, 'name'),
      charter: displayValue(bucket, 'charter'),
      copies: bucket,
      versionCount: known.size,
      unknownCount,
      identicalCopies: identicalCopyCount(bucket)
    })
  }

  // Tier 3 counts charters that are actually named. A song with one named charter and one copy
  // whose charter is blank is not evidence of two charters, and saying so would invent a second
  // person.
  const named = [...byCharter.entries()].filter(([key]) => key !== '')
  if (named.length < 2) return
  alternates.push({
    artist: displayValue(copies, 'artist'),
    name: displayValue(copies, 'name'),
    charters: named.map(([, bucket]) => ({
      charter: displayValue(bucket, 'charter'),
      copies: bucket
    }))
  })
}

/** Sort key for a group, so the report reads alphabetically rather than in catalog order. */
function byArtistThenName(
  a: { artist: string; name: string },
  b: { artist: string; name: string }
): number {
  return a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name)
}

export function findDuplicates(db: CatalogDb): DuplicateReport {
  const identicalRows = (db.prepare(IDENTICAL_SQL).all() as CopyRow[]).map(toCopy)
  const identical: IdenticalGroup[] = runs(
    identicalRows,
    (copy) => copy.cloneHeroChecksum ?? ''
  ).map((copies) => ({
    // The statement selects only non-null checksums, so this is always a string; the fallback
    // exists because the column's type says it may be null and a non-null assertion here would be
    // a claim the type system cannot check.
    checksum: copies[0].cloneHeroChecksum ?? '',
    copies
  }))

  const songRows = db.prepare(SONG_SQL).all() as (CopyRow & { songKey: string })[]
  const versions: VersionGroup[] = []
  const alternates: AlternateGroup[] = []
  for (const song of runs(songRows, (row) => row.songKey)) {
    classifySong(song.map(toCopy), versions, alternates)
  }

  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
			 SUM(CASE WHEN cloneHeroChecksum IS NULL THEN 1 ELSE 0 END) AS unidentified
		 FROM charts`
    )
    .get() as { total: number; unidentified: number | null }

  return {
    // Most copies first: the group of six is the one worth looking at before the group of two.
    identical: identical.sort((a, b) => b.copies.length - a.copies.length),
    versions: versions.sort(byArtistThenName),
    alternates: alternates.sort(byArtistThenName),
    totalCharts: counts.total,
    // SUM over no rows is null, which is 0 charts rather than an unknown number.
    unidentifiedCharts: counts.unidentified ?? 0
  }
}
