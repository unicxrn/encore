import { SCORES_EXT_VERSION, SCORE_DATA_VERSION } from '../../src/main/play/scoredata'

/**
 * Shared rather than copied into each test file, because the encoders here are the layout written
 * down a second time. Two copies would drift, and a drifted encoder makes a parser test pass
 * against bytes the game never writes.
 */

/**
 * Fixtures are BUILT from the decoded layout, never copied from a real install.
 *
 * Two reasons, and the second is the one that matters. A copied file is somebody's play history,
 * which is not test data. And a fixture built field by field fails loudly the day the layout
 * constants move, where a copied blob would keep passing while meaning something else.
 *
 * The numbers below are real ones the parser was verified against, retyped: the Skrting On The
 * Surface row is the one Encore's own `plays` table recorded through `scorestats.json`, where the
 * game reported 40122 with a clean play bonus of 22 and `scoredata.bin` stored 40100.
 */

/** One `scoredata.bin` score row, as the fields the layout defines. */
export interface RowSpec {
  variant: number
  difficulty: number
  percent: number
  isFullCombo: boolean
  playbackSpeed: number
  stars: number
  variantFlag: number
  /** What `scoredata.bin` stores: the reported score less the clean play bonus. */
  score: number
  /** What `scoresext.bin` stores: the score the game reports. */
  reportedScore: number
}

export interface ChartSpec {
  checksum: string
  playCount: number
  rows: RowSpec[]
}

function checksumBytes(checksum: string): number[] {
  const out: number[] = []
  for (let i = 0; i < 32; i += 2) out.push(Number.parseInt(checksum.slice(i, i + 2), 16))
  return out
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff]
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

/** `scoredata.bin` for the given charts, version tag and count overridable to build bad files. */
export function buildScoreData(
  charts: ChartSpec[],
  options: { version?: number; count?: number } = {}
): Uint8Array {
  const bytes: number[] = [
    ...u32(options.version ?? SCORE_DATA_VERSION),
    ...u32(options.count ?? charts.length)
  ]
  for (const chart of charts) {
    bytes.push(...checksumBytes(chart.checksum))
    bytes.push(chart.rows.length)
    bytes.push(
      chart.playCount & 0xff,
      (chart.playCount >> 8) & 0xff,
      (chart.playCount >> 16) & 0xff
    )
    for (const row of chart.rows) {
      bytes.push(...u16(row.variant))
      bytes.push(row.difficulty)
      bytes.push(row.percent)
      bytes.push(row.isFullCombo ? 1 : 0)
      bytes.push(...u16(row.playbackSpeed))
      bytes.push(row.stars)
      bytes.push(...u32(row.variantFlag))
      bytes.push(...u32(row.score))
    }
  }
  return Uint8Array.from(bytes)
}

/** `scoresext.bin` for the same charts. */
export function buildScoresExt(
  charts: ChartSpec[],
  options: { version?: number; count?: number } = {}
): Uint8Array {
  const bytes: number[] = [
    ...u32(options.version ?? SCORES_EXT_VERSION),
    ...u32(options.count ?? charts.length)
  ]
  for (const chart of charts) {
    bytes.push(...checksumBytes(chart.checksum))
    bytes.push(chart.rows.length)
    for (const row of chart.rows) {
      bytes.push(...u16(row.variant))
      bytes.push(row.isFullCombo ? 1 : 0)
      bytes.push(...u32(row.reportedScore))
      bytes.push(...u32(0))
    }
  }
  return Uint8Array.from(bytes)
}
