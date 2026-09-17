import { stripRichText } from './format'

/**
 * What makes two charts the same chart, written once.
 *
 * Three questions in this app are the same question: Explore's Hide owned and the chart page's IN
 * LIBRARY badge ask "do I have this" of a Chorus result against the catalog, the heart asks "did I
 * favourite this", and a setlist asks "is this the chart my entry names". They were three spellings
 * in one release. `catalog:exists-by-meta` compared the RAW `song.ini` text through `LOWER()`, while
 * a favourite and a setlist entry compared the markup-stripped text, so a chart whose Chorus copy
 * carries colour tags in its title and whose local copy has had them edited out was one chart to a
 * heart and two to Hide owned. This module is the single answer, and every one of the three now
 * routes through it.
 *
 * The three fields are the song, the artist and the charter as a READER sees them. Not the path,
 * and not either of the two chart identities; `shared/favourites.ts` argues that choice out in full
 * against `charts.path`, `cloneHeroChecksum` and scan-chart's `chartHash`, and none of it is
 * repeated here.
 *
 * ## Why the readable form and not the raw one
 *
 * Clone Hero renders TextMeshPro markup in these fields and charters use it (see `STRIPPED_COLUMN`
 * in main/catalog/db.ts). Comparing the raw text therefore answers a question about characters
 * nobody can see, and it fails in the direction that costs the user something real: two copies of
 * one chart read as two charts, Hide owned does not hide the one already on disk, the badge says it
 * is not in the library, and the user downloads what they already have. Comparing the readable form
 * fails the other way, where a charter would have to publish two charts distinguished by nothing
 * but colour tags for it to fire at all, and a user could not tell those two apart on any screen in
 * either application.
 *
 * It costs nothing in SQL either, which was measured rather than assumed: over a generated 20,000
 * row catalog, a batch of 100 keys took 76 ms through `LOWER(name) = LOWER(?)` and 40 ms through
 * `COALESCE(nameStripped, name) = ? COLLATE NOCASE`, because `LOWER()` builds a new string per
 * column per row and a NOCASE comparison does not. Both were full scans; `charts_meta` in
 * main/catalog/db.ts is the index that took the same batch to 1.1 ms.
 */
export interface ChartKey {
  name: string
  artist: string
  charter: string
}

/**
 * The three fields in the form they are stored and compared in.
 *
 * Markup out, per above. Missing fields become '' rather than staying null, because a chart with no
 * charter is a chart whose charter is nobody, and a null in SQL compares equal to nothing at all,
 * including to itself.
 *
 * Idempotent, which is what lets main normalise at the door of every lookup without caring whether
 * the caller handed over raw Chorus text or a key it read back out of the catalog: stripping text
 * that carries no markup returns it unchanged.
 */
export function chartKey(input: {
  name?: string | null
  artist?: string | null
  charter?: string | null
}): ChartKey {
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
 * key, and renaming a folder would move it. The heart and a setlist both refuse rather than
 * attaching to something they cannot hold on to, and Encore's metadata editor is the way out.
 *
 * Artist and charter are not required. Plenty of real charts set neither, and "this song, nobody
 * credited" is still one identifiable thing.
 */
export function namesAChart(key: ChartKey): boolean {
  return key.name !== ''
}

/**
 * Case folding, matching SQLite's NOCASE exactly: A-Z and nothing else.
 *
 * The catalog compares these three fields case-insensitively, and the favourites and
 * setlist_entries tables declare their key columns COLLATE NOCASE so one chart cannot be favourited
 * twice over a capital letter. The renderer has to answer the same question about a chart it is
 * drawing, without asking main, and `toLowerCase()` would not be the same answer: it folds `İ` and
 * `ẞ`, which NOCASE leaves alone, so a title carrying either would read as favourited on one side
 * of the boundary and not on the other. This is the narrow rule, written down once.
 */
function foldNocase(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase())
}

/**
 * One string per chart, for membership tests in the renderer.
 *
 * NUL-joined because it is the one character `song.ini` cannot carry, so no combination of name,
 * artist and charter can spell another combination's id.
 */
export function chartKeyId(key: ChartKey): string {
  return [foldNocase(key.name), foldNocase(key.artist), foldNocase(key.charter)].join('\0')
}

/** Whether these two keys name the same chart, by the same rule SQLite compares them by. */
export function sameChart(a: ChartKey, b: ChartKey): boolean {
  return chartKeyId(a) === chartKeyId(b)
}

/**
 * What a metadata edit did to the lists the user built, when it moved the chart's key.
 *
 * The metadata editor writes exactly the three fields this key is made of, so correcting a chart's
 * artist renames the thing a favourite and a setlist entry name. Encore moves them with it rather
 * than letting one feature undo another, and `main/catalog/rekey.ts` is the move. This is its
 * report, carried back through `chart:write-metadata` so the screen that did it can say what
 * happened instead of leaving the user to notice a heart missing later.
 *
 * Null on the wire when the three fields did not move, and also when they moved but named nothing
 * the user had put on a list: there is no news in either case.
 */
export interface ChartListMove {
  /** The key the chart had before the save, and the one it has now. */
  from: ChartKey
  to: ChartKey
  /** True when a favourite named the old key. */
  favourite: boolean
  /** The names of the setlists that held the old key, in the order the sidebar lists them. */
  setlists: string[]
  /**
   * True when another chart in the library still answers to the old key, so the heart and the
   * entries were COPIED to the new one rather than moved off it.
   */
  oldKeyKept: boolean
  /**
   * True when the new key cannot hold a favourite (the title was cleared), so nothing moved and
   * the rows still name the old title.
   */
  stranded: boolean
  /** True when the new key already carried a favourite or an entry, so the two became one. */
  merged: boolean
}

/**
 * The sentence the metadata editor prints after a save that moved a chart's key.
 *
 * Here rather than in the component because it is the one description of what the write did, and
 * main's own tests can then hold it to the cases `rekey.ts` produces. Null means there is nothing
 * to say, which the caller draws as no line at all rather than as an empty one.
 *
 * Undefined is read as null. This value crosses IPC, so the field is absent rather than null on an
 * answer from a main process that predates it, and a save reporting nothing about the user's lists
 * must not be a save that throws on the way to the screen.
 */
export function describeChartListMove(move: ChartListMove | null | undefined): string | null {
  if (move === null || move === undefined) return null
  const held = listsHeld(move.favourite, move.setlists)
  if (held === null) return null
  const merged = move.merged ? ' The new details already carried one, so the two are now one.' : ''
  if (move.stranded) {
    return (
      `This chart has no title now, and a chart with no title is not something Encore can keep on ` +
      `a list, so ${held.phrase} still ${held.plural ? 'name' : 'names'} "${move.from.name}". ` +
      `Typing the title back brings the chart under it again.`
    )
  }
  if (move.oldKeyKept) {
    return (
      `Encore added the new details to ${held.phrase}. Another chart in your library still says ` +
      `"${move.from.name}", so the old entry stays as well.${merged}`
    )
  }
  return `Encore moved this chart in ${held.phrase} to match.${merged}`
}

/**
 * The lists a chart is on, named the way a sentence about them needs: "your favourites",
 * `the setlist "Friday night"`, "2 setlists", "your favourites and 2 setlists". Null for none.
 *
 * Exported because the metadata editor says this twice about one save, once before it as a warning
 * and once after it as a report, and the two have to name the same lists the same way.
 */
export function chartListsPhrase(favourite: boolean, setlists: string[]): string | null {
  return listsHeld(favourite, setlists)?.phrase ?? null
}

/**
 * The same phrase, with whether it takes a plural verb.
 *
 * The flag is carried rather than derived from a count at the call site, because "your favourites"
 * is one entry and a plural subject while a single setlist is the other way round.
 */
function listsHeld(
  favourite: boolean,
  setlists: string[]
): { phrase: string; plural: boolean } | null {
  const lists =
    setlists.length === 0
      ? null
      : setlists.length === 1
        ? { phrase: `the setlist "${setlists[0]}"`, plural: false }
        : { phrase: `${setlists.length} setlists`, plural: true }
  if (!favourite) return lists
  if (lists === null) return { phrase: 'your favourites', plural: true }
  return { phrase: `your favourites and ${lists.phrase}`, plural: true }
}
