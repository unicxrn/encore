import { namesAChart, sameChart, type ChartKey, type ChartListMove } from '../../shared/chart-key'
import type { CatalogDb } from './db'
import { chartsExistByMeta } from './queries'
import { renumberSetlist } from './setlists'

/**
 * Carry the user's own lists across a chart that has been renamed.
 *
 * A favourite and a setlist entry are keyed on the song, the artist and the charter
 * (shared/chart-key.ts says why, against the path and both chart hashes). Encore's metadata editor
 * writes exactly those three fields. So correcting a chart's artist used to take the heart off it
 * and drop it out of every setlist holding it, with nothing on screen about either: two features
 * from one release quietly undoing each other. This is the answer.
 *
 * ## Why moving them, rather than refusing the edit or letting them go
 *
 * The editor exists to fix a chart whose `song.ini` is wrong, and the commonest fix of all is the
 * spelling of an artist the rest of the library spells another way. Refusing that because the user
 * had hearted the chart would make the heart a lock on their own metadata. Letting the rows go is
 * the behaviour that was reported as a defect. Moving them is what the user meant: it is the same
 * chart, and they are the one who just said what it is called.
 *
 * Three cases make the move more than a rename, and all three are handled here rather than left to
 * whichever happens first:
 *
 * - **A second copy still answers to the old details.** Two copies of one chart is exactly what
 *   `catalog:duplicates` calls an exact duplicate, and editing one of them leaves the other saying
 *   what it always said. The old key still names a chart the user has, so the rows stay on it and
 *   are COPIED to the new one. `oldKeyKept` says that happened and the editor prints it, because a
 *   user who then looks at their favourites will see two hearts where they made one edit.
 * - **The title was cleared.** A chart with no title cannot be keyed at all: `namesAChart` refuses
 *   it for the heart and for a setlist alike, because the name such a chart is drawn under is its
 *   folder's and renaming a folder would move it. There is nowhere to move to, so nothing moves.
 *   The rows are deliberately NOT deleted: a favourite matching no row today is an ordinary state
 *   in this design (that is what a favourite of an undownloaded Chorus chart is), and it starts
 *   matching again the moment a chart says that name, which here means the moment the user types
 *   the title back. Deleting would make the editor's own undo lossy. `stranded` says so and the
 *   editor prints the old title, so the list is not left to be discovered empty.
 * - **The new details already carry a favourite or an entry.** The write is then a merge, which is
 *   what `INSERT OR IGNORE` already means everywhere else these two tables are written: the row
 *   that was there keeps its `addedAt` and, in a setlist, the position the user put it at, rather
 *   than being sent to the bottom of a list they ordered.
 *
 * ## Where it runs
 *
 * After the re-index in main/index.ts, never inside the writer. The writer has never heard of the
 * database, and `oldKeyKept` is a question about the catalog AFTER the edited chart's row has been
 * rewritten: asked before, the edited chart would answer it about itself and every rename would
 * look like a copy.
 */
export function rekeyChartLists(db: CatalogDb, from: ChartKey, to: ChartKey): ChartListMove | null {
  // Case-only differences are not a move: every comparison these rows are made through is NOCASE,
  // so the row already matches the chart under its new spelling.
  if (sameChart(from, to)) return null
  // Nothing can have been stored under a key that names no chart, so there is nothing to carry.
  if (!namesAChart(from)) return null

  const favourite = heldAsFavourite(db, from)
  const held = setlistsHoldingKey(db, from)
  if (!favourite && held.length === 0) return null

  const move: ChartListMove = {
    from,
    to,
    favourite,
    setlists: held.map((list) => list.name),
    oldKeyKept: chartsExistByMeta(db, [from])[0],
    stranded: !namesAChart(to),
    merged: false
  }
  if (move.stranded) return move

  move.merged =
    (favourite && heldAsFavourite(db, to)) ||
    held.some((list) => entryPosition(db, list.id, to) !== null)

  db.transaction(() => {
    if (favourite) carryFavourite(db, from, to, move.oldKeyKept)
    for (const list of held) carryEntry(db, list.id, from, to, move.oldKeyKept)
  })()
  return move
}

/** Whether the favourites table holds this key. The columns are NOCASE, so the compare is too. */
function heldAsFavourite(db: CatalogDb, key: ChartKey): boolean {
  const row = db
    .prepare(`SELECT 1 FROM favourites WHERE name = ? AND artist = ? AND charter = ?`)
    .get(key.name, key.artist, key.charter)
  return row !== undefined
}

/**
 * The setlists holding this key, in the order the sidebar lists them.
 *
 * `listSetlists`' own ORDER BY, so the names the editor prints are in the order the user reads
 * them somewhere else in the app rather than in whatever order the join happened to produce.
 */
function setlistsHoldingKey(db: CatalogDb, key: ChartKey): { id: string; name: string }[] {
  return db
    .prepare(
      `SELECT setlists.id AS id, setlists.name AS name FROM setlist_entries
			JOIN setlists ON setlists.id = setlist_entries.setlistId
			WHERE setlist_entries.name = ? AND setlist_entries.artist = ?
				AND setlist_entries.charter = ?
			ORDER BY setlists.createdAt, setlists.name`
    )
    .all(key.name, key.artist, key.charter) as { id: string; name: string }[]
}

/** Where this key sits in that setlist, or null when the setlist does not hold it. */
function entryPosition(db: CatalogDb, setlistId: string, key: ChartKey): number | null {
  const row = db
    .prepare(
      `SELECT position FROM setlist_entries
			WHERE setlistId = ? AND name = ? AND artist = ? AND charter = ?`
    )
    .get(setlistId, key.name, key.artist, key.charter) as { position: number } | undefined
  return row?.position ?? null
}

/**
 * Put the favourite on the new details, and take it off the old ones unless a chart still has them.
 *
 * The old row's `addedAt` travels with it, so a chart hearted last year does not jump to the top of
 * a list ordered by when it was hearted just because its album was corrected. `INSERT OR IGNORE` is
 * the merge: a favourite already on the new details keeps its own, earlier, date.
 */
function carryFavourite(db: CatalogDb, from: ChartKey, to: ChartKey, keepOld: boolean): void {
  db.prepare(
    `INSERT OR IGNORE INTO favourites (name, artist, charter, addedAt)
			SELECT ?, ?, ?, addedAt FROM favourites WHERE name = ? AND artist = ? AND charter = ?`
  ).run(to.name, to.artist, to.charter, from.name, from.artist, from.charter)
  if (keepOld) return
  db.prepare(`DELETE FROM favourites WHERE name = ? AND artist = ? AND charter = ?`).run(
    from.name,
    from.artist,
    from.charter
  )
}

/**
 * Move one setlist entry onto the new details, or copy it there.
 *
 * A move keeps the position the user put the chart at: the list is a running order and a corrected
 * album is not a reason for a song to change place in it. A COPY cannot, because the old entry is
 * still sitting at that position and `(setlistId, position)` is not unique; it goes to the end,
 * which is where `setSetlistEntry` puts anything new and the only place that does not overrule an
 * order the user set.
 *
 * `renumberSetlist` runs either way. After a move it closes the gap a merge leaves behind (the
 * insert was ignored because the new details were already on the list, and the old row then went),
 * and after a copy it is what makes the appended position dense again if anything else had shifted.
 */
function carryEntry(
  db: CatalogDb,
  setlistId: string,
  from: ChartKey,
  to: ChartKey,
  keepOld: boolean
): void {
  const at = keepOld ? endOfSetlist(db, setlistId) : entryPosition(db, setlistId, from)
  if (at === null) return
  db.prepare(
    `INSERT OR IGNORE INTO setlist_entries (setlistId, name, artist, charter, position, addedAt)
			SELECT setlistId, ?, ?, ?, ?, addedAt FROM setlist_entries
			WHERE setlistId = ? AND name = ? AND artist = ? AND charter = ?`
  ).run(to.name, to.artist, to.charter, at, setlistId, from.name, from.artist, from.charter)
  if (!keepOld) {
    db.prepare(
      `DELETE FROM setlist_entries
				WHERE setlistId = ? AND name = ? AND artist = ? AND charter = ?`
    ).run(setlistId, from.name, from.artist, from.charter)
  }
  renumberSetlist(db, setlistId)
}

/** One past the last position in that setlist, which is where a new entry goes. */
function endOfSetlist(db: CatalogDb, setlistId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM setlist_entries WHERE setlistId = ?`)
    .get(setlistId) as { n: number }
  return row.n
}
