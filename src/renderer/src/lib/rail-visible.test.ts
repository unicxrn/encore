// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { railOnScreen } from './rail-visible'

/**
 * jsdom applies no stylesheet, so the media query that hides the rail below 1120px does not run
 * here and no width these tests could set would change the answer. What they pin is the rule the
 * function actually implements: it asks the element what its `display` is, whatever put it there.
 * The query itself is measured, in `scripts/measure-explore-row.mjs`, at every width the shell
 * supports.
 */
afterEach(() => {
  document.body.innerHTML = ''
})

describe('railOnScreen', () => {
  it('says yes for a rail that is drawn', () => {
    document.body.innerHTML = '<aside class="rail"></aside>'

    expect(railOnScreen()).toBe(true)
  })

  it('says no for a rail the stylesheet has turned off', () => {
    document.body.innerHTML = '<aside class="rail" style="display: none"></aside>'

    expect(railOnScreen()).toBe(false)
  })

  // The number is in App.svelte's media query and nowhere else, which is only true while this
  // reads `display` rather than a width. A test that set a width instead would be the copy.
  it('reads display rather than the window width', () => {
    document.body.innerHTML = '<aside class="rail" style="display: none"></aside>'
    const rail = document.querySelector('.rail') as HTMLElement

    rail.style.display = 'flex'

    expect(railOnScreen()).toBe(true)
  })

  // A caller is asking whether it has somewhere to put a chart. No column is not somewhere.
  it('says no when there is no rail at all', () => {
    expect(railOnScreen()).toBe(false)
  })
})
