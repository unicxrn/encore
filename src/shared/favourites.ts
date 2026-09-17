import { chartKey, chartKeyId, namesAChart, type ChartKey } from './chart-key'

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
 *
 * They are `ChartKey`, and that is the whole of the type rather than a resemblance to it. Explore's
 * Hide owned, the chart page's IN LIBRARY badge, this heart and a setlist entry all ask the same
 * question through the same functions, so "this is in your library" and "you favourited this" can
 * never disagree about which charts they are talking about. `shared/chart-key.ts` is where that
 * question is answered, and why it is answered over the readable text rather than the raw.
 *
 * What that costs is real and is the reason for the wording above: this identifies a CHART, not a
 * copy of one. Two copies of one charter's chart of one song are one favourite between them, which
 * is the same thing `catalog:duplicates` calls an exact duplicate, and the same song charted by two
 * people is two favourites.
 *
 * A user who edits a chart's name, artist or charter in the metadata editor has renamed the thing
 * this names. The heart does NOT come off: `main/catalog/rekey.ts` moves the favourite and every
 * setlist entry onto the new details inside the same save, and the editor says on screen what it
 * moved. That module also owns the three cases the move is not a plain rename in, which are a
 * second copy still answering to the old details, a title cleared to nothing, and a favourite
 * already sitting on the new ones.
 */
export type FavouriteKey = ChartKey

/** A stored favourite: its key, and when it was added. */
export interface Favourite extends FavouriteKey {
  /** ISO 8601, so the newest is first without a second column to sort on. */
  addedAt: string
}

/**
 * The readable form of the three fields, which is the form a favourite is stored and compared in.
 *
 * `chartKey` under the name this caller knows it by, not a second copy of its rules. Markup out,
 * missing fields as '' rather than null; shared/chart-key.ts carries both reasons.
 */
export const favouriteKey = chartKey

/**
 * Whether this key names a chart at all.
 *
 * `namesAChart`, aliased. A chart with no name is refused a heart because the name it would be
 * hearted under is its folder's, which is a display fallback and not an identity.
 */
export const isFavouritable = namesAChart

/** One string per favourite, for membership tests in the renderer. `chartKeyId`, aliased. */
export const favouriteId = chartKeyId
