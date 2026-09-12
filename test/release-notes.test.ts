import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain .mjs script with no declarations, and it stays that way: it is a
// release tool run by hand, not something the app imports, so giving it a build step to produce
// types would be more machinery than the file itself.
import { assetSection, releaseNotes, sectionFor } from '../scripts/release-notes.mjs'
import { parseChangelog, releasedOnly } from '../src/shared/changelog'
import pkg from '../package.json'

/**
 * The join between the changelog and the GitHub release notes.
 *
 * One direction, and this file is what holds it: CHANGELOG.md is written, and the release body is
 * generated out of it by `scripts/release-notes.mjs`. The changelog has to be right first because
 * it is bundled into the build, and a release body typed into a browser afterwards could never get
 * back into a build that already exists.
 *
 * The test that matters most here is the first one. A release cut without a changelog entry is the
 * whole failure this is meant to prevent, and it fails the suite rather than being noticed after
 * the tag is pushed.
 */
const CHANGELOG = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8')

describe('CHANGELOG.md against package.json', () => {
  it('has an entry for the version about to be built', () => {
    expect(sectionFor(CHANGELOG, pkg.version)).not.toBeNull()
  })

  // `releasedOnly` here and not `parseChangelog`, because a `## [Unreleased]` heading is the
  // normal state of this file between releases: work lands under it and is renamed to a version
  // when one is cut. The pin is about the newest *release*, which is what a build ships.
  it('leads with that version, so the newest entry is the one shipping', () => {
    expect(releasedOnly(parseChangelog(CHANGELOG))[0]?.version).toBe(pkg.version)
  })
})

describe('sectionFor', () => {
  const SAMPLE = [
    '# Changelog',
    '',
    'Preamble.',
    '',
    '## [0.2.0] - 2026-10-01',
    '',
    '### Added',
    '',
    '- Second release item.',
    '',
    '## [0.1.0] - 2026-09-10',
    '',
    '### Added',
    '',
    '- First release item.',
    '',
    '[0.2.0]: https://example.invalid/v0.2.0',
    ''
  ].join('\n')

  it('returns one version body, verbatim, without the heading', () => {
    expect(sectionFor(SAMPLE, '0.2.0')).toBe('### Added\n\n- Second release item.')
  })

  it('stops at the next release rather than running to the end of the file', () => {
    expect(sectionFor(SAMPLE, '0.2.0')).not.toContain('First release item')
  })

  it('drops the link definitions from the last section', () => {
    expect(sectionFor(SAMPLE, '0.1.0')).toBe('### Added\n\n- First release item.')
  })

  it('answers null for a version nobody wrote an entry for', () => {
    expect(sectionFor(SAMPLE, '0.3.0')).toBeNull()
  })
})

describe('releaseNotes', () => {
  it('is the changelog entry followed by the download paragraph', () => {
    const notes: string = releaseNotes(CHANGELOG, '0.1.0')
    expect(notes).toContain(sectionFor(CHANGELOG, '0.1.0'))
    expect(notes).toContain('## Which file to download')
  })

  it('names the assets electron-builder actually produces for that version', () => {
    const notes: string = assetSection('0.1.0')
    for (const asset of [
      'encore-0.1.0-setup.exe',
      'encore-0.1.0.AppImage',
      'encore_0.1.0_amd64.deb',
      'encore_0.1.0_amd64.snap'
    ]) {
      expect(notes).toContain(asset)
    }
  })

  it('refuses a version the changelog does not describe', () => {
    expect(releaseNotes(CHANGELOG, '99.0.0')).toBeNull()
  })

  it('keeps the copy rules the rest of the app is held to', () => {
    expect(assetSection('1.2.3')).not.toMatch(/[—–‘’“”]/)
  })
})
