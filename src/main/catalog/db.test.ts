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
