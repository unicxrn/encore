import { describe, expect, it } from 'vitest'
import {
  SCORES_EXT_VERSION,
  SCORE_DATA_VERSION,
  mergeScoreFiles,
  parseScoreData,
  parseScoresExt,
  scoreDataDifficultyName
} from './scoredata'
// The encoders live in test/helpers because the import tests need the same bytes. Fixtures are
// BUILT from the decoded layout and never copied from a real install; see the helper for why.
import { buildScoreData, buildScoresExt, type ChartSpec } from '../../../test/helpers/score-files'

const SKRTING: ChartSpec = {
  checksum: 'e54e9a0521444e81bd1fed4f3f3a3201',
  playCount: 2,
  rows: [
    {
      variant: 0,
      difficulty: 3,
      percent: 51,
      isFullCombo: false,
      playbackSpeed: 100,
      stars: 2,
      variantFlag: 1,
      score: 40100,
      reportedScore: 40122
    }
  ]
}

/** A chart with both classes of row, which is how a chart with two rows looked in the sample. */
const TWO_ROW: ChartSpec = {
  checksum: '5c8056b089373b38fc272824180be26c',
  playCount: 2,
  rows: [
    {
      variant: 8,
      difficulty: 1,
      percent: 98,
      isFullCombo: false,
      playbackSpeed: 100,
      stars: 6,
      variantFlag: 0,
      score: 281436,
      reportedScore: 282914
    },
    {
      variant: 0,
      difficulty: 2,
      percent: 73,
      isFullCombo: false,
      playbackSpeed: 100,
      stars: 3,
      variantFlag: 1,
      score: 66456,
      reportedScore: 66648
    }
  ]
}

/** The only shape of row that carried a set full combo flag: 100 percent and the gold star. */
const FULL_COMBO: ChartSpec = {
  checksum: '15ac8f4c9cf2415a71bd607020178c4c',
  playCount: 1,
  rows: [
    {
      variant: 0,
      difficulty: 3,
      percent: 100,
      isFullCombo: true,
      playbackSpeed: 100,
      stars: 6,
      variantFlag: 1,
      score: 106473,
      reportedScore: 106767
    }
  ]
}

describe('parseScoreData', () => {
  it('reads every field of a well formed file', () => {
    const parsed = parseScoreData(buildScoreData([SKRTING, TWO_ROW, FULL_COMBO]))
    expect(parsed).not.toBeNull()
    expect(parsed?.version).toBe(SCORE_DATA_VERSION)
    expect(parsed?.charts).toHaveLength(3)
    expect(parsed?.charts[0]).toEqual({
      checksum: 'e54e9a0521444e81bd1fed4f3f3a3201',
      playCount: 2,
      rows: [
        {
          variant: 0,
          difficulty: 3,
          percent: 51,
          isFullCombo: false,
          playbackSpeed: 100,
          stars: 2,
          variantFlag: 1,
          score: 40100
        }
      ]
    })
    // The variable length part: a two row chart has to consume 16 more bytes than a one row one,
    // and the chart after it has to still land on its checksum.
    expect(parsed?.charts[1].rows.map((row) => row.variant)).toEqual([8, 0])
    expect(parsed?.charts[1].rows[0].score).toBe(281436)
    expect(parsed?.charts[2].checksum).toBe('15ac8f4c9cf2415a71bd607020178c4c')
    expect(parsed?.charts[2].rows[0].isFullCombo).toBe(true)
  })

  it('reads a play count above a single byte', () => {
    // The count is 24 bits, and the byte after it starts the first score row. Read as one byte it
    // would truncate; read as 32 it would swallow the row's first field.
    const busy: ChartSpec = { ...SKRTING, playCount: 70_000 }
    const parsed = parseScoreData(buildScoreData([busy]))
    expect(parsed?.charts[0].playCount).toBe(70_000)
    expect(parsed?.charts[0].rows[0].variant).toBe(0)
  })

  it('accepts a file with no charts in it', () => {
    // A fresh install that has never finished a song. Eight bytes of header, nothing after, and
    // nothing wrong: an empty table is not a broken file.
    const parsed = parseScoreData(buildScoreData([]))
    expect(parsed).toEqual({ version: SCORE_DATA_VERSION, charts: [] })
  })

  it('refuses an unknown version tag', () => {
    expect(
      parseScoreData(buildScoreData([SKRTING], { version: SCORE_DATA_VERSION + 1 }))
    ).toBeNull()
    // Including the other file's tag, which is the mix up most likely to actually happen.
    expect(parseScoreData(buildScoreData([SKRTING], { version: SCORES_EXT_VERSION }))).toBeNull()
  })

  it('refuses a count that claims more charts than the bytes hold', () => {
    expect(parseScoreData(buildScoreData([SKRTING], { count: 2 }))).toBeNull()
    // Including a count no file could satisfy, which the walk refuses on its first record.
    expect(parseScoreData(buildScoreData([SKRTING], { count: 0xffffffff }))).toBeNull()
  })

  it('refuses a count that leaves bytes it cannot explain', () => {
    // Two charts of bytes, one chart declared. The first chart decodes perfectly and the second
    // chart's bytes are left over, which is exactly the case where a guess would look right.
    expect(parseScoreData(buildScoreData([SKRTING, TWO_ROW], { count: 1 }))).toBeNull()
  })

  it('refuses a truncated file', () => {
    const whole = buildScoreData([SKRTING, TWO_ROW])
    // Cut inside the second chart's score rows, inside its header, and inside the file header.
    expect(parseScoreData(whole.slice(0, whole.byteLength - 1))).toBeNull()
    expect(parseScoreData(whole.slice(0, 8 + 36 + 10))).toBeNull()
    expect(parseScoreData(whole.slice(0, 7))).toBeNull()
    expect(parseScoreData(new Uint8Array(0))).toBeNull()
  })

  it('reads a file that does not start at offset zero of its buffer', () => {
    // Whatever the caller reads with may hand over a view into a larger pool. Reading through
    // byteOffset rather than through the raw buffer is what makes that safe, and a DataView built
    // on the buffer alone would decode the padding as the header.
    const whole = buildScoreData([SKRTING])
    const padded = new Uint8Array(whole.byteLength + 9)
    padded.set(whole, 5)
    const view = padded.subarray(5, 5 + whole.byteLength)
    expect(parseScoreData(view)?.charts[0].checksum).toBe('e54e9a0521444e81bd1fed4f3f3a3201')
    expect(parseScoreData(view)?.charts[0].rows[0].score).toBe(40100)
  })
})

describe('parseScoresExt', () => {
  it('reads every field of a well formed file', () => {
    const parsed = parseScoresExt(buildScoresExt([SKRTING, TWO_ROW]))
    expect(parsed?.version).toBe(SCORES_EXT_VERSION)
    expect(parsed?.charts[0]).toEqual({
      checksum: 'e54e9a0521444e81bd1fed4f3f3a3201',
      rows: [{ variant: 0, isFullCombo: false, score: 40122, trailing: 0 }]
    })
    expect(parsed?.charts[1].rows.map((row) => row.score)).toEqual([282914, 66648])
  })

  it('accepts a file with no charts in it', () => {
    expect(parseScoresExt(buildScoresExt([]))).toEqual({ version: SCORES_EXT_VERSION, charts: [] })
  })

  it('refuses an unknown version tag', () => {
    expect(parseScoresExt(buildScoresExt([SKRTING], { version: SCORE_DATA_VERSION }))).toBeNull()
  })

  it('refuses a count that disagrees with the file length', () => {
    expect(parseScoresExt(buildScoresExt([SKRTING], { count: 2 }))).toBeNull()
    expect(parseScoresExt(buildScoresExt([SKRTING, TWO_ROW], { count: 1 }))).toBeNull()
    expect(parseScoresExt(buildScoresExt([SKRTING], { count: 0xffffffff }))).toBeNull()
  })

  it('refuses a truncated file', () => {
    const whole = buildScoresExt([SKRTING, TWO_ROW])
    expect(parseScoresExt(whole.slice(0, whole.byteLength - 1))).toBeNull()
    expect(parseScoresExt(whole.slice(0, 7))).toBeNull()
  })
})

describe('mergeScoreFiles', () => {
  const charts = [SKRTING, TWO_ROW, FULL_COMBO]

  function merge(
    data = buildScoreData(charts),
    ext = buildScoresExt(charts)
  ): ReturnType<typeof mergeScoreFiles> {
    const parsedData = parseScoreData(data)
    const parsedExt = parseScoresExt(ext)
    expect(parsedData).not.toBeNull()
    expect(parsedExt).not.toBeNull()
    return mergeScoreFiles(parsedData!, parsedExt!)
  }

  it('takes the reported score from scoresext and keeps the scoredata one beside it', () => {
    const merged = merge()
    expect(merged).not.toBeNull()
    expect(merged?.[0]).toEqual({
      checksum: 'e54e9a0521444e81bd1fed4f3f3a3201',
      playCount: 2,
      rows: [
        {
          variant: 0,
          difficulty: 3,
          percent: 51,
          isFullCombo: false,
          playbackSpeed: 100,
          stars: 2,
          score: 40122,
          scoreWithoutCleanPlayBonus: 40100
        }
      ],
      hasOnlyConfirmedVariants: true
    })
  })

  it('pairs rows by variant rather than by position', () => {
    // Same chart, same rows, written in the other order in the second file. A positional join
    // would hand the 281436 row the 66648 score and look entirely plausible doing it.
    const flipped: ChartSpec = { ...TWO_ROW, rows: [TWO_ROW.rows[1], TWO_ROW.rows[0]] }
    const merged = merge(buildScoreData([TWO_ROW]), buildScoresExt([flipped]))
    expect(merged?.[0].rows.map((row) => row.variant)).toEqual([8, 0])
    expect(merged?.[0].rows.find((row) => row.variant === 8)?.score).toBe(282914)
    expect(merged?.[0].rows.find((row) => row.variant === 0)?.score).toBe(66648)
  })

  it('marks a chart carrying an unconfirmed variant', () => {
    const merged = merge()
    expect(merged?.[1].hasOnlyConfirmedVariants).toBe(false)
    expect(merged?.[2].hasOnlyConfirmedVariants).toBe(true)
  })

  it('refuses when the two files disagree about which charts exist', () => {
    expect(merge(buildScoreData(charts), buildScoresExt([SKRTING, TWO_ROW]))).toBeNull()
    expect(merge(buildScoreData([SKRTING, TWO_ROW]), buildScoresExt(charts))).toBeNull()
    const other: ChartSpec = { ...FULL_COMBO, checksum: '00000000000000000000000000000000' }
    expect(merge(buildScoreData(charts), buildScoresExt([SKRTING, TWO_ROW, other]))).toBeNull()
  })

  it('refuses when the rows of a chart do not pair one to one', () => {
    const oneRow: ChartSpec = { ...TWO_ROW, rows: [TWO_ROW.rows[0]] }
    expect(merge(buildScoreData([TWO_ROW]), buildScoresExt([oneRow]))).toBeNull()
    const renamed: ChartSpec = {
      ...TWO_ROW,
      rows: [{ ...TWO_ROW.rows[0], variant: 4 }, TWO_ROW.rows[1]]
    }
    expect(merge(buildScoreData([TWO_ROW]), buildScoresExt([renamed]))).toBeNull()
  })

  it('refuses when scoresext holds a row the scoredata chart does not', () => {
    // The row counts are equal in every real pair, and an extra row on the scoresext side is the
    // one mismatch every other check waves through: each scoredata row still finds a partner by
    // variant, and the surplus row would simply vanish.
    const oneRow: ChartSpec = { ...TWO_ROW, rows: [TWO_ROW.rows[0]] }
    expect(merge(buildScoreData([oneRow]), buildScoresExt([TWO_ROW]))).toBeNull()
  })

  it('refuses a file that repeats a checksum', () => {
    // Once on each side, because the two are caught by different checks. A repeat in scoresext
    // with a shorter scoredata still leaves the deduplicated map the right size, so only a check
    // made while building that map can see it.
    expect(merge(buildScoreData([SKRTING]), buildScoresExt([SKRTING, SKRTING]))).toBeNull()
    expect(merge(buildScoreData([SKRTING, SKRTING]), buildScoresExt([SKRTING, TWO_ROW]))).toBeNull()
  })
})

describe('scoreDataDifficultyName', () => {
  it('names the four difficulties and nothing else', () => {
    expect(scoreDataDifficultyName(3)).toBe('Expert')
    expect(scoreDataDifficultyName(2)).toBe('Hard')
    expect(scoreDataDifficultyName(1)).toBe('Medium')
    expect(scoreDataDifficultyName(0)).toBe('Easy')
    expect(scoreDataDifficultyName(4)).toBeNull()
    expect(scoreDataDifficultyName(-1)).toBeNull()
  })
})
