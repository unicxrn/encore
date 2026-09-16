<script lang="ts">
  import { HIGHWAY_GLOW_ALPHA, HIGHWAY_HEIGHT, HIGHWAY_WIDTH, highwayShape } from '../highway'
  import { FIVE_FRET, laneLayout } from '../preview/lane-skin'

  /**
   * What the lane is doing. `rest` is a still frame; `opening` is the seconds between pressing
   * Play and the first note, while a chart is being fetched, unpacked and parsed.
   */
  let { state = 'rest' }: { state?: 'rest' | 'opening' } = $props()

  // Constant, so it is computed once for the life of the module rather than per instance: the
  // lane has no inputs, and both places that draw it draw the same lane at a different size.
  // The package's five-fret lane whatever the selects say; see `HIGHWAY_FRETS`.
  const shape = highwayShape(laneLayout(FIVE_FRET))
  const glowScale = shape.glow.ry / shape.glow.rx

  // The gradient is referenced by id, and the rail and the chart page's pane can both be on
  // screen at once. Two elements sharing one id is one gradient between them, so each instance
  // gets its own.
  const uid = $props.id()
  const glow = `hw-glow-${uid}`
</script>

<!-- Decorative. Everything it says is said in words elsewhere: the badge in the corner names the
     track, the state line under the transport says what the preview is doing, and the Play button
     beside it is what starts one.

     `slice` and not `none`. The drawing is the package's camera worked out in advance, and that
     camera scales a lane against the box's HEIGHT: scaling to the height and cropping the width
     is what makes this box the same box the renderer will draw in a moment. Stretching it to fit
     would be a lane that changes shape with the window. -->
<svg
  class="highway {state}"
  viewBox="0 0 {HIGHWAY_WIDTH} {HIGHWAY_HEIGHT}"
  preserveAspectRatio="xMidYMid slice"
  style:--hw-strike-blur="{2.5 * shape.strike.width}px"
  aria-hidden="true"
  focusable="false"
>
  <defs>
    <!-- The light over the strike line, which is where a player is looking. A glow, and the one
         this app allows: the subject of the picture rather than an outline around a control. It
         is drawn into the strike line's own sprite, so it is squashed to that sprite's height and
         cut off at its edges, and this is that ellipse rather than a light over the whole box. -->
    <radialGradient
      id={glow}
      gradientUnits="userSpaceOnUse"
      cx={shape.glow.cx}
      cy={shape.glow.cy}
      r={shape.glow.rx}
      gradientTransform="translate({shape.glow.cx} {shape.glow
        .cy}) scale(1 {glowScale}) translate({-shape.glow.cx} {-shape.glow.cy})"
    >
      <stop class="lit" offset="0" stop-opacity={HIGHWAY_GLOW_ALPHA} />
      <stop class="lit" offset="1" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect class="void" width={HIGHWAY_WIDTH} height={HIGHWAY_HEIGHT} />
  <polygon class="apron" points={shape.plane} />
  <polygon class="bed" points={shape.bed} />

  {#each shape.lanes as points, i (i)}
    <polygon class="lane" class:odd={i % 2 === 1} {points} />
  {/each}

  {#each shape.beats as points, i (i)}
    <polygon class="beat" {points} />
  {/each}

  {#each shape.rails as points, i (i)}
    <polygon class="rail" class:edge={i === 0 || i === shape.rails.length - 1} {points} />
  {/each}

  <rect
    class="glow"
    x={shape.glow.x}
    y={shape.glow.y}
    width={shape.glow.width}
    height={shape.glow.height}
    fill="url(#{glow})"
  />

  <line
    class="strike"
    x1={shape.strike.x1}
    y1={shape.strike.y1}
    x2={shape.strike.x2}
    y2={shape.strike.y2}
    stroke-width={shape.strike.width}
  />

  {#each shape.frets as fret, i (i)}
    <ellipse
      class="fret"
      style="stroke: {fret.colour}"
      cx={fret.cx}
      cy={fret.cy}
      rx={fret.rx}
      ry={fret.ry}
      stroke-width={shape.strike.width}
    />
  {/each}
</svg>

<style>
  .highway {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* Outside the highway plane there is nothing. The plane is finite and the renderer clears its
     canvas to opaque black, so this is what the box is once a preview opens: black, and not a
     step in Encore's scale, because it is not one of them. */
  .void {
    fill: #000000;
  }
  /* The plane. The two ground steps are spent across the lane rather than down it, which is what
     the texture under the playing preview does and for the same reason: the apron outside the
     rails is the recessed step and the lane floor is the card step. The depth belongs to the
     camera. */
  .apron {
    fill: var(--ground-0);
  }
  .bed {
    fill: var(--ground-3);
  }
  /* A gradient stop is styled rather than given a `stop-color` attribute: `var()` is not
     resolved inside a presentation attribute, so the token has to arrive through CSS. */
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
  /* Filled and not stroked. A rail is a mark on a surface running away from the viewer, so it
     narrows with the lane; a stroke is one width along its whole length and would be several
     times too heavy at the horizon. `highwayQuad` is what gives each of these four corners. */
  .beat {
    fill: rgba(255, 255, 255, 0.05);
  }
  .rail {
    fill: rgba(255, 255, 255, 0.05);
  }
  /* The two outer rails carry the lane's edge and take the accent, which is the only place in
     this drawing the app's own colour appears. */
  .rail.edge {
    fill: var(--accent);
    fill-opacity: 0.3;
  }
  .strike {
    stroke: var(--accent-tint);
    stroke-opacity: 0.9;
    /* The blur the sprite's own shadow is drawn with, scaled to the line: a fixed length here
       would be a halo that grew every time the lane got smaller. */
    filter: drop-shadow(0 0 var(--hw-strike-blur) var(--accent));
  }
  /* Outlined and not filled. A filled fret is what a hit note looks like, and nothing is being
     hit: at rest these are five empty buttons waiting, which is what they are. */
  .fret {
    fill: rgba(0, 0, 0, 0.5);
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
