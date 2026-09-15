<script lang="ts">
  import { partState } from '../../../../shared/format'
  import { instrumentColorVar } from '../matrix'

  let {
    instrument,
    label,
    instruments,
    tier
  }: {
    /** The instrument key the catalog and the Encore API both use, e.g. `guitar`, `bassghl`. */
    instrument: string
    /** What to call it out loud. The row draws a letter; a screen reader gets this. */
    label: string
    /** scan-chart's reading of the chart. Empty means nobody has read it, not that it is empty. */
    instruments: readonly string[]
    /** song.ini's rating: `diff_guitar` and its siblings, or the catalog's normalized copy. */
    tier: number | null | undefined
  } = $props()

  /**
   * Where the scale stops, which is not where the data does.
   *
   * song.ini's rating is a free integer and charters use it as one: in 100 charts read from
   * api.enchor.us on 2026-09-15 there were five 7s, one 8 and one 20. Clone Hero's own scale
   * runs 0 to 6, so six pips is the honest frame and anything above it fills every pip. The
   * number itself is never lost, because the accessible name below reports the real tier.
   */
  const PIPS = 6
  const SLOTS = Array.from({ length: PIPS }, (_, i) => i)

  const state = $derived(partState(instruments, instrument, tier))
  const filled = $derived(state.kind === 'rated' ? Math.min(state.tier, PIPS) : 0)

  /**
   * The instrument's colour as a custom property name, or null for a key this app has never
   * heard of. `instrumentColorVar` is the one place that mapping lives, so a new instrument
   * gets its colour by being added there and nowhere else.
   */
  const colorVar = $derived(instrumentColorVar(instrument))

  const name = $derived.by(() => {
    if (state.kind === 'absent') return `${label}: not charted`
    if (state.kind === 'unrated') return `${label}: charted, no difficulty rating`
    return state.tier > PIPS
      ? `${label}: difficulty ${state.tier}, past the top of the scale`
      : `${label}: difficulty ${state.tier} of ${PIPS}`
  })
</script>

<!-- role="img" with a name, so the six pips are read as one fact rather than as six empty
     spans. The letter is aria-hidden for the same reason: it is inside the name already. -->
<span
  class="part"
  class:absent={state.kind === 'absent'}
  role="img"
  aria-label={name}
  title={name}
  style={colorVar ? `--pip: var(${colorVar})` : undefined}
>
  <span class="letter" aria-hidden="true">{label.charAt(0)}</span>
  {#if state.kind === 'absent'}
    <!-- A dash rather than six unfilled pips. Absent and unrated would otherwise differ only
         in opacity, which is the one channel that cannot carry a distinction on its own: the
         two are different claims about the chart and have to look different, not fainter. -->
    <span class="dash" aria-hidden="true"></span>
  {:else}
    <span class="pips" aria-hidden="true">
      {#each SLOTS as i (i)}
        <span class="pip" class:on={i < filled}></span>
      {/each}
    </span>
  {/if}
</span>

<style>
  /* --pip is the instrument's colour, set inline by the script. The fallback here is what an
     instrument key with no colour gets: the neutral text step, drawn uncoloured rather than
     drawn as some other instrument. */
  .part {
    --pip: var(--text-2);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .letter {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-tight);
    color: var(--pip);
  }
  .part.absent .letter {
    color: var(--text-3);
    opacity: 0.55;
  }
  .pips {
    display: inline-flex;
    gap: 2px;
  }
  /* 3px wide and 9px tall rather than dots: at this size a column of bars is countable at a
     glance and a row of circles is a texture. Fixed dimensions, so six of them are the same
     width on every row and the column never reflows under a longer number. */
  .pip {
    display: block;
    width: 3px;
    height: 9px;
    border-radius: 1px;
    background: var(--pip);
    /* Unfilled is the same colour held well back, not a second colour: the bar the eye
       counts is the lit one, and the track behind it only has to say how many there are. */
    opacity: 0.22;
  }
  .pip.on {
    opacity: 1;
  }
  /* Same footprint as the six pips plus their gaps (6 * 3 + 5 * 2 = 28), so a row with no
     bass sits on the same grid as one with bass. */
  .dash {
    display: block;
    width: 28px;
    height: 1px;
    background: var(--text-3);
    opacity: 0.45;
  }
</style>
