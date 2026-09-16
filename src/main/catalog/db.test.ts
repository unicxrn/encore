import Database from 'better-sqlite3'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createV1Catalog } from '../../../test/helpers/v1-catalog'
import { openCatalog, SCHEMA_VERSION } from './db'
import {
  EIGHT_TAG_CHARTER,
  EIGHT_TAG_CHARTER_TEXT,
  TAGGED_CHARTER,
  TAGGED_CHARTER_TEXT
} from '../../../test/helpers/marked-up-names'
import { tmpDir } from '../../../test/helpers/tmp'

const tmpDb = (): string => join(tmpDir('db'), 'catalog.db')

/** A user_version 1 catalog carrying one pre-existing path-only row. */
const makeV1Db = (file: string): void =>
  createV1Catalog(file, [
    { path: '/lib/legacy.sng', chartType: 'sng', folderHash: '1700000000000' }
  ])

/** A user_version 2 catalog: the v1 shape plus scanVersion, exactly as M1c left it. */
const makeV2Db = (file: string, rowCount: number): void => {
  createV1Catalog(
    file,
    Array.from({ length: rowCount }, (_, i) => ({
      path: `/lib/legacy-${i}.sng`,
      chartType: 'sng' as const,
      folderHash: '1700000000000'
    }))
  )
  const db = new Database(file)
  db.exec(`ALTER TABLE charts ADD COLUMN scanVersion INTEGER NOT NULL DEFAULT 0`)
  db.pragma('user_version = 2')
  db.close()
}

const columnNames = (db: Database.Database): string[] =>
  (db.pragma('table_info(charts)') as { name: string }[]).map((c) => c.name)

describe('openCatalog', () => {
  it('creates the charts table and FTS index', () => {
    const db = openCatalog(tmpDb())
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')")
      .all() as Array<{ name: string }>
    const names = tables.map((r) => r.name)
    expect(names).toContain('charts')
    expect(names).toContain('charts_fts')
    expect(names).toContain('charts_ai')
    db.close()
  })
  it('is idempotent (safe to open twice)', () => {
    const file = tmpDb()
    openCatalog(file).close()
    expect(() => openCatalog(file).close()).not.toThrow()
  })
  it('creates the score tables the Clone Hero score files are imported into', () => {
    // Separate tables from `plays`, which is the rule the whole feature rests on: these hold
    // lifetime bests with no dates and a count that already includes every observed play.
    const db = openCatalog(tmpDb())
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(names).toContain('score_charts')
    expect(names).toContain('score_bests')
    db.close()
  })
  it('adds the score tables to a database that predates them', () => {
    // They are created outside `migrate`, by the CREATE block that runs on every open, so an
    // existing catalog picks them up without a version-gated step.
    const file = tmpDb()
    makeV1Db(file)
    const db = openCatalog(file)
    expect(() => db.prepare('SELECT count(*) FROM score_charts').get()).not.toThrow()
    expect(() => db.prepare('SELECT count(*) FROM score_bests').get()).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })
  it('creates the favourites table', () => {
    const db = openCatalog(tmpDb())
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(names).toContain('favourites')
    db.close()
  })
  it('keys favourites case-insensitively, so one chart cannot be hearted twice', () => {
    // The COLLATE NOCASE on the three key columns, read back off the PRIMARY KEY itself rather
    // than off the DDL: an index that compares case-sensitively is a table where the same chart
    // met on Chorus and in the library is two rows, and one press un-hearts only one of them.
    const db = openCatalog(tmpDb())
    const insert = db.prepare(
      `INSERT OR IGNORE INTO favourites (name, artist, charter, addedAt) VALUES (?, ?, ?, ?)`
    )
    insert.run('Everlong', 'Foo Fighters', 'Neversoft', 'now')
    insert.run('EVERLONG', 'foo fighters', 'NEVERSOFT', 'later')
    expect(db.prepare('SELECT count(*) AS n FROM favourites').get()).toEqual({ n: 1 })
    db.close()
  })
  it('adds the favourites table to a database that predates it, keeping its rows', () => {
    // Created outside `migrate` by the CREATE block that runs on every open, exactly as the score
    // tables are: a new table needs no ALTER, and the version bump is what records the shape.
    const file = tmpDb()
    makeV1Db(file)
    const db = openCatalog(file)
    expect(() => db.prepare('SELECT count(*) FROM favourites').get()).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.prepare('SELECT count(*) AS n FROM charts').get()).toEqual({ n: 1 })
    db.close()
  })
  it('keeps favourites across a close and a re-open', () => {
    const file = tmpDb()
    const first = openCatalog(file)
    first
      .prepare(`INSERT INTO favourites (name, artist, charter, addedAt) VALUES (?, ?, ?, ?)`)
      .run('Everlong', 'Foo Fighters', 'Neversoft', 'now')
    first.close()
    const db = openCatalog(file)
    expect(db.prepare('SELECT count(*) AS n FROM favourites').get()).toEqual({ n: 1 })
    db.close()
  })
  it('creates the setlist tables', () => {
    const db = openCatalog(tmpDb())
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(names).toContain('setlists')
    expect(names).toContain('setlist_entries')
    db.close()
  })
  it('refuses two setlists by one name, whatever their capitals', () => {
    // The UNIQUE COLLATE NOCASE on `setlists.name`, read off the constraint rather than off the
    // DDL. catalog/setlists.ts checks first so the user gets a sentence, but this is what holds
    // if a second writer ever appears, and a sidebar listing one name twice is unreadable.
    const db = openCatalog(tmpDb())
    const insert = db.prepare(`INSERT INTO setlists (id, name, createdAt) VALUES (?, ?, ?)`)
    insert.run('a', 'Friday night', 'now')
    expect(() => insert.run('b', 'FRIDAY NIGHT', 'now')).toThrow()
    db.close()
  })
  it('keys a setlist entry case-insensitively, so one chart cannot be added twice', () => {
    const db = openCatalog(tmpDb())
    const insert = db.prepare(
      `INSERT OR IGNORE INTO setlist_entries
			 (setlistId, name, artist, charter, position, addedAt) VALUES (?, ?, ?, ?, ?, ?)`
    )
    insert.run('a', 'Everlong', 'Foo Fighters', 'Neversoft', 0, 'now')
    insert.run('a', 'EVERLONG', 'foo fighters', 'NEVERSOFT', 1, 'later')
    expect(db.prepare('SELECT count(*) AS n FROM setlist_entries').get()).toEqual({ n: 1 })
    db.close()
  })
  it('lets two setlists hold the same chart, which the favourites key alone could not', () => {
    // The setlistId in the PRIMARY KEY, proved at the table rather than above it: without it the
    // second of these two INSERTs is the one the first already wrote.
    const db = openCatalog(tmpDb())
    const insert = db.prepare(
      `INSERT OR IGNORE INTO setlist_entries
			 (setlistId, name, artist, charter, position, addedAt) VALUES (?, ?, ?, ?, ?, ?)`
    )
    insert.run('a', 'Everlong', 'Foo Fighters', 'Neversoft', 0, 'now')
    insert.run('b', 'Everlong', 'Foo Fighters', 'Neversoft', 0, 'now')
    expect(db.prepare('SELECT count(*) AS n FROM setlist_entries').get()).toEqual({ n: 2 })
    db.close()
  })
  it('adds the setlist tables to a database that predates them, keeping its rows', () => {
    // Created outside `migrate` by the CREATE block that runs on every open, exactly as the score
    // and favourites tables are. The version bump is what records the shape.
    const file = tmpDb()
    makeV1Db(file)
    const db = openCatalog(file)
    expect(() => db.prepare('SELECT count(*) FROM setlists').get()).not.toThrow()
    expect(() => db.prepare('SELECT count(*) FROM setlist_entries').get()).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.prepare('SELECT count(*) AS n FROM charts').get()).toEqual({ n: 1 })
    db.close()
  })
  it('keeps setlists across a close and a re-open', () => {
    const file = tmpDb()
    const first = openCatalog(file)
    first
      .prepare(`INSERT INTO setlists (id, name, createdAt) VALUES (?, ?, ?)`)
      .run('a', 'F', 'now')
    first
      .prepare(
        `INSERT INTO setlist_entries (setlistId, name, artist, charter, position, addedAt)
				 VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('a', 'Everlong', 'Foo Fighters', 'Neversoft', 0, 'now')
    first.close()
    const db = openCatalog(file)
    expect(db.prepare('SELECT count(*) AS n FROM setlist_entries').get()).toEqual({ n: 1 })
    db.close()
  })
  it('enables WAL mode', () => {
    const db = openCatalog(tmpDb())
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    db.close()
  })
})

describe('scanVersion migration', () => {
  it('creates a fresh database with the scanVersion column at the current user_version', () => {
    const db = openCatalog(tmpDb())
    expect(columnNames(db)).toContain('scanVersion')
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('adds scanVersion to a v1 database, preserving existing rows at version 0', () => {
    const file = tmpDb()
    makeV1Db(file)
    const db = openCatalog(file)
    expect(columnNames(db)).toContain('scanVersion')
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const rows = db.prepare(`SELECT path, scanVersion FROM charts`).all()
    // The pre-existing row survives and lands below SCAN_VERSION, so it gets re-parsed.
    expect(rows).toEqual([{ path: '/lib/legacy.sng', scanVersion: 0 }])
    db.close()
  })

  it('is idempotent: migrating an already-migrated database is a no-op', () => {
    const file = tmpDb()
    makeV1Db(file)
    openCatalog(file).close()
    expect(() => openCatalog(file).close()).not.toThrow()
    const db = openCatalog(file)
    expect(columnNames(db).filter((c) => c === 'scanVersion')).toHaveLength(1)
    expect(db.prepare(`SELECT count(*) AS n FROM charts`).get()).toEqual({ n: 1 })
    db.close()
  })
})

describe('full chart data migration', () => {
  it('adds the M5 columns to a v2 database without dropping rows', () => {
    const file = tmpDb()
    makeV2Db(file, 3)
    const db = openCatalog(file)
    const cols = columnNames(db)
    expect(cols).toContain('albumArtMd5')
    expect(cols).toContain('instruments')
    expect(cols).toContain('noteCounts')
    expect(cols).toContain('previewStartTime')
    expect(db.prepare('SELECT COUNT(*) AS n FROM charts').get()).toEqual({ n: 3 })
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  // The update checker reads these two off the catalog rather than re-parsing every chart, so a
  // database that predates them has to gain them on open. Otherwise the columns exist only for
  // libraries scanned after this build and the feature silently does nothing on an older one.
  it('adds the update-matching hash columns to a v2 database', () => {
    const file = tmpDb()
    makeV2Db(file, 1)
    const db = openCatalog(file)
    const cols = columnNames(db)
    expect(cols).toContain('chartHash')
    expect(cols).toContain('tempoMapHash')
    expect(db.prepare('SELECT COUNT(*) AS n FROM charts').get()).toEqual({ n: 1 })
    db.close()
  })

  // The spot-checks above name four columns; this pins all of them, so ADDED_COLUMNS and
  // CREATE TABLE cannot drift apart as later milestones add fields to both.
  it('migrates to exactly the shape CREATE TABLE produces', () => {
    const file = tmpDb()
    makeV2Db(file, 1)
    const migrated = openCatalog(file)
    const fresh = openCatalog(tmpDb())
    expect(columnNames(migrated).sort()).toEqual(columnNames(fresh).sort())
    migrated.close()
    fresh.close()
  })

  it('leaves a database written by a newer build at its own version', () => {
    const file = tmpDb()
    openCatalog(file).close()
    const ahead = new Database(file)
    // Deliberately ahead of this build, not merely equal to it: the point is that migrate()
    // never stamps its own version over a higher one.
    ahead.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    ahead.close()
    const db = openCatalog(file)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION + 1)
    db.close()
  })
})

/**
 * The catalog stores a readable twin of the four text columns Clone Hero renders markup in, and
 * the interesting half is the state a user is in between installing this build and rescanning.
 * That state is not a window: nothing starts a scan on its own (only the Scan button, the
 * onboarding screen, and a filesystem change under a library root), so a catalog left waiting for
 * a rescan waits indefinitely. Hence the backfill these pin, which runs on open instead.
 */
describe('stripped name migration', () => {
  /** A pre-column catalog holding the two names verbatim, exactly as a user's does. */
  const makeMarkedUpV1Db = (file: string): void =>
    createV1Catalog(file, [
      {
        path: '/lib/firestarter',
        chartType: 'folder',
        folderHash: 'h1',
        name: `${TAGGED_CHARTER} theme`,
        artist: 'The Prodigy',
        charter: EIGHT_TAG_CHARTER
      },
      { path: '/lib/plain', chartType: 'folder', folderHash: 'h2', name: 'Everlong' }
    ])

  const search = (db: Database.Database, term: string): string[] =>
    (
      db
        .prepare(
          `SELECT charts.path AS p FROM charts_fts JOIN charts ON charts.id = charts_fts.rowid
					 WHERE charts_fts MATCH ? ORDER BY charts.path`
        )
        .all(`"${term}"*`) as { p: string }[]
    ).map((r) => r.p)

  it('fills the stripped columns for rows that predate them, without touching the raw text', () => {
    const file = tmpDb()
    makeMarkedUpV1Db(file)
    const db = openCatalog(file)
    const row = db
      .prepare(`SELECT name, charter, nameStripped, charterStripped FROM charts WHERE path = ?`)
      .get('/lib/firestarter')
    expect(row).toEqual({
      name: `${TAGGED_CHARTER} theme`,
      charter: EIGHT_TAG_CHARTER,
      nameStripped: `${TAGGED_CHARTER_TEXT} theme`,
      charterStripped: EIGHT_TAG_CHARTER_TEXT
    })
    db.close()
  })

  it('rebuilds the search index over the stripped names', () => {
    const file = tmpDb()
    makeMarkedUpV1Db(file)
    const db = openCatalog(file)
    // The name on screen, which the raw index could not answer: every letter of the charter was
    // its own token, and `color` was a term the whole library shared.
    expect(search(db, EIGHT_TAG_CHARTER_TEXT)).toEqual(['/lib/firestarter'])
    expect(search(db, 'color')).toEqual([])
    expect(search(db, 'Everlong')).toEqual(['/lib/plain'])
    db.close()
  })

  it('leaves a null name with a null stripped twin, and does not rewrite it on every open', () => {
    const file = tmpDb()
    createV1Catalog(file, [{ path: '/lib/nameless.sng', chartType: 'sng', folderHash: 'h' }])
    openCatalog(file).close()
    const db = openCatalog(file)
    expect(db.prepare(`SELECT name, nameStripped FROM charts`).get()).toEqual({
      name: null,
      nameStripped: null
    })
    // A row that keeps matching the backfill's WHERE would be rewritten, and re-indexed, by every
    // open the user ever performs.
    expect(db.prepare(`SELECT changes() AS n`).get()).toEqual({ n: 0 })
    db.close()
  })

  it('swaps the index onto the view exactly once', () => {
    const file = tmpDb()
    makeMarkedUpV1Db(file)
    openCatalog(file).close()
    openCatalog(file).close()
    const db = openCatalog(file)
    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'charts_fts'`)
      .get() as { sql: string }
    expect(sql.sql).toContain("content='charts_search'")
    expect(search(db, EIGHT_TAG_CHARTER_TEXT)).toEqual(['/lib/firestarter'])
    db.close()
  })

  /**
   * What a build that predates schema 6 leaves behind if it is installed over one that does not:
   * rows with a null stripped column in a catalog whose user_version is already 6. A
   * version-gated backfill would never look at them again.
   */
  describe('a row written by an older build', () => {
    const insertRaw = (file: string): void => {
      const raw = new Database(file)
      raw
        .prepare(
          `INSERT INTO charts (path, chartType, name, charter, folderHash, modifiedTime)
					 VALUES (?, 'folder', ?, ?, 'h', 1)`
        )
        .run('/lib/late', `${TAGGED_CHARTER} theme`, EIGHT_TAG_CHARTER)
      raw.close()
    }

    it('stays searchable by its raw name until the next open', () => {
      const file = tmpDb()
      openCatalog(file).close()
      insertRaw(file)
      const db = new Database(file)
      // Not openCatalog: that would backfill. This is the state the user is actually in while
      // the older build is the one running.
      expect(search(db, 'SirMonkfish')).toEqual(['/lib/late'])
      expect(db.prepare(`SELECT nameStripped FROM charts`).get()).toEqual({ nameStripped: null })
      db.close()
    })

    it('is repaired by the next open, index included', () => {
      const file = tmpDb()
      openCatalog(file).close()
      insertRaw(file)
      const db = openCatalog(file)
      expect(db.prepare(`SELECT nameStripped, charterStripped FROM charts`).get()).toEqual({
        nameStripped: `${TAGGED_CHARTER_TEXT} theme`,
        charterStripped: EIGHT_TAG_CHARTER_TEXT
      })
      expect(search(db, EIGHT_TAG_CHARTER_TEXT)).toEqual(['/lib/late'])
      expect(search(db, 'color')).toEqual([])
      db.close()
    })
  })
})
