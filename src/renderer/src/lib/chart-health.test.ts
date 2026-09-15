import { describe, expect, it } from 'vitest'
import { healthSummary, localHealth, remoteHealth, type HealthItem } from './chart-health'
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
