/**
 * Editing a chart's `song.ini` without changing anything the edit was not about.
 *
 * A parse-and-reserialise would be a page shorter and is the wrong shape for this job. The file
 * belongs to the user: it carries comments, a key order someone chose, keys neither Encore nor
 * scan-chart knows about, and whatever whitespace and encoding the tool that wrote it used.
 * Round-tripping it through an object drops the comments, reorders the keys, and re-encodes the
 * bytes. One of those keys may be among the seven `getChartHash` mixes in, where a value that
 * lands differently is a chart the user can no longer play with anyone else (issues/fix.ts).
 *
 * So this works on lines, as byte ranges. Every line the edit does not target is copied to the
 * output as the exact bytes it arrived as: nothing is decoded and re-encoded, so a Latin-1
 * `Motörhead` in the artist field survives a `diff_bass` removal, which a UTF-8 round trip would
 * have turned into `Mot?rhead`.
 *
 * Which lines are targeted is decided on the bytes too, against scan-chart's own reading of the
 * file (`parseIni`, node_modules/scan-chart/dist/index.js:231). Structure in an ini is ASCII
 * (`[`, `]`, `;`, `=`, the key names), and every byte of a UTF-8 multi-byte sequence is >= 0x80,
 * so a byte comparison cannot mistake part of a name for a delimiter.
 */

/** ASCII whitespace: what `parseIni` trims off a line before it looks at it. */
const SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20])

/**
 * The seven keys `getChartHash` mixes into a chart's multiplayer identity, plus the two legacy
 * spellings scan-chart falls back to.
 *
 * `hopofreq` and `star_power_note` are not hashed themselves and are easy to leave out of a list
 * like this: `extractSongMetadata` reads `hopo_frequency` as
 * `getIniInteger(songSection, "hopo_frequency", "hopofreq")`, so a chart that sets only the
 * legacy spelling has its hashed `hopo_frequency` come from that line. Removing it would move the
 * hash exactly as removing the modern spelling would. Same for `star_power_note` and
 * `multiplier_note`. The other five have no legacy alias.
 *
 * This is belt and braces. No `extraValue` row can name any of these (scan-chart only raises
 * that code for the eleven `diff_*` keys), and `applyFix` re-scans and refuses on a moved hash
 * regardless. It is here so that a caller which one day computes a key from something less
 * constrained than a fixed list cannot reach the filesystem with it.
 */
export const HASHED_INI_KEYS: readonly string[] = [
  'hopo_frequency',
  'hopofreq',
  'eighthnote_hopo',
  'multiplier_note',
  'star_power_note',
  'sustain_cutoff_threshold',
  'chord_snap_threshold',
  'five_lane_drums',
  'pro_drums'
]

/**
 * Refuse a key whose value Clone Hero matches charts by.
 *
 * Throws rather than returning false: there is no sensible way for a caller to continue, and a
 * boolean is something a caller can forget to check.
 */
export function assertKeyIsNotHashed(key: string): void {
  if (HASHED_INI_KEYS.includes(key)) {
    throw new Error(
      `Encore will not edit "${key}" in song.ini: Clone Hero matches charts between players by ` +
        `that value, so changing it would make this chart un-playable with anyone who has the ` +
        `original.`
    )
  }
}

/** The section names `scanIni` accepts as a chart's metadata; anything else is ignored. */
const SONG_SECTIONS = new Set(['song', 'Song', 'SONG'])

/** One line of the source, as the byte range that includes its own line terminator. */
interface Line {
  /** First byte of the line. */
  from: number
  /** One past the line's last byte, terminator included, so the ranges tile the file exactly. */
  to: number
  /** First non-space byte, and one past the last; the range `parseIni` would have looked at. */
  start: number
  end: number
}

/** Split `source` into lines on LF, keeping each terminator with the line it ends. */
function lines(source: Uint8Array): Line[] {
  const out: Line[] = []
  let from = 0
  while (from <= source.length) {
    let to = from
    while (to < source.length && source[to] !== 0x0a) to++
    // Past the LF, so concatenating the kept ranges reproduces the file byte for byte, and a
    // removed line takes its own newline with it rather than leaving a blank behind.
    const end = to < source.length ? to + 1 : to
    let start = from
    let stop = to
    while (start < stop && SPACE.has(source[start])) start++
    while (stop > start && SPACE.has(source[stop - 1])) stop--
    out.push({ from, to: end, start, end: stop })
    if (to >= source.length) break
    from = end
  }
  return out
}

/** The ASCII text of a byte range, for comparing against a key or a section name. */
function ascii(source: Uint8Array, from: number, to: number): string {
  let text = ''
  for (let at = from; at < to; at++) text += String.fromCharCode(source[at])
  return text
}

export interface IniKeyRemoval {
  bytes: Uint8Array
  /** How many lines were dropped. Zero means the key was not written the way we expected. */
  removed: number
}

/**
 * Remove every line that sets `key` in the chart's `[song]` section.
 *
 * Every line, not the last one: `parseIni` assigns into a plain object as it goes, so a file that
 * sets `diff_bass` twice keeps the later value. Dropping only one of them would leave the
 * value scan-chart reads exactly where it was while reporting the fix as done.
 *
 * The section is tracked the way `parseIni` tracks it, so a `diff_bass` sitting under some other
 * section header is left alone: scan-chart never read it, so it is not the value the issue row is
 * about, and removing it would be editing a part of the file nobody complained about.
 *
 * Keys are compared case-sensitively because `extractSongMetadata` indexes the parsed section
 * with a literal string. To scan-chart, `DIFF_BASS` is a key it has never heard of: an unknown
 * key, which this must preserve rather than delete.
 *
 * Refuses a UTF-16 file. `parseIni` honours a BOM and decodes those as UTF-16, where a line
 * terminator is two bytes and every ASCII character carries a zero byte: splitting on LF would
 * cut lines in the wrong places and match no key at all. Failing here says why; carrying on would
 * silently report zero removals for a file that plainly contains the key.
 */
export function removeSongIniKey(source: Uint8Array, key: string): IniKeyRemoval {
  assertKeyIsNotHashed(key)
  if (
    source.length >= 2 &&
    ((source[0] === 0xff && source[1] === 0xfe) || (source[0] === 0xfe && source[1] === 0xff))
  ) {
    throw new Error(
      'Encore cannot edit this song.ini: it is UTF-16, and Encore only edits UTF-8 and Latin-1 ini files.'
    )
  }

  const kept: Line[] = []
  let section = ''
  let removed = 0
  for (const line of lines(source)) {
    const text = ascii(source, line.start, line.end)
    if (text.length > 0 && !text.startsWith(';')) {
      if (text.startsWith('[')) {
        // `parseIni`'s own pattern. A `[` line that does not close is a `badIniLine` there and
        // leaves the section unchanged, which is what not matching does here.
        const match = /\[(.+)]$/.exec(text)
        if (match) section = match[1].trim()
      } else {
        const at = text.indexOf('=')
        if (at !== -1 && SONG_SECTIONS.has(section) && text.slice(0, at).trim() === key) {
          removed++
          continue
        }
      }
    }
    kept.push(line)
  }
  if (removed === 0) return { bytes: source, removed }

  let length = 0
  for (const line of kept) length += line.to - line.from
  const bytes = new Uint8Array(length)
  let at = 0
  for (const line of kept) {
    bytes.set(source.subarray(line.from, line.to), at)
    at += line.to - line.from
  }
  return { bytes, removed }
}
