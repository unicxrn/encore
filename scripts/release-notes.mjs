#!/usr/bin/env node
/**
 * Write one release's GitHub notes out of CHANGELOG.md.
 *
 *     node scripts/release-notes.mjs 0.2.0 > notes.md
 *     gh release create v0.2.0 --title "Encore 0.2.0" --notes-file notes.md dist/encore-*
 *
 * CHANGELOG.md is the source and the release notes are the copy, in that direction and not the
 * other, because the changelog is the one of the two that ships inside the app: the build bundles
 * it, so it has to be right in the repository before anything is published, and a release body
 * edited in a browser afterwards could not get back into a build that already exists.
 *
 * What the release notes carry that the changelog does not is the asset list, which is packaging
 * rather than history and is the same paragraph every time with the version substituted. It lives
 * here so the changelog stays a changelog.
 *
 * Deliberately a slice of the markdown rather than a parse of it. Whatever is written under the
 * heading is what GitHub renders, character for character, so there is no shape the changelog can
 * take that this quietly drops.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `## [0.1.0] - 2026-09-10`, with the brackets and the date both optional. */
const RELEASE_HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(\S+))?\s*$/
/** The `[0.1.0]: https://...` plumbing at the foot of the file, which is not prose. */
const LINK_DEFINITION = /^\[[^\]]+\]:\s/

/**
 * The body under one `##` heading, verbatim, with the heading and the link definitions removed.
 *
 * Returns null when the file has no entry for that version, which is the failure worth being loud
 * about: it means a release is about to be published with notes nobody wrote.
 */
export function sectionFor(markdown, version) {
  const lines = markdown.split('\n')
  const body = []
  let inside = false
  for (const line of lines) {
    const heading = RELEASE_HEADING.exec(line)
    if (heading) {
      if (inside) break
      inside = heading[1] === version
      continue
    }
    if (!inside || LINK_DEFINITION.test(line)) continue
    body.push(line)
  }
  if (!inside) return null
  return body.join('\n').trim()
}

/**
 * The download paragraph, which is about the files rather than about the changes.
 *
 * The names are electron-builder's, from the `artifactName` each target resolves to, so a rename
 * there has to be made here too. The two caveats are the ones the README gives and are true of
 * every build so far: nothing is code signed, and the Windows installer is cross-compiled.
 */
export function assetSection(version) {
  return `## Which file to download

- **Windows**: \`encore-${version}-setup.exe\`. A per-user installer, no administrator rights
  needed. It is not code signed, so SmartScreen warns once. Choose **More info**, then
  **Run anyway**.
- **Linux, most distributions**: \`encore-${version}.AppImage\`. \`chmod +x\` it and run it. It
  carries a statically linked runtime, so it does not need \`libfuse2\`.
- **Debian and Ubuntu**: \`encore_${version}_amd64.deb\`.
- **Snap**: \`encore_${version}_amd64.snap\`.

Encore can update itself from here. Settings, under Updates, says what this build can do about a
new release and never downloads or installs one on its own.`
}

/** The whole body of the GitHub release for `version`. */
export function releaseNotes(markdown, version) {
  const section = sectionFor(markdown, version)
  if (section === null) return null
  return `${section}\n\n${assetSection(version)}\n`
}

/** Where the script reads the changelog from. Exported so the suite reads the same file. */
export const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md')

// `process.argv[1]` is the script when it was run directly, and something else when it was
// imported by a test, which is what keeps the suite from writing to stdout and exiting.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: node scripts/release-notes.mjs <version>')
    process.exit(2)
  }
  const notes = releaseNotes(readFileSync(CHANGELOG_PATH, 'utf8'), version)
  if (notes === null) {
    console.error(`CHANGELOG.md has no entry for ${version}. Write one before publishing it.`)
    process.exit(1)
  }
  process.stdout.write(notes)
}
