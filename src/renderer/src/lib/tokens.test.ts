import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What these can and cannot check.
 *
 * The type scale is a claim about how the app LOOKS, and nothing in this suite can see that:
 * the renderer tests run in jsdom, which applies no stylesheet and computes no layout, so
 * `getComputedStyle(el).fontSize` here answers with jsdom's defaults rather than the app's.
 * Every statement about legibility, row height and reflow in this change rests on measurements
 * taken against the running Electron app with `getBoundingClientRect`, not on these tests.
 *
 * What IS pinnable is the discipline that makes the scale a system rather than a suggestion:
 * that the tokens exist, that they are documented, and that no component has gone back to
 * hardcoding a size. That is what these assert. They are cheap and they catch the realistic
 * regression: a new component landing with `font-size: 11px` because that is what the file
 * next to it used to say.
 */

const TOKENS_PATH = join(__dirname, 'tokens.css')
const tokens = readFileSync(TOKENS_PATH, 'utf8')

const COMPONENTS_DIR = join(__dirname, 'components')
/** Every stylesheet-bearing renderer source: the components plus the app shell. */
const sourceFiles = [
  ...readdirSync(COMPONENTS_DIR)
    .filter((f) => f.endsWith('.svelte'))
    .map((f) => join(COMPONENTS_DIR, f)),
  join(__dirname, '..', 'App.svelte')
]

/** The scale, smallest to largest. Order matters: the test below pins it as ascending. */
const SIZE_STEPS = [
  '--fs-caption',
  '--fs-secondary',
  '--fs-body',
  '--fs-emphasis',
  '--fs-heading',
  '--fs-display',
  '--fs-hero'
] as const

const LEADING_STEPS = ['--lh-flat', '--lh-tight', '--lh-snug', '--lh-prose', '--lh-display']
const TRACKING_STEPS = ['--ls-caps', '--ls-tight', '--ls-tighter']

/** `--fs-body: 14px;` -> 14. Throws rather than returning NaN, so a rename fails loudly. */
function pxValue(name: string): number {
  const m = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px\\s*;`).exec(tokens)
  if (!m) throw new Error(`no \`${name}\` px token in tokens.css`)
  return Number(m[1])
}

describe('type scale tokens', () => {
  it('defines every step of the scale', () => {
    for (const step of [...SIZE_STEPS, ...LEADING_STEPS, ...TRACKING_STEPS]) {
      expect(tokens, `missing ${step}`).toMatch(new RegExp(`${step}:\\s*[^;]+;`))
    }
  })

  it('is strictly ascending, so the step names order the same way the sizes do', () => {
    const sizes = SIZE_STEPS.map(pxValue)
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
    expect(new Set(sizes).size, 'two steps share a size').toBe(sizes.length)
  })

  /**
   * The floor is the whole point of the change: 74 declarations sat at 10px, which is a caption
   * size, and they were carrying song metadata, the status bar and the sidebar. 12px is the
   * smallest text the app is allowed to set.
   */
  it('puts the floor at 12px and the body at 14px', () => {
    expect(pxValue('--fs-caption')).toBe(12)
    expect(pxValue('--fs-body')).toBe(14)
  })

  it('sets `body` from the scale rather than a literal', () => {
    // Two rules in this file have a selector line of exactly `body`: the `html,\nbody` pair
    // that sets height, and the real one. Picked by content rather than by position, so
    // reordering the file does not silently point this at the wrong rule.
    const body = [...tokens.matchAll(/^body\s*\{([^}]*)\}/gm)]
      .map((m) => m[1])
      .find((rule) => rule.includes('font-family'))
    if (body === undefined) throw new Error('no `body {…}` rule setting font-family in tokens.css')
    expect(body).toMatch(/font-size:\s*var\(--fs-body\)\s*;/)
    expect(body).toMatch(/line-height:\s*var\(--lh-[a-z]+\)\s*;/)
  })

  /**
   * A token nobody can tell apart from its neighbour gets picked by coin flip. tokens.css
   * carries its reasoning in comments for colour already; this keeps type to the same bar by
   * requiring each size step to be commented where it is declared.
   */
  it('says what each size step is for, on the line that declares it', () => {
    for (const step of SIZE_STEPS) {
      // Horizontal whitespace only, and no `s` flag: the comment has to be on the declaration's
      // own line. Allowing `\s*` here lets the match run past the newline and find the next
      // SECTION comment instead, which passes for every token whatever it says. Verified by
      // deleting a step's comment and watching the looser version stay green.
      const documented = new RegExp(`${step}:[^;\\n]+;[^\\S\\n]*/\\*[^\\n]*\\*/`)
      expect(
        tokens,
        `\`${step}\` is declared without a comment on its line saying what it is for`
      ).toMatch(documented)
    }
  })
})

describe('components use the scale', () => {
  /**
   * The regression this exists for: someone adds a component, copies a rule out of the file
   * beside it, and `font-size: 11px` is back, followed by 11.5px when it looks a shade large.
   * That is exactly how the 216 declarations this replaced accumulated.
   */
  it('never hardcodes a font-size', () => {
    const offenders: string[] = []
    for (const file of sourceFiles) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (/font-size:\s*[\d.]+(px|rem|em|pt)/.test(line)) {
          offenders.push(`${file.split('/').pop()}:${i + 1}${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * Leading was the other half of why the small text read badly: before this change every
   * element in the app computed `line-height: normal`, and the handful of explicit ones were
   * ad-hoc decimals (1.4, 1.45, 1.5, 1.55, 1.6, 1.7) with nothing distinguishing them.
   */
  it('never hardcodes a line-height', () => {
    const offenders: string[] = []
    for (const file of sourceFiles) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (/line-height:\s*[\d.]+\s*;/.test(line)) {
          offenders.push(`${file.split('/').pop()}:${i + 1}${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * Tracking has two deliberate survivors, and they are allowed BY NAME rather than by a
   * blanket exemption: the Sidebar wordmark at 0.14em and Home's lone mono status word at
   * 0.1em. Both carry a comment where they are declared. Anything else reaching for a raw
   * `em` value should be using --ls-caps.
   */
  it('keeps raw letter-spacing to the two documented exceptions', () => {
    const found: string[] = []
    for (const file of sourceFiles) {
      const name = file.split('/').pop()
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /letter-spacing:\s*(-?[\d.]+em)\s*;/.exec(line)
        if (m) found.push(`${name} ${m[1]}`)
      }
    }
    expect(found.sort()).toEqual(['Home.svelte 0.1em', 'Sidebar.svelte 0.14em'])
  })

  /**
   * Archivo ships 400/500/600/700 here and JetBrains Mono 400/500. See the @fontsource imports
   * in main.ts. A weight outside that set is not a bolder rendering, it is the nearest loaded
   * face: `font-weight: 800` was live on Home's hero and measured pixel-identical to 700.
   */
  it('only asks for weights the bundled faces actually ship', () => {
    const loaded = new Set(['400', '500', '600', '700', 'inherit', 'normal', 'bold'])
    const offenders: string[] = []
    for (const file of sourceFiles) {
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const m = /font-weight:\s*([a-z0-9]+)\s*;/.exec(line)
        if (m && !loaded.has(m[1])) offenders.push(`${file.split('/').pop()}:${i + 1} ${m[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
