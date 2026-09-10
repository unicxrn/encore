import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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
 * Nothing enforces a bump: a scanner change that forgets one leaves the tests green and the
 * user's rows stale. It is convention, checked in review.
 *
 * This is deliberately separate from SCHEMA_VERSION: table shape and parse output change
 * for different reasons and on different schedules.
 */
export const SCAN_VERSION = 6

/** Shape of the `charts` table. Bump when a migration is added below. */
const SCHEMA_VERSION = 4

/** The columns `charts` currently has: the lookup that makes the ALTER migrations re-runnable. */
function existingColumns(db: CatalogDb): Set<string> {
  return new Set((db.pragma('table_info(charts)') as { name: string }[]).map((c) => c.name))
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
  { name: 'tempoMapHash', ddl: 'tempoMapHash TEXT' }
]

/**
 * Bring an existing database up to SCHEMA_VERSION.
 *
 * Every step is an additive ALTER guarded by a column-existence check, so this is safe to run
 * repeatedly and safe on a freshly created database where CREATE TABLE already produced the
 * final shape. Rows keep their data; the SCAN_VERSION bump is what refills the new columns.
 *
 * `user_version` only ever moves forward. A database written by a NEWER build carries a higher
 * version, and stamping SCHEMA_VERSION over it would destroy the only record of what shape it
 * is in. That is harmless while every migration here is additive and idempotent, but the first
 * version-gated migration would then silently skip on that database.
 */
function migrate(db: CatalogDb): void {
  const columns = existingColumns(db)
  for (const { name, ddl } of ADDED_COLUMNS) {
    if (!columns.has(name)) db.exec(`ALTER TABLE charts ADD COLUMN ${ddl}`)
  }
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`)
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
			tempoMapHash TEXT
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS charts_fts USING fts5(
			name, artist, album, charter, content='charts', content_rowid='id'
		);
		-- Writes must use ON CONFLICT upserts, never INSERT OR REPLACE: REPLACE's implicit
		-- delete bypasses these triggers and desyncs the FTS index.
		CREATE TRIGGER IF NOT EXISTS charts_ai AFTER INSERT ON charts BEGIN
			INSERT INTO charts_fts(rowid, name, artist, album, charter)
			VALUES (new.id, new.name, new.artist, new.album, new.charter);
		END;
		CREATE TRIGGER IF NOT EXISTS charts_ad AFTER DELETE ON charts BEGIN
			INSERT INTO charts_fts(charts_fts, rowid, name, artist, album, charter)
			VALUES ('delete', old.id, old.name, old.artist, old.album, old.charter);
		END;
		CREATE TRIGGER IF NOT EXISTS charts_au AFTER UPDATE ON charts BEGIN
			INSERT INTO charts_fts(charts_fts, rowid, name, artist, album, charter)
			VALUES ('delete', old.id, old.name, old.artist, old.album, old.charter);
			INSERT INTO charts_fts(rowid, name, artist, album, charter)
			VALUES (new.id, new.name, new.artist, new.album, new.charter);
		END;
	`)
  migrate(db)
  return db
}
