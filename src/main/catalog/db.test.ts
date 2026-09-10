import Database from 'better-sqlite3'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createV1Catalog } from '../../../test/helpers/v1-catalog'
import { openCatalog } from './db'
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
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    db.close()
  })

  it('adds scanVersion to a v1 database, preserving existing rows at version 0', () => {
    const file = tmpDb()
    makeV1Db(file)
    const db = openCatalog(file)
    expect(columnNames(db)).toContain('scanVersion')
    expect(db.pragma('user_version', { simple: true })).toBe(4)
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
    expect(db.pragma('user_version', { simple: true })).toBe(4)
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
    ahead.pragma('user_version = 4')
    ahead.close()
    const db = openCatalog(file)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    db.close()
  })
})
