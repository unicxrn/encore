import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { stripRichText } from '../../shared/format'

export type CatalogDb = Database.Database

/**
 * Version of the scanner's parsing logic, stamped onto every row it writes.
 *
 * Bump this whenever the scanner's OUTPUT changes (a better parser, a new field, a fixed
 * bug), so already-scanned charts are re-parsed on the next scan. Without it, the content
 * checks (folderHash / mtime) match unchanged files forever and stale rows are stuck:
 * .sng charts scanned before M1c kept their path-only metadata and showed as raw paths
 * with empty difficulty columns no matter how many times the user rescanned.
 *
 * 3: .sng extraction now generates song.ini from the archive header. This changes the parse
 *    for every .sng (all of them lose a phantom "no metadata" finding) and is the only way
 *    charts whose title exists nowhere else get one at all.
 *
 * 4: difficulty ratings of -1 (song.ini's "unrated" sentinel) are stored as null instead of
 *    being passed through and displayed as a literal "-1".
 *
 * 5: most of what scan-chart returns is now stored: album art, instruments, per-difficulty
 *    note counts, peak NPS and the bulk of the song.ini metadata. Not stored, because nothing
 *    displays them: chartHash, playable, the issue arrays, track hashes, and the .mid parsing
 *    modifiers. Stored but lossy: maxNps keeps only instrument/difficulty/nps, and the schema
 *    drops upstream's `time`. Existing rows carry none of the new fields and must be re-parsed.
 *
 * 7: cloneHeroChecksum is computed and stored. It is Clone Hero's own identity for a chart and
 *    the only key that joins a recorded play to a catalog row, so every existing chart has to be
 *    re-parsed to get one; the column alone would stay null forever otherwise.
 *
 * Nothing enforces a bump: a scanner change that forgets one leaves the tests green and the
 * user's rows stale. It is convention, checked in review.
 *
 * NOT bumped for the stripped-name columns added at schema 6, and that is the interesting case.
 * The usual rule is that a new column needs a bump too, because the column alone stays null until
 * a rescan refills it. It holds for every column above: each one carries something only a re-read
 * of the chart's files can produce. A stripped name is different in kind. It is a pure function
 * of text the row already stores, so `migrate` below fills it in SQL, and the scanner would have
 * nothing to add that the migration has not already written. Bumping anyway would make every user
 * re-parse their whole library for a value that is correct before they open the app.
 *
 * The thing that makes that safe is that the catalog is never asked for a rescan to repair those
 * columns: see BACKFILL_SQL, which runs on every open and is what closes the hole a downgrade would
 * otherwise leave. A change to stripRichText's rules is the one case that needs more: the stored
 * values go stale, and the fix is to null the four columns in a migration step so the backfill
 * recomputes them, not to bump this.
 *
 * This is deliberately separate from SCHEMA_VERSION: table shape and parse output change
 * for different reasons and on different schedules.
 */
export const SCAN_VERSION = 7

/**
 * Shape of the catalog's tables. Bump when a migration is added below.
 *
 * Exported for the tests alone, which assert against it rather than against a literal: a bump
 * used to mean editing four hard-coded 4s in db.test.ts, and the version this stamps is not
 * itself the thing those tests are about.
 *
 * 6: the four stripped-name columns, the `charts_search` view and an FTS index rebuilt over it.
 *
 * 7: `score_charts` and `score_bests`, holding what Clone Hero's own score files say. No
 *    SCAN_VERSION bump goes with this one, and that is not an oversight: nothing in either table
 *    comes from reading a chart, so a rescan could not fill them and asking every user for one
 *    would re-read their whole library to learn nothing. The import fills them instead.
 */
export const SCHEMA_VERSION = 7

/**
 * The text columns stored twice: once as the chart says it, once as a reader sees it.
 *
 * Clone Hero renders TextMeshPro markup in these four, and charters use it: a charter whose
 * song.ini name is one colour tag per letter reads as `WIlIMayI` on screen and as eight colour
 * tags in the file. Searching and sorting over the raw string therefore answers questions about text
 * nobody can see. The stripped column is what search and sort read; the raw column stays exactly
 * as the chart wrote it, because it is the chart's own data and Encore does not get to edit it.
 *
 * Keyed by the raw column, valued by its stripped twin, so queries.ts and the DDL below cannot
 * disagree about a name.
 */
export const STRIPPED_COLUMN = {
  name: 'nameStripped',
  artist: 'artistStripped',
  album: 'albumStripped',
  charter: 'charterStripped'
} as const

export type StrippedSource = keyof typeof STRIPPED_COLUMN

/**
 * The value a reader sees for one of those columns, falling back to the raw text.
 *
 * The fallback is the whole half-migrated story in one expression. A stripped column is null on
 * any row written before schema 6 and on any row a downgraded build wrote since, and a null there
 * means "not computed", never "empty". Coalescing to the raw column keeps such a row searchable
 * and sortable exactly as well as it was before this feature existed, rather than dropping it out
 * of the index and off the end of every sort.
 */
export function readableColumn(column: StrippedSource, prefix = ''): string {
  return `COALESCE(${prefix}${STRIPPED_COLUMN[column]}, ${prefix}${column})`
}

/**
 * The view the FTS index is built from, and the only definition of what gets indexed.
 *
 * FTS5's `content=` table is read by 'rebuild' and 'integrity-check', so pointing it at `charts`
 * while the triggers fed it something else would leave a rebuild silently reverting the index to
 * the raw names. A view carrying the coalesced values makes both halves read the same expression.
 *
 * Created even on a database that predates the stripped columns: SQLite resolves a view's columns
 * when the view is used, not when it is created, and `migrate` runs the ALTERs before anything
 * selects from it.
 */
const SEARCH_VIEW_SQL = `CREATE VIEW IF NOT EXISTS charts_search AS
		SELECT id,
			${readableColumn('name')} AS name,
			${readableColumn('artist')} AS artist,
			${readableColumn('album')} AS album,
			${readableColumn('charter')} AS charter
		FROM charts;`

/**
 * Marks a `charts_fts` built over the view rather than straight over `charts`.
 *
 * An FTS5 table's columns and content source cannot be altered, so a database from before
 * schema 6 has to have the index dropped and rebuilt. This substring in the stored CREATE
 * statement is how `migrate` tells the two apart.
 */
const SEARCH_CONTENT = "content='charts_search'"

const FTS_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS charts_fts USING fts5(
			name, artist, album, charter, ${SEARCH_CONTENT}, content_rowid='id'
		);`

/**
 * Keeping the index in step with `charts`, row by row.
 *
 * The values repeat the view's COALESCE rather than selecting from it: a trigger sees `new`/`old`
 * as rows, not as something the view can be joined against, and the delete half in particular has
 * to reproduce what was indexed when the row went in or FTS5 corrupts. Reproducing it from `old`
 * is what makes the backfill below safe: for a row whose stripped columns are still null the
 * expression yields the raw name, which is exactly what the pre-schema-6 triggers indexed.
 *
 * Writes must use ON CONFLICT upserts, never INSERT OR REPLACE: REPLACE's implicit delete bypasses
 * these triggers and desyncs the FTS index.
 */
const FTS_TRIGGERS_SQL = `
		CREATE TRIGGER IF NOT EXISTS charts_ai AFTER INSERT ON charts BEGIN
			INSERT INTO charts_fts(rowid, name, artist, album, charter)
			VALUES (new.id, ${readableColumn('name', 'new.')}, ${readableColumn('artist', 'new.')},
				${readableColumn('album', 'new.')}, ${readableColumn('charter', 'new.')});
		END;
		CREATE TRIGGER IF NOT EXISTS charts_ad AFTER DELETE ON charts BEGIN
			INSERT INTO charts_fts(charts_fts, rowid, name, artist, album, charter)
			VALUES ('delete', old.id, ${readableColumn('name', 'old.')}, ${readableColumn('artist', 'old.')},
				${readableColumn('album', 'old.')}, ${readableColumn('charter', 'old.')});
		END;
		CREATE TRIGGER IF NOT EXISTS charts_au AFTER UPDATE ON charts BEGIN
			INSERT INTO charts_fts(charts_fts, rowid, name, artist, album, charter)
			VALUES ('delete', old.id, ${readableColumn('name', 'old.')}, ${readableColumn('artist', 'old.')},
				${readableColumn('album', 'old.')}, ${readableColumn('charter', 'old.')});
			INSERT INTO charts_fts(rowid, name, artist, album, charter)
			VALUES (new.id, ${readableColumn('name', 'new.')}, ${readableColumn('artist', 'new.')},
				${readableColumn('album', 'new.')}, ${readableColumn('charter', 'new.')});
		END;`

/** The SQL name of the stripper, registered per connection by `migrate`. */
const STRIP_FUNCTION = 'encore_strip_rich_text'

/**
 * Fill in stripped columns that have never been computed, and only those.
 *
 * Runs on every open, not once at the version bump. A build that predates schema 6 can still be
 * installed over one that does not, and it writes rows knowing nothing about these columns; a
 * version-gated backfill would skip them for good, because `user_version` is already 6 by then.
 * The condition is what makes repeated runs free: a row whose raw column is null keeps a null
 * stripped column and must not match again, or every open would rewrite it. Measured on a
 * generated 20,000 row catalog: 81 ms the once, 4 ms per open after that.
 *
 * What it deliberately does not do is re-derive a stripped column that already has a value. One
 * case survives that: an older build is installed over this one, rescans a chart whose name has
 * changed on disk, and writes the new raw name beside the stripped form of the old one. Nothing
 * here repairs that afterwards, because telling a stale value from a current one means computing
 * every row on every open, and the price of that is the 81 ms above at every launch plus the
 * write traffic to go with it. The chart reads correctly again after anything rewrites its row.
 */
const BACKFILL_SQL = `UPDATE charts SET
		nameStripped = ${STRIP_FUNCTION}(name),
		artistStripped = ${STRIP_FUNCTION}(artist),
		albumStripped = ${STRIP_FUNCTION}(album),
		charterStripped = ${STRIP_FUNCTION}(charter)
	WHERE (nameStripped IS NULL AND name IS NOT NULL)
		OR (artistStripped IS NULL AND artist IS NOT NULL)
		OR (albumStripped IS NULL AND album IS NOT NULL)
		OR (charterStripped IS NULL AND charter IS NOT NULL)`

/** The columns `charts` currently has: the lookup that makes the ALTER migrations re-runnable. */
function existingColumns(db: CatalogDb): Set<string> {
  return new Set((db.pragma('table_info(charts)') as { name: string }[]).map((c) => c.name))
}

/** Whether `charts_fts` is the one built over `charts_search`, or the older one over `charts`. */
function searchIndexIsCurrent(db: CatalogDb): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'charts_fts'`)
    .get() as { sql: string | null } | undefined
  return row?.sql?.includes(SEARCH_CONTENT) === true
}

/** Columns added after v1, with the exact DDL fragment each needs. */
const ADDED_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'scanVersion', ddl: 'scanVersion INTEGER NOT NULL DEFAULT 0' },
  { name: 'albumArtMd5', ddl: 'albumArtMd5 TEXT' },
  { name: 'instruments', ddl: "instruments TEXT NOT NULL DEFAULT '[]'" },
  { name: 'noteCounts', ddl: "noteCounts TEXT NOT NULL DEFAULT '[]'" },
  { name: 'maxNps', ddl: "maxNps TEXT NOT NULL DEFAULT '[]'" },
  { name: 'diffBand', ddl: 'diffBand INTEGER' },
  { name: 'diffRhythm', ddl: 'diffRhythm INTEGER' },
  { name: 'diffGuitarCoop', ddl: 'diffGuitarCoop INTEGER' },
  { name: 'diffDrumsReal', ddl: 'diffDrumsReal INTEGER' },
  { name: 'diffGuitarGhl', ddl: 'diffGuitarGhl INTEGER' },
  { name: 'diffBassGhl', ddl: 'diffBassGhl INTEGER' },
  { name: 'diffRhythmGhl', ddl: 'diffRhythmGhl INTEGER' },
  { name: 'diffGuitarCoopGhl', ddl: 'diffGuitarCoopGhl INTEGER' },
  { name: 'previewStartTime', ddl: 'previewStartTime INTEGER' },
  { name: 'icon', ddl: 'icon TEXT' },
  { name: 'loadingPhrase', ddl: 'loadingPhrase TEXT' },
  { name: 'albumTrack', ddl: 'albumTrack INTEGER' },
  { name: 'playlistTrack', ddl: 'playlistTrack INTEGER' },
  { name: 'drumType', ddl: 'drumType TEXT' },
  { name: 'modchart', ddl: 'modchart INTEGER NOT NULL DEFAULT 0' },
  { name: 'proDrums', ddl: 'proDrums INTEGER NOT NULL DEFAULT 0' },
  { name: 'fiveLaneDrums', ddl: 'fiveLaneDrums INTEGER NOT NULL DEFAULT 0' },
  { name: 'has2xKick', ddl: 'has2xKick INTEGER NOT NULL DEFAULT 0' },
  { name: 'hasSoloSections', ddl: 'hasSoloSections INTEGER NOT NULL DEFAULT 0' },
  { name: 'hasVocals', ddl: 'hasVocals INTEGER NOT NULL DEFAULT 0' },
  { name: 'hasOpenNotes', ddl: 'hasOpenNotes INTEGER NOT NULL DEFAULT 0' },
  { name: 'hasTapNotes', ddl: 'hasTapNotes INTEGER NOT NULL DEFAULT 0' },
  { name: 'hasForcedNotes', ddl: 'hasForcedNotes INTEGER NOT NULL DEFAULT 0' },
  { name: 'hasFlexLanes', ddl: 'hasFlexLanes INTEGER NOT NULL DEFAULT 0' },
  { name: 'chartHash', ddl: 'chartHash TEXT' },
  { name: 'tempoMapHash', ddl: 'tempoMapHash TEXT' },
  { name: 'cloneHeroChecksum', ddl: 'cloneHeroChecksum TEXT' },
  // Nullable on purpose, and null means "never computed". A chart whose name is nothing but
  // markup strips to '', which is a different fact and has to stay tellable from this one.
  { name: 'nameStripped', ddl: 'nameStripped TEXT' },
  { name: 'artistStripped', ddl: 'artistStripped TEXT' },
  { name: 'albumStripped', ddl: 'albumStripped TEXT' },
  { name: 'charterStripped', ddl: 'charterStripped TEXT' }
]

/**
 * Bring an existing database up to SCHEMA_VERSION.
 *
 * Every step is an additive ALTER guarded by a column-existence check, so this is safe to run
 * repeatedly and safe on a freshly created database where CREATE TABLE already produced the
 * final shape. Rows keep their data; a SCAN_VERSION bump is what refills a column only a re-read
 * of the chart's files can produce, and the backfill here is what fills the ones it cannot.
 *
 * One transaction, because the search index is briefly not there. A crash between dropping the
 * old `charts_fts` and rebuilding the new one would leave a catalog whose triggers write into a
 * table that does not exist, and every scan after it would fail on the first row.
 *
 * `user_version` only ever moves forward. A database written by a NEWER build carries a higher
 * version, and stamping SCHEMA_VERSION over it would destroy the only record of what shape it
 * is in. That is harmless while every migration here is additive and idempotent, but the first
 * version-gated migration would then silently skip on that database.
 */
function migrate(db: CatalogDb): void {
  // Registered on the connection rather than inlined as SQL because the rules live in one place:
  // a second, SQL-shaped stripper would drift from the one the screen uses, and the two
  // disagreeing means a name the user can see and cannot find.
  db.function(STRIP_FUNCTION, { deterministic: true }, (value: unknown) =>
    value === null || value === undefined ? null : stripRichText(String(value))
  )
  db.transaction(() => {
    const columns = existingColumns(db)
    for (const { name, ddl } of ADDED_COLUMNS) {
      if (!columns.has(name)) db.exec(`ALTER TABLE charts ADD COLUMN ${ddl}`)
    }
    // After the ALTERs, never in openCatalog's CREATE block: on a database written before v5 the
    // column does not exist yet when that block runs, and CREATE INDEX would throw rather than
    // being skipped by its IF NOT EXISTS. This is the lookup every play join makes.
    db.exec('CREATE INDEX IF NOT EXISTS charts_checksum ON charts(cloneHeroChecksum)')
    // A database opened by a build that predates the view has none: openCatalog's IF NOT EXISTS
    // created it a moment ago only if this is a fresh file.
    db.exec(SEARCH_VIEW_SQL)
    if (searchIndexIsCurrent(db)) {
      // Steps in place: the triggers carry the backfill's rows into the index as it writes them.
      db.exec(BACKFILL_SQL)
    } else {
      // The index still holds the raw names. Dropping the triggers first means the backfill does
      // not pay to update an index that is about to be thrown away. Over a generated 20,000 row
      // catalog: 81 ms for the backfill plus 20 ms for the rebuild, against 134 ms for the same
      // backfill with the triggers live, which would still leave the index to swap afterwards.
      db.exec('DROP TRIGGER IF EXISTS charts_ai; DROP TRIGGER IF EXISTS charts_ad;')
      db.exec('DROP TRIGGER IF EXISTS charts_au; DROP TABLE IF EXISTS charts_fts;')
      db.exec(BACKFILL_SQL)
      db.exec(FTS_SQL)
      db.exec(FTS_TRIGGERS_SQL)
      db.exec(`INSERT INTO charts_fts(charts_fts) VALUES('rebuild')`)
    }
    const version = db.pragma('user_version', { simple: true }) as number
    if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`)
  })()
}

export function openCatalog(filePath: string): CatalogDb {
  mkdirSync(dirname(filePath), { recursive: true })
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.exec(`
		CREATE TABLE IF NOT EXISTS charts (
			id INTEGER PRIMARY KEY,
			path TEXT UNIQUE NOT NULL,
			chartType TEXT NOT NULL,
			name TEXT, artist TEXT, album TEXT, genre TEXT, year INTEGER, charter TEXT,
			diffGuitar INTEGER, diffBass INTEGER, diffDrums INTEGER, diffKeys INTEGER, diffVocals INTEGER,
			songLength INTEGER,
			hasVideo INTEGER NOT NULL DEFAULT 0,
			hasBackground INTEGER NOT NULL DEFAULT 0,
			hasAlbumArt INTEGER NOT NULL DEFAULT 0,
			hasLyrics INTEGER NOT NULL DEFAULT 0,
			folderHash TEXT NOT NULL,
			modifiedTime INTEGER NOT NULL,
			scanVersion INTEGER NOT NULL DEFAULT 0,
			albumArtMd5 TEXT,
			instruments TEXT NOT NULL DEFAULT '[]',
			noteCounts TEXT NOT NULL DEFAULT '[]',
			maxNps TEXT NOT NULL DEFAULT '[]',
			diffBand INTEGER, diffRhythm INTEGER, diffGuitarCoop INTEGER, diffDrumsReal INTEGER,
			diffGuitarGhl INTEGER, diffBassGhl INTEGER, diffRhythmGhl INTEGER, diffGuitarCoopGhl INTEGER,
			previewStartTime INTEGER, icon TEXT, loadingPhrase TEXT,
			albumTrack INTEGER, playlistTrack INTEGER, drumType TEXT,
			modchart INTEGER NOT NULL DEFAULT 0,
			proDrums INTEGER NOT NULL DEFAULT 0,
			fiveLaneDrums INTEGER NOT NULL DEFAULT 0,
			has2xKick INTEGER NOT NULL DEFAULT 0,
			hasSoloSections INTEGER NOT NULL DEFAULT 0,
			hasVocals INTEGER NOT NULL DEFAULT 0,
			hasOpenNotes INTEGER NOT NULL DEFAULT 0,
			hasTapNotes INTEGER NOT NULL DEFAULT 0,
			hasForcedNotes INTEGER NOT NULL DEFAULT 0,
			hasFlexLanes INTEGER NOT NULL DEFAULT 0,
			chartHash TEXT,
			tempoMapHash TEXT,
			cloneHeroChecksum TEXT,
			nameStripped TEXT,
			artistStripped TEXT,
			albumStripped TEXT,
			charterStripped TEXT
		);
		-- One row per play Clone Hero recorded, accumulated by watching its scorestats.json.
		-- That file only ever holds the MOST RECENT play, so this table is the only history
		-- there is: a play missed while Encore was not running is gone for good.
		--
		-- The checksum column is Clone Hero's own chart identity, stored lower-hex to match
		-- charts.cloneHeroChecksum (the game writes upper). It is deliberately NOT a foreign key
		-- to charts: a play of a chart the user has since deleted, or has not scanned yet, is
		-- still a play, and losing it to a constraint would be worse than an orphan row.
		--
		-- UNIQUE(checksum, playedAt) is the "already recorded" rule. Clone Hero stamps
		-- score_timestamp to sub-millisecond precision, so two plays of one chart cannot collide
		-- while re-reading the same unchanged file always does. Writes use INSERT OR IGNORE.
		CREATE TABLE IF NOT EXISTS plays (
			id INTEGER PRIMARY KEY,
			checksum TEXT NOT NULL,
			playedAt TEXT NOT NULL,
			songName TEXT, artistName TEXT, charterName TEXT,
			gameVersion TEXT, gameMode TEXT,
			playbackSpeed INTEGER,
			bandScore INTEGER, bandStars INTEGER, playerCount INTEGER,
			instrument TEXT, difficulty TEXT, profileName TEXT,
			score INTEGER, notesHit INTEGER, totalNotes INTEGER, maxStreak INTEGER,
			isFc INTEGER NOT NULL DEFAULT 0,
			isPfc INTEGER NOT NULL DEFAULT 0,
			stars INTEGER,
			avgMultiplier REAL,
			UNIQUE(checksum, playedAt)
		);
		CREATE INDEX IF NOT EXISTS plays_checksum ON plays(checksum);
		-- What Clone Hero's own score files say about each chart, imported from scoredata.bin and
		-- scoresext.bin (play/scoredata.ts decodes them, play/score-store.ts writes these rows).
		--
		-- SEPARATE FROM plays ON PURPOSE, and the two must never be merged. plays is a log of
		-- plays Encore watched happen, one row per play, each with the timestamp the game wrote.
		-- These two tables are a table of BESTS with no dates at all, and playCount is a lifetime
		-- running total that ALREADY INCLUDES every play plays holds. Writing these rows into
		-- plays would double count every play Encore has seen, invent dates for plays that have
		-- none, and corrupt every total and every day of the activity chart. Keeping them apart is
		-- also what lets a screen show the two side by side and say which is which.
		--
		-- The checksum is Clone Hero's own chart identity, lower hex, joinable to
		-- charts.cloneHeroChecksum through the charts_checksum index. Not a foreign key, for the
		-- same reason plays is not: the game has records for charts this library never had.
		--
		-- One row per chart the game has a record of. rowCount and hasOnlyConfirmedVariants are
		-- derived from the score rows, and stored rather than re-derived by a join: a chart can have
		-- a play count and no score rows at all, and the rule for which variants are confirmed
		-- lives in the parser. One writer (the import) replaces both tables inside one
		-- transaction, so they cannot disagree.
		CREATE TABLE IF NOT EXISTS score_charts (
			checksum TEXT PRIMARY KEY,
			playCount INTEGER NOT NULL,
			rowCount INTEGER NOT NULL,
			hasOnlyConfirmedVariants INTEGER NOT NULL
		);
		-- One row per chart per variant: the game's own key for the several scores it keeps for one
		-- chart. See play/scoredata.ts on what a variant is not known to mean, and why a score from
		-- an unconfirmed variant must not be shown beside a confirmed one.
		CREATE TABLE IF NOT EXISTS score_bests (
			checksum TEXT NOT NULL,
			variant INTEGER NOT NULL,
			difficulty INTEGER NOT NULL,
			percent INTEGER NOT NULL,
			isFullCombo INTEGER NOT NULL DEFAULT 0,
			playbackSpeed INTEGER NOT NULL,
			stars INTEGER NOT NULL,
			score INTEGER NOT NULL,
			scoreWithoutCleanPlayBonus INTEGER NOT NULL,
			PRIMARY KEY (checksum, variant)
		);
		${SEARCH_VIEW_SQL}
		${FTS_SQL}
		${FTS_TRIGGERS_SQL}
	`)
  migrate(db)
  return db
}
