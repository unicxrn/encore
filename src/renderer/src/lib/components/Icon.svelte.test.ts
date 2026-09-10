import { render } from '@testing-library/svelte'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Icon from './Icon.svelte'

/**
 * What these can and cannot check.
 *
 * jsdom draws nothing, so whether a 1.75 stroke at 16px reads as the same weight as the
 * sidebar's icons is a claim that rests on screenshots of the running app, not on this file.
 * What IS pinnable is the contract the rest of the UI relies on: the icon is decorative and
 * says so, it identifies itself for tests, it is drawn on the 24-unit grid every Lucide glyph
 * is designed for. And the part that stops the old way from creeping back: no component
 * draws an icon with a text glyph any more.
 */

describe('Icon', () => {
  it('is decorative and names itself for tests', () => {
    const { container } = render(Icon, { name: 'check' })
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.dataset.icon).toBe('check')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.querySelector('path')?.getAttribute('d')).toMatch(/^M20 6/)
  })

  it('is sized by the size prop, defaulting to 16', () => {
    const small = render(Icon, { name: 'x', size: 12 }).container.querySelector('svg')
    expect(small?.getAttribute('width')).toBe('12')
    expect(small?.getAttribute('height')).toBe('12')
    const dflt = render(Icon, { name: 'x' }).container.querySelector('svg')
    expect(dflt?.getAttribute('width')).toBe('16')
  })
})

describe('no text glyphs as icons', () => {
  const dir = __dirname
  const sources = [
    ...readdirSync(dir)
      .filter((f) => f.endsWith('.svelte'))
      .map((f) => join(dir, f)),
    join(dir, '..', '..', 'App.svelte')
  ]

  /**
   * The glyphs that were standing in for icons before the set existed. Only the markup is
   * scanned (a `✕` in a code comment explaining what a button used to be is not a defect),
   * so each file is cut at its `<style>` and its `<script>` blocks are dropped first.
   *
   * `›` is deliberately not in the set: "Settings › Library folders" in the empty states is a
   * breadcrumb separator inside a sentence, which is copy, not an icon.
   */
  it.each(sources)('%s draws no icon with a text glyph', (file) => {
    const src = readFileSync(file, 'utf8')
    const markup = src
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
    expect(markup).not.toMatch(/[✕✓▢‹]/)
  })
})
