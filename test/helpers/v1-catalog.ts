import Database from 'better-sqlite3'

/**
 * The catalog schema exactly as it shipped at `user_version = 1`, before scanVersion existed.
 *
 * Copied verbatim from openCatalog() at that revision: charts, the external-content FTS5
 * index, and all three sync triggers. Fidelity matters: a fixture that creates `charts`
 * without `charts_fts` leaves the FTS index permanently out of sync with the content table,
 * and the first UPDATE fires the charts_au trigger's 'delete' against a rowid the index has
 * never seen, which fails with "database disk image is malformed". That is a broken fixture,
 * not a broken migration, and it will send you hunting for a bug that isn't there.
 */
const V1_SCHEMA = `
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
		modifiedTime INTEGER NOT NULL
	);
	CREATE VIRTUAL TABLE IF NOT EXISTS charts_fts USING fts5(
		name, artist, album, charter, content='charts', content_rowid='id'
	);
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
	END;`

/** A row as the pre-M1c scanner wrote it: the path and its change stamp, no metadata. */
export interface V1Row {
  path: string
  chartType: 'folder' | 'sng'
  folderHash: string
}

/** Creates and closes a user_version 1 catalog at `file`, seeded with `rows`. */
export function createV1Catalog(file: string, rows: V1Row[] = []): void {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('user_version = 1')
  db.exec(V1_SCHEMA)
  const insert = db.prepare(
    `INSERT INTO charts (path, chartType, folderHash, modifiedTime) VALUES (?, ?, ?, ?)`
  )
  for (const row of rows) insert.run(row.path, row.chartType, row.folderHash, Date.now())
  db.close()
}
