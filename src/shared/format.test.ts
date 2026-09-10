import { describe, expect, it } from 'vitest'
import { msToTime, diffDisplay, formatBytes, instrumentDiff, fallbackChartName } from './format'

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

describe('instrumentDiff', () => {
  it('shows the rating when the instrument is charted', () => {
    expect(instrumentDiff(['guitar'], 'guitar', 4)).toBe('4')
  })
  it('shows a dash when charted but unrated', () => {
    expect(instrumentDiff(['guitar'], 'guitar', null)).toBe('–')
    // song.ini's -1 sentinel is still "charted but unrated", not "absent".
    expect(instrumentDiff(['guitar'], 'guitar', -1)).toBe('–')
  })
  it('shows nothing when the instrument is not charted at all', () => {
    // "no bass track" and "bass with no rating" are different facts and must not look alike.
    expect(instrumentDiff(['guitar'], 'bass', null)).toBe('')
    // A stale rating for a track the chart does not contain is still absent: the note data
    // wins over song.ini, which charters routinely copy between projects without editing.
    expect(instrumentDiff(['guitar'], 'bass', 4)).toBe('')
  })
  it('falls back to the rating when instruments are unknown', () => {
    // Rows scanned before instruments were stored have an empty list, which is not the same
    // as "this chart has no instruments". Show what we have rather than blanking the row.
    expect(instrumentDiff([], 'guitar', 4)).toBe('4')
    expect(instrumentDiff([], 'bass', null)).toBe('–')
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
