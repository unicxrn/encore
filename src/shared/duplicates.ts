/**
 * What "duplicate" means in a Clone Hero library, which is three different things.
 *
 * A library collected over years accumulates all three, and flattening them into one list would
 * be wrong in both directions: it would let a chart nobody should delete sit under a heading that
 * implies they should, and it would bury the one case that really is pure waste. So the report
 * keeps them apart and each tier carries its own sentence about what it is.
 *
 * Nothing here removes anything. The report says what is duplicated and where each copy lives;
 * what to do about it is the user's, on their own filesystem. See DUPLICATE_TIERS for the wording
 * each tier is presented with, which is the part that has to stay honest.
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
      'still differ in album art, video or lyrics, so both are listed.'
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
