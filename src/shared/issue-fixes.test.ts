import { describe, expect, it } from 'vitest'
import type { ChartIssueRow } from '../main/catalog/issues'
import { resolveFixAction } from '../main/issues/fix'
import { fixForRow, fixSentence, isBadVideoName, videoNameFromRow } from './issue-fixes'

/**
 * The renderer decides whether to draw a Fix button 24,151 times per report, and it cannot call
 * main's `resolveFixAction` to do it. These tests pin the two to the same answer, and pin the
 * cases where the answer is not what a reader would guess from the code alone.
 */

const row = (over: Partial<ChartIssueRow>): ChartIssueRow => ({
  chartPath: '/library/Rush - YYZ',
  kind: 'folder',
  code: 'badVideo',
  description: '"video.mp4" will not work on Linux and should be converted to .webm.',
  ...over
})

const strayIni = row({
  code: 'invalidIni',
  description: '"desktop.ini" is not named "song.ini".'
})

const multipleIni = row({
  code: 'multipleIniFiles',
  description: 'This chart has more than one .ini file.'
})

const extraValue = row({
  kind: 'metadata',
  code: 'extraValue',
  description: 'Metadata contains "diff_bass", but bass is not charted.'
})

const albumArt = row({
  code: 'albumArtSize',
  description: 'The album art is 1024x1024 instead of 512x512.'
})

describe('fixForRow', () => {
  it('repairs the four codes that have an action', () => {
    expect(fixForRow(row({}))?.actionCode).toBe('badVideo')
    expect(fixForRow(extraValue)?.actionCode).toBe('extraValue')
    expect(fixForRow(albumArt)?.actionCode).toBe('albumArtSize')
    expect(fixForRow(strayIni)?.actionCode).toBe('invalidIni')
  })

  /**
   * The trap this file exists for. `strayIniAction.code` is `'invalidIni'` and `issues:fixable`
   * therefore reports three codes for four that are repairable, so a renderer that decided
   * fixability by testing a row's code against that list would leave every `multipleIniFiles` row
   * without a button, for a fix that works on it.
   */
  it('repairs multipleIniFiles, which no reported code is named after', () => {
    expect(fixForRow(multipleIni)?.actionCode).toBe('invalidIni')
    expect(resolveFixAction(multipleIni)).not.toBe(null)
  })

  it('offers nothing for the codes that need a charter rather than a button', () => {
    // The library's three largest groups, and the one the design deliberately excluded.
    expect(
      fixForRow(row({ kind: 'chart', code: 'difficultyForbiddenNote', description: 'x' }))
    ).toBe(null)
    expect(fixForRow(row({ kind: 'chart', code: 'badSustainGap', description: 'x' }))).toBe(null)
    expect(
      fixForRow(
        row({
          kind: 'metadata',
          code: 'missingValue',
          description: 'Metadata is missing a "diff_guitar" value.'
        })
      )
    ).toBe(null)
    // multipleChart is excluded permanently, on multiplayer-safety grounds.
    expect(fixForRow(row({ kind: 'chart', code: 'multipleChart', description: 'x' }))).toBe(null)
  })

  it('offers nothing when the description is not the wording scan-chart writes', () => {
    // Both of these fixes DELETE what they parse out of the description. A row they cannot read
    // has to produce no button rather than a button that fails on click.
    expect(fixForRow({ ...extraValue, description: 'Metadata contains "diff_bass".' })).toBe(null)
    expect(fixForRow({ ...strayIni, description: 'There is a stray ini file.' })).toBe(null)
  })

  it('checks kind as well as code, since one row type carries three scan-chart arrays', () => {
    expect(fixForRow({ ...albumArt, kind: 'metadata' })).toBe(null)
    expect(fixForRow({ ...extraValue, kind: 'folder' })).toBe(null)
  })

  it('agrees with main about every row above', () => {
    for (const candidate of [row({}), extraValue, albumArt, strayIni, multipleIni]) {
      expect(resolveFixAction(candidate)).not.toBe(null)
    }
    for (const candidate of [
      { ...extraValue, description: 'Metadata contains "diff_bass".' },
      { ...strayIni, description: 'There is a stray ini file.' },
      row({ kind: 'chart', code: 'badSustainGap', description: 'x' })
    ]) {
      expect(resolveFixAction(candidate)).toBe(null)
    }
  })
})

describe('describing a fix', () => {
  it('names the exact file being written or removed', () => {
    // "Clean up duplicates" is not an acceptable confirmation for something that deletes.
    expect(fixForRow(strayIni)?.describe).toContain('desktop.ini')
    expect(fixForRow(row({}))?.describe).toContain('video.mp4')
    expect(fixForRow(extraValue)?.describe).toContain('diff_bass')
  })

  it('says what will happen when the row names no single file', () => {
    expect(fixForRow(multipleIni)?.describe).toContain(
      'Delete every .ini file except the one Clone Hero reads'
    )
  })

  it('refuses to describe a row its action does not handle', () => {
    expect(() => fixSentence(albumArt, 'badVideo')).toThrow(/does not handle/)
  })
})

describe('the video name rules, which decide what gets converted', () => {
  it('matches what scan-chart flags and nothing else', () => {
    expect(isBadVideoName('video.mp4')).toBe(true)
    expect(isBadVideoName('video.avi')).toBe(true)
    expect(isBadVideoName('video.mpeg')).toBe(true)
    // Recognised video names scan-chart does NOT complain about.
    expect(isBadVideoName('video.webm')).toBe(false)
    expect(isBadVideoName('video.ogv')).toBe(false)
  })

  it('leaves video.mp4.disabled alone', () => {
    // Three of these exist in the reference library, 2,357.5 MiB of video the user switched off
    // on purpose. A looser rule here would convert all of it.
    expect(isBadVideoName('video.mp4.disabled')).toBe(false)
    expect(
      videoNameFromRow(
        row({ description: '"video.mp4.disabled" will not work on Linux and should be converted.' })
      )
    ).toBe(null)
  })
})
