import { stripRichText } from './format'

/**
 * What a favourite is attached to: the song, the artist and the charter, as a reader sees them.
 *
 * Not the path, and not either of the two chart identities. The alternatives were weighed against
 * the five things that actually happen to a chart:
 *
 * - **The path** is the catalog's own key and the worst of the three. A rescan after someone
 *   reorganises their folders rewrites every path in the library, and a `.sng` that replaces a
 *   folder changes one; both would silently empty the list.
 * - **`cloneHeroChecksum`** (main/catalog/chart-checksum.ts) is an MD5 over the chart file's bytes.
 *   It survives a move, but a re-download of a charter's NEWER version is a different digest, so
 *   the favourite would quietly come off the chart at exactly the moment the user went and got it
 *   again. It also does not exist until a chart has been scanned, which makes it unable to answer
 *   the question the rail asks about a chart from Chorus.
 * - **`chartHash`** is scan-chart's, over the same bytes plus seven gameplay keys, so it moves for
 *   everything the checksum moves for and for a `song.ini` edit besides.
 *
 * The three fields here are what Chorus publishes about a chart and what `song.ini` carries, which
 * is what lets one favourite cover a chart before it is downloaded and the same chart afterwards.
 * They are also exactly the ownership test Explore's Hide owned already makes
 * (`catalog:exists-by-meta`), so "this is in your library" and "you favourited this" can never
 * disagree about which charts they are talking about.
 *
 * What that costs is real and is the reason for the wording above: this identifies a CHART, not a
 * copy of one. Two copies of one charter's chart of one song are one favourite between them, which
 * is the same thing `catalog:duplicates` calls an exact duplicate, and the same song charted by two
 * people is two favourites. And a user who edits a chart's name, artist or charter in the metadata
 * editor has renamed the thing the favourite names: the heart goes out, exactly as Hide owned stops
 * hiding that chart on Chorus and every picker in Installed moves it. Neither is silent, because
 * both follow the value the user typed.
 */
export interface FavouriteKey {
  name: string
  artist: string
  charter: string
}

/** A stored favourite: its key, and when it was added. */
export interface Favourite extends FavouriteKey {
  /** ISO 8601, so the newest is first without a second column to sort on. */
  addedAt: string
}

/**
 * The readable form of the three fields, which is the form a favourite is stored and compared in.
 *
 * Markup out, for the reason `STRIPPED_COLUMN` in main/catalog/db.ts gives: a charter whose
 * `song.ini` name is one colour tag per letter writes eight tags and the screen shows a word, and
 * a favourite is something a user did to the word. Missing fields become '' rather than staying
 * null, because a chart with no charter is a chart whose charter is nobody, and a null in SQL
 * compares equal to nothing at all, including to itself.
 */
export function favouriteKey(input: {
  name?: string | null
  artist?: string | null
  charter?: string | null
}): FavouriteKey {
  return {
    name: stripRichText(input.name),
    artist: stripRichText(input.artist),
    charter: stripRichText(input.charter)
  }
}

/**
 * Whether this key names a chart at all.
 *
 * A chart whose `song.ini` sets no name is drawn from its folder name (`fallbackChartName`), and
 * that is a display fallback, not an identity: two unnamed charts in two folders would share this
 * key and become one favourite, and renaming the folder would move it. The heart refuses rather
 * than attaching to something it cannot hold on to, and Encore's metadata editor is the way out.
 *
 * Artist and charter are not required. Plenty of real charts set neither, and "this song, nobody
 * credited" is still one identifiable thing.
 */
export function isFavouritable(key: FavouriteKey): boolean {
  return key.name !== ''
}

/**
 * Case folding, matching SQLite's NOCASE exactly: A-Z and nothing else.
 *
 * The catalog compares these three fields case-insensitively (`catalog:exists-by-meta` through
 * LOWER, `catalog:facets` through COLLATE NOCASE), and the favourites table declares its key
 * columns COLLATE NOCASE so one chart cannot be favourited twice over a capital letter. The
 * renderer has to answer the same question about a chart it is drawing, without asking main, and
 * `toLowerCase()` would not be the same answer: it folds `İ` and `ẞ`, which NOCASE leaves alone,
 * so a title carrying either would read as favourited on one side of the boundary and not on the
 * other. This is the narrow rule, written down once.
 */
function foldNocase(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase())
}

/**
 * One string per favourite, for membership tests in the renderer.
 *
 * NUL-joined because it is the one character `song.ini` cannot carry, so no combination of name,
 * artist and charter can spell another combination's id.
 */
export function favouriteId(key: FavouriteKey): string {
  return [foldNocase(key.name), foldNocase(key.artist), foldNocase(key.charter)].join('\0')
}
