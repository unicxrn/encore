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
