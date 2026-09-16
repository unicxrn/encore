<script lang="ts" module>
  /**
   * The app's icon set: nine Lucide glyphs, inlined.
   *
   * Before this existed the UI drew its icons with text (`✕` for close, `✓` and `+` for the
   * asset pills, `‹` for Back, an en dash and `▢` for the window controls) and those render
   * with whatever the font makes of them: a different weight from the stroked SVG icons in the
   * sidebar, a different optical size, and, for the close glyph, a shape that depended on which
   * fallback font had the codepoint. An icon set is what makes the marks read as one family.
   *
   * Lucide, because it is the stroked, 24-unit, round-capped style the sidebar's hand-drawn
   * icons already follow (they were drawn to the same grid at stroke 1.7), so the two sit side
   * by side without one looking heavier. Inlined rather than installed: nine paths do not earn
   * a dependency, and a package that ships a thousand icons invites the thousand-and-first.
   *
   * Every icon here is decorative (`aria-hidden`) because every place one is used already
   * names itself: an icon-only button carries an `aria-label`, and a pill puts the word beside
   * the mark. That is a rule, not a default: an icon that has to speak for itself needs a label
   * ON THE CONTROL, where a screen reader will find it, not on the picture inside it.
   *
   * `data-icon` is for the tests, which cannot see a path: it is the one thing that lets a test
   * assert "the present pill shows a check and the missing one a plus" without parsing d-strings.
   */
  export type IconName =
    'x' | 'minus' | 'square' | 'check' | 'plus' | 'chevron-left' | 'panel-right' | 'play' | 'folder'

  const PATHS: Record<IconName, string> = {
    x: 'M18 6 6 18M6 6l12 12',
    minus: 'M5 12h14',
    square: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    check: 'M20 6 9 17l-5-5',
    plus: 'M5 12h14M12 5v14',
    'chevron-left': 'm15 18-6-6 6-6',
    // The window with its right column divided off, which is the thing the control it labels
    // does: put this chart in that column. Lucide's own panel-right, its rect spelled as the
    // same rounded-square subpath `square` already uses so the two are the same drawing.
    'panel-right':
      'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM15 3v18',
    // Lucide's play and folder, for the two controls in the title bar. The play triangle is
    // stroked rather than filled like every other glyph here, so it reads at the same weight as
    // the window controls beside it rather than as a heavier mark.
    play: 'M6 3 20 12 6 21Z',
    folder:
      'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
  }
</script>

<script lang="ts">
  /**
   * `size` is the rendered box in px, applied as the SVG's own width and height so the glyph
   * scales with the viewBox and never with the surrounding font-size. A 12px icon in a pill and
   * a 16px one in a button should be the same drawing at two sizes, not two drawings.
   */
  let { name, size = 16 }: { name: IconName; size?: number } = $props()
</script>

<svg
  class="icon"
  data-icon={name}
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={PATHS[name]} />
</svg>

<style>
  .icon {
    display: block;
    flex-shrink: 0;
  }
</style>
