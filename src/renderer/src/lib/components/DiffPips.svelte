<script lang="ts">
  import { partState } from '../../../../shared/format'
  import { instrumentColorVar } from '../matrix'

  let {
    instrument,
    label,
    instruments,
    tier,
    icon = false
  }: {
    /** The instrument key the catalog and the Encore API both use, e.g. `guitar`, `bassghl`. */
    instrument: string
    /** What to call it out loud. The row draws a letter; a screen reader gets this. */
    label: string
    /** scan-chart's reading of the chart. Empty means nobody has read it, not that it is empty. */
    instruments: readonly string[]
    /** song.ini's rating: `diff_guitar` and its siblings, or the catalog's normalized copy. */
    tier: number | null | undefined
    /**
     * Draw the instrument as a glyph in a ring with its pips underneath, instead of as a letter
     * with its pips beside it.
     *
     * Every list row takes it: Explore's, Installed's and Home's. Letters in a line read as a
     * word rather than as one mark per instrument, and the ring is also the narrower of the
     * two, a group being 34px here against roughly 40px as a letter, so the two rows that
     * switched to it gave their titles 12px back rather than paying anything.
     *
     * Off by default for the one caller that cannot take it, which is Explore's grid card: it is
     * 148px wide and has no line to give a 19px ring, so it keeps the letters and draws the same
     * instruments. Switching layout changes the shape and not the subject.
     */
    icon?: boolean
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

  /**
   * The part the key plays, read back off the colour it was given.
   *
   * Ten instrument keys collapse onto six parts, and the glyph and the colour want the same
   * collapse: a six-fret bass is drawn as a bass in both. `instrumentColorVar` is where that
   * mapping lives, so taking the part out of its answer keeps it in one place rather than
   * copying the table here and letting the two drift.
   */
  const part = $derived(colorVar === null ? null : colorVar.replace('--inst-', ''))

  /**
   * One glyph per part, at Lucide's 24-unit grid and the stroke the rest of the app draws at.
   *
   * Five of the six are the prototype's own row icons, unchanged. Rhythm has no glyph of its
   * own there and gets the guitar: it is a guitar part, which is also why it takes the guitar's
   * place in the colour mapping. A key with no part draws no glyph and keeps the letter, for
   * the same reason it draws no colour: an instrument this app has never heard of should not
   * be dressed up as one it has.
   */
  const GLYPHS: Record<string, string> = {
    guitar:
      'M14.5 3.5 17 6M9 14l-3.5 3.5a2.5 2.5 0 1 0 3 3L12 17M19 4.5 14 9.5l-2 4.5 4.5-2 5-5a2.1 2.1 0 0 0-2.5-2.5z',
    rhythm:
      'M14.5 3.5 17 6M9 14l-3.5 3.5a2.5 2.5 0 1 0 3 3L12 17M19 4.5 14 9.5l-2 4.5 4.5-2 5-5a2.1 2.1 0 0 0-2.5-2.5z',
    bass: 'M6 4v11M6 19a2.2 2.2 0 1 0 0-4.4M18 4v11M18 19a2.2 2.2 0 1 0 0-4.4M6 6h12',
    drums: 'M4 9v5c0 2 3.6 3.6 8 3.6s8-1.6 8-3.6V9',
    keys: 'M3 6h18v12H3zM8 6v7M12 6v7M16 6v7',
    vocals: 'M9 3h6v11H9zM5 11a7 7 0 0 0 14 0M12 18v3'
  }

  const glyph = $derived(part === null ? null : (GLYPHS[part] ?? null))

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
  class:iconic={icon}
  role="img"
  aria-label={name}
  title={name}
  style={colorVar ? `--pip: var(${colorVar})` : undefined}
>
  {#if icon && glyph}
    <!-- The ring lights for a part the chart has, whether or not anybody rated it, so the glyph
         answers "is this instrument here" and the pips below answer "how hard". Keeping those two
         questions on two marks is what lets the icon form hold the same three states the letter
         form does. -->
    <span class="ring" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d={glyph} />
      </svg>
    </span>
  {:else}
    <span class="letter" aria-hidden="true">{label.charAt(0)}</span>
  {/if}
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
  /* `flex-shrink: 0` on both the group and the bars inside it. Measured at a 668px view before
     this line existed: three groups drew 40px between them inside a 40px track, because a flex
     item's default is to shrink and a 3px bar has plenty of room to shrink into. The width of
     this thing is the information it carries, so it does not negotiate. */
  .part {
    --pip: var(--text-2);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
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
    flex-shrink: 0;
  }
  /* 3px wide and 9px tall rather than dots: at this size a column of bars is countable at a
     glance and a row of circles is a texture. Fixed dimensions, so six of them are the same
     width on every row and the column never reflows under a longer number. */
  .pip {
    display: block;
    width: 3px;
    height: 9px;
    flex-shrink: 0;
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
    flex-shrink: 0;
    width: 28px;
    height: 1px;
    background: var(--text-3);
    opacity: 0.45;
  }

  /* The icon form. Everything below is scoped to `.iconic`, so a caller that does not ask for
     it gets exactly the drawing above and nothing here can reach it. */
  .iconic {
    flex-direction: column;
    gap: 4px;
  }
  /* 19px, which is smaller than the 34px of pips under it, so the pip row is what sets the
     group's width and five groups are five equal columns whatever each one is carrying. */
  .ring {
    display: grid;
    place-items: center;
    width: 19px;
    height: 19px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid var(--hairline);
    background: var(--surface-2);
    color: var(--text-3);
  }
  .ring svg {
    display: block;
    width: 11px;
    height: 11px;
  }
  /* Lit for a part the chart has. Half-strength on the ring and full on the glyph: at 19px a
     full-strength circle is the loudest thing in the row, and five of them would out-shout the
     title they sit beside. */
  .iconic:not(.absent) .ring {
    border-color: color-mix(in srgb, var(--pip) 50%, transparent);
    color: var(--pip);
  }
  /* Round and 4px in this form, where the bars of the letter form would be a 9px-tall block
     hanging under a 19px circle. The group is read down here rather than across, so the pips
     are a row the eye measures against the ring above it, and a row of dots is the shape that
     reads as a scale under a mark rather than as a second mark. */
  .iconic .pip {
    width: 4px;
    height: 4px;
    border-radius: 50%;
  }
  /* 6 * 4 + 5 * 2, the same footprint the dots take, for the same reason the letter form's
     dash matches its bars. */
  .iconic .dash {
    width: 34px;
  }
</style>
