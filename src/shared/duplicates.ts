/**
 * What "duplicate" means in a Clone Hero library, which is three different things.
 *
 * A library collected over years accumulates all three, and flattening them into one list would
 * be wrong in both directions: it would let a chart nobody should delete sit under a heading that
 * implies they should, and it would bury the one case that really is pure waste. So the report
 * keeps them apart and each tier carries its own sentence about what it is.
 *
 * Only tier 1 offers to remove a copy, and only because its claim is the one that survives being
 * acted on: the copies hold the same notes byte for byte. Tiers 2 and 3 are listings, and a
 * button on either of them would be Encore inviting a user to throw away a chart it has no
 * grounds to call spare. See DUPLICATE_TIERS for the wording each tier is presented with, which
 * is the part that has to stay honest.
 */

/** One chart in a duplicate group, as much of its catalog row as the report shows. */
export interface DuplicateCopy {
  path: string
  chartType: 'folder' | 'sng'
  name: string | null
  artist: string | null
  charter: string | null
  album: string | null
  songLength: number | null
  /** Last modified time of the chart, so the newer copy of a pair can be told from the older. */
  modifiedTime: number
  /**
   * Clone Hero's own identity for this chart (`ChartRecord.cloneHeroChecksum`). Null for a chart
   * with no readable chart file, and for any row not rescanned since Encore started recording it.
   */
  cloneHeroChecksum: string | null
  /**
   * What this copy holds around the notes, straight off the catalog row.
   *
   * Carried because the checksum does NOT cover any of it. Two copies can be the same chart file
   * and still differ in every one of these four, so "these are identical, remove one" can be a
   * true statement about the charts and a loss of the album art, the video or the synced lyrics
   * in the same moment. They are on the row already; showing them is a read, not a scan.
   */
  hasAlbumArt: boolean
  hasVideo: boolean
  hasBackground: boolean
  hasLyrics: boolean
  /**
   * Size of the chart on disk in bytes: the file for a .sng, the whole folder for a folder chart.
   *
   * Filled for tier 1 copies only, which are the ones a removal can be offered on, because it is
   * the one field here that is not already in the catalog and has to be read from the filesystem.
   * Null everywhere else, and null for a copy whose size could not be read, which is also what a
   * chart that has since left the disk looks like.
   */
  sizeBytes: number | null
}

/**
 * Tier 1: one chart file, installed more than once.
 *
 * Grouped on `cloneHeroChecksum`, which is an MD5 over the chart file's bytes alone. Two rows
 * sharing one is the same notes, and the game cannot tell them apart either. Metadata is NOT part
 * of the key, so a copy whose song.ini was edited, or which was renamed on the way in, still lands
 * here. This is the only tier where nothing unique is lost by having one copy instead of two.
 *
 * What it does not cover: audio, album art, video, background and lyrics live outside the chart
 * file, so two copies here can still differ in what is around the notes. That is why the report
 * shows every copy rather than nominating one to keep.
 */
export interface IdenticalGroup {
  checksum: string
  copies: DuplicateCopy[]
}

/**
 * Tier 2: the same song by the same charter, at more than one chart file.
 *
 * Almost always an update downloaded beside the copy it was meant to replace. The old one is not
 * waste in the way tier 1 is: it is a different chart, and a score set on it is recorded against
 * its checksum rather than the new one's.
 *
 * `versionCount` counts distinct known checksums. `unknownCount` is the copies whose checksum is
 * null, which are the reason a group can qualify without two known versions: rows that cannot be
 * compared must not be reported as identical.
 */
export interface VersionGroup {
  artist: string
  name: string
  charter: string
  copies: DuplicateCopy[]
  versionCount: number
  unknownCount: number
  /**
   * How many of these copies are also byte-identical to another copy in this same group, and so
   * also appear under tier 1.
   *
   * Stated rather than hidden, because the overlap is real: three copies at two versions, two of
   * them the same file, belong in both lists and the user should not have to work that out by
   * comparing paths across two sections.
   */
  identicalCopies: number
}

/**
 * Tier 3: the same song, charted by different people.
 *
 * Not a duplicate in the sense the other two are, and not a problem at all. People keep several
 * charts of one song deliberately: a drums chart from one charter and a guitar chart from
 * another, a faithful chart and a harder one. It is listed because "why do I have this song three
 * times" is a question with an answer, and the answer is worth showing.
 */
export interface AlternateGroup {
  artist: string
  name: string
  /** One entry per charter, each holding that charter's copies. Always two or more entries. */
  charters: { charter: string; copies: DuplicateCopy[] }[]
}

export interface DuplicateReport {
  identical: IdenticalGroup[]
  versions: VersionGroup[]
  alternates: AlternateGroup[]
  /** Charts in the catalog, for the "3 of 1,204" phrasing the summary uses. */
  totalCharts: number
  /**
   * Charts with no stored `cloneHeroChecksum`, which the identical check cannot see at all.
   *
   * A row gets one when it is scanned by scan version 7 or later, so a catalog that has not been
   * rescanned since carries none, and the answer "no identical copies" would then mean "not
   * looked" rather than "none". The count is shown whenever it is not zero so that distinction
   * reaches the user instead of being swallowed.
   */
  unidentifiedCharts: number
}

/**
 * The four things that live OUTSIDE the chart file, in the order a copy lists them.
 *
 * This list is the whole reason a tier 1 group shows every copy's contents rather than
 * nominating one to keep. `cloneHeroChecksum` is an MD5 over the chart file alone, so none of
 * these is in it: a copy can be byte-identical to its twin and be the only one of the two with
 * a background video.
 */
export type CopyAssetKey = 'hasAlbumArt' | 'hasVideo' | 'hasBackground' | 'hasLyrics'

export const COPY_ASSETS: { key: CopyAssetKey; label: string }[] = [
  { key: 'hasAlbumArt', label: 'album art' },
  { key: 'hasVideo', label: 'video' },
  { key: 'hasBackground', label: 'background' },
  { key: 'hasLyrics', label: 'lyrics' }
]

/** Which of the four this copy has, as labels, in COPY_ASSETS order. */
export function assetsHeld(copy: DuplicateCopy): string[] {
  return COPY_ASSETS.filter((asset) => copy[asset.key]).map((asset) => asset.label)
}

/**
 * Which of the four this copy has that NO other copy in its group has.
 *
 * The set that a removal would actually lose, which is a narrower question than "what does this
 * one have that the one next to it does not": in a group of three, art held by two of them
 * survives either of those two being removed. `group` is the whole group, this copy included;
 * copies are matched by path, since that is what identifies a row.
 */
export function assetsOnlyHere(copy: DuplicateCopy, group: DuplicateCopy[]): string[] {
  const others = group.filter((other) => other.path !== copy.path)
  return COPY_ASSETS.filter(
    (asset) => copy[asset.key] && others.every((other) => !other[asset.key])
  ).map((asset) => asset.label)
}

export type DuplicateTierId = 'identical' | 'versions' | 'alternates'

/**
 * How each tier is introduced on screen, and the reason the wording is here rather than inline.
 *
 * Tier 3 is the one that has to be got right. Titling it anything like a problem would tell users
 * their deliberate collection of four charts of one song is a fault in their library, and the
 * worst outcome available here is a user deleting a chart they wanted because Encore implied they
 * should. So its title says what it is, its blurb says outright that nothing is wrong, and it
 * carries no count of anything "wasted".
 */
export const DUPLICATE_TIERS: {
  id: DuplicateTierId
  title: string
  blurb: string
}[] = [
  {
    id: 'identical',
    title: 'The same chart, installed twice',
    blurb:
      'These copies hold the same notes, byte for byte. Clone Hero shows each of them as a ' +
      'separate song. Keeping one loses nothing from the chart itself, though the copies can ' +
      'still differ in album art, video or lyrics, so each one lists what it holds and nothing ' +
      'is chosen for you.'
  },
  {
    id: 'versions',
    title: 'Different versions of one chart',
    blurb:
      'The same song by the same charter, at more than one version. Usually an update that ' +
      'landed beside the copy it was meant to replace. They are different charts: a score set ' +
      'on one is not recorded against the other.'
  },
  {
    id: 'alternates',
    title: 'The same song by different charters',
    blurb:
      'Nothing is wrong here. Several people charted this song and you have more than one of ' +
      'their charts, which is a normal thing to want. Listed so the song showing up more than ' +
      'once in Clone Hero has an explanation.'
  }
]
