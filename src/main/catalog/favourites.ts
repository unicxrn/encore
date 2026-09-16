import type { Favourite, FavouriteKey } from '../../shared/favourites'
import type { CatalogDb } from './db'

/**
 * Every favourite, newest first.
 *
 * The whole table rather than a page of it: it is three short strings and a date per chart the
 * user hearted, the renderer holds it as a set so the rail can answer "is this one" without a
 * round trip per chart, and a favourite list long enough for paging to matter is a list nobody
 * could read anyway.
 *
 * Newest first because that is the only order the table itself justifies. Alphabetical would be a
 * claim about how the list is read, and the one screen that lists favourites (Installed, filtered)
 * orders them by its own sort over the catalog, not by this.
 */
export function listFavourites(db: CatalogDb): Favourite[] {
  return db
    .prepare(`SELECT name, artist, charter, addedAt FROM favourites ORDER BY addedAt DESC, name`)
    .all() as Favourite[]
}

/**
 * Heart a chart, or un-heart it. Returns the list as it now stands.
 *
 * Idempotent in both directions: hearting twice is one row (the PRIMARY KEY is the rule, and
 * `INSERT OR IGNORE` is what keeps the FIRST `addedAt` rather than restamping it), and un-hearting
 * something that was never hearted changes nothing and does not fail. The renderer's heart is a
 * toggle over state it read a moment ago, so both of those happen for real: two windows, a double
 * click, a toggle raced against a reload.
 *
 * Returning the list rather than a boolean is what keeps the renderer's copy honest. The key is
 * normalised in one place (shared/favourites.ts) and the row is written here, so handing back the
 * table means the renderer never has to reconstruct what main decided to store.
 */
export function setFavourite(db: CatalogDb, key: FavouriteKey, favourite: boolean): Favourite[] {
  if (favourite) {
    db.prepare(
      `INSERT OR IGNORE INTO favourites (name, artist, charter, addedAt) VALUES (?, ?, ?, ?)`
    ).run(key.name, key.artist, key.charter, new Date().toISOString())
  } else {
    db.prepare(`DELETE FROM favourites WHERE name = ? AND artist = ? AND charter = ?`).run(
      key.name,
      key.artist,
      key.charter
    )
  }
  return listFavourites(db)
}
