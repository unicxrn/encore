import { describe, expect, it } from 'vitest'
import {
  healthPhrase,
  healthScore,
  healthSummary,
  localHealth,
  remoteHealth,
  type HealthItem
} from './chart-health'
import type { ChartData } from './api/enchor'
import type { ChartRecord } from '../../../shared/schemas'

/**
 * The distinction these exist to hold is "missing" against "unknown".
 *
 * A local chart has been read, so a false flag is a fact about the chart and the Asset Studio
 * can be sent after it. A chart on Chorus has not, so the same false would be a guess. Reading
 * "MISSING" next to a background that is sitting in the .sng is the failure this file prevents,
 * and it is the kind that no screenshot catches because the word is spelled correctly.
 */

const record = (over: Partial<ChartRecord> = {}): ChartRecord =>
  ({
    path: '/library/Rush - YYZ',
    chartType: 'folder',
    name: 'YYZ',
    artist: 'Rush',
    charter: 'someone',
    hasVideo: false,
    hasBackground: false,
    hasAlbumArt: false,
    hasLyrics: false,
    noteCounts: [],
    ...over
  }) as ChartRecord

const chart = (over: Partial<ChartData> = {}): ChartData =>
  ({
    name: 'YYZ',
    artist: 'Rush',
    charter: 'someone',
    albumArtMd5: null,
    hasVideoBackground: false,
    ...over
  }) as ChartData

const stateOf = (items: HealthItem[], key: HealthItem['key']): string =>
  items.find((item) => item.key === key)?.state ?? 'absent'

describe('chart health: a local chart', () => {
  it('reports each asset flag as present or missing, never as unknown', () => {
    const items = localHealth(
      record({ hasAlbumArt: true, hasBackground: false, hasVideo: true, hasLyrics: false })
    )
    expect(stateOf(items, 'albumArt')).toBe('present')
    expect(stateOf(items, 'background')).toBe('missing')
    expect(stateOf(items, 'video')).toBe('present')
    expect(stateOf(items, 'lyrics')).toBe('missing')
  })

  // An empty noteCounts is what every row carries until a scan fills it in (see matrix.ts), so
  // it is "not read", not "no notes". Reporting it as missing would send the user to rescan a
  // library that is fine.
  it('calls an unread note count unknown, and a read one present', () => {
    expect(stateOf(localHealth(record({ noteCounts: [] })), 'notes')).toBe('unknown')
    expect(
      stateOf(
        localHealth(
          record({ noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 1420 }] })
        ),
        'notes'
      )
    ).toBe('present')
  })

  // A populated array of zeroes IS a measurement: something looked and found nothing.
  it('calls a note count that was read and came back at zero missing', () => {
    const counts = [{ instrument: 'guitar', difficulty: 'expert', count: 0 }]
    expect(stateOf(localHealth(record({ noteCounts: counts })), 'notes')).toBe('missing')
  })
})

describe('chart health: a chart on Chorus', () => {
  it('answers for the two things the API reports and refuses to guess the other two', () => {
    const items = remoteHealth(chart({ albumArtMd5: 'a'.repeat(32), hasVideoBackground: true }))
    expect(stateOf(items, 'albumArt')).toBe('present')
    expect(stateOf(items, 'video')).toBe('present')
    expect(stateOf(items, 'background')).toBe('unknown')
    expect(stateOf(items, 'lyrics')).toBe('unknown')
  })

  it('says missing for a cover the API answered null for', () => {
    expect(stateOf(remoteHealth(chart({ albumArtMd5: null })), 'albumArt')).toBe('missing')
  })

  it('lists the same five keys a local chart does, so the rail does not change shape', () => {
    expect(remoteHealth(chart()).map((i) => i.key)).toEqual(localHealth(record()).map((i) => i.key))
  })
})

describe('the health summary', () => {
  it('counts only what was measured', () => {
    // A background and a lyrics track are never in the API's answer, and this chart has no
    // note counts in it either, so three of the five are unknown and the denominator is two.
    const items = remoteHealth(chart({ albumArtMd5: 'a'.repeat(32) }))
    expect(healthSummary(items)).toEqual({ present: 1, known: 2 })
  })

  it('is null when nothing in the list is known either way', () => {
    expect(healthSummary([{ key: 'lyrics', label: 'Lyrics', state: 'unknown' }])).toBeNull()
    expect(healthSummary([])).toBeNull()
  })

  it('counts every flag on a local chart, because every one of them was read', () => {
    const items = localHealth(
      record({
        hasAlbumArt: true,
        hasBackground: true,
        hasVideo: false,
        hasLyrics: false,
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 9 }]
      })
    )
    expect(healthSummary(items)).toEqual({ present: 3, known: 5 })
  })
})

describe('the health score the ring draws', () => {
  it('is a percentage of the checks that were looked at, not of the five items', () => {
    // Album art present, video absent, and the other three never measured: one of two known.
    const items = remoteHealth(chart({ albumArtMd5: 'a'.repeat(32) }))
    expect(healthScore(items)).toBe(50)
  })

  it('resolves to one check and no finer', () => {
    // Four of five on a local chart is 80, and the only other values a five-check chart can
    // reach are 0, 20, 40, 60 and 100. A score of 95 is not in the set, which is the point:
    // the ring must not imply a precision five booleans do not have.
    const four = localHealth(
      record({
        hasAlbumArt: true,
        hasBackground: true,
        hasVideo: true,
        hasLyrics: false,
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 9 }]
      })
    )
    expect(healthScore(four)).toBe(80)
    const all = localHealth(
      record({
        hasAlbumArt: true,
        hasBackground: true,
        hasVideo: true,
        hasLyrics: true,
        noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 9 }]
      })
    )
    expect(healthScore(all)).toBe(100)
    expect(healthScore(localHealth(record()))).toBe(0)
  })

  it('rounds a three-check chart to the nearest whole percent', () => {
    const items: HealthItem[] = [
      { key: 'albumArt', label: 'Album art', state: 'present' },
      { key: 'video', label: 'Video', state: 'present' },
      { key: 'notes', label: 'Note counts', state: 'missing' },
      { key: 'lyrics', label: 'Lyrics', state: 'unknown' }
    ]
    expect(healthScore(items)).toBe(67)
  })

  it('has no number at all when nothing was measured', () => {
    expect(healthScore([{ key: 'lyrics', label: 'Lyrics', state: 'unknown' }])).toBeNull()
    expect(healthScore([])).toBeNull()
  })
})

describe('the phrase beside each tick', () => {
  it('states what is there, what is not, and what nobody looked at', () => {
    expect(healthPhrase({ key: 'albumArt', label: 'Album art', state: 'present' })).toBe(
      'Album art'
    )
    expect(healthPhrase({ key: 'albumArt', label: 'Album art', state: 'missing' })).toBe(
      'No album art'
    )
    expect(healthPhrase({ key: 'albumArt', label: 'Album art', state: 'unknown' })).toBe(
      'Album art unknown'
    )
  })

  // The claim carries the state in words, so the colour of the glyph beside it is the second
  // signal and never the only one. A label that read the same in all three states would put
  // the whole distinction on a green tick against an amber one.
  it('never reads the same for two different states', () => {
    for (const label of ['Album art', 'Background', 'Video', 'Lyrics', 'Note counts']) {
      const said = (['present', 'missing', 'unknown'] as const).map((state) =>
        healthPhrase({ key: 'notes', label, state })
      )
      expect(new Set(said).size).toBe(3)
    }
  })
})
