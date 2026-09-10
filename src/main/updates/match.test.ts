import { describe, expect, it } from 'vitest'
import { classifyChart, type LocalChartIdentity, type RemoteChart } from './match'

const local = (over: Partial<LocalChartIdentity> = {}): LocalChartIdentity => ({
  path: '/lib/song.sng',
  name: 'The Silver Scream',
  artist: 'Ice Nine Kills',
  charter: 'Nea7x',
  chartHash: 'LOCAL_HASH',
  tempoMapHash: 'TEMPO_A',
  ...over
})

const remote = (over: Partial<RemoteChart> = {}): RemoteChart => ({
  chartId: 1,
  name: 'The Silver Scream',
  artist: 'Ice Nine Kills',
  charter: 'Nea7x',
  chartHash: 'REMOTE_HASH',
  md5: 'a'.repeat(32),
  modifiedTime: '2026-05-16T18:34:48.885Z',
  tempoMapHash: 'TEMPO_A',
  noteCount: 12374,
  hasVideoBackground: false,
  ...over
})

describe('classifyChart', () => {
  it('reports an alternate version when no upload carries the local notes', () => {
    const verdict = classifyChart(local(), [remote()])
    expect(verdict.kind).toBe('alternate')
    if (verdict.kind !== 'alternate') throw new Error('narrowing')
    expect(verdict.alternates.map((a) => a.chartId)).toEqual([1])
  })

  /**
   * The whole safety argument rests on this. An exact `chartHash` is proof that Chorus still
   * serves the user's exact notes, so there is nothing they are missing out on, and the other
   * rows under the same name are siblings. On the real 219-chart library every one of them was
   * an OLDER, smaller cut of the same song (guitar-only vs full band). Flagging those would have
   * turned four true "you are fine" answers into four wrong "update available" prompts.
   */
  it('reports current when some upload matches the local notes exactly, even alongside siblings', () => {
    const verdict = classifyChart(local(), [
      remote({ chartId: 2, chartHash: 'LOCAL_HASH', noteCount: 3490 }),
      remote({ chartId: 3, chartHash: 'OTHER', noteCount: 1204 })
    ])
    expect(verdict.kind).toBe('current')
  })

  it('ignores uploads by a different charter', () => {
    expect(classifyChart(local(), [remote({ charter: 'SomeoneElse' })]).kind).toBe('unknown')
  })

  it('ignores a different song by the same charter', () => {
    expect(classifyChart(local(), [remote({ name: 'A Different Song' })]).kind).toBe('unknown')
  })

  /**
   * A charter who charts many songs at one constant tempo shares a tempo map across all of them,
   * so this only ever narrows a name+charter bucket and never forms one. Measured on 6019 live
   * charts: charter+tempoMapHash alone spans more than one song title 2.55% of the time, worse
   * than charter+artist+name at 1.41%, which is why it corroborates rather than identifies.
   */
  it('rejects a same-named chart whose tempo map disagrees', () => {
    expect(classifyChart(local(), [remote({ tempoMapHash: 'TEMPO_B' })]).kind).toBe('unknown')
  })

  it('still matches when either side is missing a tempo map', () => {
    expect(classifyChart(local({ tempoMapHash: null }), [remote()]).kind).toBe('alternate')
    expect(classifyChart(local(), [remote({ tempoMapHash: null })]).kind).toBe('alternate')
  })

  it('compares names, artists and charters case- and whitespace-insensitively', () => {
    const verdict = classifyChart(local(), [
      remote({ name: 'the  SILVER scream ', artist: 'ICE NINE KILLS', charter: ' nea7x' })
    ])
    expect(verdict.kind).toBe('alternate')
  })

  it('is unknown when nothing shares the identity', () => {
    expect(classifyChart(local(), []).kind).toBe('unknown')
  })

  /**
   * A chart the scan could not hash cannot be told apart from a revision of itself, and guessing
   * would put a destructive-looking prompt on a chart we know nothing about.
   */
  it('is unknown when the local chart has no hash', () => {
    expect(classifyChart(local({ chartHash: null }), [remote()]).kind).toBe('unknown')
  })

  it('is unknown when the local chart has no charter or name to match on', () => {
    expect(classifyChart(local({ charter: null }), [remote()]).kind).toBe('unknown')
    expect(classifyChart(local({ name: null }), [remote()]).kind).toBe('unknown')
  })

  it('orders alternates by note count so the fullest cut is offered first', () => {
    const verdict = classifyChart(local(), [
      remote({ chartId: 7, chartHash: 'X', noteCount: 100 }),
      remote({ chartId: 8, chartHash: 'Y', noteCount: 900 })
    ])
    if (verdict.kind !== 'alternate') throw new Error('expected alternate')
    expect(verdict.alternates.map((a) => a.chartId)).toEqual([8, 7])
  })

  it('collapses mirror uploads of identical notes to one alternate', () => {
    // versionGroupId groups the same bytes reached through several Drive packs; on the live API
    // every multi-row group shared one md5 AND one chartHash. Offering the user the same chart
    // three times would be three identical download buttons.
    const verdict = classifyChart(local(), [
      remote({ chartId: 10, chartHash: 'SAME', md5: 'b'.repeat(32) }),
      remote({ chartId: 11, chartHash: 'SAME', md5: 'b'.repeat(32) })
    ])
    if (verdict.kind !== 'alternate') throw new Error('expected alternate')
    expect(verdict.alternates).toHaveLength(1)
  })
})
