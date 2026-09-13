import { describe, expect, it } from 'vitest'
import { explainIssue, humanizeCode, ISSUE_GROUPS, videoConversionPurpose } from './issue-labels'

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

/**
 * Every explanation now names the machine reading it, because one of them, `badVideo`, means
 * different things on different ones. Linux is the platform these general assertions are written
 * for: it is the case scan-chart's own wording describes and the only one anyone here has
 * verified. `describe('badVideo across platforms')` below is where the three answers are pinned.
 */
const LINUX = 'linux'
const GROUP_IDS = ISSUE_GROUPS.map((g) => g.id)

describe('explainIssue', () => {
  it.each(ALL_CODES)('explains %s without falling back to the raw code', (code) => {
    const { label, meaning, group, severity } = explainIssue(code, undefined, LINUX)
    expect(label).not.toBe(code)
    expect(label.length).toBeGreaterThan(0)
    expect(meaning.length).toBeGreaterThan(0)
    expect(GROUP_IDS).toContain(group)
    expect(['blocking', 'quality']).toContain(severity)
  })

  it('treats an unrecognized code as blocking rather than hiding it', () => {
    // Quality notes are hidden by default, so an unknown code must never default into
    // that bucket; otherwise a scan-chart upgrade would silently stop reporting something.
    expect(explainIssue('someBrandNewIssue', undefined, LINUX).severity).toBe('blocking')
  })

  it('classifies the charting-craft checks as quality, not breakage', () => {
    expect(explainIssue('badSustainGap', undefined, LINUX).severity).toBe('quality')
    expect(explainIssue('difficultyForbiddenNote', undefined, LINUX).severity).toBe('quality')
    expect(explainIssue('noAudio', undefined, LINUX).severity).toBe('blocking')
    expect(explainIssue('noChart', undefined, LINUX).severity).toBe('blocking')
  })

  it('does not treat conversion leftovers as breakage', () => {
    // extraValue only ever means "song.ini rates an instrument this chart doesn't have".
    // It is the single most common finding on Rock Band conversions and nothing is wrong.
    expect(explainIssue('extraValue', undefined, LINUX).severity).toBe('quality')
  })

  describe('missingValue, which scan-chart overloads', () => {
    // Both flavours are hardcoded templates in scan-chart; these strings are copied from
    // ini-scanner.ts:214 and index.ts:49 so a wording change upstream shows up here.
    it('grades an unset difficulty rating as cosmetic', () => {
      expect(
        explainIssue('missingValue', 'Metadata is missing a "diff_guitar" value.', LINUX).severity
      ).toBe('quality')
      expect(
        explainIssue('missingValue', 'Metadata is missing a "diff_vocals" value.', LINUX).severity
      ).toBe('quality')
    })
    it('grades an absent song property as blocking', () => {
      for (const prop of ['name', 'artist', 'album', 'genre', 'year', 'charter']) {
        expect(
          explainIssue('missingValue', `Metadata is missing the "${prop}" property.`, LINUX)
            .severity
        ).toBe('blocking')
      }
    })
    it('stays blocking when no description is available', () => {
      // The safer default: over-reporting is recoverable, silently hiding breakage is not.
      expect(explainIssue('missingValue', undefined, LINUX).severity).toBe('blocking')
    })
    it('does not let the description downgrade any other code', () => {
      expect(
        explainIssue('noAudio', 'Metadata is missing a "diff_guitar" value.', LINUX).severity
      ).toBe('blocking')
    })
    it('says whose job an unset rating is, since it is the one large group with no fix', () => {
      const rating = explainIssue(
        'missingValue',
        'Metadata is missing a "diff_guitar" value.',
        LINUX
      )
      expect(rating.meaning).toMatch(/person who charted it/)
      // The other flavour keeps the generic wording; the two are different problems.
      expect(
        explainIssue('missingValue', 'Metadata is missing the "album" property.', LINUX).meaning
      ).not.toMatch(/person who charted it/)
    })
  })

  it('keeps star power that Clone Hero will ignore in the default view', () => {
    // The chart plays, but a whole scoring mechanic is dead and the cause is a one-line
    // song.ini fix. That is breakage, not a charting opinion.
    expect(explainIssue('badStarPower', undefined, LINUX).severity).toBe('blocking')
  })

  it('falls back to a humanized label for an unknown code', () => {
    const explained = explainIssue('someBrandNewIssue', undefined, LINUX)
    expect(explained.label).toBe('Some brand new issue')
    expect(explained.group).toBe('other')
  })

  /**
   * The one code whose answer depends on the machine reading it.
   *
   * scan-chart's own text says "will not work on Linux", and Encore used to report it the same
   * way everywhere: on Windows a user was told a chart that plays is faulty, and offered a VP8
   * re-encode to repair it. What is actually known is set out beside badVideoExplanation().
   */
  describe('badVideo across platforms', () => {
    const DESCRIPTION = '"video.mp4" will not work on Linux and should be converted to .webm.'

    it('is breakage on Linux, where the format really does not play', () => {
      const linux = explainIssue('badVideo', DESCRIPTION, 'linux')
      expect(linux.severity).toBe('blocking')
      expect(linux.group).toBe('other')
      expect(linux.meaning).toMatch(/Clone Hero on Linux cannot play this format/)
    })

    it('is not a fault on Windows, where the file plays', () => {
      const windows = explainIssue('badVideo', DESCRIPTION, 'win32')
      expect(windows.severity).toBe('portability')
      // Not 'other': a Windows user opening "Other problems" would be reading about a chart
      // that has none.
      expect(windows.group).toBe('portability')
      expect(windows.meaning).toMatch(/This video plays here/)
    })

    it('keeps the one label that is true everywhere', () => {
      // The fault claim lived in the meaning, never in the label. "Video won't play on Linux" is
      // a fact about Linux and stays readable from any machine.
      for (const platform of ['linux', 'win32', 'darwin']) {
        expect(explainIssue('badVideo', DESCRIPTION, platform).label).toBe(
          "Video won't play on Linux"
        )
      }
    })

    it('says plainly that macOS is unchecked rather than picking a side', () => {
      const mac = explainIssue('badVideo', DESCRIPTION, 'darwin')
      expect(mac.severity).toBe('portability')
      expect(mac.meaning).toMatch(/Nobody has checked what it does on this platform/)
      // Neither of the two claims it would have to make to say more than that.
      expect(mac.meaning).not.toMatch(/This video plays here/)
    })

    it('treats a platform it has never heard of the same as macOS', () => {
      // freebsd, or whatever Node reports next. An unknown platform is one nobody checked, which
      // is exactly what the macOS wording says.
      const other = explainIssue('badVideo', DESCRIPTION, 'freebsd')
      expect(other.severity).toBe('portability')
      expect(other.meaning).toBe(explainIssue('badVideo', DESCRIPTION, 'darwin').meaning)
    })

    it('changes nothing about any other code', () => {
      for (const platform of ['linux', 'win32', 'darwin']) {
        expect(explainIssue('noAudio', undefined, platform).severity).toBe('blocking')
        expect(explainIssue('badSustainGap', undefined, platform).severity).toBe('quality')
        expect(explainIssue('multipleVideo', undefined, platform).severity).toBe('blocking')
      }
    })
  })

  describe('videoConversionPurpose', () => {
    it('says nothing extra on Linux, where converting is the repair', () => {
      expect(videoConversionPurpose('linux')).toBe(null)
    })

    it('says what converting buys and what it costs on Windows', () => {
      const purpose = videoConversionPurpose('win32')
      expect(purpose).toMatch(/play on Linux/)
      expect(purpose).toMatch(/image quality/)
      // The sentence exists to stop the offer reading as an accusation.
      expect(purpose).toMatch(/Nothing is wrong with these charts/)
    })

    it('does not claim the videos play on a platform nobody checked', () => {
      const purpose = videoConversionPurpose('darwin')
      expect(purpose).toMatch(/nobody has checked/)
      expect(purpose).not.toMatch(/These play here/)
    })
  })

  it('never places an issue in a group the view cannot render', () => {
    for (const code of ALL_CODES)
      expect(GROUP_IDS).toContain(explainIssue(code, undefined, LINUX).group)
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
