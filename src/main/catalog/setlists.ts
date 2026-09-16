import { randomUUID } from 'node:crypto'
import type { Setlist, SetlistEntry, SetlistEntryKey } from '../../shared/setlists'
import type { CatalogDb } from './db'

/**
 * Every setlist, entries included, oldest first.
 *
 * Two queries and a group in memory rather than one per setlist: the whole table is a name and a
 * handful of short strings per chart, and a setlist long enough for paging to matter is one nobody
 * could play. Every write below answers with this same list for the reason the favourites writes
 * do, which is that the renderer then never has to reconstruct what main decided to store.
 *
 * Oldest first, and by name only to break a tie between two setlists made in the same millisecond.
 * The alternative, alphabetical, is a claim about how the list is read; a setlist the user made a
 * moment ago appearing at the bottom where they made it is not.
 */
export function listSetlists(db: CatalogDb): Setlist[] {
  const lists = db
    .prepare(`SELECT id, name, createdAt FROM setlists ORDER BY createdAt, name`)
    .all() as { id: string; name: string; createdAt: string }[]
  if (lists.length === 0) return []
  const rows = db
    .prepare(
      `SELECT setlistId, name, artist, charter, addedAt FROM setlist_entries
			ORDER BY setlistId, position`
    )
    .all() as (SetlistEntry & { setlistId: string })[]
  const byList = new Map<string, SetlistEntry[]>()
  for (const { setlistId, ...entry } of rows) {
    const held = byList.get(setlistId)
    if (held === undefined) byList.set(setlistId, [entry])
    else held.push(entry)
  }
  return lists.map((list) => ({ ...list, entries: byList.get(list.id) ?? [] }))
}

/**
 * Rewrite one setlist's positions as 0..n-1 in their current order.
 *
 * Called after every write that can leave a gap or a tie, which is all of them. Storing a dense
 * range rather than the sparse one a plain delete leaves behind is what lets `moveEntry` be a swap
 * of two numbers instead of a search for the neighbour that happens to be next. The cost is a
 * handful of UPDATEs over a list a person is meant to read, inside a transaction the caller has
 * already opened.
 */
function renumber(db: CatalogDb, setlistId: string): void {
  const ids = db
    .prepare(
      `SELECT name, artist, charter FROM setlist_entries WHERE setlistId = ? ORDER BY position`
    )
    .all(setlistId) as SetlistEntryKey[]
  const update = db.prepare(
    `UPDATE setlist_entries SET position = ?
			WHERE setlistId = ? AND name = ? AND artist = ? AND charter = ?`
  )
  ids.forEach((key, index) => update.run(index, setlistId, key.name, key.artist, key.charter))
}

/** The setlist this id names, or a refusal saying so. Every write starts here. */
function requireSetlist(db: CatalogDb, id: string): { id: string; name: string } {
  const row = db.prepare(`SELECT id, name FROM setlists WHERE id = ?`).get(id) as
    { id: string; name: string } | undefined
  if (row === undefined) throw new Error('That setlist no longer exists.')
  return row
}

/**
 * Refuse a name another setlist already carries.
 *
 * Checked here rather than left to the UNIQUE constraint so the user gets a sentence instead of a
 * SQLite error string. The constraint stays in the schema regardless: this check and the write are
 * inside one transaction, but the constraint is what holds if a second writer ever appears.
 */
function requireFreeName(db: CatalogDb, name: string, exceptId: string | null): void {
  const clash = db.prepare(`SELECT id FROM setlists WHERE name = ? COLLATE NOCASE`).get(name) as
    { id: string } | undefined
  if (clash !== undefined && clash.id !== exceptId) {
    throw new Error(`You already have a setlist called ${name}.`)
  }
}

/** Make a setlist. The name arrives normalised and checked; see main/index.ts. */
export function createSetlist(db: CatalogDb, name: string): Setlist[] {
  db.transaction(() => {
    requireFreeName(db, name, null)
    db.prepare(`INSERT INTO setlists (id, name, createdAt) VALUES (?, ?, ?)`).run(
      randomUUID(),
      name,
      new Date().toISOString()
    )
  })()
  return listSetlists(db)
}

/** Rename one. Its entries are keyed on its id, so they do not move. */
export function renameSetlist(db: CatalogDb, id: string, name: string): Setlist[] {
  db.transaction(() => {
    requireSetlist(db, id)
    requireFreeName(db, name, id)
    db.prepare(`UPDATE setlists SET name = ? WHERE id = ?`).run(name, id)
  })()
  return listSetlists(db)
}

/**
 * Delete a setlist and everything in it.
 *
 * The entries go explicitly rather than by cascade, because this connection leaves
 * `PRAGMA foreign_keys` off and a declared cascade would be a promise nothing keeps. One
 * transaction, so a setlist can never be left with rows nothing names.
 *
 * Nothing on disk is touched. A setlist holds three names per chart and no path, so there is
 * nothing here that could delete a chart even by accident, which is the property that makes
 * deleting a full setlist safe enough to offer without a second screen.
 */
export function deleteSetlist(db: CatalogDb, id: string): Setlist[] {
  db.transaction(() => {
    db.prepare(`DELETE FROM setlist_entries WHERE setlistId = ?`).run(id)
    db.prepare(`DELETE FROM setlists WHERE id = ?`).run(id)
  })()
  return listSetlists(db)
}

/**
 * Put a chart in a setlist, or take it out. Returns the lists as they now stand.
 *
 * Idempotent both ways, for the reasons the heart is: the renderer toggles over state it read a
 * moment ago, and two windows, a double click and a toggle raced against a reload all happen.
 * Adding what is already there is `INSERT OR IGNORE`, which keeps the FIRST `addedAt` and the
 * position the chart already holds rather than sending it to the bottom of a list the user
 * ordered. Removing what was never there changes nothing and is not an error.
 *
 * A new entry goes at the end. That is the only place it can go without overruling an order the
 * user set, and it is where a person adding to a running order expects the next song to land.
 */
export function setSetlistEntry(
  db: CatalogDb,
  setlistId: string,
  key: SetlistEntryKey,
  member: boolean
): Setlist[] {
  db.transaction(() => {
    requireSetlist(db, setlistId)
    if (member) {
      const next = db
        .prepare(`SELECT COUNT(*) AS n FROM setlist_entries WHERE setlistId = ?`)
        .get(setlistId) as { n: number }
      db.prepare(
        `INSERT OR IGNORE INTO setlist_entries
					(setlistId, name, artist, charter, position, addedAt) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(setlistId, key.name, key.artist, key.charter, next.n, new Date().toISOString())
    } else {
      db.prepare(
        `DELETE FROM setlist_entries
					WHERE setlistId = ? AND name = ? AND artist = ? AND charter = ?`
      ).run(setlistId, key.name, key.artist, key.charter)
    }
    renumber(db, setlistId)
  })()
  return listSetlists(db)
}

/**
 * Move one chart up or down its setlist by one place.
 *
 * A swap of two positions rather than a re-insert, which is what the dense numbering `renumber`
 * maintains buys. Asking to move the first entry up, or the last one down, is not an error: it is
 * what a user gets for holding the button down at the end of the list, and refusing it would put a
 * message on screen for something that already looks like nothing happening.
 *
 * A chart this setlist does not hold is a stale press from a list that has since changed under the
 * user, and does nothing for the same reason.
 */
export function moveSetlistEntry(
  db: CatalogDb,
  setlistId: string,
  key: SetlistEntryKey,
  delta: -1 | 1
): Setlist[] {
  db.transaction(() => {
    requireSetlist(db, setlistId)
    const row = db
      .prepare(
        `SELECT position FROM setlist_entries
				WHERE setlistId = ? AND name = ? AND artist = ? AND charter = ?`
      )
      .get(setlistId, key.name, key.artist, key.charter) as { position: number } | undefined
    if (row === undefined) return
    const target = row.position + delta
    const swap = db
      .prepare(
        `SELECT name, artist, charter FROM setlist_entries WHERE setlistId = ? AND position = ?`
      )
      .get(setlistId, target) as SetlistEntryKey | undefined
    if (swap === undefined) return
    const set = db.prepare(
      `UPDATE setlist_entries SET position = ?
				WHERE setlistId = ? AND name = ? AND artist = ? AND charter = ?`
    )
    // Through a position no row can hold, because (setlistId, position) is not unique but the
    // swap reads the neighbour by it: parking one row out of range first means the two UPDATEs
    // cannot both be at `target` for the instant between them.
    set.run(-1, setlistId, key.name, key.artist, key.charter)
    set.run(row.position, setlistId, swap.name, swap.artist, swap.charter)
    set.run(target, setlistId, key.name, key.artist, key.charter)
  })()
  return listSetlists(db)
}
