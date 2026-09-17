import { describe, expect, it } from 'vitest'
import {
  diffDisplay,
  fallbackChartName,
  formatBytes,
  msToTime,
  partState,
  playedOn,
  stripRichText
} from './format'

describe('msToTime', () => {
  it('formats minutes and seconds', () => {
    expect(msToTime(250_000)).toBe('4:10')
  })
  it('pads seconds', () => {
    expect(msToTime(61_000)).toBe('1:01')
  })
  it('handles null and negative as em dash', () => {
    expect(msToTime(null)).toBe('—')
    expect(msToTime(-5)).toBe('—')
  })
  it('formats hour-long songs', () => {
    expect(msToTime(3_661_000)).toBe('61:01')
  })
})

describe('diffDisplay', () => {
  it('shows the tier number', () => {
    expect(diffDisplay(4)).toBe('4')
    expect(diffDisplay(0)).toBe('0')
  })
  it('shows an en dash for missing', () => {
    expect(diffDisplay(null)).toBe('–')
    expect(diffDisplay(undefined)).toBe('–')
  })
  it("shows song.ini's -1 sentinel as unrated, never as a number", () => {
    // Real data: "Asking Alexandria - Believe" has diff_bass = -1. Shown raw it reads "B-1".
    expect(diffDisplay(-1)).toBe('–')
  })
})

describe('partState', () => {
  it('reports a rating as rated, carrying the tier', () => {
    expect(partState(['guitar'], 'guitar', 4)).toEqual({ kind: 'rated', tier: 4 })
  })
  it('reports a rating of zero as rated, not as an absent part', () => {
    // The one confusion this type exists to stop. Zero is a number song.ini wrote down; the
    // sentinel for "no such part" is -1, and treating the two alike hides a charted track.
    expect(partState(['guitar'], 'guitar', 0)).toEqual({ kind: 'rated', tier: 0 })
  })
  it("reports song.ini's -1 sentinel on a charted part as unrated", () => {
    expect(partState(['guitar'], 'guitar', -1)).toEqual({ kind: 'unrated' })
    expect(partState(['guitar'], 'guitar', null)).toEqual({ kind: 'unrated' })
  })
  it('reports a part the notes do not contain as absent', () => {
    expect(partState(['guitar'], 'bass', -1)).toEqual({ kind: 'absent' })
  })
  it('lets the note data outrank a rating for a part the chart does not contain', () => {
    // Measured on api.enchor.us 2026-09-15: six charts in a hundred rate a part their notes
    // lack. scan-chart raises `extraValue` for exactly this and calls it a conversion
    // artifact, so the notes are the answer and the rating is the stale copy.
    expect(partState(['guitar'], 'bass', 4)).toEqual({ kind: 'absent' })
  })
  it('falls back to the rating when the note data was never read', () => {
    expect(partState([], 'bass', 4)).toEqual({ kind: 'rated', tier: 4 })
    expect(partState([], 'bass', null)).toEqual({ kind: 'unrated' })
  })
  it('carries a tier past the top of the scale rather than clamping it', () => {
    // Real data, same sample: diff_guitar of 20 and several of 7 and 8. Where the scale stops
    // is a rendering decision, so it belongs to whatever draws this and not to the fact.
    expect(partState(['guitar'], 'guitar', 20)).toEqual({ kind: 'rated', tier: 20 })
  })
})

describe('fallbackChartName', () => {
  it('reduces a .sng path to its file name without the extension', () => {
    expect(fallbackChartName('/home/u/.clonehero/Songs/Coldplay - Yellow (Harmonix).sng')).toBe(
      'Coldplay - Yellow (Harmonix)'
    )
  })
  it('reduces a chart folder path to its folder name', () => {
    expect(fallbackChartName('/home/u/.clonehero/Songs/Some Pack/TDWDTG')).toBe('TDWDTG')
  })
  it('handles Windows separators', () => {
    expect(fallbackChartName('C:\\Games\\Songs\\Metallica - One (Nero).sng')).toBe(
      'Metallica - One (Nero)'
    )
  })
  it('leaves a bare name alone', () => {
    expect(fallbackChartName('TDWDTG')).toBe('TDWDTG')
  })
  it('ignores a trailing separator rather than returning nothing', () => {
    expect(fallbackChartName('/home/u/.clonehero/Songs/TDWDTG/')).toBe('TDWDTG')
  })
  it('falls back to the input when no segment survives', () => {
    // A blank row is worse than an ugly one: it looks like a broken, unclickable entry.
    expect(fallbackChartName('')).toBe('')
    expect(fallbackChartName('/')).toBe('/')
    expect(fallbackChartName('.sng')).toBe('.sng')
  })
})

describe('formatBytes', () => {
  it('keeps small counts exact', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('steps in binary units under decimal names, as a file manager does', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1_500_000)).toBe('1.4 MB')
    expect(formatBytes(159 * 1024 * 1024)).toBe('159 MB')
    expect(formatBytes(6.6 * 1024 * 1024 * 1024)).toBe('6.6 GB')
  })

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(formatBytes(9.7 * 1024 * 1024)).toBe('9.7 MB')
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB')
  })

  it('renders nonsense as a dash rather than as NaN', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('playedOn', () => {
  /**
   * The output is the host locale's, so what is pinned is the parse, not the wording. Clone Hero
   * writes seven fractional digits, which is more than the three ECMAScript spells out, and this
   * asserts that the engine takes it rather than throwing the whole value away.
   */
  it("reads Clone Hero's seven-digit ISO timestamp", () => {
    const iso = '2026-03-03T18:04:11.1234567Z'
    expect(playedOn(iso)).toBe(new Date(iso).toLocaleDateString())
    expect(playedOn(iso)).not.toBe('—')
  })

  it('shows the empty-cell dash for a missing timestamp', () => {
    expect(playedOn(null)).toBe('—')
    expect(playedOn(undefined)).toBe('—')
  })

  /** The unguarded form of this renders the literal words "Invalid Date" into the page. */
  it('shows the dash rather than "Invalid Date" for something unparsable', () => {
    expect(playedOn('not a timestamp')).toBe('—')
  })
})

describe('stripRichText', () => {
  it('reads a charter name written in Clone Hero colour tags', () => {
    // Verbatim from the owner's play history: the FireStarter charter, one tag per letter.
    const raw =
      '<b><color=#7B0000>W</color><color=#8E0000>I</color><color=#A31616>l</color>' +
      '<color=#B82A2A>I</color><color=#CC3F3F>M</color><color=#E05555>a</color>' +
      '<color=#F5A9A9>y</color><color=#FFFFFF>I</color></b>'
    expect(stripRichText(raw)).toBe('WIlIMayI')
  })

  it('reads the simpler single-tag form', () => {
    expect(stripRichText('<color=#8200f3>SirMonkfish</color>')).toBe('SirMonkfish')
  })

  it('leaves a name that only looks like markup alone', () => {
    // The reason this is an allowlist and not <[^>]*>: neither of these is a tag the game renders,
    // and dropping either would rename someone's chart with nothing on screen to say so.
    expect(stripRichText('Rock <3 Roll >')).toBe('Rock <3 Roll >')
    expect(stripRichText('<Unknown>')).toBe('<Unknown>')
  })

  it('leaves an ordinary name untouched', () => {
    expect(stripRichText('AbyssalEmmie')).toBe('AbyssalEmmie')
  })

  it('answers empty for nothing, and for a name that is only tags', () => {
    expect(stripRichText(null)).toBe('')
    expect(stripRichText(undefined)).toBe('')
    expect(stripRichText('<b></b>')).toBe('')
  })
})
