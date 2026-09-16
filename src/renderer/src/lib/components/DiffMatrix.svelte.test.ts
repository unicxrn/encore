import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import DiffMatrix from './DiffMatrix.svelte'
import type { DiffCell, DiffKey, PartRow } from '../matrix'

const EMPTY = 'Nothing has read this chart.'
const UNREAD = 'Run a scan to count the notes.'

const cells = (map: Partial<Record<DiffKey, DiffCell>>): PartRow['cells'] => ({
  E: map.E ?? { kind: 'uncharted' },
  M: map.M ?? { kind: 'uncharted' },
  H: map.H ?? { kind: 'uncharted' },
  X: map.X ?? { kind: 'uncharted' }
})

const row = (over: Partial<PartRow> = {}): PartRow => ({
  instrument: 'guitar',
  label: 'Guitar',
  state: { kind: 'rated', tier: 4 },
  rating: 4,
  cells: cells({
    H: { kind: 'charted', count: 902, nps: 6.25 },
    X: { kind: 'charted', count: 1408, nps: 9.4 }
  }),
  ...over
})

function renderMatrix(rows: PartRow[]): ReturnType<typeof render> {
  return render(DiffMatrix, { rows, empty: EMPTY, unread: UNREAD })
}

describe('DiffMatrix: what each square says', () => {
  it('prints the note count of every charted difficulty', () => {
    renderMatrix([row()])
    expect(screen.getByText('1,408')).toBeTruthy()
    expect(screen.getByText('902')).toBeTruthy()
  })

  /**
   * The peak is the second number in a square, and it is the whole reason the chart page's grid
   * is worth opening from a rail that already prints one of them: the rail shows the peak for
   * the ONE instrument and difficulty its two selects name, and this shows all of them at once.
   */
  it('prints the peak notes per second under the count', () => {
    renderMatrix([row()])
    expect(screen.getByText('9.4/s')).toBeTruthy()
    expect(screen.getByLabelText('Expert: 1,408 notes, peak 9.4 notes per second')).toBeTruthy()
  })

  it('leaves the peak off a square the source never measured', () => {
    renderMatrix([row({ cells: cells({ X: { kind: 'charted', count: 1408, nps: null } }) })])
    expect(screen.getByLabelText('Expert: 1,408 notes')).toBeTruthy()
    expect(screen.queryByText(/\/s$/)).toBeNull()
  })

  /**
   * "Nobody counted" and "counted, and there is nothing here" are two different claims about a
   * chart, and the old grid rendered both as the same dash. A catalog row written before note
   * counts existed is the first case on every one of its squares.
   */
  it('tells a square nobody counted from one counted and empty', () => {
    renderMatrix([row({ cells: cells({ E: { kind: 'unread' }, X: { kind: 'unread' } }) })])
    expect(screen.getByLabelText('Easy: not counted')).toBeTruthy()
    expect(screen.getByLabelText('Hard: not charted')).toBeTruthy()
  })

  it("puts the caller's sentence under the grid when the squares were never counted", () => {
    renderMatrix([row({ cells: cells({ X: { kind: 'unread' } }) })])
    expect(screen.getByText(UNREAD)).toBeTruthy()
  })
})

describe('DiffMatrix: the rating, which runs past the scale it is drawn on', () => {
  /**
   * Measured against api.enchor.us on 2026-09-16: `{instrument: 'guitar', minIntensity: 7}`
   * answers with 2,419 charts, and one page of them carries ratings up to 73. Six pips is the
   * honest frame for Clone Hero's own 0-to-6 scale, so anything above it fills every pip; the
   * number itself is never lost, because it is printed beside them and repeated in the name.
   */
  it('saturates the pips at six and still prints the real number', () => {
    const { container } = renderMatrix([row({ state: { kind: 'rated', tier: 73 }, rating: 73 })])
    expect(container.querySelectorAll('.pip').length).toBe(6)
    expect(container.querySelectorAll('.pip.on').length).toBe(6)
    expect(screen.getByText(/73/)).toBeTruthy()
  })

  it('says in the accessible name that the rating is past the top of the scale', () => {
    renderMatrix([row({ state: { kind: 'rated', tier: 73 }, rating: 73 })])
    expect(screen.getByLabelText('Guitar: difficulty 73, past the top of the scale')).toBeTruthy()
  })

  // A 7 and a 6 light the same six bars. Without a mark of its own, two characters at 12px are
  // the only thing separating a rating that fills the scale from one that runs off the end.
  it('draws an over-scale mark only above six', () => {
    const { container } = renderMatrix([row({ state: { kind: 'rated', tier: 7 }, rating: 7 })])
    expect(container.querySelector('.over')).toBeTruthy()

    const six = renderMatrix([row({ state: { kind: 'rated', tier: 6 }, rating: 6 })])
    expect(six.container.querySelector('.over')).toBeNull()
  })

  it('lights one pip per tier inside the scale', () => {
    const { container } = renderMatrix([row({ state: { kind: 'rated', tier: 4 }, rating: 4 })])
    expect(container.querySelectorAll('.pip.on').length).toBe(4)
  })
})

describe('DiffMatrix: a part that is absent and a part that is unrated', () => {
  // Two different claims about a chart. Collapsing them tells a drummer that a chart with drums
  // has none, which is why `partState` has three states and this grid draws all three.
  it('names an unrated part as charted with no rating', () => {
    const { container } = renderMatrix([row({ state: { kind: 'unrated' }, rating: null })])
    expect(screen.getByLabelText('Guitar: charted, no difficulty rating')).toBeTruthy()
    // Six pips, none lit: the frame is there, nobody filled it in.
    expect(container.querySelectorAll('.pip').length).toBe(6)
    expect(container.querySelectorAll('.pip.on').length).toBe(0)
  })

  it('draws an absent part as a dash rather than as six unlit pips', () => {
    const { container } = renderMatrix([
      row({
        instrument: 'keys',
        label: 'Keys',
        state: { kind: 'absent' },
        rating: 3,
        cells: cells({})
      })
    ])
    expect(container.querySelectorAll('.pip').length).toBe(0)
    expect(container.querySelector('.dash.wide')).toBeTruthy()
  })

  /**
   * The row is otherwise unreadable: an instrument listed, and empty across all four
   * difficulties, with nothing on screen saying that the claim came from song.ini rather than
   * from the notes. Six charts in a hundred carry one (scan-chart's `extraValue`).
   */
  it('says in words that song.ini rated a part the chart has no notes for', () => {
    renderMatrix([
      row({
        instrument: 'keys',
        label: 'Keys',
        state: { kind: 'absent' },
        rating: 3,
        cells: cells({})
      })
    ])
    expect(
      screen.getByText('song.ini rates Keys, but the chart carries no notes for it.')
    ).toBeTruthy()
    expect(
      screen.getByLabelText('Keys: no track in this chart, though song.ini rates it 3')
    ).toBeTruthy()
  })

  it('lists every such part in one sentence rather than one each', () => {
    renderMatrix([
      row({
        instrument: 'keys',
        label: 'Keys',
        state: { kind: 'absent' },
        rating: 3,
        cells: cells({})
      }),
      row({
        instrument: 'rhythm',
        label: 'Rhythm',
        state: { kind: 'absent' },
        rating: 1,
        cells: cells({})
      })
    ])
    expect(
      screen.getByText('song.ini rates Keys and Rhythm, but the chart carries no notes for them.')
    ).toBeTruthy()
  })

  it('says nothing about mismatches when there are none', () => {
    renderMatrix([row()])
    expect(screen.queryByText(/song\.ini rates/)).toBeNull()
  })
})

describe('DiffMatrix: nothing to show', () => {
  // The two sources disagree about what an empty grid means ("run a scan" is false of a chart on
  // Chorus), so the sentence is the caller's rather than one this component picks.
  it('renders the sentence it was handed instead of a grid', () => {
    renderMatrix([])
    expect(screen.getByText(EMPTY)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
