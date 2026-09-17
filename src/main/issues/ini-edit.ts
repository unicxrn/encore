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
  assertNotUtf16(source)

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

/**
 * Which `[song]` lines set `key`, in the order `parseIni` would have read them.
 *
 * Shared by the reader and the writer below so the two cannot disagree about which line holds a
 * value: reading one line and rewriting another is how a form reports a change it did not make.
 * `parseIni` assigns into a plain object as it goes, so the LAST entry is the one scan-chart sees.
 */
function songKeyLines(source: Uint8Array, key: string): Line[] {
  const hits: Line[] = []
  let section = ''
  for (const line of lines(source)) {
    const text = ascii(source, line.start, line.end)
    if (text.length === 0 || text.startsWith(';')) continue
    if (text.startsWith('[')) {
      const match = /\[(.+)]$/.exec(text)
      if (match) section = match[1].trim()
      continue
    }
    const at = text.indexOf('=')
    if (at !== -1 && SONG_SECTIONS.has(section) && text.slice(0, at).trim() === key) hits.push(line)
  }
  return hits
}

/**
 * Refuse a file `parseIni` would decode as UTF-16.
 *
 * Shared by every entry point here for the reason `removeSongIniKey` gave: a UTF-16 line
 * terminator is two bytes and every ASCII character carries a zero byte, so splitting on LF cuts
 * lines in the wrong places and matches no key at all. Failing says why; carrying on would report
 * an empty field for a file that plainly holds one, and then write a second copy of the key that
 * Clone Hero would never read.
 */
function assertNotUtf16(source: Uint8Array): void {
  if (
    source.length >= 2 &&
    ((source[0] === 0xff && source[1] === 0xfe) || (source[0] === 0xfe && source[1] === 0xff))
  ) {
    throw new Error(
      'Encore cannot edit this song.ini: it is UTF-16, and Encore only edits UTF-8 and Latin-1 ini files.'
    )
  }
}

/**
 * The value `scanIni` would read for `key`, or the empty string when the chart does not set it.
 *
 * Deliberately raw: no style tags stripped, no `-1`/`0` sentinel folded to a default, no trim
 * beyond the one `parseIni` itself performs. A form that showed scan-chart's reading would show
 * `Unknown Album` for a chart whose ini says nothing, and writing that back would put the words
 * "Unknown Album" in the user's file. What the editor has to show is what is in the file.
 *
 * Decoded as UTF-8, which is what `parseIni` does for anything without a UTF-16 BOM. A Latin-1
 * file's accented characters therefore read back with replacement characters here, exactly as
 * they already do everywhere else in the app, because they are what scan-chart put in the catalog
 * too. The bytes are only at risk if the user edits that particular field, which is an edit they
 * asked for; every line they leave alone is copied through untouched.
 */
export function readSongIniKey(source: Uint8Array, key: string): string {
  assertNotUtf16(source)
  const hits = songKeyLines(source, key)
  if (hits.length === 0) return ''
  const line = hits[hits.length - 1]
  const text = new TextDecoder().decode(source.subarray(line.start, line.end))
  const at = text.indexOf('=')
  return at === -1 ? '' : text.slice(at + 1).trim()
}

/** What `setSongIniKey` did, so a caller can refuse to report a change that did not happen. */
export interface IniKeyWrite {
  bytes: Uint8Array
  /** False when the file already said this, so the caller can skip the write entirely. */
  changed: boolean
}

/**
 * Set `key` to `value` in the chart's `[song]` section, touching nothing else.
 *
 * An empty `value` REMOVES the key rather than writing `key = `. The two are the same thing to
 * scan-chart, which folds an empty string to the field's default and raises `missingValue` either
 * way, and they are the same thing to a `.sng` header, whose generator omits an empty key. One of
 * them leaves a line in the file that means nothing; this writes the other.
 *
 * When the key is already there, only the VALUE's bytes are replaced. The line keeps its
 * indentation, its key spelling, the spacing around its `=`, any trailing whitespace and its own
 * line terminator, so a CRLF file stays CRLF and an aligned block stays aligned. Earlier
 * duplicate settings of the same key are dropped, because `parseIni` keeps the last and a file
 * that still set it twice would disagree with itself the next time anything read it.
 *
 * When the key is absent it is appended to the END of the `[song]` section, after the last line
 * that belongs to it and before whatever follows. Appending to the file instead would put the key
 * under a later section, where `parseIni` would never look at it, and inserting after the section
 * header would push it above keys the charter chose to lead with.
 *
 * Refuses a `value` carrying a line terminator: an ini value ends at the newline, so those bytes
 * would not be part of the value at all. The remainder would become a line of its own, which is
 * either a `badIniLine` or, if it happened to contain an `=`, a key nobody set.
 *
 * Refuses a hashed key before it looks at the file at all, on the same terms as
 * `removeSongIniKey`: changing one of those is a chart the user can no longer play with anyone
 * who has the original.
 */
export function setSongIniKey(source: Uint8Array, key: string, value: string): IniKeyWrite {
  assertKeyIsNotHashed(key)
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Encore will not write a line break into song.ini's "${key}": an ini value ends at the ` +
        `end of its line, so everything after the break would become a line of its own.`
    )
  }
  assertNotUtf16(source)
  if (value === '') {
    const removal = removeSongIniKey(source, key)
    return { bytes: removal.bytes, changed: removal.removed > 0 }
  }

  const hits = songKeyLines(source, key)
  const encoder = new TextEncoder()
  if (hits.length > 0) {
    const target = hits[hits.length - 1]
    // Past the `=`, then past the spaces that follow it, clamped to the line's own trimmed end so
    // a `key =` with nothing after it cannot walk into the terminator.
    const equals = target.start + ascii(source, target.start, target.end).indexOf('=')
    let valueStart = equals + 1
    while (valueStart < target.end && SPACE.has(source[valueStart])) valueStart++
    if (readSongIniKey(source, key) === value && hits.length === 1) {
      return { bytes: source, changed: false }
    }
    const replaced = new Map<number, Uint8Array>([
      [
        target.from,
        concat([
          source.subarray(target.from, valueStart),
          encoder.encode(value),
          // Everything the trimmed line did not cover: trailing spaces and the terminator.
          source.subarray(target.end, target.to)
        ])
      ]
    ])
    const dropped = new Set(hits.slice(0, -1).map((line) => line.from))
    return { bytes: rebuild(source, dropped, replaced), changed: true }
  }

  const insertion = songSectionEnd(source)
  if (insertion === null) {
    throw new Error(
      `Encore cannot edit this song.ini: it has no [song] section, so there is nowhere a "${key}" ` +
        `line would be read from.`
    )
  }
  const added = encoder.encode(`${insertion.before}${key} = ${value}${insertion.after}`)
  return {
    bytes: concat([source.subarray(0, insertion.at), added, source.subarray(insertion.at)]),
    changed: true
  }
}

/**
 * Where a new `[song]` key goes, and what to wrap it in.
 *
 * "The end of the section" is the byte after the last line that carries something, not the byte
 * before the next `[`: a section followed by a blank line and then a comment introducing the NEXT
 * section would otherwise take the new key after both, where it reads as part of that comment's
 * subject. Null when the file has no `[song]` section at all.
 *
 * `before` and `after` are what the new line is wrapped in. The terminator is copied from the
 * line the key lands after, so a CRLF file gains a CRLF line rather than a mixed one. A section
 * whose last line has no terminator (the file ends there) gets its newline in `before` instead,
 * so the new key cannot be appended onto the end of an existing one.
 */
function songSectionEnd(source: Uint8Array): { at: number; before: string; after: string } | null {
  let section = ''
  let end: { at: number; before: string; after: string } | null = null
  for (const line of lines(source)) {
    const text = ascii(source, line.start, line.end)
    if (text.startsWith('[')) {
      const match = /\[(.+)]$/.exec(text)
      if (match) section = match[1].trim()
    }
    if (!SONG_SECTIONS.has(section) || text.length === 0) continue
    const tail = ascii(source, line.end, line.to)
    end = tail.includes('\n')
      ? { at: line.to, before: '', after: tail.includes('\r\n') ? '\r\n' : '\n' }
      : { at: line.to, before: '\n', after: '' }
  }
  return end
}

/** Join byte ranges into one array, in order. */
function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const bytes = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

/**
 * Rebuild the file from its lines, dropping the ones whose start is in `dropped` and swapping in
 * `replaced` for the ones it names.
 *
 * Keyed on a line's first byte, which is unique across the file because the ranges tile it.
 */
function rebuild(
  source: Uint8Array,
  dropped: Set<number>,
  replaced: Map<number, Uint8Array>
): Uint8Array {
  const parts: Uint8Array[] = []
  for (const line of lines(source)) {
    if (dropped.has(line.from)) continue
    parts.push(replaced.get(line.from) ?? source.subarray(line.from, line.to))
  }
  return concat(parts)
}
