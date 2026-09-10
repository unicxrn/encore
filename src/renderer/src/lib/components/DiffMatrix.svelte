<script lang="ts">
  import type { DiffKey, MatrixRow } from '../matrix'

  let { rows }: { rows: MatrixRow[] } = $props()

  // Column order is the user-facing E/M/H/X convention from matrix.ts.
  const COLUMNS: readonly DiffKey[] = ['E', 'M', 'H', 'X']
  const COLUMN_NAMES: Record<DiffKey, string> = {
    E: 'Easy',
    M: 'Medium',
    H: 'Hard',
    X: 'Expert'
  }
</script>

{#if rows.length === 0}
  <div class="empty mono">NO CHART DATA</div>
{:else}
  <table class="matrix">
    <thead>
      <tr>
        <th class="label" scope="col"><span class="sr-only">Instrument</span></th>
        {#each COLUMNS as col (col)}
          <th class="col-head mono" scope="col" title={COLUMN_NAMES[col]}>{col}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.instrument)}
        <tr>
          <th class="label" scope="row">{row.label}</th>
          {#each COLUMNS as col (col)}
            <td aria-label={`${COLUMN_NAMES[col]}: ${row.diffs[col] ? 'charted' : 'not charted'}`}>
              {#if row.diffs[col]}
                <svg
                  class="check"
                  viewBox="0 0 14 14"
                  width="14"
                  height="14"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M2.8 7.4 L5.6 10.2 L11.2 4"
                    stroke="var(--accent)"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              {:else}
                <span class="dash" aria-hidden="true"></span>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .matrix {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    overflow: hidden;
    table-layout: fixed;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .empty {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 16px 12px;
    text-align: center;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  th,
  td {
    padding: 7px 8px;
    text-align: center;
    border-bottom: 1px solid var(--hairline);
  }
  tbody tr:last-child th,
  tbody tr:last-child td {
    border-bottom: 0;
  }
  th.label {
    width: auto;
    text-align: left;
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .col-head {
    width: 34px;
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  td {
    width: 34px;
  }
  .check {
    display: block;
    margin: 0 auto;
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
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
