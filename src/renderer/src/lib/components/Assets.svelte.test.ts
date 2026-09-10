import { render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChartRecordSchema, defaultSettings, type ChartRecord } from '../../../../shared/schemas'
import { settings } from '../stores/settings'
import Assets from './Assets.svelte'
// Vite's ?raw hands back the component's own bytes, untransformed. jsdom applies no CSS and
// computes no layout, so reading the stylesheet as text is the only way a test here can see
// the narrow-pane rules at all. See the note on narrowLayoutBlock().
import assetsSource from './Assets.svelte?raw'

const CHART_PATH = '/library/Rush - YYZ'

/**
 * Goes through the real schema so the fields the row reads are the ones the catalog would hand
 * it, rather than a hand-written literal that can drift from the row shape.
 */
const chart = (overrides: Partial<ChartRecord> = {}): ChartRecord =>
  ChartRecordSchema.parse({
    path: CHART_PATH,
    chartType: 'folder',
    folderHash: CHART_PATH,
    modifiedTime: 0,
    name: 'YYZ',
    artist: 'Rush',
    ...overrides
  })

function renderAssets(rows: ChartRecord[]): void {
  vi.stubGlobal('encore', {
    catalogQuery: (): Promise<ChartRecord[]> => Promise.resolve(rows),
    catalogCount: (): Promise<number> => Promise.resolve(rows.length),
    sidecarStatus: (): Promise<{ installed: boolean }> => Promise.resolve({ installed: false })
  })
  render(Assets)
}

afterEach(() => {
  vi.unstubAllGlobals()
  settings.set(defaultSettings())
})

/** `onMount` fetches the list on a microtask, so the first paint has no rows in it. */
async function firstRow(): Promise<HTMLElement> {
  return waitFor(() => {
    const row = document.querySelector('.list .row')
    if (!(row instanceof HTMLElement)) throw new Error('no chart row rendered')
    return row
  })
}

/**
 * The pane width at which the row stops fitting on one line. Moved from 900px to 960px when
 * the type scale landed: --fs-caption widened both the pills and the need-count, so the single
 * line runs out about 60px earlier than it used to. Named here so a future change to the
 * threshold is a one-line edit that reads as deliberate.
 */
const NARROW_PANE = '960px'

/**
 * The body of the `@container` block that lays the row out as two lines in a narrow pane.
 *
 * Braces are balanced by hand rather than matched with a regex because the block nests one
 * level, and throwing beats guessing: if the block is renamed or its threshold changes, the
 * tests below should say "update this parser", not quietly pass against nothing.
 */
function narrowLayoutBlock(): string {
  const open = assetsSource.indexOf(`@container (max-width: ${NARROW_PANE}) {`)
  if (open === -1) {
    throw new Error(`no \`@container (max-width: ${NARROW_PANE})\` block in Assets.svelte`)
  }
  let depth = 0
  for (let i = assetsSource.indexOf('{', open); i < assetsSource.length; i++) {
    if (assetsSource[i] === '{') depth++
    else if (assetsSource[i] === '}' && --depth === 0) {
      return assetsSource.slice(assetsSource.indexOf('{', open) + 1, i)
    }
  }
  throw new Error('unbalanced braces in the @container block')
}

/** The class selectors given an explicit rule inside that block, e.g. `.thumb` -> `thumb`. */
const narrowLayoutSelectors = (): Set<string> =>
  new Set([...narrowLayoutBlock().matchAll(/^\s*\.([a-z-]+)\s*\{/gm)].map((m) => m[1]))

describe('Asset Studio chart row', () => {
  it('lays the row out as thumb, pills, song and need-count', async () => {
    renderAssets([chart()])

    const children = [...(await firstRow()).children]
    expect(children.map((c) => c.className.split(/\s+/)[0])).toEqual([
      'thumb',
      'pills',
      'song',
      'need'
    ])
  })

  /**
   * The defect this guards: `.detail` is a fixed 400px and `.pills` never compresses, so at a
   * narrow window the `1fr` title track absorbed the whole deficit and collapsed to zero,
   * measured at 0px in the running app at both 960 and 1000, with the need-count spilling out
   * of the row. jsdom cannot see that; it computes no layout. What it CAN check is that the
   * rules that fix it are still present and still cover every cell the row renders.
   */
  it('gives every child of the row an explicit place in the narrow two-line layout', async () => {
    renderAssets([chart()])

    const rendered = [...(await firstRow()).children].map((c) => c.className.split(/\s+/)[0])
    const placed = narrowLayoutSelectors()

    // An unplaced child auto-places into the next free cell, which in a two-line grid means
    // silently overlapping one of the others. Adding a column to the row has to mean choosing
    // where it goes when the row stacks.
    const unplaced = rendered.filter((cls) => !placed.has(cls))
    expect(unplaced).toEqual([])
  })

  // The block is inert without this: `@container` only matches inside a declared container,
  // so dropping this one line would silently restore the collapsing row at every width.
  it('declares the query container the narrow layout is measured against', () => {
    const assetsRule = /^\s*\.assets\s*\{([^}]*)\}/m.exec(assetsSource)
    if (!assetsRule) throw new Error('no `.assets {…}` rule in Assets.svelte')
    expect(assetsRule[1]).toMatch(/container-type:\s*inline-size\s*;/)
  })

  /**
   * The narrow layout only fits because the inspector gives width back, and how much it gives
   * back is load-bearing rather than cosmetic. The pills line spans `1fr + gap + need`, so it
   * is what `.detail` leaves over: measured, 360px left it at exactly 269.0px against a 271.0px
   * worst case, a 2px clip on the one element the row exists to state correctly. 344px puts it
   * at 285.0px. Pinned to the number, not just to the selector's presence, because widening
   * `.detail` again is precisely the edit that would silently reintroduce the clip.
   */
  it('narrows the inspector in the same block that stacks the row', () => {
    expect(narrowLayoutSelectors()).toContain('detail')
    expect(narrowLayoutBlock()).toMatch(/\.detail\s*\{[^}]*width:\s*344px/)
  })

  /**
   * The pills state which assets a chart is missing, which is the whole point of the row, so
   * they are the one thing that must never be compressed to make something else fit. Both
   * layouts are built around that, so it is asserted rather than left as a convention.
   */
  it('never lets the asset pills shrink', () => {
    const pillsRule = /^\s*\.pills\s*\{([^}]*)\}/m.exec(assetsSource)
    if (!pillsRule) throw new Error('no `.pills {…}` rule in Assets.svelte')
    expect(pillsRule[1]).toMatch(/flex-shrink:\s*0\s*;/)
  })

  it('shows a pill for each of the four assets, marking the missing ones', async () => {
    renderAssets([chart({ hasVideo: true, hasAlbumArt: false })])
    const row = await firstRow()

    const pills = [...row.querySelectorAll('.pill')]
    // The mark is an Icon, which is decorative and invisible to textContent; `data-icon` is
    // the one thing that says whether a pill shows the tick or the plus.
    const mark = (p: Element): string =>
      `${p.querySelector('svg')?.getAttribute('data-icon')} ${p.textContent?.trim()}`
    expect(pills.map(mark)).toEqual(['check Video', 'plus Art', 'plus Background', 'plus Lyrics'])
    expect(await screen.findByText('3 MISSING')).toBeTruthy()
  })
})
