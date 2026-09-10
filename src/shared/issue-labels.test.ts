import { describe, expect, it } from 'vitest'
import { explainIssue, humanizeCode, ISSUE_GROUPS } from './issue-labels'

// Copied from scan-chart's FolderIssueType / MetadataIssueType / ChartIssueType unions
// (node_modules/scan-chart/dist/index.d.ts). Completeness is enforced at COMPILE time by
// the Record key type in issue-labels.ts: a library upgrade adding a code fails typecheck.
// These runtime lists are the belt to that braces: they assert every known code resolves to
// a real explanation (non-empty label/meaning, valid group), which types alone can't check.
const FOLDER_ISSUES = [
  'noMetadata',
  'invalidIni',
  'invalidMetadata',
  'badIniLine',
  'multipleIniFiles',
  'noAlbumArt',
  'albumArtSize',
  'badAlbumArt',
  'multipleAlbumArt',
  'noAudio',
  'invalidAudio',
  'badAudio',
  'multipleAudio',
  'noChart',
  'invalidChart',
  'badChart',
  'multipleChart',
  'badVideo',
  'multipleVideo'
]
const METADATA_ISSUES = ['missingValue', 'invalidValue', 'extraValue']
const CHART_ISSUES = [
  'misalignedTimeSignature',
  'noNotes',
  'noExpert',
  'difficultyNotReduced',
  'isDefaultBPM',
  'noSections',
  'badEndEvent',
  'smallLeadingSilence',
  'noStarPower',
  'emptyStarPower',
  'badStarPower',
  'emptySoloSection',
  'noDrumActivationLanes',
  'emptyFlexLane',
  'difficultyForbiddenNote',
  'invalidChord',
  'brokenNote',
  'badSustainGap',
  'babySustain'
]
// Synthesized by scanIssues() when a chart cannot be parsed at all.
const ENCORE_ISSUES = ['scanFailed']

const ALL_CODES = [...FOLDER_ISSUES, ...METADATA_ISSUES, ...CHART_ISSUES, ...ENCORE_ISSUES]
const GROUP_IDS = ISSUE_GROUPS.map((g) => g.id)

describe('explainIssue', () => {
  it.each(ALL_CODES)('explains %s without falling back to the raw code', (code) => {
    const { label, meaning, group, severity } = explainIssue(code)
    expect(label).not.toBe(code)
    expect(label.length).toBeGreaterThan(0)
    expect(meaning.length).toBeGreaterThan(0)
    expect(GROUP_IDS).toContain(group)
    expect(['blocking', 'quality']).toContain(severity)
  })

  it('treats an unrecognized code as blocking rather than hiding it', () => {
    // Quality notes are hidden by default, so an unknown code must never default into
    // that bucket; otherwise a scan-chart upgrade would silently stop reporting something.
    expect(explainIssue('someBrandNewIssue').severity).toBe('blocking')
  })

  it('classifies the charting-craft checks as quality, not breakage', () => {
    expect(explainIssue('badSustainGap').severity).toBe('quality')
    expect(explainIssue('difficultyForbiddenNote').severity).toBe('quality')
    expect(explainIssue('noAudio').severity).toBe('blocking')
    expect(explainIssue('noChart').severity).toBe('blocking')
  })

  it('does not treat conversion leftovers as breakage', () => {
    // extraValue only ever means "song.ini rates an instrument this chart doesn't have".
    // It is the single most common finding on Rock Band conversions and nothing is wrong.
    expect(explainIssue('extraValue').severity).toBe('quality')
  })

  describe('missingValue, which scan-chart overloads', () => {
    // Both flavours are hardcoded templates in scan-chart; these strings are copied from
    // ini-scanner.ts:214 and index.ts:49 so a wording change upstream shows up here.
    it('grades an unset difficulty rating as cosmetic', () => {
      expect(
        explainIssue('missingValue', 'Metadata is missing a "diff_guitar" value.').severity
      ).toBe('quality')
      expect(
        explainIssue('missingValue', 'Metadata is missing a "diff_vocals" value.').severity
      ).toBe('quality')
    })
    it('grades an absent song property as blocking', () => {
      for (const prop of ['name', 'artist', 'album', 'genre', 'year', 'charter']) {
        expect(
          explainIssue('missingValue', `Metadata is missing the "${prop}" property.`).severity
        ).toBe('blocking')
      }
    })
    it('stays blocking when no description is available', () => {
      // The safer default: over-reporting is recoverable, silently hiding breakage is not.
      expect(explainIssue('missingValue').severity).toBe('blocking')
    })
    it('does not let the description downgrade any other code', () => {
      expect(explainIssue('noAudio', 'Metadata is missing a "diff_guitar" value.').severity).toBe(
        'blocking'
      )
    })
    it('says whose job an unset rating is, since it is the one large group with no fix', () => {
      const rating = explainIssue('missingValue', 'Metadata is missing a "diff_guitar" value.')
      expect(rating.meaning).toMatch(/person who charted it/)
      // The other flavour keeps the generic wording; the two are different problems.
      expect(
        explainIssue('missingValue', 'Metadata is missing the "album" property.').meaning
      ).not.toMatch(/person who charted it/)
    })
  })

  it('keeps star power that Clone Hero will ignore in the default view', () => {
    // The chart plays, but a whole scoring mechanic is dead and the cause is a one-line
    // song.ini fix. That is breakage, not a charting opinion.
    expect(explainIssue('badStarPower').severity).toBe('blocking')
  })

  it('falls back to a humanized label for an unknown code', () => {
    const explained = explainIssue('someBrandNewIssue')
    expect(explained.label).toBe('Some brand new issue')
    expect(explained.group).toBe('other')
  })

  it('never places an issue in a group the view cannot render', () => {
    for (const code of ALL_CODES) expect(GROUP_IDS).toContain(explainIssue(code).group)
  })
})

describe('humanizeCode', () => {
  it('splits camelCase into a sentence', () => {
    expect(humanizeCode('noAlbumArt')).toBe('No album art')
  })
  it('handles acronym runs', () => {
    expect(humanizeCode('isDefaultBPM')).toBe('Is default bpm')
  })
})
