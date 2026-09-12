import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Nothing in this directory may write.
 *
 * Everything here reads another program's live data: Clone Hero's score files, in a folder that
 * since the score-folder setting can be anywhere the user points Encore, including the game's own
 * install directory. Encore has no business creating a file in it, tidying a quarantined one away
 * or replacing one it could not parse, and the user has no backup of any of it.
 *
 * "We currently do not write" is a property of today's code and disappears the first time someone
 * adds a convenience. This is the guard with teeth: a module here that so much as imports a
 * writing API fails the suite, in the same run as everything else, with this comment attached.
 *
 * WHAT IT PROVES, exactly, because a guard that is believed to do more than it does is worse than
 * none. It proves that no module in this directory reaches a filesystem write through an import
 * of `node:fs`, through a call that looks like one of the write APIs, or through `require`. It
 * does NOT prove the process cannot write: a module here could call something in another
 * directory that writes, or spawn a child. Those routes are open everywhere in main and are
 * guarded by review, not by this. What is closed is the short route, which is the one anybody
 * would actually take.
 */

const DIR = new URL('.', import.meta.url).pathname

/** Reads. Anything not on this list is a write, or close enough to want a conversation. */
const READ_ONLY_FS = new Set([
  'existsSync',
  'readFileSync',
  'readdirSync',
  'readdir',
  'readFile',
  'statSync',
  'stat',
  'lstatSync',
  'realpathSync',
  'watch',
  'type FSWatcher'
])

/**
 * Call-shaped, so a comment saying "nothing here renames a file" is prose and `renameSync(` is
 * not. Covers the fs APIs that change a filesystem, by the names they are called by.
 */
const WRITE_CALLS = [
  /\bwriteFile(Sync)?\s*\(/,
  /\bappendFile(Sync)?\s*\(/,
  /\brename(Sync)?\s*\(/,
  /\bunlink(Sync)?\s*\(/,
  /\brm(Sync|dir|dirSync)?\s*\(/,
  /\bmkdir(Sync|temp|tempSync)?\s*\(/,
  /\bcopyFile(Sync)?\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\btruncate(Sync)?\s*\(/,
  /\bchmod(Sync)?\s*\(/,
  /\butimes(Sync)?\s*\(/,
  /\bcp(Sync)?\s*\(/,
  /\brequire\s*\(/
]

function sources(): { name: string; text: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }))
}

/** The named bindings of every `import ... from 'node:fs...'` in one file. */
function fsImports(text: string): { file: string; names: string[]; namespace: boolean }[] {
  const out: { file: string; names: string[]; namespace: boolean }[] = []
  const re = /import\s+([^'"]+?)\s+from\s+'(node:fs(?:\/promises)?)'/g
  for (const match of text.matchAll(re)) {
    const clause = match[1].trim()
    const braces = clause.match(/\{([^}]*)\}/)
    out.push({
      file: match[2],
      names: braces
        ? braces[1]
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean)
        : [],
      // `import * as fs` or a default import: the whole module, writes included.
      namespace: braces === null || /\*\s+as\s+/.test(clause)
    })
  }
  return out
}

describe('play modules never write', () => {
  it('has the modules this is about', () => {
    // The guard is a loop over a directory listing, and a loop over nothing passes. This is what
    // stops a rename or a move turning the whole file into a test that asserts nothing.
    const names = sources().map((s) => s.name)
    expect(names).toContain('location.ts')
    expect(names).toContain('score-watcher.ts')
    expect(names.length).toBeGreaterThan(4)
  })

  it('imports nothing from node:fs that could write', () => {
    for (const { name, text } of sources()) {
      for (const imported of fsImports(text)) {
        expect(imported.namespace, `${name} imports all of ${imported.file}`).toBe(false)
        for (const binding of imported.names) {
          expect(READ_ONLY_FS.has(binding), `${name} imports ${binding}`).toBe(true)
        }
      }
    }
  })

  it('calls nothing that changes a filesystem', () => {
    for (const { name, text } of sources()) {
      for (const pattern of WRITE_CALLS) {
        expect(pattern.test(text), `${name} matches ${pattern}`).toBe(false)
      }
    }
  })
})
