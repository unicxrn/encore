<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { albumArtUrl } from '../api/enchor'
  import { artUrl } from '../../../../shared/art'
  import { msToTime, fallbackChartName, stripRichText } from '../../../../shared/format'
  import {
    localHealth,
    remoteHealth,
    healthPhrase,
    healthScore,
    healthSummary
  } from '../chart-health'
  import { INTENSITY_SCALE_TOP } from '../api/advanced'
  import { diffMatrix, instrumentColorVar, type DiffKey } from '../matrix'
  import { partState } from '../../../../shared/format'
  import { encore } from '../stores/bridge'
  import { favouriteId, favouriteKey, isFavouritable } from '../../../../shared/favourites'
  import { favouriteIds, toggleFavourite } from '../stores/favourites'
  import { canJoinASetlist, setlistEntryKey, SETLIST_NAME_MAX } from '../../../../shared/setlists'
  import { createSetlist, setlists, setlistsWith, setSetlistEntry } from '../stores/setlists'
  import {
    nowPlaying,
    playerError,
    playerState,
    progress,
    closePreview,
    openPreview,
    registerViewport,
    seekTo,
    togglePlay,
    viewportOwner
  } from '../stores/preview-controller'
  import type { ChartTarget } from './Home.svelte'
  import type { PreviewSource } from '../preview/player'
  import Highway from './Highway.svelte'

  /**
   * `onOpenDetail` is the rail's way through to the chart page, and the only one Explore has.
   *
   * Required rather than optional: the rail answers "is this the chart I want" and the page
   * answers everything else, and a callback with a no-op default is how the half of that pair
   * which nothing can reach gets shipped.
   */
  let {
    target,
    onOpenDetail
  }: { target: ChartTarget | null; onOpenDetail: (target: ChartTarget) => void } = $props()

  const chart = $derived(target?.kind === 'remote' ? target.chart : null)
  const record = $derived(target?.kind === 'local' ? target.record : null)

  const title = $derived.by(() => {
    if (chart) return stripRichText(chart.name)
    if (record) return stripRichText(record.name) || fallbackChartName(record.path)
    return ''
  })
  const artist = $derived(stripRichText(chart?.artist ?? record?.artist))
  const charter = $derived(stripRichText(chart?.charter ?? record?.charter))

  /**
   * The dim line under the artist: album, year and genre, and only the ones this chart has.
   *
   * Joined rather than laid out in three slots, so a chart with no album does not leave a
   * leading separator floating at the start of the line. Empty for a chart that carries none of
   * the three, which is what `:empty` in the stylesheet removes rather than leaving a blank row
   * in a head whose height is otherwise set by the cover beside it.
   */
  const context = $derived.by(() => {
    const album = stripRichText(chart?.album ?? record?.album)
    const year = chart?.year?.trim() || (record?.year != null ? String(record.year) : '')
    const genre = stripRichText(chart?.genre ?? record?.genre)
    return [album, year, genre].filter(Boolean).join(' · ')
  })

  let artFailed = $state(false)
  const coverUrl = $derived.by<string | null>(() => {
    if (artFailed) return null
    if (chart?.albumArtMd5) return albumArtUrl(chart.albumArtMd5)
    return artUrl(record?.albumArtMd5)
  })

  /**
   * What the art box shows when the chart ships no cover, or when the cover fails to load.
   *
   * A letter rather than an empty square or a generic disc glyph. The box is 76px and the rail
   * holds one chart at a time, so the only job left for it is to stop being a gap in the head,
   * and an initial does that while still differing from chart to chart. It deliberately does not
   * say "no art": the health card below already carries an album art row, and saying it twice on
   * one screen would be the rail contradicting nothing and repeating itself.
   *
   * Empty for a title with no letter or digit in it at all, which leaves the tinted, bordered box
   * on its own. Decorative either way: the name is in the four lines beside it.
   */
  const monogram = $derived.by(() => {
    for (const ch of title) if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase()
    return ''
  })

  const health = $derived(record ? localHealth(record) : chart ? remoteHealth(chart) : [])
  const summary = $derived(healthSummary(health))
  const score = $derived(healthScore(health))

  /**
   * The ring's arc, in the units an SVG circle takes.
   *
   * r = 25 and stroke-width 6 inside a 56px box, so the stroke sits fully inside its viewBox at
   * both ends of the arc rather than being clipped by it: 25 + 3 = 28, which is exactly the
   * half-box. The circumference is computed rather than written down, because a radius edited
   * without its dasharray is a ring that reports the wrong number while still looking like a
   * ring.
   */
  const RING_R = 25
  const RING_C = 2 * Math.PI * RING_R
  const ringOffset = $derived(RING_C * (1 - (score ?? 0) / 100))
  /**
   * Green only when nothing known is missing, amber otherwise, and no third threshold.
   *
   * The same two colours the checklist's own glyphs take, so the ring cannot disagree with the
   * list beside it. A red band at some score would need a cut-off nobody measured, and "half of
   * the assets are missing" is not a worse kind of problem than "one is", it is more of it.
   */
  const ringColor = $derived(
    summary !== null && summary.present === summary.known ? 'var(--success)' : 'var(--warning)'
  )

  // Same source, same shape, same helper as the chart page's matrix: the catalog stores note
  // counts under the field names the API returns, so one call covers both kinds of target.
  const noteCounts = $derived(chart?.notesData?.noteCounts ?? record?.noteCounts)
  const matrixRows = $derived(diffMatrix(noteCounts))

  interface DiffOption {
    value: string
    label: string
    /** The word on its own, for the badge over the highway, where the letter would be noise. */
    word: string
    key: DiffKey
  }

  // The letters the difficulty matrix uses, so the rail's selector and the chart page's grid
  // read as one vocabulary rather than two.
  const DIFFICULTY_OPTIONS: readonly DiffOption[] = [
    { value: 'expert', label: 'Expert (X)', word: 'Expert', key: 'X' },
    { value: 'hard', label: 'Hard (H)', word: 'Hard', key: 'H' },
    { value: 'medium', label: 'Medium (M)', word: 'Medium', key: 'M' },
    { value: 'easy', label: 'Easy (E)', word: 'Easy', key: 'E' }
  ]

  const instrumentList = $derived.by<{ value: string; label: string }[]>(() => {
    const rows = matrixRows.map((row) => ({ value: row.instrument, label: row.label }))
    if (rows.length > 0) return rows
    // A chart scanned before the catalog stored note counts has no matrix, and an empty select
    // would be worse than a guess: the chart may well hold a guitar track nothing recorded.
    return [{ value: 'guitar', label: 'Guitar' }]
  })

  const difficultyList = $derived.by<readonly DiffOption[]>(() => {
    const row = matrixRows.find((r) => r.instrument === instrument)
    if (!row) return DIFFICULTY_OPTIONS
    const present = DIFFICULTY_OPTIONS.filter((opt) => row.diffs[opt.key])
    return present.length > 0 ? present : DIFFICULTY_OPTIONS
  })

  let instrument = $state('guitar')
  const instrumentVar = $derived(instrumentColorVar(instrument))
  let difficulty = $state('expert')

  // What the badge over the highway says the preview would play. Read off the same two lists the
  // selects are built from, so it cannot name a track the selects do not offer.
  const trackLabel = $derived(
    `${DIFFICULTY_OPTIONS.find((o) => o.value === difficulty)?.word ?? difficulty} · ` +
      `${instrumentList.find((o) => o.value === instrument)?.label ?? instrument}`
  )

  // Keep the two selections answerable by the chart in front of us. Written the way the chart
  // page's preview pane writes them, for the same reason: switching instrument can drop the
  // difficulty that was selected, and a select showing a value it no longer offers is a lie.
  $effect(() => {
    const list = instrumentList
    if (!list.some((opt) => opt.value === instrument)) instrument = list[0].value
  })
  $effect(() => {
    const list = difficultyList
    if (!list.some((opt) => opt.value === difficulty)) difficulty = list[0].value
  })

  // ─── what the selected track is made of ───────────────────────────────────
  /**
   * Three numbers, chosen the way step three chose its badges: by whether they change anything.
   *
   * Notes and peak notes per second are the two facts that differ between one instrument's Expert
   * and another's Easy, which is the question the two selects above them exist to ask. Length is
   * the song's rather than the track's, and it is here because the transport beside it reads
   * 0:00 / 0:00 until something is playing, so without it the rail cannot say how long the chart
   * is until the user commits to listening to it.
   *
   * Six booleans were available and five are out. hasLyrics, hasOpenNotes, hasTapNotes and
   * hasSoloSections were measured over 100 charts from api.enchor.us on 2026-09-15 at 62, 61, 57
   * and 44; a flag set on half of Chorus separates nothing, and hasLyrics already has a row of
   * its own in the health list. hasFlexLanes has no measured frequency at all and no decision
   * hanging off it. has2xKick is the one that stays, because it is rare, because a double pedal
   * is a thing a drummer either owns or does not, and because the rail knows which part is
   * selected and can therefore show it only where it is a fact about the track on screen.
   */
  const maxNps = $derived<readonly { instrument: string; difficulty: string; nps: number }[]>(
    chart?.notesData?.maxNps ?? record?.maxNps ?? []
  )
  const selectedNotes = $derived(
    (noteCounts ?? []).find((e) => e.instrument === instrument && e.difficulty === difficulty)
      ?.count ?? null
  )
  const selectedNps = $derived(
    maxNps.find((e) => e.instrument === instrument && e.difficulty === difficulty)?.nps ?? null
  )
  const songLength = $derived(chart ? chart.song_length : (record?.songLength ?? null))
  const doubleKick = $derived(
    instrument === 'drums' && (chart?.notesData?.has2xKick ?? record?.has2xKick ?? false)
  )

  /**
   * Notes per second across the whole song, which is not the same number as the peak beside it.
   *
   * Derived rather than stored, because nothing stores it: the catalog holds note counts and a
   * peak rate and no average, and computing one in the scanner would cost every user a rescan
   * for a division the renderer can do. Deliberately over the SONG's length, including whatever
   * silence the audio starts and ends with, so a chart with a 40 second intro reads lower here
   * than it plays. The honest name for it is therefore "notes per second of song", which is what
   * the label says; a figure over the charted span would need a first and last note timestamp,
   * and neither the record nor the search result carries one.
   */
  const avgNps = $derived.by<number | null>(() => {
    if (selectedNotes === null || songLength === null || songLength <= 0) return null
    return selectedNotes / (songLength / 1000)
  })

  /**
   * song.ini's intensity rating for the part on screen, and only for that part.
   *
   * The catalog carries ten of these and the search API five, so a rhythm or GHL track selected
   * on a chart from Chorus has no rating to show and dashes out. `partState` is the one place
   * that decides what a rating means: it reads the instruments list first, because six charts in
   * a hundred rate a part their notes do not contain, and it separates "charted, nobody said how
   * hard" from "rated 0". Both of those are a dash here; the number is the only thing this cell
   * can say without a second line to say it in.
   */
  const instrumentNames = $derived<readonly string[]>(
    chart?.notesData?.instruments ?? record?.instruments ?? []
  )
  const ratings = $derived.by<Record<string, number | null | undefined>>(() => {
    if (chart) {
      return {
        guitar: chart.diff_guitar,
        bass: chart.diff_bass,
        drums: chart.diff_drums,
        keys: chart.diff_keys
      }
    }
    if (!record) return {}
    return {
      guitar: record.diffGuitar,
      bass: record.diffBass,
      drums: record.diffDrums,
      keys: record.diffKeys,
      rhythm: record.diffRhythm,
      guitarcoop: record.diffGuitarCoop,
      guitarghl: record.diffGuitarGhl,
      bassghl: record.diffBassGhl,
      rhythmghl: record.diffRhythmGhl,
      guitarcoopghl: record.diffGuitarCoopGhl
    }
  })
  const intensity = $derived.by<string>(() => {
    const state = partState(instrumentNames, instrument, ratings[instrument])
    return state.kind === 'rated' ? `${state.tier}/${INTENSITY_SCALE_TOP}` : '—'
  })

  // Both counts come off the same matrix the instrument select is built from, so the card can
  // never report a track the select does not offer.
  const trackCount = $derived(matrixRows.length)
  const diffCount = $derived.by<number | null>(() => {
    const row = matrixRows.find((r) => r.instrument === instrument)
    if (!row) return null
    return (Object.values(row.diffs) as boolean[]).filter(Boolean).length
  })

  /**
   * Whether the chart marks out solo sections, which Clone Hero scores a bonus for.
   *
   * Step five turned this down as a row badge and was right to: measured at 44 of 100 charts on
   * api.enchor.us, a flag set on half the catalog separates nothing when you are scanning thirty
   * rows for one to download. This card asks a different question. It is about the one chart in
   * front of the user, where "does this have solos" is a fact somebody wants before they commit
   * to practising it, and a value shared with half the catalog is no less true for being common.
   *
   * Null, not false, when nothing read the notes. A record's flag defaults to false, so the
   * empty note counts are what separate "no solos" from "never looked" - the same test
   * `chart-health` applies to the note counts themselves.
   */
  const soloSections = $derived.by<boolean | null>(() => {
    if (chart) return chart.notesData?.hasSoloSections ?? null
    if (!record) return null
    if (!record.noteCounts || record.noteCounts.length === 0) return null
    return record.hasSoloSections
  })

  /**
   * The eight cells, in the two columns the panel draws them in.
   *
   * Four of the design's eight do not exist in Encore's data and are not here: sustains, chords,
   * HOPO share and star power are all note-level shapes nothing records, and putting any of them
   * on screen needs a scanner pass and a SCAN_VERSION bump that re-reads every user's library.
   *
   * What replaces them keeps the split the design had. The left column is the selected track,
   * the four numbers that change when either select above changes. The right column is the shape
   * of the chart as a whole, which does not.
   */
  const statCells = $derived.by<{ label: string; value: string }[]>(() => [
    { label: 'Notes', value: selectedNotes === null ? '—' : selectedNotes.toLocaleString() },
    { label: 'Intensity', value: intensity },
    { label: 'NPS avg', value: avgNps === null ? '—' : avgNps.toFixed(1) },
    { label: 'Difficulties', value: diffCount === null ? '—' : String(diffCount) },
    { label: 'NPS peak', value: selectedNps === null ? '—' : selectedNps.toFixed(1) },
    { label: 'Tracks', value: trackCount === 0 ? '—' : String(trackCount) },
    { label: 'Length', value: msToTime(songLength) },
    { label: 'Solos', value: soloSections === null ? '—' : soloSections ? 'Yes' : 'No' }
  ])

  // ─── the actions that exist ───────────────────────────────────────────────
  /**
   * The rail offers the ones its subject can answer, and no more.
   *
   * A chart on Chorus can be downloaded and nothing else: reveal and remove both take a path on
   * disk, and it has none. A chart in the library is the other way round, so it gets Show in
   * folder. The heart is the one control here that both kinds of subject can answer, because a
   * favourite is attached to the chart rather than to a copy of one (shared/favourites.ts): the
   * same press on a Chorus result and on the chart it becomes once downloaded is the same row.
   * Add to setlist is the third of them and is the same kind of control for the same reason: a
   * setlist entry is keyed on the chart too (shared/setlists.ts), so a chart put in a setlist from
   * here before it is downloaded is already in it when it arrives.
   *
   * Removal is deliberately not here, and it is the one of the three that was turned down rather
   * than being unavailable. Installed's own Remove does bookkeeping the rail cannot: it drops the
   * row, adjusts the three counts beside it, and puts the Trash and play-history promises in full
   * next to the path being removed. A second removal path that did none of that would leave the
   * list on screen showing a chart that is gone and the rail naming one, because the rail's
   * subject survives every navigation and would survive this too.
   */
  let actionError = $state<string | null>(null)

  async function reveal(): Promise<void> {
    const r = record
    if (r === null) return
    actionError = null
    try {
      await encore().chartReveal(r.path)
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * The three fields the heart attaches to, from whichever kind of subject the rail is showing.
   *
   * The raw values rather than the stripped ones already computed above for display: main
   * normalises, and it has to be the one that does, or a chart hearted from Explore and the same
   * chart hearted from Installed could end up as two rows. `favouriteKey` is only applied here to
   * answer the two questions this component asks of the value, which is whether the chart can be
   * hearted at all and whether it already is.
   */
  const favSubject = $derived({
    name: chart?.name ?? record?.name ?? null,
    artist: chart?.artist ?? record?.artist ?? null,
    charter: chart?.charter ?? record?.charter ?? null
  })
  /**
   * A chart with no name of its own cannot be hearted, and says so rather than pretending.
   *
   * The title on screen for such a chart is its folder name, which is a display fallback and not
   * an identity: two unnamed charts in two folders would be one favourite between them, and
   * renaming a folder would move it. Refusing is the smaller harm, and Encore's metadata editor
   * is the way out of it. See `isFavouritable`.
   */
  const favouritable = $derived(target !== null && isFavouritable(favouriteKey(favSubject)))
  /**
   * Why the heart is refused, said where the user pressed it rather than in a tooltip.
   *
   * The button carries `aria-disabled` and not `disabled`, which is the whole reason this string
   * exists: Chromium suppresses every event on a disabled control, its own tooltip included, so a
   * `title` there is a reason nobody can read and the button is a dead square with no explanation.
   * This way the press lands, and the sentence goes to the line a refused reveal already uses.
   */
  const UNNAMED_CHART =
    'This chart sets no name of its own, so there is nothing for a favourite to hold on to. ' +
    'Give it one in the metadata editor and the heart will keep.'
  const favourited = $derived(
    favouritable && $favouriteIds.has(favouriteId(favouriteKey(favSubject)))
  )

  /**
   * Which setlists hold this chart, and whether it can go in one at all.
   *
   * The same subject and the same refusal as the heart, through the same key: a chart with no name
   * of its own has nothing for an entry to hold on to either, so the button says so where it was
   * pressed rather than being a dead square. `favSubject` is reused rather than copied, because
   * the two controls have to be talking about the same chart or one could add what the other
   * cannot heart.
   */
  const setlistable = $derived(target !== null && canJoinASetlist(setlistEntryKey(favSubject)))
  const UNNAMED_FOR_SETLIST =
    'This chart sets no name of its own, so there is nothing for a setlist to hold on to. ' +
    'Give it one in the metadata editor and it can go in one.'
  const inSetlists = $derived(setlistsWith($setlists, favSubject))
  /**
   * The panel under the row, open or shut.
   *
   * Inline rather than a popover, which is the design decision worth recording. The rail is a
   *374px column that already scrolls, and the only two shapes available were a panel that pushes
   * the cards down and one positioned over them. The inline one needs no focus trap, no outside
   * click handler and no z-index against a scrolling parent, and the rail already puts a
   * conditional line (`act-error`) in exactly this place, so it is the shape this column has.
   *
   * Shut on every change of subject, by keying off `target`: a panel left open over a different
   * chart would be a list of ticks about the chart before it.
   */
  let setlistPanelOpen = $state(false)
  let newSetlistName = $state('')
  $effect(() => {
    void target
    untrack(() => {
      setlistPanelOpen = false
      newSetlistName = ''
    })
  })

  function openSetlistPanel(): void {
    if (!setlistable) {
      actionError = UNNAMED_FOR_SETLIST
      return
    }
    actionError = null
    setlistPanelOpen = !setlistPanelOpen
  }

  async function toggleSetlist(id: string, member: boolean): Promise<void> {
    actionError = null
    try {
      await setSetlistEntry(id, favSubject, member)
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * Make a setlist and put this chart in it, which is the one move a user in this panel wants.
   *
   * Two calls rather than one channel that does both: the create is the write that can be refused
   * (a name already taken, a name that is nothing), and folding the add into it would mean a
   * refusal that leaves the caller unsure which half happened. The new setlist is found by the
   * name main stored rather than by position, because the list is main's order and not this
   * component's guess at it.
   */
  async function addToNewSetlist(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const wanted = newSetlistName.trim()
    actionError = null
    try {
      await createSetlist(newSetlistName)
      const made = $setlists.find((list) => list.name === wanted)
      if (made !== undefined) await setSetlistEntry(made.id, favSubject, true)
      newSetlistName = ''
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    }
  }

  async function favourite(): Promise<void> {
    if (!favouritable) {
      actionError = UNNAMED_CHART
      return
    }
    actionError = null
    try {
      await toggleFavourite(favSubject, !favourited)
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    }
  }

  async function download(): Promise<void> {
    const c = chart
    if (c === null) return
    actionError = null
    try {
      await encore().downloadAdd({
        md5: c.md5,
        hasVideoBackground: c.hasVideoBackground,
        meta: { name: c.name, artist: c.artist, charter: c.charter }
      })
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    }
  }

  $effect(() => {
    void target
    artFailed = false
    actionError = null
  })

  // ─── the highway ──────────────────────────────────────────────────────────
  /**
   * The rail claims the preview viewport only while it is actually previewing.
   *
   * It cannot hold it permanently. `registerViewport` closes whatever preview is open, and
   * `viewportMounted` is what the player bar reads to decide whether to cede its transport, so
   * a rail that registered on mount would take the bar's play button away for the whole session
   * and would close the chart page's preview the moment the rail re-rendered. Claiming on the
   * first Play and letting go on close keeps both of those exactly as they were.
   *
   * `viewportOwner` is how the rail finds out it has been superseded: the chart page's pane
   * registers over this one without the mounted flag ever going false.
   *
   * The limit step two left open is closed by `releaseIfHidden` below.
   */
  let railEl = $state<HTMLElement | null>(null)
  let viewportEl = $state<HTMLDivElement | null>(null)
  let unregister: (() => void) | null = null
  let owns = $state(false)
  let opening = $state(false)
  let openError = $state<string | null>(null)

  /**
   * A window dragged under the shell's breakpoint gives the viewport back.
   *
   * Below it the rail is `display: none`, so without this a resize made while the rail is
   * previewing leaves a chart playing with nothing on screen that can stop it: the element is
   * hidden but alive, `viewportMounted` is still true, and the player bar is therefore still
   * ceding its transport to a column the user can no longer see. Releasing hands the transport
   * back and closes the preview, which is what every other way of leaving the rail already does.
   *
   * The breakpoint is not repeated here. The answer is read off the rail's own computed
   * `display`, so the number stays written down exactly once, in App.svelte's media query, and a
   * later change to it needs no matching edit in this file.
   */
  function releaseIfHidden(): void {
    if (!owns || railEl === null) return
    if (getComputedStyle(railEl).display !== 'none') return
    unregister?.()
    unregister = null
  }

  onMount(() => {
    const stop = viewportOwner.subscribe((owner) => {
      owns = owner !== null && owner === viewportEl
      // Superseded. The stored unregister is already a no-op against the controller's own
      // guard, so it is dropped rather than called.
      if (!owns && owner !== null) unregister = null
    })
    window.addEventListener('resize', releaseIfHidden)
    return () => {
      window.removeEventListener('resize', releaseIfHidden)
      stop()
      unregister?.()
      unregister = null
    }
  })

  async function buildSource(t: ChartTarget): Promise<PreviewSource> {
    if (t.kind === 'remote') {
      const { chartDownloadUrl } = await import('../api/enchor')
      return { kind: 'url', url: chartDownloadUrl(t.chart.md5, t.chart.hasVideoBackground) }
    }
    const files = await encore().chartReadFiles({
      path: t.record.path,
      chartType: t.record.chartType
    })
    return { kind: 'files', files }
  }

  async function play(): Promise<void> {
    const t = target
    if (t === null || opening) return
    if (owns && $nowPlaying !== null) {
      togglePlay()
      return
    }
    opening = true
    openError = null
    try {
      const source = await buildSource(t)
      const el = viewportEl
      if (el === null) return
      unregister = registerViewport(el)
      await openPreview({
        title,
        artist,
        artUrl: coverUrl,
        source,
        instrument,
        difficulty
      })
    } catch (err) {
      openError = err instanceof Error ? err.message : String(err)
    } finally {
      opening = false
    }
  }

  /**
   * A new subject closes the rail's own preview.
   *
   * Without this the rail would name one chart and play another: the rail outlives every
   * navigation, so a preview it started keeps running while the user opens something else, and
   * the art, the title and the health beside it would all have moved on. Closing matches what
   * the rest of the app already does, where playback is bound to the pane that started it and
   * navigating away ends it.
   *
   * Only the rail's own preview: `owns` is false while the chart page's pane holds the
   * viewport, and reaching into that one from here would stop the highway the user is watching.
   */
  $effect(() => {
    void target
    untrack(() => {
      if (owns) closePreview()
    })
  })

  // Changing either selection reloads: the controller has no reconfigure, only an open.
  function reopenIfPlaying(): void {
    if (!owns || $nowPlaying === null) return
    void play()
  }

  const live = $derived(owns && $nowPlaying !== null)
  const isPlaying = $derived(live && $playerState === 'playing')
  const percent = $derived(live ? ($progress?.percent ?? 0) : 0)
  const currentMs = $derived(live ? ($progress?.currentMs ?? 0) : 0)
  const totalMs = $derived(live ? ($progress?.totalMs ?? 0) : 0)

  function onSeekClick(e: MouseEvent): void {
    if (!live) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (rect.width === 0) return
    seekTo(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * 100)
  }

  const stateLine = $derived.by(() => {
    if (openError !== null) return `ERROR: ${openError}`
    if (live && $playerError !== null) return `ERROR: ${$playerError}`
    if (opening) return 'OPENING…'
    if (!owns && $viewportOwner !== null) return 'PREVIEW IS ON THE CHART PAGE'
    if (live) return $playerState.toUpperCase()
    // Nothing to report. The line used to read READY, which is a word the Play button beside it
    // already says, and it cost the column a row of its height on every chart to say it. Empty
    // rather than removed: the element is the live region, so it has to outlive its own text for
    // the next state to be announced into it.
    return ''
  })
</script>

<!-- A complementary landmark, not a second `main`: the rail is about whatever the content pane
     is about, and a screen reader that offers it as its own region has said enough. -->
<aside class="rail" aria-label="Chart detail" bind:this={railEl}>
  {#if target === null}
    <!-- The rail's only empty state, and it ends for good at the first chart of the session.
         See App's `railChart` for why it is not re-entered by navigating to Settings. -->
    <div class="empty">
      <div class="empty-mark" aria-hidden="true"></div>
      <p class="empty-line">Open a chart and it stays here.</p>
      <p class="empty-note">Art, instruments, the highway and what the chart is missing.</p>
    </div>
  {:else}
    <!-- Cover beside the name rather than above it, which is the design's arrangement and also
         the only one that fits: a full-width square cover put the column's content at about
         920px against the 680 a 1280x800 window gives it.

         It does not all fit even so. Measured with `scripts/measure-rail-panel.mjs`, the panel
         is 746px, so at 1280x800 the last 52px of the health card is below the fold and the
         column scrolls; from a window 866px tall it fits whole. What that height buys is spent
         on the eight-figure statistics card, which is 149px where the strip it replaced was 40.
         The order is what makes the overrun affordable: the head, the highway, the two selects
         and the action all sit in the first 419px, so nothing a user came here to press is ever
         the thing they have to scroll for. -->
    <div class="head">
      {#if coverUrl}
        <img class="art" src={coverUrl} alt="Album art" onerror={() => (artFailed = true)} />
      {:else}
        <div class="art placeholder" aria-hidden="true">{monogram}</div>
      {/if}
      <div class="ident selectable">
        <!-- Deliberately not a heading. The rail restates the chart the content pane is
             already headlining, and a second <h2> carrying the same words gives a screen reader
             two headings for one song. The landmark's own label is what names this column. -->
        <p class="title" {title}>{title}</p>
        <p class="artist" title={artist}>{artist || '—'}</p>
        <p class="context" title={context}>{context}</p>
        <p class="charter" title={charter}>{charter ? `Charted by ${charter}` : '—'}</p>
      </div>
    </div>

    <!-- The highway, directly under the name, which is the order the design puts them in: the
         cover says which chart and the highway says what playing it looks like, and everything
         below is detail on those two.

         The badge is the design's, and names the track the Play button would open. The score
         and multiplier it draws in the opposite corner are not here and cannot be: Encore's
         preview renders notes and plays audio, and has no scoring engine behind it, so a
         figure in that corner would be a number nobody computed. -->
    <section class="preview" aria-label="Preview">
      <div class="hw">
        <!-- The controller appends `<chart-preview-player>` here; Svelte never renders into it. -->
        <div class="viewport" bind:this={viewportEl}></div>
        <!-- The still lane, and the answer to what this box shows with nothing playing. It is
             drawn AFTER the viewport, which is to say over it: the player element that lands in
             there is opaque, and a picture underneath an opaque player is a picture nobody
             sees. -->
        <div class="rest" class:gone={live}>
          <Highway state={opening ? 'opening' : 'rest'} />
        </div>
        <span class="hwt mono" aria-hidden="true">{trackLabel}</span>
      </div>
      <div class="transport">
        <button
          class="play"
          onclick={() => void play()}
          disabled={opening}
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
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="seek" onclick={onSeekClick}>
          <div class="seek-fill" style="width:{percent}%"></div>
        </div>
        <span class="time mono">{msToTime(currentMs)} / {msToTime(totalMs)}</span>
      </div>
      <p class="state mono" role="status">{stateLine}</p>
    </section>

    <section class="picks" aria-label="Preview track">
      <label class="pick">
        <span class="pick-label mono">
          <!-- The part's colour, from the one mapping that owns it (instrumentColorVar). A
               swatch rather than a coloured label: the word has to stay readable at
               --fs-caption, and an instrument hue is chosen to be told apart from four other
               hues, not to carry 12px text. Decorative; the word beside it is the label. -->
          {#if instrumentVar}
            <span class="swatch" style="background: var({instrumentVar})" aria-hidden="true"></span>
          {/if}
          INST
        </span>
        <select bind:value={instrument} onchange={reopenIfPlaying}>
          {#each instrumentList as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
      <label class="pick">
        <span class="pick-label mono">DIFF</span>
        <select bind:value={difficulty} onchange={reopenIfPlaying}>
          {#each difficultyList as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
    </section>

    <!-- One row: the action this kind of chart has, the heart, and the way through to its full
         page. The action takes the width left over rather than being sized to its word, because a
         button floating at the left of a 374px column reads as the leftover of a row that lost its
         second control.

         The two icon buttons sit between them, which is the design's order: the action, then the
         controls that do something to the chart, then the way out of the column. Measured with
         `scripts/measure-rail-panel.mjs` at 1280x800: the action was 239px alone, 196px beside the
         heart, and is 153px now that the setlist button is there too, so each icon button costs it
         43px and the column no height at all, the row being one flex line whose tallest control is
         still 36px. Nothing is clipped at 153px: "Show in folder" is the longest word this button
         carries, longer than the "Download" a chart from Chorus gets. -->
    <div class="actions">
      {#if chart}
        <button class="act primary" onclick={() => void download()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"
            ><path d="M12 4v10m0 0 3.5-3.5M12 14l-3.5-3.5M5 19h14" /></svg
          >Download
        </button>
      {:else if record}
        <button class="act" onclick={() => void reveal()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"
            ><path
              d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
            /></svg
          >Show in folder
        </button>
      {/if}
      <!-- The heart. Drawn for both kinds of subject, unlike the action above it, because that
           is what a favourite keyed on the chart rather than on a path buys: hearting a chart on
           Chorus and finding it already hearted once it is downloaded is one row, not two.

           `aria-pressed` rather than two labels, so the state is announced as the state of one
           control instead of as a button whose name changes under the reader. -->
      <button
        class="act icon fav"
        aria-pressed={favourited}
        aria-label="Favourite"
        aria-disabled={!favouritable}
        title={favouritable
          ? favourited
            ? 'Remove from favourites'
            : 'Add to favourites'
          : UNNAMED_CHART}
        onclick={() => void favourite()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 8a4 4 0 0 1 7 2.7C19 15.6 12 20 12 20z" /></svg
        >
      </button>
      <!-- The third action, beside the heart. An icon button and not a word, because it opens a
           choice rather than doing one thing: which setlist is the question, and a button that
           read "Add to setlist" would still have to ask it.

           `aria-expanded` rather than `aria-pressed`: this does not hold a state of the chart the
           way the heart does, it shows and hides the list under the row. `aria-disabled` and not
           `disabled`, for the reason the heart records: Chromium suppresses every event on a
           disabled control, tooltip included, so the refusal would be unreadable. -->
      <button
        class="act icon setlist"
        aria-expanded={setlistPanelOpen}
        aria-label="Add to setlist"
        aria-disabled={!setlistable}
        class:on={inSetlists.size > 0}
        title={setlistable
          ? inSetlists.size > 0
            ? `In ${inSetlists.size} of your setlists`
            : 'Add to a setlist'
          : UNNAMED_FOR_SETLIST}
        onclick={openSetlistPanel}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M4 6h11M4 12h8M4 18h8M17 11v8M13 15h8" /></svg
        >
      </button>
      <!-- Sized to its own word and quiet, which is the whole of its design. This column is
           where a chart is judged; the page carries the things it cannot, the full difficulty
           matrix, the version check, the ABOUT table and the chips that search on a charter or
           an album. A route that looked like the action beside it would put the page back as
           the place every chart goes, and Explore already left that arrangement. -->
      <button
        class="act to-detail"
        title="Everything else about this chart: every difficulty, where it came from, and whether Chorus has a newer version"
        onclick={() => {
          if (target !== null) onOpenDetail(target)
        }}>All details</button
      >
    </div>
    <!-- Only the failure. A download that was accepted says so in the player bar directly under
         this column, where the percent, the failure and the retry already are; a second line here
         would be the rail reporting on a queue it does not own. A refused reveal has no such
         second place, and silence there reads as a button that does nothing. -->
    {#if setlistPanelOpen}
      <!-- One toggle per setlist, and the way to make another. A chart can be in several at once,
           which is why these are toggles rather than a radio group: the table's key carries the
           setlist's id, so two setlists holding one chart is two rows and not a contradiction. -->
      <div class="setlist-panel">
        {#if $setlists.length === 0}
          <p class="setlist-empty">You have no setlists yet. Name one and this chart goes in it.</p>
        {:else}
          <ul class="setlist-list">
            {#each $setlists as list (list.id)}
              {@const held = inSetlists.has(list.id)}
              <li>
                <button
                  class="setlist-row"
                  aria-pressed={held}
                  onclick={() => void toggleSetlist(list.id, !held)}
                >
                  <span class="setlist-tick" aria-hidden="true">
                    {#if held}
                      <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg>
                    {/if}
                  </span>
                  <span class="setlist-name">{list.name}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <form class="setlist-new" onsubmit={(e) => void addToNewSetlist(e)}>
          <input
            class="setlist-input"
            type="text"
            bind:value={newSetlistName}
            maxlength={SETLIST_NAME_MAX}
            aria-label="New setlist name"
            placeholder="New setlist"
          />
          <button class="setlist-add" type="submit" disabled={newSetlistName.trim() === ''}
            >Add</button
          >
        </form>
      </div>
    {/if}
    {#if actionError !== null}
      <p class="act-error" role="alert">{actionError}</p>
    {/if}

    <!-- Eight cells in two columns, the shape the design gives this card. The left column is
         the track the two selects name and moves with them; the right column is the chart and
         does not. Four of the design's own eight are not here and say so in `statCells`. -->
    <section class="card stats" aria-label="Chart statistics">
      <h2 class="card-head">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h13" /></svg>
        Chart statistics
        {#if doubleKick}
          <!-- Beside the heading rather than in a ninth cell: the grid is eight and stays
               eight, and a flag that appears only on a drum chart would otherwise make a drum
               chart taller than every other chart. -->
          <span class="chip mono" title="The drum chart uses a double pedal.">2X KICK</span>
        {/if}
      </h2>
      <div class="kv">
        {#each statCells as cell (cell.label)}
          <div class="stat">
            <span class="stat-label">{cell.label}</span>
            <span class="stat-value mono">{cell.value}</span>
          </div>
        {/each}
      </div>
    </section>

    <section class="card health" aria-label="Chart health">
      <h2 class="card-head">
        <svg viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M12 2 4 5.4v6.1c0 4.7 3.4 9.1 8 10.5 4.6-1.4 8-5.8 8-10.5V5.4z" /></svg
        >
        Chart health
        {#if summary}
          <!-- The denominator, next to the heading rather than inside the ring. A ring reading
               67 with nothing to say what it is 67 of invites the reader to assume five checks
               and a third of a check missing, which is not what happened. -->
          <span class="count mono">{summary.present} of {summary.known} checks</span>
        {/if}
      </h2>
      <div class="hl">
        {#if score !== null}
          <div
            class="ring"
            role="img"
            aria-label="{score} out of 100: {summary?.present} of {summary?.known} checks passed"
          >
            <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
              <circle
                cx="28"
                cy="28"
                r={RING_R}
                fill="none"
                stroke="var(--ground-4)"
                stroke-width="6"
              />
              <circle
                cx="28"
                cy="28"
                r={RING_R}
                fill="none"
                stroke={ringColor}
                stroke-width="6"
                stroke-linecap="round"
                stroke-dasharray={RING_C}
                stroke-dashoffset={ringOffset}
              />
            </svg>
            <span class="ring-value mono" aria-hidden="true">{score}</span>
          </div>
        {/if}
        <ul class="hlc">
          {#each health as item (item.key)}
            <!-- The claim, not the noun: "No lyrics" and "Lyrics unknown" and "Lyrics" are three
                 different sentences, so the glyph's colour beside them is the second signal and
                 never the only one. -->
            <li class="health-row" data-state={item.state} data-key={item.key}>
              {#if item.state === 'present'}
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7" /></svg>
              {:else if item.state === 'missing'}
                <svg viewBox="0 0 24 24" aria-hidden="true"
                  ><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.2v.01" /></svg
                >
              {:else}
                <svg viewBox="0 0 24 24" aria-hidden="true"
                  ><circle cx="12" cy="12" r="9" /><path d="M8.5 12h7" /></svg
                >
              {/if}
              <span class="health-label">{healthPhrase(item)}</span>
            </li>
          {/each}
        </ul>
      </div>
    </section>
  {/if}
</aside>

<style>
  /* One step lighter than the content pane beside it, which is the design's arrangement: the
     window is --ground-1, this column sits on it at --ground-2, and the two cards at the bottom
     sit on the column at --ground-3. Three steps, each one readable against the one under it,
     rather than a flat column with outlined boxes floating on it. */
  .rail {
    display: flex;
    flex-direction: column;
    gap: 13px;
    padding: 14px;
    border-left: 1px solid var(--hairline);
    background: var(--ground-2);
    overflow-y: auto;
  }
  .empty {
    margin: auto 0;
    text-align: center;
    padding: 0 8px;
  }
  .empty-mark {
    width: 64px;
    height: 64px;
    margin: 0 auto 14px;
    border-radius: var(--radius-lg);
    border: 1px dashed var(--border-2);
    background: var(--ground-0);
  }
  .empty-line {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    line-height: var(--lh-prose);
  }
  .empty-note {
    margin-top: 4px;
    font-size: var(--fs-caption);
    color: var(--text-3);
    line-height: var(--lh-prose);
  }
  .head {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  /* 76px, the design's number. The head's height is then set by the four lines naming the chart
     rather than by the cover beside them, which is the right way round for a block whose job is
     the name. */
  .art {
    width: 76px;
    height: 76px;
    flex-shrink: 0;
    display: block;
    object-fit: cover;
    border-radius: var(--radius);
    background: var(--ground-3);
    box-shadow: var(--elev-2);
  }
  /* The monogram box. Quiet on purpose: it stands in for a cover, and a bright letter would
     out-shout the title next to it, which is the thing actually naming the chart. */
  .art.placeholder {
    border: 1px solid var(--border-1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--fs-display);
    line-height: var(--lh-flat);
    font-weight: 600;
    color: var(--text-3);
  }
  .ident {
    min-width: 0;
    flex: 1;
  }
  .title {
    font-size: var(--fs-emphasis);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
    line-height: var(--lh-display);
    color: var(--text-1);
    /* Two lines, then ellipsis: a rail this narrow will meet titles that do not fit, and a
       title that wraps without limit pushes the highway off the bottom of the column. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  /* The accent, which is the design's one use of it in this block: the artist is the second
     thing read after the title and the only line here that is a link to anywhere in the user's
     head. --accent-tint measures 10.4:1 on --ground-2. */
  .artist {
    margin-top: 2px;
    font-size: var(--fs-secondary);
    font-weight: 500;
    color: var(--accent-tint);
  }
  .context,
  .charter {
    margin-top: 2px;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .charter {
    margin-top: 5px;
    color: var(--text-2);
  }
  .artist,
  .context,
  .charter {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A chart with no album, no year and no genre has no third line rather than a blank one. */
  .context:empty {
    display: none;
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* The frame the badge is positioned against. The player is appended into `.viewport` inside
     it, so nothing Svelte owns is ever a child of the element the controller writes into. */
  .hw {
    position: relative;
    border-radius: var(--radius);
    border: 1px solid var(--border-2);
    background: var(--ground-0);
    overflow: hidden;
    box-shadow: var(--elev-2);
  }
  /* 16/9 and not the design's 16/10. The two are 21px apart in a 374px column and this panel
     has no 21px to spare; it is also the aspect the chart page's pane uses, so one highway is
     drawn at two sizes rather than at two shapes. `scripts/measure-rail-panel.mjs` prints what
     the column costs with this number in it. */
  .viewport {
    width: 100%;
    aspect-ratio: 16 / 9;
    display: block;
  }
  .viewport :global(chart-preview-player) {
    width: 100%;
    height: 100%;
    display: block;
  }
  /* Faded out rather than torn out, which is what the player bar does with its transport and
     for the same reason: the frame is a fixed aspect and nothing in the column may move when
     the real highway arrives. Inert to the pointer throughout, so the player element's own
     clicks and shortcuts land on it and not on a picture lying over it. */
  .rest {
    position: absolute;
    inset: 0;
    pointer-events: none;
    transition:
      opacity var(--t-med) var(--ease),
      visibility 0s linear;
  }
  .rest.gone {
    opacity: 0;
    visibility: hidden;
    transition:
      opacity var(--t-med) var(--ease),
      visibility 0s linear var(--t-med);
  }
  .hwt {
    position: absolute;
    left: 8px;
    top: 8px;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-2);
    background: rgba(7, 6, 16, 0.75);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    padding: 1px 7px;
    backdrop-filter: blur(6px);
    pointer-events: none;
    max-width: calc(100% - 16px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .play {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--ground-1);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .play svg {
    width: 14px;
    height: 14px;
    fill: currentColor;
  }
  .play:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .seek {
    flex: 1;
    min-width: 0;
    height: 4px;
    border-radius: 999px;
    background: var(--ground-4);
    cursor: pointer;
  }
  .seek-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
  }
  .time {
    font-size: var(--fs-caption);
    color: var(--text-3);
    flex-shrink: 0;
  }
  /* No text, no row, and no gap above it either: an empty element still holds a flex slot, and
     the slot is most of what the line costs. */
  .state:empty {
    display: none;
  }
  .state {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Two boxes of equal width, each a label at the left and the pick at the right, which is the
     shape the design draws them in. A real <select> rather than the design's fake button: the
     pick has to be operable, and the arrow the UA draws is what says so. */
  .picks {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7px;
  }
  .pick {
    min-width: 0;
    height: 33px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 4px 0 10px;
    background: var(--ground-3);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    transition: border-color var(--t-fast) var(--ease);
  }
  .pick:hover {
    border-color: var(--accent);
  }
  .pick:focus-within {
    border-color: var(--accent);
  }
  .pick-label {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: none;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .pick select {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    color: var(--text-1);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    font-weight: 600;
    text-align: right;
    cursor: pointer;
  }
  .swatch {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .actions {
    display: flex;
    gap: 7px;
  }
  .act {
    flex: 1;
    min-width: 0;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border-radius: var(--radius);
    padding: 0 12px;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    font-weight: 600;
    cursor: pointer;
    background: var(--ground-3);
    border: 1px solid var(--border-2);
    color: var(--text-2);
    transition:
      filter var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .act svg {
    width: 14px;
    height: 14px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .act:hover {
    color: var(--text-1);
    border-color: var(--accent);
  }
  /* The design lifts this one off the column with a violet cast. --elev-2 is the same lift in
     the scale's own terms; a component that spells its own shadow out is the regression
     tokens.test.ts exists to catch, and a glow token for one button is not worth a step. */
  .act.primary {
    border-color: transparent;
    background: var(--accent-grad);
    color: #fff;
    box-shadow: var(--elev-2);
  }
  .act.primary:hover {
    filter: brightness(1.12);
  }
  /* Square, and sized to the row rather than to a word: the design's icon button is the action's
     own height with no padding, so a row of them reads as one strip of controls. */
  .act.icon {
    flex: 0 0 36px;
    width: 36px;
    padding: 0;
  }
  .act[aria-disabled='true'] {
    opacity: 0.45;
  }
  .act[aria-disabled='true']:hover {
    color: var(--text-2);
    border-color: var(--border-2);
  }
  /* Filled and accented when it is on, outlined when it is off. Both states are drawn, which is
     the point: an icon button whose only signal is a colour is one a reader has to have seen the
     other state of to read. */
  .act.fav[aria-pressed='true'] {
    color: var(--accent-tint);
    border-color: var(--accent);
  }
  .act.fav[aria-pressed='true'] svg {
    fill: currentColor;
  }
  /* Accented once the chart is in a setlist, the way the heart is once it is hearted. Outlined,
     not filled: the glyph is lines and a plus, and filling it would close the lines up. */
  .act.setlist.on {
    color: var(--accent-tint);
    border-color: var(--accent);
  }
  /* Under the row rather than over it. See the panel's comment in the script above. */
  .setlist-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 7px;
    padding: 8px;
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    background: var(--ground-3);
  }
  .setlist-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* Capped so a long list cannot push the eight statistics and the health ring off the column.
       Six rows at 28px; past that the panel scrolls and the cards below it stay where they are. */
    max-height: 172px;
    overflow-y: auto;
  }
  .setlist-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    cursor: pointer;
    text-align: left;
  }
  .setlist-row:hover {
    background: var(--ground-4);
    color: var(--text-1);
  }
  .setlist-row[aria-pressed='true'] {
    color: var(--text-1);
  }
  .setlist-tick {
    width: 14px;
    height: 14px;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--accent-tint);
  }
  .setlist-tick svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .setlist-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .setlist-empty {
    margin: 0;
    font-size: var(--fs-caption);
    line-height: var(--lh-snug);
    color: var(--text-3);
  }
  .setlist-new {
    display: flex;
    gap: 6px;
  }
  .setlist-input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-1);
    background: var(--ground-4);
    color: var(--text-1);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
  }
  .setlist-input:focus-visible {
    border-color: var(--accent);
  }
  .setlist-add {
    flex: none;
    height: 28px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-2);
    background: var(--ground-4);
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    font-weight: 600;
    cursor: pointer;
  }
  .setlist-add:hover:not(:disabled) {
    color: var(--text-1);
    border-color: var(--accent);
  }
  .setlist-add:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /**
   * The way through to the chart page: as wide as its word, and no wider.
   *
   * `flex: 0 0 auto` rather than the `1` the action beside it takes, so the action keeps the
   * width and this keeps only what "All details" needs. Transparent rather than a card surface,
   * so the row reads as one action and one link out of it rather than two choices of equal
   * weight. Measured with `scripts/measure-rail-panel.mjs`, which prints both buttons' widths
   * and whether either word is clipped.
   */
  .to-detail {
    flex: 0 0 auto;
    background: none;
    border-color: transparent;
    color: var(--text-3);
  }
  .to-detail:hover,
  .to-detail:focus-visible {
    color: var(--text-1);
    border-color: var(--border-2);
  }
  /* Wraps rather than ellipsising: a reveal that failed says which path it refused and why, and
     a clipped reason is a reason nobody can act on. It is also the only block in the column that
     is absent almost always, so the height it takes is not height an ordinary chart spends. */
  .act-error {
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    margin-top: -7px;
    color: var(--danger);
  }
  .card {
    background: var(--ground-3);
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    padding: 12px 13px;
    box-shadow: var(--elev-1);
  }
  .card-head {
    margin: 0 0 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-caption);
    font-weight: 600;
    color: var(--text-2);
  }
  .card-head svg {
    width: 12px;
    height: 12px;
    flex: none;
    fill: none;
    stroke: var(--text-3);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .card-head .count {
    margin-left: auto;
    font-size: var(--fs-caption);
    font-weight: 400;
    color: var(--text-3);
  }
  .card-head .chip {
    margin-left: auto;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-2);
    background: var(--ground-4);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
  }
  /* Two columns, four rows, and the column gap wider than the row gap so the two halves read as
     two lists rather than as one four-wide table. */
  .kv {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 14px;
  }
  .stat {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--ground-4);
    font-size: var(--fs-caption);
  }
  .stat-label {
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Tabular figures, so the right-hand edge of the two columns does not shuffle when the
     instrument pick changes a 1,420 into a 987. */
  .stat-value {
    flex: none;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-1);
  }
  .hl {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .ring {
    position: relative;
    width: 56px;
    height: 56px;
    flex: none;
  }
  /* From twelve o'clock, which is where a reader expects a dial to start. */
  .ring svg {
    display: block;
    transform: rotate(-90deg);
  }
  .ring-value {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: var(--fs-emphasis);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text-1);
  }
  .hlc {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .health-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-caption);
    line-height: var(--lh-tight);
    color: var(--text-2);
  }
  .health-row svg {
    width: 11px;
    height: 11px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .health-label {
    min-width: 0;
  }
  .health-row[data-state='present'] svg {
    stroke: var(--success);
    stroke-width: 3.2;
  }
  /* The missing rows are the ones somebody can act on, so they take --text-1 and the rest stay
     at --text-2. The words differ too ("No lyrics" against "Lyrics"), which is what keeps the
     amber glyph a second signal rather than the only one. */
  .health-row[data-state='missing'] {
    color: var(--text-1);
  }
  .health-row[data-state='missing'] svg {
    stroke: var(--warning);
  }
  /* Unknown keeps the neutral glyph and the neutral word. It is not a warning: nobody has
     looked, and colouring it amber would send the user to the Asset Studio after a chart that
     may want nothing at all. */
  .health-row[data-state='unknown'] svg {
    stroke: var(--text-3);
  }
  .mono {
    font-family: var(--font-mono);
  }
</style>
