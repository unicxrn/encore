import { describe, expect, it } from 'vitest'
import { issueSummary, issueTitle } from './issue-summary'
import type { ChartData } from './api/enchor'

const LINUX = 'linux'

function chart(over: Partial<ChartData> = {}): ChartData {
  return {
    chartId: 1,
    songId: null,
    md5: 'm',
    albumArtMd5: null,
    hasVideoBackground: false,
    name: 'Song',
    artist: 'Artist',
    album: '',
    genre: '',
    year: '',
    charter: 'Charter',
    song_length: 1000,
    diff_guitar: null,
    diff_bass: null,
    diff_drums: null,
    diff_keys: null,
    diff_vocals: null,
    ...over
  }
}

describe('issueSummary', () => {
  it('calls a chart with no issue arrays clean', () => {
    // 60 of the 100 charts sampled from api.enchor.us on 2026-09-15 are in this state, so it
    // is the common case and not the edge one.
    expect(issueSummary(chart(), LINUX).worst).toBeNull()
    expect(issueTitle(issueSummary(chart(), LINUX))).toBeNull()
  })

  it('counts a missing audio file as breakage', () => {
    const summary = issueSummary(
      chart({
        folderIssues: [{ folderIssue: 'noAudio', description: 'This chart has no audio file.' }]
      }),
      LINUX
    )
    expect(summary).toMatchObject({ blocking: 1, quality: 0, worst: 'blocking' })
    expect(summary.labels).toContain('No audio')
  })

  it('counts wrongly sized album art as a charting note, not breakage', () => {
    // The single most common finding in the sample: 40 charts in 100 carry albumArtSize and
    // nothing else. A row that called those broken would call 40% of Chorus broken.
    const summary = issueSummary(
      chart({
        folderIssues: [{ folderIssue: 'albumArtSize', description: 'Album art is 1000x1000.' }]
      }),
      LINUX
    )
    expect(summary).toMatchObject({ blocking: 0, quality: 1, worst: 'quality' })
  })

  it('reads the three arrays together and lets breakage outrank craft', () => {
    const summary = issueSummary(
      chart({
        folderIssues: [{ folderIssue: 'albumArtSize', description: 'Album art is 1000x1000.' }],
        metadataIssues: [
          {
            metadataIssue: 'missingValue',
            description: 'Metadata is missing the "artist" property.'
          }
        ],
        notesData: {
          chartIssues: [
            {
              instrument: 'guitar',
              difficulty: 'expert',
              noteIssue: 'babySustain',
              description: 'x'
            }
          ]
        }
      }),
      LINUX
    )
    expect(summary).toMatchObject({ blocking: 1, quality: 2, worst: 'blocking' })
  })

  it('separates the two things scan-chart reports under one missingValue code', () => {
    // An absent artist is breakage; an unset difficulty rating is cosmetic. Only the
    // description tells them apart, and issueSummary has to pass it through for that to work.
    const rating = issueSummary(
      chart({
        metadataIssues: [
          {
            metadataIssue: 'missingValue',
            description: 'Metadata is missing a "diff_guitar" value.'
          }
        ]
      }),
      LINUX
    )
    expect(rating.worst).toBe('quality')
  })

  it('folds a portability finding in with the craft notes rather than calling it broken', () => {
    // badVideo on Windows is scan-chart saying "this will not play on Linux". The chart the
    // user is looking at plays where they are, so the row must not mark it broken.
    const windows = issueSummary(
      chart({ folderIssues: [{ folderIssue: 'badVideo', description: 'video.mp4' }] }),
      'win32'
    )
    expect(windows).toMatchObject({ blocking: 0, quality: 1, worst: 'quality' })
    // On Linux the same finding is a real fault, and the platform is what decides.
    expect(
      issueSummary(chart({ folderIssues: [{ folderIssue: 'badVideo', description: 'v' }] }), LINUX)
        .worst
    ).toBe('blocking')
  })

  it('names distinct problems once each rather than once per row', () => {
    const summary = issueSummary(
      chart({
        notesData: {
          chartIssues: Array.from({ length: 50 }, () => ({
            noteIssue: 'babySustain',
            description: 'The sustain on this note is too short.'
          }))
        }
      }),
      LINUX
    )
    expect(summary.quality).toBe(50)
    expect(summary.labels).toHaveLength(1)
  })
})

describe('issueTitle', () => {
  it('says the chart plays when nothing found is breakage', () => {
    const title = issueTitle(
      issueSummary(
        chart({ folderIssues: [{ folderIssue: 'albumArtSize', description: 'x' }] }),
        LINUX
      )
    )
    expect(title).toContain('The chart plays.')
  })

  it('does not say that when something is broken', () => {
    const title = issueTitle(
      issueSummary(chart({ folderIssues: [{ folderIssue: 'noChart', description: 'x' }] }), LINUX)
    )
    expect(title).not.toContain('The chart plays.')
    expect(title).toContain('1 problem')
  })
})
