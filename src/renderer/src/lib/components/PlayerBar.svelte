<script lang="ts">
  import { msToTime } from '../../../../shared/format'
  import { downloads } from '../stores/downloads'
  import { scanProgress } from '../stores/scan'
  import { settings } from '../stores/settings'
  import {
    type NowPlaying,
    nowPlaying,
    playerRepeat,
    playerState,
    playerVolume,
    progress,
    seekTo,
    setPlayerVolume,
    togglePlay,
    toggleRepeat,
    viewportMounted
  } from '../stores/preview-controller'
  import DownloadsPanel from './DownloadsPanel.svelte'

  // Bindable so App-level chrome (sidebar Downloads item) can toggle the panel too.
  let { open = $bindable(false) }: { open?: boolean } = $props()

  const active = $derived($downloads.filter((d) => d.status === 'running' || d.status === 'queued'))
  const running = $derived($downloads.find((d) => d.status === 'running'))

  const idle = $derived($nowPlaying === null)
  // While PreviewPane is mounted it owns the transport (see `viewportMounted`), and the bar keeps
  // only what the pane does not carry: the title, the repeat toggle, the volume slider and the
  // downloads toggle.
  // Playback is view-bound, so any navigation unmounts the pane and hands the transport back.
  const ceded = $derived($viewportMounted)
  const isPlaying = $derived($playerState === 'playing')
  const percent = $derived($progress?.percent ?? 0)
  const currentMs = $derived($progress?.currentMs ?? 0)
  const totalMs = $derived($progress?.totalMs ?? 0)

  // Local covers come from the art protocol, which answers 404 when a chart's md5 has no
  // cached file (cache cleared, or a sweep raced the catalog row) and 400 when the md5 is
  // malformed; both arrive here as a failed load, and both should show the bar's placeholder
  // rather than a broken-image glyph.
  //
  // The failure is pinned to the NowPlaying object it happened on, not to the URL: the bar is
  // mounted outside the view chain and lives for the whole session, so a URL-keyed flag would
  // stay dead until restart even after a rescan repaired the file. The controller publishes a
  // fresh object on every open, so pinning to it expires the failure at the next play,
  // including a replay of the same chart.
  //
  // `$state.raw` and not `$state`: plain `$state` deep-proxies the object it is assigned, and the
  // proxy is never `===` the raw object the store still holds, so the comparison below would be
  // true forever and the placeholder would never appear at all.
  let failedTrack = $state.raw<NowPlaying | null>(null)
  const art = $derived($nowPlaying && $nowPlaying !== failedTrack ? $nowPlaying.artUrl : null)

  // The live volume while a preview owns one, the stored volume otherwise; both are written only
  // by the controller. Writable so a drag lands at once, and re-derived the moment either source
  // moves: the preview element's own shortcuts (↑/↓/M) change the live value behind this
  // slider's back, settings load asynchronously after mount, and while PreviewPane is mounted its
  // slider sits beside this one and commits through the controller into settings. A bar that
  // stopped listening once touched would sit at its own last value while the pane moved on.
  let volume = $derived($playerVolume ?? $settings.previewVolume)

  function onSeekClick(e: MouseEvent): void {
    if (idle) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (rect.width === 0) return
    seekTo(((e.clientX - rect.left) / rect.width) * 100)
  }

  function onVolumeInput(value: number): void {
    volume = value
    setPlayerVolume(value, { persist: false })
  }

  function onVolumeCommit(): void {
    setPlayerVolume(volume)
  }
</script>

<footer class="playerbar">
  <!-- The same three-part shape whether a chart is loaded or not: a 40px tile, a name, and a
       line under it. The bar used to answer the empty case with the word ENCORE, which named the
       app in the one place nobody needs telling and left the other two thirds of the group
       blank. What it says instead is what is true (nothing is previewing) and where a preview
       comes from, in the slots it will use for the chart's own name the moment there is one. -->
  <div class="now">
    {#if $nowPlaying}
      {#if art}
        <img class="art" src={art} alt="" onerror={() => (failedTrack = $nowPlaying)} />
      {:else}
        <div class="art placeholder"></div>
      {/if}
      <div class="meta">
        <span class="title">{$nowPlaying.title}</span>
        <!-- Artist and track on one line, which is the design's arrangement. The artist is the
             half that ellipsises and the track is pinned beside it, deliberately: the title
             above already carries the song, so a long artist crowding out which instrument and
             difficulty are playing would lose the only thing on this line the rest of the bar
             does not say. -->
        <span class="line">
          <span class="artist">{$nowPlaying.artist}</span>
          <span class="track">{$nowPlaying.track}</span>
        </span>
      </div>
    {:else}
      <div class="art tile" aria-hidden="true">
        <svg viewBox="0 0 24 24"
          ><path d="M9 17V6.2l9-2v10.6" /><circle cx="6.6" cy="17.2" r="2.6" /><circle
            cx="15.6"
            cy="14.9"
            r="2.6"
          /></svg
        >
      </div>
      <div class="meta">
        <span class="title resting">Nothing previewing</span>
        <span class="line"><span class="artist">Press play on a chart</span></span>
      </div>
    {/if}
  </div>

  <!-- Ceded by fading, not by removal: the bar is 70px whatever it holds, and the transport keeps
       its `flex: 1` so the slot stays reserved and the title and volume do not slide when it goes.
       A faded control is still a control, hence `inert` (no Tab stop, no pointer target) and
       `aria-hidden` (no announcement) for as long as the pane owns playback. -->
  <div class="transport" class:ceded inert={ceded} aria-hidden={ceded}>
    <!-- One control where the design's control group has five, and a second of the five,
         repeat, is over in `.right` for the reason given there.

         Shuffle, previous and next all need a sequence, and Encore has none. It previews one
         chart, the one the rail or the chart page is pointed at: nothing hands the controller a
         list, `openPreview` replaces whatever was playing, and pointing the rail somewhere new
         closes the old preview outright. Nor are they drawn disabled, the way the sidebar draws
         the two features that are merely unbuilt: a disabled control says "later", and these
         would be promising a play queue this app has no reason to grow. -->
    <button
      class="play"
      disabled={idle}
      onclick={togglePlay}
      aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
    >
      {#if isPlaying}
        <svg viewBox="0 0 24 24" aria-hidden="true"
          ><rect x="8" y="7" width="3" height="10" /><rect
            x="13"
            y="7"
            width="3"
            height="10"
          /></svg
        >
      {:else}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5 17.5 12 9 17.5Z" /></svg>
      {/if}
    </button>
    <span class="time">{totalMs > 0 ? msToTime(currentMs) : '0:00'}</span>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="seek" class:disabled={idle} onclick={onSeekClick}>
      <div class="track"><div class="fill" style:--p={percent / 100}></div></div>
      <div class="knob" style:--p={percent / 100}></div>
    </div>
    <span class="time">{totalMs > 0 ? msToTime(totalMs) : '0:00'}</span>
  </div>

  <div class="right">
    <!-- Repeat sits with the volume slider rather than beside play, which is not where the
         design draws it.

         The transport above fades out for as long as a viewport is registered, and a viewport is
         registered whenever anything is playing: a preview can only exist inside one. Measured
         at all five widths and from both surfaces that start a preview
         (`scripts/measure-player-bar.mjs`), the transport is ceded in every state where the bar
         has a chart in it. A repeat drawn there would be reachable only while nothing was
         playing, which is the one time nobody wants it. This group is the one the bar keeps, and
         repeat belongs to it for the same reason the volume slider does: neither the rail nor
         the chart page carries one.

         Not disabled while idle either, unlike play: it is a mode rather than an action, it
         outlives the chart it was armed on, and arming it before pressing Play in the rail is a
         thing to do. -->
    <button
      class="repeat"
      onclick={toggleRepeat}
      aria-pressed={$playerRepeat}
      title="Play the preview again when it ends"
      aria-label="Repeat"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><path
          d="M17 3l3 3-3 3M4 12V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 12v3a3 3 0 0 1-3 3H4"
        /></svg
      >
    </button>
    <input
      class="vol"
      type="range"
      min="0"
      max="100"
      step="1"
      value={volume}
      aria-label="Preview volume"
      oninput={(e) => onVolumeInput(Number(e.currentTarget.value))}
      onchange={onVolumeCommit}
    />
    <!-- The same panel the sidebar's Downloads row toggles, so the same state word
         (`aria-expanded`) and the same open-state visual (`.open`), off the same `open`
         that App binds both to. -->
    <button class="dl" class:open aria-expanded={open} onclick={() => (open = !open)}>
      {#if active.length}
        DOWNLOADING {active.length}{running?.percent != null ? ` · ${running.percent}%` : ''}
      {:else}
        DOWNLOADS
      {/if}
    </button>
    {#if $scanProgress && $scanProgress.status === 'running'}
      <span class="scan"
        >SCAN {$scanProgress.percent != null
          ? `${$scanProgress.percent}%`
          : $scanProgress.phase.toUpperCase()}</span
      >
    {/if}
  </div>
  <!-- Inside the footer, not after it, so the panel opens and closes with the bar's own
       state. Where it sits is App's business: the panel anchors to App's `.foot`, the box
       holding this bar AND the runtime error strip above it (see DownloadsPanel's `.panel`). -->
  {#if open}
    <DownloadsPanel onclose={() => (open = false)} />
  {/if}
</footer>

<style>
  .playerbar {
    display: flex;
    align-items: center;
    gap: 16px;
    /* Row 3 of the app shell is 70px and this bar is what fills it. The number lives here
       rather than being inherited from the row, because the row is content-sized against this
       box: see App's `.foot`, where that is what lets the error strip appear without moving
       the bar. */
    height: 70px;
    flex-shrink: 0;
    padding: 0 16px;
    background: var(--surface-1);
    border-top: 1px solid var(--hairline);
    /* Deliberately NOT `position: relative`: the downloads panel must anchor to App's `.foot`,
       not to this bar, or it lands on the runtime error strip. */
  }
  .now {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 240px;
    min-width: 0;
  }
  .art {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    object-fit: cover;
    flex-shrink: 0;
  }
  .art.placeholder {
    background: var(--surface-2);
  }
  /* The resting tile. Outlined rather than filled flat, so the empty group reads as a box
     waiting for a cover rather than as a grey smudge, and a glyph rather than a play triangle:
     a triangle in the slot beside a real play button is a second button that does nothing. */
  .art.tile {
    background: var(--ground-2);
    border: 1px solid var(--border-1);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-3);
  }
  .art.tile svg {
    width: 17px;
    height: 17px;
    fill: currentColor;
    stroke: currentColor;
    stroke-width: 1.7;
  }
  .art.tile path {
    fill: none;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title,
  .artist {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-size: var(--fs-secondary);
    font-weight: 600;
    color: var(--text-1);
  }
  /* An absence is not a name: the resting line takes the second text level, so the bar with
     nothing in it does not sit at the same weight of voice as the bar with a song in it. */
  .title.resting {
    color: var(--text-2);
  }
  .line {
    display: flex;
    align-items: baseline;
    min-width: 0;
  }
  .artist {
    min-width: 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
  }
  /* Never shrinks: see the note beside the markup. The separator belongs to the track and not
     to the artist, so a chart whose artist is empty gets the track with nothing in front of
     it rather than a middot floating at the start of the line. */
  .track {
    flex: none;
    font-size: var(--fs-caption);
    color: var(--text-3);
    white-space: nowrap;
  }
  .artist:not(:empty) + .track::before {
    content: ' · ';
    white-space: pre;
  }
  .transport {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    /* Opacity, never width or display: the bar's height and the neighbours' positions must not
       move when the transport comes or goes. Visibility rides along so a hidden transport is
       also hidden from hit-testing in engines that ignore `inert`; on the way out it waits for
       the fade, on the way in it flips at once. tokens.css zeroes both under reduced motion. */
    transition:
      opacity var(--t-fast) var(--ease),
      visibility 0s linear;
  }
  .transport.ceded {
    opacity: 0;
    visibility: hidden;
    transition:
      opacity var(--t-fast) var(--ease),
      visibility 0s linear var(--t-fast);
  }
  .play {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    position: relative;
    transition:
      background var(--t-fast) var(--ease),
      opacity var(--t-fast) var(--ease);
  }
  /* A 32px circle is the visual; the thing the pointer has to land on is 44px. The extra
     reach is invisible and the bar is 70px tall, so it costs nothing on screen. */
  .play::after {
    content: '';
    position: absolute;
    inset: -6px;
  }
  .play:hover:not(:disabled) {
    background: var(--accent-hi);
  }
  .play:disabled {
    background: var(--surface-2);
    color: var(--text-3);
    cursor: default;
  }
  .play svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }
  /* Quieter than play and smaller, which is the design's own ratio between the two, with the
     same invisible 44px reach: 28px of circle and 8px of overhang on every side. */
  .repeat {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text-2);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    position: relative;
    transition:
      background var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .repeat::after {
    content: '';
    position: absolute;
    inset: -8px;
  }
  .repeat:hover {
    background: var(--surface-2);
    color: var(--text-1);
  }
  .repeat svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }
  /* --accent-text measures 7.3:1 on --surface-1 (tokens.css), which is the same violet the
     DOWNLOADS label goes when its panel is open, so the bar has one colour for "this is on". */
  .repeat[aria-pressed='true'] {
    color: var(--accent-text);
  }
  /* Colour is not the whole signal. `aria-pressed` carries the state to a screen reader and this
     dot carries it to anyone who cannot separate --accent-text from --text-2, which is the same
     pair of hues the rest of the bar asks nobody to tell apart. */
  .repeat[aria-pressed='true']::before {
    content: '';
    position: absolute;
    left: 50%;
    bottom: 0;
    width: 3px;
    height: 3px;
    margin-left: -1.5px;
    border-radius: 50%;
    background: currentColor;
  }
  .time {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
    min-width: 4ch;
    text-align: center;
  }
  .seek {
    position: relative;
    flex: 1;
    max-width: 480px;
    padding: 8px 0;
    cursor: pointer;
  }
  .seek.disabled {
    cursor: default;
  }
  .track {
    height: 4px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }
  /* Driven by `--p` (0 to 1) through a transform rather than by an animated width: a width change
     re-lays out the track on every progress tick, while scaleX is composited. Same visual.
     The gradient is painted before the scale, so it runs across the filled part rather than
     across the whole track, which is the design's own arrangement. */
  .fill {
    height: 100%;
    width: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--accent-hi));
    transform-origin: left;
    transform: scaleX(var(--p, 0));
    transition: transform var(--t-fast) linear;
  }
  /* The handle the design draws, and the thing that says this bar can be dragged rather than
     merely watched. A zero-height box the width of the track, translated by a percentage of its
     own width and therefore of the track: the same composited move as the fill, with no
     arithmetic that needs to know how wide the bar is. The dot hangs off the box's left edge so
     that edge is the position and the dot is centred on it. */
  .knob {
    position: absolute;
    left: 0;
    top: 50%;
    width: 100%;
    height: 0;
    pointer-events: none;
    transform: translateX(calc(var(--p, 0) * 100%));
    transition: transform var(--t-fast) linear;
  }
  .knob::after {
    content: '';
    position: absolute;
    left: -5px;
    top: -5px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #fff;
    box-shadow: var(--elev-1);
  }
  .right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    width: 240px;
  }
  .vol {
    width: 72px;
    accent-color: var(--accent);
    /* The one control in the bar that showed the arrow cursor. */
    cursor: pointer;
  }
  .dl,
  .scan {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    white-space: nowrap;
  }
  /* Padding rather than a bigger label: the text stays 12px mono, the hit box becomes 32px
     tall inside the 70px bar. Negative side margins keep the label where it was. */
  .dl {
    background: none;
    border: 0;
    padding: 10px 6px;
    margin: 0 -6px;
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .dl:hover {
    color: var(--text-1);
  }
  /* Panel open: the label goes violet, which is the same signal the sidebar's Downloads row
     gives (its glyph and chevron turn --accent-text). Colour only, and no fill: the bar has
     nowhere to put a chevron without moving the label, and the open panel is sitting right
     above this control. --accent-text measures 6.8:1 on --surface-1 (tokens.css), AA for
     this 12px caption. Hover keeps its text-1, above, so the control still answers the mouse. */
  .dl.open {
    color: var(--accent-text);
  }
  .dl.open:hover {
    color: var(--text-1);
  }
</style>
