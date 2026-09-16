import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import DiffPips from './DiffPips.svelte'

// jsdom applies no CSS and computes no layout, so nothing here can say what a pip looks like.
// What it can say is how many pips exist, which of them carry the lit class, and what the one
// accessible name on the group claims. The look is measured in a real engine by
// scripts/measure-explore-row.mjs instead.
const pips = (): Element[] => Array.from(document.querySelectorAll('.pip'))
const lit = (): Element[] => Array.from(document.querySelectorAll('.pip.on'))

describe('DiffPips', () => {
  describe('the three states a chart can be in for one instrument', () => {
    it('draws a dash and no pips for a part the chart does not have', () => {
      render(DiffPips, { instrument: 'bass', label: 'Bass', instruments: ['guitar'], tier: -1 })
      expect(screen.getByLabelText('Bass: not charted')).toBeTruthy()
      expect(document.querySelectorAll('.dash')).toHaveLength(1)
      expect(pips()).toHaveLength(0)
    })

    it('draws six unlit pips for a part that is charted but unrated', () => {
      // The case this component exists to keep separate from the one above. A dash here would
      // tell a drummer the chart has no drums when it has drums nobody rated.
      render(DiffPips, { instrument: 'drums', label: 'Drums', instruments: ['drums'], tier: -1 })
      expect(screen.getByLabelText('Drums: charted, no difficulty rating')).toBeTruthy()
      expect(pips()).toHaveLength(6)
      expect(lit()).toHaveLength(0)
      expect(document.querySelectorAll('.dash')).toHaveLength(0)
    })

    it('lights one pip per tier for a rated part', () => {
      render(DiffPips, { instrument: 'guitar', label: 'Guitar', instruments: ['guitar'], tier: 4 })
      expect(screen.getByLabelText('Guitar: difficulty 4 of 6')).toBeTruthy()
      expect(pips()).toHaveLength(6)
      expect(lit()).toHaveLength(4)
    })
  })

  it('draws a tier of zero as a rated part with nothing lit, never as an absent one', () => {
    // Zero is a number a charter wrote; -1 is the sentinel for "no such part". A component
    // that renders them alike reports a charted instrument as missing.
    render(DiffPips, { instrument: 'keys', label: 'Keys', instruments: ['keys'], tier: 0 })
    expect(screen.getByLabelText('Keys: difficulty 0 of 6')).toBeTruthy()
    expect(pips()).toHaveLength(6)
    expect(lit()).toHaveLength(0)
  })

  it('fills every pip for a tier past the top of the scale and still names the real one', () => {
    // Live data carries these: one chart in the 100-chart sample rates its guitar 20. Six pips
    // is the frame Clone Hero's scale gives, so the drawing saturates and the name does not.
    render(DiffPips, { instrument: 'guitar', label: 'Guitar', instruments: ['guitar'], tier: 20 })
    expect(screen.getByLabelText('Guitar: difficulty 20, past the top of the scale')).toBeTruthy()
    expect(lit()).toHaveLength(6)
  })

  it('takes its colour from the instrument mapping rather than a second copy of one', () => {
    render(DiffPips, {
      instrument: 'bassghl',
      label: 'Bass (GHL)',
      instruments: ['bassghl'],
      tier: 3
    })
    // A six-fret bass is bass: instrumentColorVar maps the controller variant to the part it
    // plays, and this component reads that rather than keeping its own table.
    const part = document.querySelector('.part') as HTMLElement
    expect(part.getAttribute('style')).toContain('--inst-bass')
  })

  it('draws an instrument it has never heard of uncoloured rather than as another one', () => {
    render(DiffPips, {
      instrument: 'theremin',
      label: 'Theremin',
      instruments: ['theremin'],
      tier: 2
    })
    const part = document.querySelector('.part') as HTMLElement
    // No inline custom property at all, so the stylesheet's neutral fallback stands.
    expect(part.getAttribute('style')).toBeNull()
  })

  it('shows the rating when the note data was never read', () => {
    // An empty instruments list is what a catalog row carries before a rescan. It means "we
    // have not looked", so the rating is still the best thing there is to show.
    render(DiffPips, { instrument: 'guitar', label: 'Guitar', instruments: [], tier: 5 })
    expect(lit()).toHaveLength(5)
  })
})

// The icon form Explore asks for, and the promise that asking for it changes nothing for the
// callers that do not. jsdom still applies no CSS, so what these pin is which elements exist and
// what the one accessible name says, never how any of it looks.
describe('DiffPips as an instrument icon', () => {
  const ring = (): Element | null => document.querySelector('.part .ring')

  it('draws a letter and no ring unless the icon form is asked for', () => {
    // The default, which is what Installed, Home and the chart page render. Every rule the icon
    // form adds is scoped to the class this test asserts is absent.
    render(DiffPips, { instrument: 'guitar', label: 'Guitar', instruments: ['guitar'], tier: 3 })
    const group = document.querySelector('.part') as HTMLElement
    expect(group.classList.contains('iconic')).toBe(false)
    expect(ring()).toBeNull()
    expect(document.querySelector('.letter')?.textContent).toBe('G')
  })

  it('swaps the letter for a glyph in a ring when it is', () => {
    render(DiffPips, {
      instrument: 'guitar',
      label: 'Guitar',
      instruments: ['guitar'],
      tier: 3,
      icon: true
    })
    expect(ring()).toBeTruthy()
    expect(ring()?.querySelector('svg path')?.getAttribute('d')).toBeTruthy()
    // Not both: two marks for one instrument is the row saying the same thing twice.
    expect(document.querySelector('.letter')).toBeNull()
  })

  it('keeps the three states apart, with the ring carrying whether the part is there at all', () => {
    // Absent: a dash under an unlit ring. The prototype draws absent and unrated alike; this
    // does not, because they are different claims and the component exists to keep them apart.
    const absent = render(DiffPips, {
      instrument: 'bass',
      label: 'Bass',
      instruments: ['guitar'],
      tier: -1,
      icon: true
    })
    expect(screen.getByLabelText('Bass: not charted')).toBeTruthy()
    expect(document.querySelector('.part')?.classList.contains('absent')).toBe(true)
    expect(document.querySelectorAll('.dash')).toHaveLength(1)
    expect(pips()).toHaveLength(0)
    absent.unmount()

    // Unrated: the ring is lit, because the chart has drums; the pips are all dark, because
    // nobody said how hard they are.
    const unrated = render(DiffPips, {
      instrument: 'drums',
      label: 'Drums',
      instruments: ['drums'],
      tier: -1,
      icon: true
    })
    expect(screen.getByLabelText('Drums: charted, no difficulty rating')).toBeTruthy()
    expect(document.querySelector('.part')?.classList.contains('absent')).toBe(false)
    expect(pips()).toHaveLength(6)
    expect(lit()).toHaveLength(0)
    unrated.unmount()

    render(DiffPips, {
      instrument: 'keys',
      label: 'Keys',
      instruments: ['keys'],
      tier: 2,
      icon: true
    })
    expect(screen.getByLabelText('Keys: difficulty 2 of 6')).toBeTruthy()
    expect(lit()).toHaveLength(2)
  })

  it('still saturates at six and still names the rating that ran past it', () => {
    // 73 is not a number anybody has seen: the highest in 100 charts read from api.enchor.us on
    // 2026-09-16, asked for the ones rated above 6, was 20. It is here because song.ini's rating
    // is a free integer and nothing in the format bounds it, so the test has to be about the
    // absence of a ceiling rather than about the highest value observed so far. The scale is a
    // frame, and the icon form is a second drawing of the same fact, not a second rule about it.
    render(DiffPips, {
      instrument: 'guitar',
      label: 'Guitar',
      instruments: ['guitar'],
      tier: 73,
      icon: true
    })
    expect(screen.getByLabelText('Guitar: difficulty 73, past the top of the scale')).toBeTruthy()
    expect(pips()).toHaveLength(6)
    expect(lit()).toHaveLength(6)
  })

  it('draws a six-fret bass as a bass, in the glyph as well as the colour', () => {
    render(DiffPips, {
      instrument: 'bassghl',
      label: 'Bass (GHL)',
      instruments: ['bassghl'],
      tier: 3,
      icon: true
    })
    const drawn = ring()?.querySelector('svg path')?.getAttribute('d')
    const group = document.querySelector('.part') as HTMLElement
    group.remove()

    render(DiffPips, {
      instrument: 'bass',
      label: 'Bass',
      instruments: ['bass'],
      tier: 3,
      icon: true
    })
    // One table, in `instrumentColorVar`, decides both the hue and the drawing. A controller
    // variant that took a different glyph would be a second table disagreeing with the first.
    expect(ring()?.querySelector('svg path')?.getAttribute('d')).toBe(drawn)
  })

  it('keeps the letter for an instrument it has no glyph for, rather than inventing one', () => {
    render(DiffPips, {
      instrument: 'theremin',
      label: 'Theremin',
      instruments: ['theremin'],
      tier: 2,
      icon: true
    })
    expect(ring()).toBeNull()
    expect(document.querySelector('.letter')?.textContent).toBe('T')
  })
})

/**
 * Every fixed track the ring form is dropped into, against the width it actually draws in.
 *
 * `.part` declares `flex-shrink: 0`, which is the point of it: the width of this thing is the
 * information it carries, so it does not negotiate. That makes a track one pixel short a group
 * painted over whatever is beside it rather than a group squeezed, and jsdom cannot see either.
 * What is checkable without layout is the arithmetic the track widths were chosen by, read back
 * out of the sources: a group is as wide as its six pips and their gaps, the track has to hold
 * every group the view draws plus the gaps between them, and the numbers are all declared.
 *
 * It catches the realistic regression, which is a fourth instrument added to a row whose track
 * was sized for three. `scripts/measure-explore-row.mjs` and `scripts/measure-home.mjs` are what
 * report the other half, which is what the track costs the title beside it.
 */
describe('the row tracks are wide enough for the groups in them', () => {
  const source = (name: string): string => readFileSync(join(__dirname, name), 'utf8')
  const pips = source('DiffPips.svelte')

  /** One number from a `prop: 12px` declaration, the first one in the given block. */
  const px = (text: string, block: string, prop: string): number => {
    const body = new RegExp(`${block}\\s*\\{([^}]*)\\}`).exec(text)
    if (!body) throw new Error(`no ${block} rule`)
    const found = new RegExp(`${prop}:\\s*([\\d.]+)px`).exec(body[1])
    if (!found) throw new Error(`no ${prop} in ${block}`)
    return Number(found[1])
  }

  // Six, the same constant the component declares and for the reason its own comment gives:
  // Clone Hero's scale runs 0 to 6.
  const SLOTS = Number(/const PIPS = (\d+)/.exec(pips)?.[1])
  const pipWidth = px(pips, '\\.iconic \\.pip', 'width')
  const pipGap = px(pips, '\\.pips', 'gap')
  /** What one group comes to: six 4px dots with 2px between them, which is 34px. */
  const group = SLOTS * pipWidth + (SLOTS - 1) * pipGap

  /**
   * Each row that draws the ring form, with the track it was given.
   *
   * Explore draws five and the other two draw three, which is not a disagreement: Explore's row
   * folds the difficulty onto a line of its own below 800px of column and theirs do not, so five
   * groups there are free at the widths where the column is narrow and would come straight off
   * the title in Installed and Home. Both scripts above priced it at 74px of title at every
   * width the shell supports.
   */
  const ROWS = [
    { file: 'Browse.svelte', rule: '\\.diffs', parts: 5, track: 210 },
    { file: 'Library.svelte', rule: '\\.diffs', parts: 3, track: 124 },
    { file: 'Home.svelte', rule: '\\.diffs', parts: 3, track: 124 }
  ]

  it('draws six 4px pips to a group, which is what the tracks are counted in', () => {
    expect(SLOTS).toBe(6)
    expect(group).toBe(34)
  })

  /**
   * One gap for all three rows, because a chart has to read the same in whichever list it is
   * met in. Wider than the 4px between a group's ring and its own pips and than the 2px between
   * the pips: the gap inside a group has to read as smaller than the gap between groups, or the
   * pips read as one run rather than as a mark per instrument.
   */
  it('separates the groups by the same gap in every row, and by more than the pips', () => {
    const gaps = ROWS.map((row) => px(source(row.file), row.rule, 'gap'))
    expect(new Set(gaps).size).toBe(1)
    expect(gaps[0]).toBeGreaterThan(px(pips, '\\.iconic', 'gap'))
    expect(gaps[0]).toBeGreaterThan(pipGap)
  })

  for (const row of ROWS) {
    it(`gives ${row.file} room for its ${row.parts} groups`, () => {
      const text = source(row.file)
      const gap = px(text, row.rule, 'gap')
      const drawn = row.parts * group + (row.parts - 1) * gap

      // The count is read out of the source rather than written here twice, so a part added to
      // the row without the track being widened is what fails this rather than a stale number.
      const list = /const ROW_PARTS[^[]*\[([\s\S]*?)\n {2}\]/.exec(text)
      if (!list) throw new Error(`no ROW_PARTS in ${row.file}`)
      expect((list[1].match(/\bkey:/g) ?? []).length).toBe(row.parts)

      expect(drawn).toBeLessThanOrEqual(row.track)
      // Every fixed declaration of that track, and not only the first: each container query
      // redeclares the row's grid, and one left at the old width is a column that clips at
      // exactly one range of window sizes.
      const declared = [...text.matchAll(/grid-template-columns:([^;]*);/g)]
        .map((m) => m[1])
        .filter((tracks) => /\bminmax\(0, 1fr\)/.test(tracks))
        // `minmax(0, 130px)` is a text track that gives way, not a fixed one, and its number is
        // in the same range as the difficulty track's. Dropped before the numbers are read.
        .map((tracks) => tracks.replace(/minmax\([^)]*\)/g, ''))
        .flatMap((tracks) => tracks.match(/\d+(?=px)/g) ?? [])
        .map(Number)
        .filter((n) => n >= drawn)
      expect(declared.length).toBeGreaterThan(0)
      expect([...new Set(declared)]).toEqual([row.track])
    })
  }
})
