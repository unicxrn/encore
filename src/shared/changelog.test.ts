import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseChangelog,
  parseSpans,
  releaseFor,
  whatsNewOnLaunch,
  type ChangelogItem
} from './changelog'

/** The real file, read the way a test may and the app may not: the app imports it as text. */
const CHANGELOG = readFileSync(
  fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url)),
  'utf8'
)

/** An item's visible text, which is what most assertions here are actually about. */
const text = (item: ChangelogItem): string => item.map((span) => span.text).join('')

describe('parseSpans', () => {
  it('leaves a line with no backticks as one plain span', () => {
    expect(parseSpans('Scans the library.')).toEqual([{ text: 'Scans the library.', code: false }])
  })

  it('splits a backtick pair out of the surrounding text', () => {
    expect(parseSpans('Removes the `song.ini` files.')).toEqual([
      { text: 'Removes the ', code: false },
      { text: 'song.ini', code: true },
      { text: ' files.', code: false }
    ])
  })

  it('handles several pairs, and a line that is nothing but code', () => {
    expect(parseSpans('`a` and `b`').filter((s) => s.code)).toEqual([
      { text: 'a', code: true },
      { text: 'b', code: true }
    ])
    expect(parseSpans('`snap refresh encore`')).toEqual([
      { text: 'snap refresh encore', code: true }
    ])
  })

  it('leaves an unclosed backtick as text rather than swallowing the line', () => {
    expect(parseSpans('a `b c')).toEqual([{ text: 'a `b c', code: false }])
  })
})

describe('parseChangelog', () => {
  const SAMPLE = [
    '# Changelog',
    '',
    'A preamble that is not part of any release.',
    '',
    '## [0.2.0] - 2026-10-01',
    '',
    'A lead paragraph, wrapped',
    'across two lines in the file.',
    '',
    '### Added',
    '',
    '- A short item.',
    '- A long item that prettier wrapped, so the rest of it',
    '  sits on the next line, indented.',
    '',
    '### Fixed',
    '',
    '- Something in `song.ini`.',
    '',
    '## [0.1.0] - 2026-09-10',
    '',
    '### Added',
    '',
    '- The first release.',
    '',
    '[0.2.0]: https://example.invalid/v0.2.0',
    '[0.1.0]: https://example.invalid/v0.1.0',
    ''
  ].join('\n')

  const releases = parseChangelog(SAMPLE)

  it('reads every release, newest first, with its version and date', () => {
    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ['0.2.0', '2026-10-01'],
      ['0.1.0', '2026-09-10']
    ])
  })

  it('skips the preamble above the first release heading', () => {
    const everything = releases.flatMap((r) => r.sections.flatMap((s) => s.items.map(text)))
    expect(everything.join(' ')).not.toContain('not part of any release')
  })

  it('puts a lead paragraph in an untitled section and joins its wrapped lines', () => {
    const lead = releases[0].sections[0]
    expect(lead.title).toBeNull()
    expect(lead.items.map(text)).toEqual([
      'A lead paragraph, wrapped across two lines in the file.'
    ])
  })

  it('groups bullets under their section heading', () => {
    expect(releases[0].sections.map((s) => s.title)).toEqual([null, 'Added', 'Fixed'])
    expect(releases[0].sections[1].items.map(text)).toEqual([
      'A short item.',
      'A long item that prettier wrapped, so the rest of it sits on the next line, indented.'
    ])
  })

  it('parses backticks inside an item', () => {
    expect(releases[0].sections[2].items[0]).toEqual([
      { text: 'Something in ', code: false },
      { text: 'song.ini', code: true },
      { text: '.', code: false }
    ])
  })

  it('drops the link definitions at the foot of the file', () => {
    const everything = releases.flatMap((r) => r.sections.flatMap((s) => s.items.map(text)))
    expect(everything.join(' ')).not.toContain('example.invalid')
  })

  it('reads a heading with no date and no brackets', () => {
    expect(parseChangelog('## 9.9.9\n\n- Something.\n')[0]).toEqual({
      version: '9.9.9',
      date: null,
      sections: [{ title: null, items: [[{ text: 'Something.', code: false }]] }]
    })
  })

  it('keeps a release heading with nothing under it rather than dropping the version', () => {
    expect(parseChangelog('## [1.0.0] - 2026-01-01\n')).toEqual([
      { version: '1.0.0', date: '2026-01-01', sections: [] }
    ])
  })

  it('returns nothing for a file with no release headings', () => {
    expect(parseChangelog('# Changelog\n\nNothing released yet.\n')).toEqual([])
  })
})

describe('the real CHANGELOG.md', () => {
  const releases = parseChangelog(CHANGELOG)

  it('parses into at least one release', () => {
    expect(releases.length).toBeGreaterThan(0)
  })

  it('gives every release a semver version, a date and something to read', () => {
    for (const release of releases) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(release.sections.flatMap((s) => s.items).length).toBeGreaterThan(0)
    }
  })

  it('names no version twice', () => {
    const versions = releases.map((r) => r.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('leaves no markdown the panel cannot render', () => {
    // The panel renders backticks and plain text, and nothing else. A link or a bold run written
    // into an entry would reach the screen as its own source, so it fails here instead.
    for (const release of releases) {
      for (const section of release.sections) {
        for (const item of section.items) {
          for (const span of item) {
            if (span.code) continue
            expect(span.text).not.toMatch(/\[[^\]]*\]\(/)
            expect(span.text).not.toMatch(/\*\*/)
          }
        }
      }
    }
  })

  it('keeps the copy rules the rest of the app is held to', () => {
    // Em dash, en dash and the four curly quotes. The whole codebase was scrubbed of these, so a
    // changelog entry that reintroduced one would be the obvious regression.
    expect(CHANGELOG).not.toMatch(/[—–‘’“”]/)
  })

  it('has an entry for 0.1.0 that describes the first release', () => {
    const first = releaseFor(releases, '0.1.0')
    expect(first).not.toBeNull()
    const everything = (first?.sections ?? []).flatMap((s) => s.items.map(text)).join(' ')
    expect(everything).toContain('Chorus Encore')
    expect(everything).toContain('multiplayer')
  })
})

describe('releaseFor', () => {
  const releases = parseChangelog(
    '## [0.2.0] - 2026-10-01\n\n- b\n\n## [0.1.0] - 2026-09-10\n\n- a\n'
  )

  it('finds the entry for a version the build carries', () => {
    expect(releaseFor(releases, '0.1.0')?.date).toBe('2026-09-10')
  })

  it('answers null for a version it has never heard of, which is any later release', () => {
    expect(releaseFor(releases, '0.3.0')).toBeNull()
  })
})

describe('whatsNewOnLaunch', () => {
  const launch = (lastSeenVersion: string, tourSeen: boolean): string =>
    whatsNewOnLaunch({ currentVersion: '0.2.0', lastSeenVersion, tourSeen })

  it('shows once after an update, and not on the launch after that', () => {
    // The upgrade: 0.1.0 recorded, 0.2.0 running.
    expect(launch('0.1.0', true)).toBe('show')
    // Showing records the version (the store patches settings), so the next launch sees this.
    expect(launch('0.2.0', true)).toBe('nothing')
    // And every launch after it.
    expect(launch('0.2.0', false)).toBe('nothing')
  })

  it('stays quiet on a fresh install but writes the version down', () => {
    // Nothing recorded and the tour not yet shown: nobody has run Encore on this machine, so the
    // changelog is noise on top of the welcome. Recorded so the first real update does show it.
    expect(launch('', false)).toBe('record')
  })

  it('shows for an upgrade off a build that recorded no version', () => {
    // 0.1.0 had no lastSeenVersion field at all. The tour flag is what says this is not a fresh
    // install, and this case is the whole reason the panel exists.
    expect(launch('', true)).toBe('show')
  })

  it('shows for a downgrade, because the build in front of the user did change', () => {
    expect(launch('0.9.0', true)).toBe('show')
  })

  it('does nothing when there is no version to record', () => {
    expect(whatsNewOnLaunch({ currentVersion: '', lastSeenVersion: '0.1.0', tourSeen: true })).toBe(
      'nothing'
    )
  })
})
