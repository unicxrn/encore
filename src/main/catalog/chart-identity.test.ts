import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { chartKey } from '../../shared/chart-key'
import { ChartRecordSchema, type ChartRecord } from '../../shared/schemas'
import { tmpDir } from '../../../test/helpers/tmp'
import { TAGGED_CHARTER, TAGGED_CHARTER_TEXT } from '../../../test/helpers/marked-up-names'
import { openCatalog, type CatalogDb } from './db'
import { setFavourite } from './favourites'
import { chartsByMeta, chartsExistByMeta, queryCharts, upsertChart } from './queries'
import { createSetlist, listSetlists, setSetlistEntry } from './setlists'

/**
 * The one question, asked through all four of the features that ask it.
 *
 * Hide owned, the chart page's IN LIBRARY badge, the heart and a setlist entry all ask whether a
 * chart from Chorus is a chart the user has. In one release they were two different tests:
 * `chartsExistByMeta` compared the RAW `song.ini` text through `LOWER()` and the other three
 * compared the markup-stripped form, so a chart whose Chorus copy carries colour markup in its
 * title and whose local copy has had it edited out was one chart to a heart and two to Hide owned.
 *
 * The case below is that exact pair of copies, and every test here is a different feature being
 * shown the same two and asked to say they are one chart. Hide owned and the badge are the same
 * call (`catalog:exists-by-meta`) and are tested once rather than twice; what differs between them
 * is only which screen draws the answer.
 */

/** The local copy: the markup has been edited out, so the row holds the words a reader sees. */
const LOCAL: ChartRecord = ChartRecordSchema.parse({
  path: '/library/prodigy-firestarter',
  chartType: 'folder',
  name: 'Firestarter',
  artist: 'The Prodigy',
  charter: TAGGED_CHARTER_TEXT,
  folderHash: 'h1',
  modifiedTime: 1
})

/** The Chorus copy of the same chart: the charter's name still carries its colour tag. */
const FROM_CHORUS = { name: 'Firestarter', artist: 'The Prodigy', charter: TAGGED_CHARTER }

/** A different chart, to prove nothing here matches everything. */
const OTHER: ChartRecord = ChartRecordSchema.parse({
  path: '/library/rush-yyz',
  chartType: 'folder',
  name: 'YYZ',
  artist: 'Rush',
  charter: 'Harmonix',
  folderHash: 'h2',
  modifiedTime: 1
})

describe('two copies that differ only by rich text', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('identity'), 'catalog.db'))
    upsertChart(db, LOCAL)
    upsertChart(db, OTHER)
  })

  it('is one chart to Hide owned and to the IN LIBRARY badge', () => {
    expect(chartsExistByMeta(db, [FROM_CHORUS])).toEqual([true])
  })

  it('is one chart the other way round, when the local copy is the one carrying markup', () => {
    upsertChart(db, { ...LOCAL, path: '/library/marked', charter: TAGGED_CHARTER })
    expect(
      chartsExistByMeta(db, [
        { name: 'Firestarter', artist: 'The Prodigy', charter: TAGGED_CHARTER_TEXT }
      ])
    ).toEqual([true])
  })

  it('is one chart to the heart, hearted from Chorus and filtered in Installed', () => {
    setFavourite(db, chartKey(FROM_CHORUS), true)
    const hits = queryCharts(db, { search: '', offset: 0, limit: 100, favouritesOnly: true })
    expect(hits.map((c) => c.path)).toEqual([LOCAL.path])
  })

  it('is one chart to a setlist, added from Chorus and opened against the library', () => {
    createSetlist(db, 'Friday night')
    setSetlistEntry(db, listSetlists(db)[0].id, chartKey(FROM_CHORUS), true)
    const entries = listSetlists(db)[0].entries
    expect(chartsByMeta(db, entries)[0]?.path).toBe(LOCAL.path)
  })

  it('still tells two real charts apart', () => {
    expect(
      chartsExistByMeta(db, [{ name: 'YYZ', artist: 'Rush', charter: 'Somebody else' }])
    ).toEqual([false])
  })

  /**
   * The mutation that shows the reconcile is real rather than incidental.
   *
   * This is the clause `chartsExistByMeta` used to carry, run against the same two rows. It answers
   * false where the code above answers true, which is the defect as a user met it: Hide owned left
   * a chart on screen that was already in the library, and the badge said it was not there.
   */
  it('was two charts to the raw comparison this replaced', () => {
    const raw = db.prepare(
      `SELECT 1 FROM charts
			 WHERE LOWER(name) = LOWER(?) AND LOWER(artist) = LOWER(?) AND LOWER(charter) = LOWER(?)
			 LIMIT 1`
    )
    expect(raw.get(FROM_CHORUS.name, FROM_CHORUS.artist, FROM_CHORUS.charter)).toBeUndefined()
    expect(chartsExistByMeta(db, [FROM_CHORUS])).toEqual([true])
  })
})

describe('a key that names no chart', () => {
  let db: CatalogDb
  beforeEach(() => {
    db = openCatalog(join(tmpDir('identity-empty'), 'catalog.db'))
    // A chart whose song.ini sets no name: the row is real and the question is still unanswerable.
    upsertChart(
      db,
      ChartRecordSchema.parse({
        path: '/library/nameless',
        chartType: 'folder',
        name: null,
        artist: 'Some Artist',
        charter: 'Some Charter',
        folderHash: 'h3',
        modifiedTime: 1
      })
    )
  })

  it('is not in the library, whatever the catalog holds', () => {
    // The same refusal the heart and a setlist make: the name such a chart would be matched under
    // is its folder's, which is a display fallback and not an identity.
    expect(
      chartsExistByMeta(db, [{ name: '', artist: 'Some Artist', charter: 'Some Charter' }])
    ).toEqual([false])
    expect(
      chartsExistByMeta(db, [
        { name: '<color=red></color>', artist: 'Some Artist', charter: 'Some Charter' }
      ])
    ).toEqual([false])
  })

  it('has no row for a setlist to draw, rather than the first nameless one', () => {
    expect(
      chartsByMeta(db, [{ name: '', artist: 'Some Artist', charter: 'Some Charter' }])
    ).toEqual([null])
  })
})

/**
 * That the lookup is a lookup.
 *
 * `charts_meta` is an expression index and an expression index is silent when it stops matching:
 * change either side of `identityColumn` and the query keeps answering correctly while quietly
 * going back to reading every row. Over a generated 20,000 row catalog that is 76 ms per batch of
 * 100 keys against 1.1 ms, and a batch of 100 is one Explore page.
 */
describe('the identity index', () => {
  const plan = (db: CatalogDb, sql: string): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(['a', 'b', 'c']) as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ')

  it('answers both identity queries without scanning the library', () => {
    const db = openCatalog(join(tmpDir('identity-plan'), 'catalog.db'))
    upsertChart(db, LOCAL)
    const exists = plan(db, `SELECT 1 FROM charts WHERE ${identityWhere()} LIMIT 1`)
    const byMeta = plan(db, `SELECT * FROM charts WHERE ${identityWhere()} ORDER BY path LIMIT 1`)
    expect(exists).toContain('USING INDEX charts_meta')
    expect(byMeta).toContain('USING INDEX charts_meta')
    // The mutation: the clause this replaced cannot use it, and the planner says so.
    expect(
      plan(
        db,
        `SELECT 1 FROM charts WHERE LOWER(name) = LOWER(?) AND LOWER(artist) = LOWER(?)
			 AND LOWER(charter) = LOWER(?) LIMIT 1`
      )
    ).toContain('SCAN charts')
    db.close()
  })
})

/**
 * The WHERE as queries.ts builds it, restated here so the plan above is asserted against real SQL.
 *
 * Deliberately a copy rather than an export: an export would be the test asking the code what it
 * does, and what is being pinned is that this particular shape reaches the index.
 */
function identityWhere(): string {
  const col = (name: string): string => `COALESCE(COALESCE(${name}Stripped, ${name}), '')`
  return `${col('name')} = ? COLLATE NOCASE
		AND ${col('artist')} = ? COLLATE NOCASE
		AND ${col('charter')} = ? COLLATE NOCASE`
}
