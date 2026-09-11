import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmpDir } from '../../../test/helpers/tmp'
import { readSngEntriesForScan } from '../downloads/sng-read-selective'
import { parseScoreStats } from '../play/scorestats'
import { cloneHeroChecksum, normalizeChecksum, type ChartFileEntry } from './chart-checksum'

const entry = (fileName: string, text: string): ChartFileEntry => ({
  fileName,
  data: new TextEncoder().encode(text)
})

describe('cloneHeroChecksum', () => {
  it('is the md5 of the chart file alone', () => {
    const text = '[Song]\n{\n  Name = "x"\n}\n'
    const expected = createHash('md5').update(text).digest('hex')
    expect(cloneHeroChecksum([entry('notes.chart', text)])).toBe(expected)
  })

  it('ignores every file that is not the chart', () => {
    const text = '[Song]\n{}\n'
    const only = cloneHeroChecksum([entry('notes.chart', text)])
    const surrounded = cloneHeroChecksum([
      entry('song.ini', '[song]\nname = x\n'),
      entry('notes.chart', text),
      entry('album.jpg', 'not really a jpeg'),
      entry('song.opus', 'not really an opus')
    ])
    // The point of the whole feature: adding album art to a chart must not move its identity,
    // or every play recorded before the artwork stops matching it.
    expect(surrounded).toBe(only)
  })

  it('matches the chart file case-insensitively', () => {
    const text = 'x'
    expect(cloneHeroChecksum([entry('Notes.Chart', text)])).toBe(
      cloneHeroChecksum([entry('notes.chart', text)])
    )
  })

  it('prefers notes.mid, matching the file scan-chart parses', () => {
    const mid = 'the mid'
    const chart = 'the chart'
    expect(cloneHeroChecksum([entry('notes.chart', chart), entry('notes.mid', mid)])).toBe(
      createHash('md5').update(mid).digest('hex')
    )
  })

  it('returns null rather than the md5 of nothing when no chart file has bytes', () => {
    // Both scan paths name every file but read bytes only for the ones scan-chart parses, so a
    // zero-length entry is "not read", not "empty file". Hashing it would give d41d8cd9... for
    // every such chart alike and collide them all onto one play.
    expect(cloneHeroChecksum([{ fileName: 'notes.chart', data: new Uint8Array(0) }])).toBeNull()
    expect(cloneHeroChecksum([entry('song.ini', '[song]')])).toBeNull()
    expect(cloneHeroChecksum([])).toBeNull()
  })
})

describe('normalizeChecksum', () => {
  it('lowercases the upper hex Clone Hero writes', () => {
    expect(normalizeChecksum('E54E9A0521444E81BD1FED4F3F3A3201')).toBe(
      'e54e9a0521444e81bd1fed4f3f3a3201'
    )
  })

  it('rejects anything that is not a 32-character hex digest', () => {
    expect(normalizeChecksum('')).toBeNull()
    expect(normalizeChecksum('not a checksum')).toBeNull()
    expect(normalizeChecksum('e54e9a0521444e81bd1fed4f3f3a320')).toBeNull() // 31
    expect(normalizeChecksum('e54e9a0521444e81bd1fed4f3f3a32011')).toBeNull() // 33
    expect(normalizeChecksum('g54e9a0521444e81bd1fed4f3f3a3201')).toBeNull() // not hex
    expect(normalizeChecksum(null)).toBeNull()
    expect(normalizeChecksum(12345)).toBeNull()
  })
})

/**
 * The claim this whole feature rests on, checked against a real Clone Hero install.
 *
 * Everything else here is self-consistent: it proves that `cloneHeroChecksum` computes an MD5 of
 * the chart file, which is only interesting if that is the same number Clone Hero writes into
 * scorestats.json. Nothing hermetic can establish that — a fixture whose checksum we generated
 * ourselves would agree with us by construction and say nothing about the game. So this reads
 * the owner's actual files.
 *
 * It is therefore skipped anywhere those files are absent, which is every other machine and
 * every CI run. That is a real limit and not a comfortable one: on a machine without Clone Hero,
 * a regression that broke the derivation would show up only in the hermetic tests above, which
 * cannot see it. The value is that it runs, and passes, where the evidence actually exists.
 *
 * Read-only throughout. The chart is COPIED into a scratch directory before it is hashed, and
 * nothing under ~/.clonehero is opened for writing.
 */
const CLONE_HERO = join(homedir(), '.clonehero')
const SCORE_STATS = join(CLONE_HERO, 'scorestats.json')
const SONGS = join(CLONE_HERO, 'Songs')
const hasRealInstall = existsSync(SCORE_STATS) && existsSync(SONGS)

/** The chart file's bytes for one chart on disk, by the same route the scanner reads them. */
async function chartFileBytes(
  path: string
): Promise<{ fileName: string; data: Uint8Array } | null> {
  const wanted = (name: string): boolean => {
    const lower = name.toLowerCase()
    return lower === 'notes.mid' || lower === 'notes.chart'
  }
  if (statSync(path).isDirectory()) {
    const name = readdirSync(path).find(wanted)
    return name ? { fileName: name, data: new Uint8Array(readFileSync(join(path, name))) } : null
  }
  const { entries } = await readSngEntriesForScan(path)
  const found = entries.find((e) => wanted(e.fileName) && e.data.length > 0)
  return found ?? null
}

describe.skipIf(!hasRealInstall)('the checksum Clone Hero records', () => {
  it('is the md5 of the played chart file, on the real install', async () => {
    const play = parseScoreStats(readFileSync(SCORE_STATS, 'utf8'))
    expect(play, 'the real scorestats.json should parse').not.toBeNull()
    const recorded = play!.checksum

    // Find the chart the recorded play refers to by asking every chart in the library for its
    // checksum. Deliberately not by matching song/artist/charter: those are the strings this
    // feature exists NOT to join on, and using them here would test the wrong thing.
    const candidates = readdirSync(SONGS).map((name) => join(SONGS, name))
    let matched: string | null = null
    for (const candidate of candidates) {
      const file = await chartFileBytes(candidate).catch(() => null)
      if (file === null) continue
      if (createHash('md5').update(file.data).digest('hex') === recorded) {
        matched = candidate
        break
      }
    }
    expect(
      matched,
      `no chart in ${SONGS} hashes to the recorded checksum ${recorded}; the derivation is wrong`
    ).not.toBeNull()

    // Copy it out of the library before hashing, so the assertion runs against files this test
    // owns and the library is never more than read. A folder chart is reproduced as a directory
    // holding just its chart file; a .sng is copied whole, because its chart file only exists
    // inside it and the decode is half of what is being proved.
    const scratch = tmpDir('ch-checksum')
    let copy: string
    if (statSync(matched!).isDirectory()) {
      const source = await chartFileBytes(matched!)
      copy = join(scratch, 'chart')
      mkdirSync(copy, { recursive: true })
      copyFileSync(join(matched!, source!.fileName), join(copy, source!.fileName))
    } else {
      copy = join(scratch, basename(matched!))
      copyFileSync(matched!, copy)
    }

    const file = await chartFileBytes(copy)
    expect(file).not.toBeNull()
    expect(createHash('md5').update(file!.data).digest('hex')).toBe(recorded)
    // And the same value through the production function, off the entries a scan produces.
    expect(cloneHeroChecksum([file!])).toBe(recorded)
  })
})
