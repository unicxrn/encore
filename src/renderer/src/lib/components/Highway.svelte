<script lang="ts">
  import { HIGHWAY_HEIGHT, HIGHWAY_WIDTH, highwayShape } from '../highway'

  /**
   * What the lane is doing. `rest` is a still frame; `opening` is the seconds between pressing
   * Play and the first note, while a chart is being fetched, unpacked and parsed.
   */
  let { state = 'rest' }: { state?: 'rest' | 'opening' } = $props()

  // Constant, so it is computed once for the life of the module rather than per instance: the
  // lane has no inputs, and both places that draw it draw the same lane at a different size.
  const shape = highwayShape()

  /**
   * Clone Hero's five frets, in the order `chart-preview` names its five-fret lanes: green, red,
   * yellow, blue, orange.
   *
   * Values rather than custom properties, and here rather than in tokens.css, because they name
   * the buttons on a controller and not anything in Encore's palette. The red in particular is
   * the guitar's second fret and not --danger: drawn from that token it would be the app's error
   * colour saying something it does not mean, and it would move the day the error colour is
   * retuned. tokens.css is the one source for the scale, and the way to keep that true is to
   * declare a colour that is not in the scale as what it is instead of inventing a token for it.
   */
  const FRETS = ['#4ade80', '#f87171', '#facc15', '#60a5fa', '#fb923c']

  // The two gradients are referenced by id, and the rail and the chart page's pane can both be
  // on screen at once. Two elements sharing one id is one gradient between them, so each
  // instance gets its own pair.
  const uid = $props.id()
  const ground = `hw-ground-${uid}`
  const glow = `hw-glow-${uid}`
</script>

<!-- Decorative. Everything it says is said in words elsewhere: the badge in the corner names the
     track, the state line under the transport says what the preview is doing, and the Play button
     beside it is what starts one. -->
<svg
  class="highway {state}"
  viewBox="0 0 {HIGHWAY_WIDTH} {HIGHWAY_HEIGHT}"
  preserveAspectRatio="none"
  aria-hidden="true"
  focusable="false"
>
  <defs>
    <linearGradient id={ground} x1="0" y1="0" x2="0" y2="1">
      <stop class="far" offset="0" />
      <stop class="near" offset="1" />
    </linearGradient>
    <!-- The light over the strike line, which is where a player is looking. A glow, and the one
         this app allows: the subject of the picture rather than an outline around a control. -->
    <radialGradient id={glow} cx="0.5" cy={shape.strike.y1 / HIGHWAY_HEIGHT} r="0.62">
      <stop class="lit" offset="0" stop-opacity="0.16" />
      <stop class="lit" offset="1" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect width={HIGHWAY_WIDTH} height={HIGHWAY_HEIGHT} fill="url(#{ground})" />
  <rect width={HIGHWAY_WIDTH} height={HIGHWAY_HEIGHT} fill="url(#{glow})" />

  {#each shape.lanes as points, i (i)}
    <polygon class="lane" class:odd={i % 2 === 1} {points} />
  {/each}

  {#each shape.beats as beat, i (i)}
    <line class="beat" x1={beat.x1} y1={beat.y1} x2={beat.x2} y2={beat.y2} />
  {/each}

  {#each shape.rails as rail, i (i)}
    <line
      class="rail"
      class:edge={i === 0 || i === shape.rails.length - 1}
      x1={rail.x1}
      y1={rail.y1}
      x2={rail.x2}
      y2={rail.y2}
    />
  {/each}

  <line
    class="strike"
    x1={shape.strike.x1}
    y1={shape.strike.y1}
    x2={shape.strike.x2}
    y2={shape.strike.y2}
  />

  {#each shape.frets as fret, i (i)}
    <ellipse class="fret" style="stroke: {FRETS[i]}" {...fret} />
  {/each}
</svg>

<style>
  .highway {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* A gradient stop is styled rather than given a `stop-color` attribute: `var()` is not
     resolved inside a presentation attribute, so the token has to arrive through CSS. */
  .far {
    stop-color: var(--ground-0);
  }
  .near {
    stop-color: var(--ground-3);
  }
  .lit {
    stop-color: var(--accent);
  }
  /* The lane floor. Two values a hair apart, so the lanes are told apart by a gradient in
     brightness rather than by lines alone, which is what the real highway's texture does. */
  .lane {
    fill: rgba(255, 255, 255, 0.006);
  }
  .lane.odd {
    fill: rgba(255, 255, 255, 0.018);
  }
  .beat {
    stroke: rgba(255, 255, 255, 0.05);
    stroke-width: 1;
  }
  .rail {
    stroke: rgba(255, 255, 255, 0.05);
    stroke-width: 1;
  }
  /* The two outer rails carry the lane's edge and take the accent, which is the only place in
     this drawing the app's own colour appears. */
  .rail.edge {
    stroke: var(--accent);
    stroke-opacity: 0.3;
  }
  .strike {
    stroke: var(--accent-tint);
    stroke-opacity: 0.9;
    stroke-width: 2.2;
    filter: drop-shadow(0 0 5px var(--accent));
  }
  /* Outlined and not filled. A filled fret is what a hit note looks like, and nothing is being
     hit: at rest these are five empty buttons waiting, which is what they are. */
  .fret {
    fill: rgba(0, 0, 0, 0.5);
    stroke-width: 2.2;
  }
  /* The one thing in the lane that moves, and only while a chart is being fetched and parsed,
     which on a long chart from Chorus is several seconds of a Play button that has visibly done
     nothing. The strike line is what brightens, because it is the part of a highway that answers
     when something arrives.

     No keyframe moves anything, so `animation: none` is a still frame and not a jump: the global
     reduced-motion rule in tokens.css turns this off and leaves the line lit at the value
     declared above, which is exactly the resting lane. That rule is the app's only
     reduced-motion machinery and this follows it rather than adding a second one in script. */
  .highway.opening .strike {
    animation: strike-wait 1.6s var(--ease) infinite;
  }
  @keyframes strike-wait {
    0%,
    100% {
      stroke-opacity: 0.9;
    }
    50% {
      stroke-opacity: 0.35;
    }
  }
</style>
