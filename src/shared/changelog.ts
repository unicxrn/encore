/**
 * The changelog: what CHANGELOG.md says, and when the app puts it in front of someone.
 *
 * Everything here is a plain type or a pure function. The file itself is read in exactly one
 * place, `renderer/src/lib/changelog.ts`, which imports it as text so the bundler inlines it into
 * the build. Nothing in this module touches the filesystem or the network, so the suite can run
 * the parser against a fixture and against the real file without either being a special case.
 *
 * Not to be confused with `shared/app-update.ts`, which is about whether a newer Encore exists.
 * This is about what is in one.
 */

/** A run of text in an item, either plain or written in `backticks`. */
export interface ChangelogSpan {
  text: string
  /** True for the inside of a backtick pair: a path, a filename, a command. */
  code: boolean
}

/** One bullet or one paragraph, already split into its plain and code runs. */
export type ChangelogItem = ChangelogSpan[]

/** A `###` group inside a release, or the text before the first one. */
export interface ChangelogSection {
  /** The heading, verbatim. Null for the paragraphs that open a release. */
  title: string | null
  items: ChangelogItem[]
}

/** One `##` release heading and everything under it. */
export interface ChangelogRelease {
  /** `0.1.0`, with no `v` and no brackets. */
  version: string
  /** The ISO date beside the heading, or null when the heading carries none. */
  date: string | null
  sections: ChangelogSection[]
}

/** `## [0.1.0] - 2026-09-10`, with the brackets and the date both optional. */
const RELEASE_HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?\s*$/
/** `### Added` */
const SECTION_HEADING = /^###\s+(.*\S)\s*$/
/** `- something` */
const BULLET = /^-\s+(.*)$/
/**
 * A link-reference definition, which is markdown plumbing rather than prose: the `[0.1.0]:` lines
 * at the foot of the file are what make the bracketed headings above link to a tag. Rendering one
 * would put a bare URL in the panel.
 */
const LINK_DEFINITION = /^\[[^\]]+\]:\s/

/**
 * Split one line into plain and code runs.
 *
 * Backticks are the only markdown the panel renders, because they are the only markdown the
 * entries need: every file name, path and command in this project is written in them, and a
 * changelog that printed them as literal backticks would read as a mistake. An unclosed backtick
 * is left as text rather than swallowing the rest of the line, so a typo costs one character
 * instead of a paragraph.
 */
export function parseSpans(line: string): ChangelogItem {
  const spans: ChangelogItem = []
  let rest = line
  while (rest.length > 0) {
    const open = rest.indexOf('`')
    if (open === -1) break
    const close = rest.indexOf('`', open + 1)
    if (close === -1) break
    if (open > 0) spans.push({ text: rest.slice(0, open), code: false })
    spans.push({ text: rest.slice(open + 1, close), code: true })
    rest = rest.slice(close + 1)
  }
  if (rest.length > 0) spans.push({ text: rest, code: false })
  return spans
}

/**
 * Read CHANGELOG.md into releases, newest first.
 *
 * Deliberately a small reader of one shape rather than a markdown parser. The shape is Keep a
 * Changelog, the file is written by hand, and `changelog.test.ts` runs this over the real file, so
 * an entry written in some other shape fails the suite instead of rendering as an empty release.
 *
 * What it understands, and nothing else: `##` release headings, `###` section headings, `-`
 * bullets with wrapped continuation lines, and paragraphs before the first section heading.
 * Anything above the first release heading is the file's own preamble and is skipped.
 */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let release: ChangelogRelease | null = null
  let section: ChangelogSection | null = null
  /** The line being accumulated: a bullet and its wrapped remainder, or a paragraph. */
  let buffer: string | null = null

  const flush = (): void => {
    if (buffer !== null && section !== null) section.items.push(parseSpans(buffer))
    buffer = null
  }
  const openSection = (title: string | null): void => {
    flush()
    section = { title, items: [] }
    release?.sections.push(section)
  }

  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\s+$/, '')

    const heading = RELEASE_HEADING.exec(line)
    if (heading) {
      flush()
      release = { version: heading[1], date: heading[2] ?? null, sections: [] }
      section = null
      releases.push(release)
      continue
    }
    if (release === null) continue

    const sectionHeading = SECTION_HEADING.exec(line)
    if (sectionHeading) {
      openSection(sectionHeading[1])
      continue
    }
    if (line.trim() === '' || LINK_DEFINITION.test(line)) {
      flush()
      continue
    }

    const bullet = BULLET.exec(line.trimStart())
    if (bullet) {
      flush()
      // A bullet before any `###` belongs to an unnamed section, so a release written as a flat
      // list still renders rather than dropping every item on the floor.
      if (section === null) openSection(null)
      buffer = bullet[1]
      continue
    }

    // Not a heading, not blank, not a bullet: either the wrapped remainder of the line above or
    // the start of a paragraph. Joined with a space, because the line breaks in the file are
    // prettier's wrapping and mean nothing on screen.
    if (buffer !== null) {
      buffer = `${buffer} ${line.trim()}`
      continue
    }
    if (section === null) openSection(null)
    buffer = line.trim()
  }
  flush()

  // A release heading with nothing under it is a stub someone is part way through writing. It is
  // kept, not dropped: the version matters on its own, and the panel says there is nothing written
  // down rather than pretending the version does not exist.
  return releases
}

/**
 * The heading Keep a Changelog puts above work that is committed but not yet cut.
 *
 * It is a real entry in the file and parses like any other, but it is not a release: it has no
 * version and no date, and no build has ever carried it. Everything that reasons about releases
 * goes through `releasedOnly` so a heading here cannot be mistaken for one, which is what the
 * release pins in `test/release-notes.test.ts` depend on.
 */
export const UNRELEASED = 'Unreleased'

/** True for the `## [Unreleased]` heading, in any casing someone writes it. */
export function isUnreleased(release: ChangelogRelease): boolean {
  return release.version.toLowerCase() === UNRELEASED.toLowerCase()
}

/**
 * The releases, with the unreleased heading dropped.
 *
 * The parser keeps that heading rather than swallowing it, because dropping it silently would mean
 * a typo in a version heading vanished from the file instead of failing a test. Filtering it here
 * puts the decision in one place.
 */
export function releasedOnly(releases: readonly ChangelogRelease[]): readonly ChangelogRelease[] {
  return releases.filter((release) => !isUnreleased(release))
}

/** The entry for one version, or null when this build's changelog has none. */
export function releaseFor(
  releases: readonly ChangelogRelease[],
  version: string
): ChangelogRelease | null {
  return releases.find((entry) => entry.version === version) ?? null
}

/**
 * What a launch should do about the changelog.
 *
 * - `show` puts the panel on screen and records the version, so it appears once.
 * - `record` writes the version down without showing anything.
 * - `nothing` leaves both alone, which is every launch after the first on a given version.
 */
export type WhatsNewOnLaunch = 'show' | 'record' | 'nothing'

export interface WhatsNewInput {
  /** `APP_VERSION`: the build running right now. */
  currentVersion: string
  /** What was written down the last time this ran. Empty when nothing ever was. */
  lastSeenVersion: string
  /**
   * Whether the welcome tour has been shown. This is what tells a fresh install apart from an
   * upgrade off a build that predates `lastSeenVersion`: both arrive with an empty last-seen, and
   * only one of them has ever run Encore before.
   */
  tourSeen: boolean
}

/**
 * Decide, once, at launch.
 *
 * The rule is "the version changed", not "the version went up". A downgrade is rare and the panel
 * is honest in it either way: what it shows is the entry for the build now running, which is what
 * changed about the copy in front of the user.
 *
 * The empty last-seen case is the one worth reading twice. A first run has enough on screen
 * already, between the welcome and the tour, and a changelog for a version the user has never run
 * anything else of says nothing they need. So a fresh install records and stays quiet, and its
 * first real update is the first time the panel appears. An upgrade from 0.1.0, which wrote no
 * last-seen at all, is told apart by the tour flag and does get the panel, which is the whole
 * point of shipping this.
 */
export function whatsNewOnLaunch({
  currentVersion,
  lastSeenVersion,
  tourSeen
}: WhatsNewInput): WhatsNewOnLaunch {
  // A build with no version to record is a test double or a broken define, not something to open
  // a panel about.
  if (currentVersion === '') return 'nothing'
  if (lastSeenVersion === currentVersion) return 'nothing'
  if (lastSeenVersion === '') return tourSeen ? 'show' : 'record'
  return 'show'
}
