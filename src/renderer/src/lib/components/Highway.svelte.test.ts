import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import Highway from './Highway.svelte'
import { HIGHWAY_FRETS } from '../highway'

/**
 * What this can check, and what `highway.test.ts` checks instead.
 *
 * jsdom applies no CSS and computes no layout, so nothing here can see the lane: every shape is
 * at zero pixels and no colour resolves. The geometry is a pure function for that reason and is
 * checked to the number next door. What is pinnable here is that the drawing is assembled out of
 * it, that the two states are two states, and that the rules the reduced-motion answer depends on
 * are the rules that are written down.
 */
const lane = (container: HTMLElement): SVGSVGElement =>
  container.querySelector('svg.highway') as SVGSVGElement

describe('Highway: what is in the drawing', () => {
  it('draws the lane out of the shared geometry rather than a picture of its own', () => {
    const { container } = render(Highway)
    const svg = lane(container)

    expect(svg.querySelectorAll('.lane')).toHaveLength(HIGHWAY_FRETS)
    expect(svg.querySelectorAll('.rail')).toHaveLength(HIGHWAY_FRETS + 1)
    expect(svg.querySelectorAll('.fret')).toHaveLength(HIGHWAY_FRETS)
    expect(svg.querySelectorAll('.strike')).toHaveLength(1)
    expect(svg.querySelectorAll('.beat').length).toBeGreaterThan(0)
  })

  /**
   * The lane is decoration and says so.
   *
   * Everything it could announce is already in words beside it: the badge in the corner names the
   * track, the state line says what the preview is doing, and the Play button is what starts one.
   * A screen reader meeting a hundred unlabelled shapes here would be worse off.
   */
  it('is hidden from a screen reader, having nothing to say it does not say in words', () => {
    const { container } = render(Highway)
    expect(lane(container).getAttribute('aria-hidden')).toBe('true')
  })

  /**
   * The rail and the chart page's pane can be on screen together, and both draw this. Two
   * elements sharing one gradient id is one gradient between them: whichever came first wins and
   * the second lane is painted with the first one's fill.
   */
  it('gives each instance its own gradient ids, because two of these can be on screen at once', () => {
    const { container: a } = render(Highway)
    const { container: b } = render(Highway)
    const ids = (root: HTMLElement): string[] =>
      [...root.querySelectorAll('defs > *')].map((el) => el.id)

    expect(ids(a)).toHaveLength(2)
    expect(ids(b)).toHaveLength(2)
    expect(new Set([...ids(a), ...ids(b)]).size).toBe(4)
    // And the lane actually references its own pair rather than a hardcoded name.
    for (const id of ids(a)) {
      expect(a.innerHTML).toContain(`url(#${id})`)
    }
  })

  /**
   * The five colours are the five-fret lane names `chart-preview` loads guitar, bass, rhythm and
   * keys as, and they are values rather than tokens on purpose: tokens.css is the one source for
   * Encore's scale, and a controller's buttons are not in it. `tokens.test.ts` is what holds that
   * line, so this is the half of the claim that says the lane still paints five distinct frets.
   */
  it('paints each fret its own colour, none of them borrowed from the app palette', () => {
    const { container } = render(Highway)
    const strokes = [...container.querySelectorAll('.fret')].map(
      (el) => (el as SVGElement).style.stroke
    )

    expect(strokes).toHaveLength(HIGHWAY_FRETS)
    expect(new Set(strokes).size).toBe(HIGHWAY_FRETS)
    expect(strokes.some((s) => s.includes('var('))).toBe(false)
  })

  it('has two states and draws the resting one unless told otherwise', () => {
    const { container: resting } = render(Highway)
    expect(lane(resting).classList.contains('rest')).toBe(true)
    expect(lane(resting).classList.contains('opening')).toBe(false)

    const { container: opening } = render(Highway, { props: { state: 'opening' } })
    expect(lane(opening).classList.contains('opening')).toBe(true)
  })
})

/**
 * Reduced motion, pinned where it lives.
 *
 * The app has exactly one piece of reduced-motion machinery, the global rule at the foot of
 * tokens.css, and this lane is built to be answered by it rather than to carry a second copy in
 * script. That only works while two things hold: the lane's only motion is a CSS `animation`, and
 * the keyframes of that animation move nothing. `animation: none` then leaves the strike line at
 * the value its own rule declares, which is the resting lane exactly as drawn.
 *
 * jsdom loads no stylesheet and computes no styles, so the source is the only place to check it.
 */
describe('Highway: what reduced motion collapses', () => {
  const source = readFileSync(join(__dirname, 'Highway.svelte'), 'utf8')
  const tokens = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8')
  // Comments out, because half of them are about the rules below and would match every pattern
  // here by talking about them.
  const styles = (/<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )

  it('moves one thing, only while a chart is being opened', () => {
    const animated = [...styles.matchAll(/([^{}]+)\{[^{}]*\banimation:/g)].map((m) => m[1].trim())
    expect(animated).toEqual(['.highway.opening .strike'])
    // And nothing else in the lane transitions either: a resting highway is a still picture.
    expect(styles).not.toMatch(/\btransition:/)
  })

  it('animates a value that moves nothing, so the still frame is the resting lane', () => {
    const frames = /@keyframes strike-wait\s*\{([\s\S]*?)\n {2}\}/.exec(styles)?.[1] ?? ''
    expect(frames).not.toBe('')
    const properties = [...frames.matchAll(/^\s{6}([a-z-]+):/gm)].map((m) => m[1])
    expect(properties.length).toBeGreaterThan(0)
    expect(new Set(properties)).toEqual(new Set(['stroke-opacity']))
    // The resting value is the one the strike line's own rule declares, so turning the animation
    // off lands on it rather than on a half-faded line.
    expect(/\.strike\s*\{[^}]*stroke-opacity:\s*0\.9/.test(styles)).toBe(true)
  })

  it('leans on the one reduced-motion rule the app has, which is still there', () => {
    const rule = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(tokens)?.[1]
    expect(rule).toBeTruthy()
    expect(rule).toMatch(/animation:\s*none\s*!important/)
    expect(rule).toMatch(/transition:\s*none\s*!important/)
  })
})
