import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The source was scrubbed of em dashes, en dashes and curly quotes once, and CLAUDE.md asks for
 * them to stay out of comments, strings and docs alike. Nothing checked it, and across the 0.4.0
 * branch twenty five of them came back in comments, one per author who did not know the rule.
 * A grep in a test is the cheapest thing that notices.
 *
 * Two characters are typography rather than punctuation and are allowed on their own inside a
 * string or an element: the em dash `format.ts` prints for a cell nothing measured, and the en
 * dash `diffDisplay` prints for a part that is charted and carries nobody's rating. They mean
 * different things, which is why there are two of them.
 */
const BANNED = /[—–‘’“”]/
const SOURCE = new Set(['.ts', '.svelte', '.css', '.js', '.mjs'])
const SKIP = new Set(['node_modules', 'out', 'dist', '.build-tmp', '.git'])

/** The character alone in a quoted string, a JSX-ish expression, or an element's whole body. */
const PLACEHOLDER = /(['"`>]\s*[—–]\s*['"`<]|^[—–]$)/
/** A character class that names the banned characters is how a test like this one spells them. */
const NAMES_THEM = /\[[—–‘’“”\\u]/

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, found)
    else if (SOURCE.has(path.slice(path.lastIndexOf('.')))) found.push(path)
  }
  return found
}

describe('the punctuation this codebase strips', () => {
  it('appears nowhere in src, outside the two placeholders', () => {
    const offences: string[] = []
    for (const file of sourceFiles('src')) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!BANNED.test(line)) return
        const text = line.trim()
        if (PLACEHOLDER.test(text) || NAMES_THEM.test(line)) return
        offences.push(`${file}:${i + 1} ${text.slice(0, 80)}`)
      })
    }
    expect(offences).toEqual([])
  })

  it('can tell a real one from the placeholders it allows', () => {
    // Spelled by code point so this file does not contain the characters it is banning, which
    // would either fail the sweep above or force an exemption a violation could then hide in.
    const em = String.fromCharCode(0x2014)
    expect(BANNED.test(`two things ${em} and a third`)).toBe(true)
    expect(PLACEHOLDER.test(`return '${em}'`)).toBe(true)
    expect(PLACEHOLDER.test(`<span>${em}</span>`)).toBe(true)
    expect(PLACEHOLDER.test(`a sentence ${em} with an aside`)).toBe(false)
  })
})
