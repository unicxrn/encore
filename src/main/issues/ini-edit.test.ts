import { describe, expect, it } from 'vitest'
import {
  assertKeyIsNotHashed,
  HASHED_INI_KEYS,
  readSongIniKey,
  removeSongIniKey,
  setSongIniKey
} from './ini-edit'

const encoder = new TextEncoder()
const bytes = (text: string): Uint8Array => encoder.encode(text)
const text = (data: Uint8Array): string => Buffer.from(data).toString('utf8')

/**
 * A `song.ini` with every awkward thing a real one has: a comment, blank lines, a key order
 * nobody would choose, inconsistent spacing, CRLF on one line, and a key scan-chart has never
 * heard of.
 *
 * The point of the fixture is that a parse-and-reserialise would lose or reorder something in it.
 */
const MESSY = [
  '; downloaded from somewhere, do not edit',
  '',
  '[song]',
  'name = Fixture',
  'diff_bass=4',
  '   pro_drums   =   True   ',
  'artist=Tester\r',
  '',
  'some_key_we_have_never_heard_of = 7',
  'hopo_frequency = 3'
].join('\n')

describe('removeSongIniKey', () => {
  it('removes only the targeted line and leaves every other byte alone', () => {
    const before = bytes(MESSY)

    const after = removeSongIniKey(before, 'diff_bass')

    expect(after.removed).toBe(1)
    // Byte-for-byte, not "contains": comments, blank lines, the odd spacing around pro_drums,
    // the lone CR after `artist=Tester`, the unknown key and the key ORDER all survive. A
    // parse-and-reserialise would have changed at least four of those.
    expect(text(after.bytes)).toBe(MESSY.replace('diff_bass=4\n', ''))
  })

  it("takes the removed line's newline with it rather than leaving a blank", () => {
    const after = removeSongIniKey(bytes('[song]\na = 1\ndiff_bass = 4\nb = 2\n'), 'diff_bass')

    expect(text(after.bytes)).toBe('[song]\na = 1\nb = 2\n')
  })

  it('handles a file whose last line has no newline', () => {
    const after = removeSongIniKey(bytes('[song]\nname = X\ndiff_bass = 4'), 'diff_bass')

    expect(after.removed).toBe(1)
    expect(text(after.bytes)).toBe('[song]\nname = X\n')
  })

  it('removes every occurrence, not just the first', () => {
    // `parseIni` assigns into a plain object as it walks, so the LAST value wins. Dropping only
    // one of two would leave the value scan-chart reads exactly where it was.
    const after = removeSongIniKey(
      bytes('[song]\ndiff_bass = 1\nname = X\ndiff_bass = 4\n'),
      'diff_bass'
    )

    expect(after.removed).toBe(2)
    expect(text(after.bytes)).toBe('[song]\nname = X\n')
  })

  it.each(['[song]', '[Song]', '[SONG]'])('edits inside %s', (header) => {
    const after = removeSongIniKey(bytes(`${header}\ndiff_bass = 4\n`), 'diff_bass')

    expect(after.removed).toBe(1)
  })

  it('leaves a matching key in some other section alone', () => {
    // scan-chart only reads `[song]`, so a diff_bass under another header is not the value the
    // issue row is about, and deleting it would be editing part of a file nobody complained of.
    const source = '[song]\nname = X\n[Other]\ndiff_bass = 4\n'

    const after = removeSongIniKey(bytes(source), 'diff_bass')

    expect(after.removed).toBe(0)
    expect(text(after.bytes)).toBe(source)
  })

  it('leaves a key before any section header alone', () => {
    const source = 'diff_bass = 4\n[song]\nname = X\n'

    expect(removeSongIniKey(bytes(source), 'diff_bass').removed).toBe(0)
  })

  it('ignores a commented-out line', () => {
    const source = '[song]\n; diff_bass = 4\nname = X\n'

    expect(removeSongIniKey(bytes(source), 'diff_bass').removed).toBe(0)
  })

  it('matches case-sensitively, the way scan-chart indexes the parsed section', () => {
    // `extractSongMetadata` reads `songSection["diff_bass"]`, so `DIFF_BASS` is an unknown key to
    // scan-chart. Unknown keys are the user's, and this preserves them.
    const source = '[song]\nDIFF_BASS = 4\n'

    expect(removeSongIniKey(bytes(source), 'diff_bass').removed).toBe(0)
  })

  it('does not match a key that merely starts with the target', () => {
    const source = '[song]\ndiff_bassghl = 4\n'

    expect(removeSongIniKey(bytes(source), 'diff_bass').removed).toBe(0)
  })

  it('reports zero removals without touching the bytes when the key is absent', () => {
    const before = bytes(MESSY)

    const after = removeSongIniKey(before, 'diff_keys')

    expect(after.removed).toBe(0)
    expect(after.bytes).toBe(before)
  })

  it('preserves non-UTF-8 bytes elsewhere in the file', () => {
    // A Latin-1 `Motörhead`: 0xF6 is not valid UTF-8, so decoding the file to a string and
    // re-encoding it would replace it with U+FFFD and silently corrupt the user's artist name.
    const source = Buffer.concat([
      Buffer.from('[song]\nartist = Mot'),
      Buffer.from([0xf6]),
      Buffer.from('rhead\ndiff_bass = 4\n')
    ])

    const after = removeSongIniKey(new Uint8Array(source), 'diff_bass')

    expect(after.removed).toBe(1)
    expect(Buffer.from(after.bytes)).toEqual(
      Buffer.concat([
        Buffer.from('[song]\nartist = Mot'),
        Buffer.from([0xf6]),
        Buffer.from('rhead\n')
      ])
    )
  })

  it('refuses a UTF-16 file rather than silently finding nothing in it', () => {
    // `parseIni` honours the BOM and decodes these as UTF-16, where every ASCII character carries
    // a zero byte and LF is two bytes: splitting on LF would match no key at all, and returning
    // "removed nothing" would look like a file that simply did not contain the key.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[song]\n', 'utf16le')])

    expect(() => removeSongIniKey(new Uint8Array(utf16), 'diff_bass')).toThrow(/UTF-16/)
  })
})

describe('the hashed-key refusal', () => {
  it.each([...HASHED_INI_KEYS])('refuses to edit %s', (key) => {
    expect(() => assertKeyIsNotHashed(key)).toThrow(/matches charts between players/)
    expect(() => removeSongIniKey(bytes(`[song]\n${key} = 1\n`), key)).toThrow(
      /matches charts between players/
    )
  })

  it('covers the legacy spellings that feed a hashed key, not only the seven', () => {
    // `hopo_frequency` is read as getIniInteger(section, "hopo_frequency", "hopofreq") and
    // `multiplier_note` as getIniInteger(section, "multiplier_note", "star_power_note"), so a
    // chart that sets only the legacy spelling has its hashed value come from that line.
    // Removing it moves the hash exactly as removing the modern spelling would.
    expect(HASHED_INI_KEYS).toContain('hopofreq')
    expect(HASHED_INI_KEYS).toContain('star_power_note')
  })

  it('allows the keys the fixes actually need', () => {
    for (const key of ['diff_bass', 'diff_guitar', 'diff_vocals', 'album', 'year', 'genre']) {
      expect(() => assertKeyIsNotHashed(key)).not.toThrow()
    }
  })
})

describe('readSongIniKey', () => {
  it("reads the raw value, not scan-chart's reading of it", () => {
    // `getIniString` would fold an absent album to "Unknown Album" and strip style tags. The
    // editor has to show what is in the file: writing scan-chart's answer back would put the
    // words "Unknown Album" in the user's song.ini.
    const ini = bytes('[song]\nname = <color=#FF0000>Fixture</color>\nartist=Tester\n')

    expect(readSongIniKey(ini, 'name')).toBe('<color=#FF0000>Fixture</color>')
    expect(readSongIniKey(ini, 'artist')).toBe('Tester')
    expect(readSongIniKey(ini, 'album')).toBe('')
  })

  it('reads the value parseIni would keep when a key is set twice', () => {
    expect(readSongIniKey(bytes('[song]\nalbum = one\nalbum = two\n'), 'album')).toBe('two')
  })

  it('ignores a key under some other section, exactly as parseIni does', () => {
    expect(readSongIniKey(bytes('[song]\nname = X\n[extras]\nalbum = nope\n'), 'album')).toBe('')
  })

  it('refuses a UTF-16 file rather than reporting every field empty', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('[song]\nalbum = X\n', 'utf16le')
    ])

    expect(() => readSongIniKey(new Uint8Array(utf16), 'album')).toThrow(/UTF-16/)
  })
})

describe('setSongIniKey', () => {
  it('replaces the value and leaves every other byte alone', () => {
    const after = setSongIniKey(bytes(MESSY), 'artist', 'Motorhead')

    expect(after.changed).toBe(true)
    // Byte-for-byte again, and this fixture is the reason: `artist=Tester\r` has no space around
    // its `=` and ends in a lone CR, and the hashed `pro_drums` line above it is padded with
    // spaces. A parse-and-reserialise would normalise all three.
    expect(text(after.bytes)).toBe(MESSY.replace('artist=Tester', 'artist=Motorhead'))
  })

  it('keeps the spacing the charter chose around the delimiter', () => {
    const after = setSongIniKey(bytes('[song]\nalbum   =   old   \n'), 'album', 'new')

    expect(text(after.bytes)).toBe('[song]\nalbum   =   new   \n')
  })

  it('keeps a CRLF line a CRLF line', () => {
    const after = setSongIniKey(bytes('[song]\r\nalbum = old\r\nname = X\r\n'), 'album', 'new')

    expect(text(after.bytes)).toBe('[song]\r\nalbum = old\r\nname = X\r\n'.replace('old', 'new'))
  })

  it('appends a missing key at the end of the [song] section', () => {
    // Not at the end of the FILE: `parseIni` tracks sections, so a key written under `[extras]`
    // is a key scan-chart never reads.
    const after = setSongIniKey(
      bytes('[song]\nname = X\n\n[extras]\nsomething = 1\n'),
      'album',
      'Moving Pictures'
    )

    expect(text(after.bytes)).toBe(
      '[song]\nname = X\nalbum = Moving Pictures\n\n[extras]\nsomething = 1\n'
    )
  })

  it('appends with the terminator the section already uses', () => {
    const after = setSongIniKey(bytes('[song]\r\nname = X\r\n'), 'album', 'A')

    expect(text(after.bytes)).toBe('[song]\r\nname = X\r\nalbum = A\r\n')
  })

  it('gives a file with no trailing newline one before appending', () => {
    const after = setSongIniKey(bytes('[song]\nname = X'), 'album', 'A')

    expect(text(after.bytes)).toBe('[song]\nname = X\nalbum = A')
  })

  it('writes into an empty [song] section', () => {
    const after = setSongIniKey(bytes('[song]\n'), 'album', 'A')

    expect(text(after.bytes)).toBe('[song]\nalbum = A\n')
  })

  it('refuses a file with no [song] section at all', () => {
    // scan-chart reports `invalidMetadata` for such a file and reads nothing out of it, so a key
    // written anywhere in it would be a key nobody ever reads.
    expect(() => setSongIniKey(bytes('[extras]\na = 1\n'), 'album', 'A')).toThrow(/no \[song\]/)
  })

  it('removes the key when the value is cleared to empty', () => {
    // `key = ` and no key at all are the same thing to scan-chart, which folds an empty value to
    // the field's default either way. One of them leaves a line that means nothing.
    const after = setSongIniKey(bytes('[song]\nname = X\nalbum = old\n'), 'album', '')

    expect(after.changed).toBe(true)
    expect(text(after.bytes)).toBe('[song]\nname = X\n')
  })

  it('reports no change when clearing a key the file never set', () => {
    const after = setSongIniKey(bytes('[song]\nname = X\n'), 'album', '')

    expect(after.changed).toBe(false)
    expect(text(after.bytes)).toBe('[song]\nname = X\n')
  })

  it('reports no change when the file already says this', () => {
    // The caller skips the write entirely on a false, which for a .sng is a whole archive not
    // copied and for either shape is an mtime the scanner would otherwise have to chase.
    const after = setSongIniKey(bytes('[song]\nalbum = same\n'), 'album', 'same')

    expect(after.changed).toBe(false)
    expect(text(after.bytes)).toBe('[song]\nalbum = same\n')
  })

  it('collapses a key the file set twice down to the one parseIni reads', () => {
    const after = setSongIniKey(
      bytes('[song]\nalbum = one\nname = X\nalbum = two\n'),
      'album',
      'three'
    )

    expect(text(after.bytes)).toBe('[song]\nname = X\nalbum = three\n')
  })

  it('writes non-ASCII as UTF-8 and leaves a Latin-1 neighbour alone', () => {
    // The neighbour is the point. `parseIni` decodes UTF-8, so this artist already reads back as
    // a replacement character everywhere in Encore; what must not happen is a decode-and-re-encode
    // of the whole file turning its byte into one.
    const latin1 = new Uint8Array(
      Buffer.concat([
        Buffer.from('[song]\nartist = Mot'),
        Buffer.from([0xf6]),
        Buffer.from('rhead\nalbum = old\n')
      ])
    )

    const after = setSongIniKey(latin1, 'album', 'Ace of Spädes')

    expect(Buffer.from(after.bytes)).toEqual(
      Buffer.concat([
        Buffer.from('[song]\nartist = Mot'),
        Buffer.from([0xf6]),
        Buffer.from('rhead\nalbum = Ace of Spädes\n')
      ])
    )
  })

  it('refuses a value carrying a line break', () => {
    // An ini value ends at the newline, so the remainder would become a line of its own: a
    // `badIniLine`, or worse, a key nobody set.
    expect(() => setSongIniKey(bytes('[song]\nalbum = old\n'), 'album', 'a\nname = evil')).toThrow(
      /line break/
    )
    expect(() => setSongIniKey(bytes('[song]\nalbum = old\n'), 'album', 'a\rb')).toThrow(
      /line break/
    )
  })

  it('refuses a UTF-16 file rather than writing a key Clone Hero would never read', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('[song]\nalbum = X\n', 'utf16le')
    ])

    expect(() => setSongIniKey(new Uint8Array(utf16), 'album', 'Y')).toThrow(/UTF-16/)
  })

  it.each([...HASHED_INI_KEYS])('refuses to set %s', (key) => {
    expect(() => setSongIniKey(bytes(`[song]\n${key} = 1\n`), key, '2')).toThrow(
      /matches charts between players/
    )
  })
})
