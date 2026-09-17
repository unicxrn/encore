<script lang="ts">
  import { INTENSITY_SCALE_TOP } from '../api/advanced'
  import { instrumentColorVar, type DiffKey, type PartRow } from '../matrix'

  let {
    rows,
    empty,
    unread
  }: {
    rows: PartRow[]
    /** What to say when the chart names no part at all. The caller knows which source it is. */
    empty: string
    /** Why the squares are empty when nothing has counted the notes. Also the caller's to word. */
    unread: string
  } = $props()

  // Column order is the user-facing E/M/H/X convention from matrix.ts.
  const COLUMNS: readonly DiffKey[] = ['E', 'M', 'H', 'X']
  const COLUMN_NAMES: Record<DiffKey, string> = {
    E: 'Easy',
    M: 'Medium',
    H: 'Hard',
    X: 'Expert'
  }

  /**
   * Where the pips stop, which is nowhere near where the ratings stop.
   *
   * `INTENSITY_SCALE_TOP` is Clone Hero's own 0 to 6, read from the one place that already owns
   * that number rather than counted out again here. The data runs far past it: asking
   * api.enchor.us for `{instrument: 'guitar', minIntensity: 7}` on 2026-09-16 answers with 2,419
   * charts, and one page of them carries 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23,
   * 30 and 73. So the bar saturates and the number beside it is printed in full, always: a rating
   * drawn only as a fraction of six would render 73 and 6 identically.
   */
  const SLOTS = Array.from({ length: INTENSITY_SCALE_TOP }, (_, i) => i)

  const ratingName = (row: PartRow): string => {
    if (row.state.kind === 'absent') {
      // The row exists only because song.ini rates it, so the rating is never null here.
      return `${row.label}: no track in this chart, though song.ini rates it ${row.rating}`
    }
    if (row.state.kind === 'unrated') return `${row.label}: charted, no difficulty rating`
    return row.state.tier > INTENSITY_SCALE_TOP
      ? `${row.label}: difficulty ${row.state.tier}, past the top of the scale`
      : `${row.label}: difficulty ${row.state.tier} of ${INTENSITY_SCALE_TOP}`
  }

  const cellName = (row: PartRow, col: DiffKey): string => {
    const cell = row.cells[col]
    if (cell.kind === 'unread') return `${COLUMN_NAMES[col]}: not counted`
    if (cell.kind === 'uncharted') return `${COLUMN_NAMES[col]}: not charted`
    const notes = `${COLUMN_NAMES[col]}: ${cell.count.toLocaleString()} notes`
    return cell.nps === null ? notes : `${notes}, peak ${cell.nps.toFixed(1)} notes per second`
  }

  // The two footnotes, each drawn only where it is true of the chart on screen.
  const notCounted = $derived(rows.some((row) => row.cells.X.kind === 'unread'))
  const mismatched = $derived(rows.filter((row) => row.state.kind === 'absent'))
  /**
   * A rating with no notes under it, named rather than left as a row of dashes.
   *
   * scan-chart calls this `extraValue` and it is a Rock Band conversion artifact. Without the
   * sentence the row reads as a bug in Encore: an instrument listed, rated, and empty across all
   * four difficulties, with nothing on screen saying which of the two sources it came from.
   */
  const mismatchNote = $derived.by(() => {
    if (mismatched.length === 0) return null
    const names = mismatched.map((row) => row.label)
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    return names.length === 1
      ? `song.ini rates ${list}, but the chart carries no notes for it.`
      : `song.ini rates ${list}, but the chart carries no notes for them.`
  })
</script>

<section class="matrix-card" aria-label="Parts and difficulties">
  {#if rows.length === 0}
    <p class="empty">{empty}</p>
  {:else}
    <table class="matrix">
      <thead>
        <tr>
          <th class="label" scope="col"><span class="sr-only">Instrument</span></th>
          <th class="rating-head mono" scope="col">RATING</th>
          {#each COLUMNS as col (col)}
            <th class="col-head mono" scope="col" title={COLUMN_NAMES[col]}>{col}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.instrument)}
          {@const colorVar = instrumentColorVar(row.instrument)}
          <tr class:absent={row.state.kind === 'absent'}>
            <th class="label" scope="row" style={colorVar ? `--pip: var(${colorVar})` : undefined}>
              <!-- The flex box is inside the cell rather than on it: a `display: flex` on a <th>
                   stops it being a table cell at all, and `table-layout: fixed` above then has
                   no column to apply its widths to. -->
              <span class="label-box">
                <!-- The part's colour, from the one mapping that owns it. Decorative: the word
                     beside it is what names the row, and a hue has to be told apart from five
                     other hues rather than carry the label itself. -->
                <span class="swatch" aria-hidden="true"></span>
                <span class="name">{row.label}</span>
              </span>
            </th>
            <td
              class="rating"
              aria-label={ratingName(row)}
              style={colorVar ? `--pip: var(${colorVar})` : undefined}
            >
              <span class="rating-box" aria-hidden="true">
                {#if row.state.kind === 'absent'}
                  <!-- The same dash DiffPips draws for a part that is not there, and for the same
                       reason: absent and unrated are two claims about a chart, so they differ in
                       shape rather than only in opacity. -->
                  <span class="dash wide"></span>
                {:else}
                  <span class="pips">
                    {#each SLOTS as i (i)}
                      <span class="pip" class:on={row.state.kind === 'rated' && i < row.state.tier}
                      ></span>
                    {/each}
                  </span>
                {/if}
                <span class="tier mono">
                  {#if row.state.kind === 'rated'}
                    {row.state.tier}{#if row.state.tier > INTENSITY_SCALE_TOP}<span class="over"
                        >+</span
                      >{/if}
                  {:else if row.state.kind === 'unrated'}
                    <!-- The same placeholder `diffDisplay` prints for a rating nobody set, so a
                         chart read in the Installed list and read here says it the same way. -->
                    –
                  {/if}
                </span>
              </span>
            </td>
            {#each COLUMNS as col (col)}
              {@const cell = row.cells[col]}
              <td class="cell" aria-label={cellName(row, col)}>
                {#if cell.kind === 'charted'}
                  <span class="count mono" aria-hidden="true">{cell.count.toLocaleString()}</span>
                  {#if cell.nps !== null}
                    <span class="nps mono" aria-hidden="true">{cell.nps.toFixed(1)}/s</span>
                  {/if}
                {:else if cell.kind === 'unread'}
                  <span class="unknown mono" aria-hidden="true">?</span>
                {:else}
                  <span class="dash" aria-hidden="true"></span>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>

    <!-- What the second number in a square is. One line, and only where a square has two: a
         legend for a column that is entirely dashes would be explaining nothing. -->
    {#if !notCounted}
      <p class="legend mono">NOTES, THEN PEAK NOTES PER SECOND</p>
    {:else}
      <p class="legend">{unread}</p>
    {/if}
    {#if mismatchNote !== null}
      <p class="legend">{mismatchNote}</p>
    {/if}
  {/if}
</section>

<style>
  .matrix-card {
    background: var(--ground-3);
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    box-shadow: var(--elev-2);
    overflow: hidden;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .empty {
    padding: 18px 14px;
    text-align: center;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .matrix {
    width: 100%;
    border-collapse: collapse;
    /* Fixed, so the four difficulty squares and the rating keep the widths declared below and
       the label column takes whatever is left. The page is one column at the widths where the
       rail is open, so "whatever is left" swings from about 120px to about 700px. */
    table-layout: fixed;
  }
  th,
  td {
    padding: 7px 8px;
    text-align: center;
    border-bottom: 1px solid var(--border-1);
  }
  tbody tr:last-child th,
  tbody tr:last-child td {
    border-bottom: 0;
  }
  th.label {
    --pip: var(--text-2);
    width: auto;
    text-align: left;
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--text-1);
  }
  .label-box {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .swatch {
    width: 7px;
    height: 7px;
    flex-shrink: 0;
    border-radius: 2px;
    background: var(--pip);
  }
  /* A part song.ini rates that the chart has no notes for. Held back rather than hidden: the
     row is still a fact about the chart, and the sentence under the table says which fact. */
  tr.absent th.label,
  tr.absent .name {
    color: var(--text-3);
  }
  tr.absent .swatch {
    opacity: 0.4;
  }
  .col-head,
  .rating-head {
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  /* 78px holds six 3px pips with their gaps (28px), the 6px gap after them, and three digits of
     mono at --fs-caption (about 22px), inside the 16px of padding. Three digits because the
     measured tail of this field reaches 73; see SLOTS above. */
  .rating-head,
  .rating {
    width: 78px;
  }
  .col-head,
  .cell {
    width: 62px;
  }
  .rating {
    --pip: var(--text-2);
  }
  .rating-box {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
  }
  .pips {
    display: inline-flex;
    gap: 2px;
    flex-shrink: 0;
  }
  /* The same 3px by 9px bar DiffPips draws in the Explore row, so one chart read in the list
     and on this page is read in one vocabulary. Fixed, so every row sits on the same grid. */
  .pip {
    display: block;
    width: 3px;
    height: 9px;
    flex-shrink: 0;
    border-radius: 1px;
    background: var(--pip);
    opacity: 0.22;
  }
  .pip.on {
    opacity: 1;
  }
  .tier {
    flex: 1;
    min-width: 0;
    text-align: right;
    font-size: var(--fs-caption);
    line-height: var(--lh-flat);
    color: var(--text-2);
  }
  /* The one mark that separates a saturated rating from a rating that fills the scale exactly.
     Without it a 7 and a 6 draw the same six lit bars, and the number beside them is the only
     thing that differs, which is a lot to ask of two characters at 12px. */
  .over {
    color: var(--accent-text);
  }
  .cell {
    line-height: var(--lh-tight);
  }
  .count {
    display: block;
    font-size: var(--fs-secondary);
    color: var(--text-1);
  }
  .nps {
    display: block;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  /* Nobody has counted. A question mark rather than the dash below it, because "not counted"
     and "counted, and there are none" are the two states this grid exists to keep apart. */
  .unknown {
    display: block;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  /* Absent difficulty: a dimmed hairline dash, never an empty hole. */
  .dash {
    display: block;
    width: 8px;
    height: 1px;
    margin: 0 auto;
    background: var(--text-3);
    opacity: 0.45;
  }
  /* Same footprint as the six pips plus their gaps (6 * 3 + 5 * 2 = 28), so a rated row and an
     absent one put their number in the same place. */
  .dash.wide {
    width: 28px;
    margin: 0;
    flex-shrink: 0;
  }
  .legend {
    padding: 8px 12px;
    border-top: 1px solid var(--border-1);
    background: var(--ground-2);
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .legend + .legend {
    border-top: 0;
    padding-top: 0;
  }
  .legend.mono {
    letter-spacing: var(--ls-caps);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
