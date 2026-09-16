<script lang="ts" module>
  import { writable } from 'svelte/store'

  /**
   * Whether the list leaves out the charts already installed.
   *
   * Module-scoped for the reason `browseSearch` is: this view is remounted by every navigation,
   * and a toggle held per instance would come back off every time the user looked at a chart and
   * came back. It is not in the search store because it narrows nothing that was asked of Chorus:
   * the answer is the same either way, and what changes is which of its rows are drawn.
   *
   * Not persisted either. It is the answer to "what is left for me here", which is a question
   * about this visit, and a filter that silently outlives the session is a list that looks wrong
   * the next time it is opened.
   *
   * Exported for the same reason `browseSearch` is reachable from outside: a singleton one test
   * leaves set is the next test's first paint, so the suite has to be able to put it back.
   */
  export const hideOwned = writable(false)
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import { get } from 'svelte/store'
  import { SvelteSet } from 'svelte/reactivity'
  import { browseSearch } from '../stores/search'
  import { globalQuery } from '../stores/global-search'
  import { settings } from '../stores/settings'
  import {
    INSTRUMENTS,
    DIFFICULTIES,
    SORT_OPTIONS,
    albumArtUrl,
    type ChartData,
    type FilterOption
  } from '../api/enchor'
  import {
    ADVANCED_RANGES,
    INTENSITY_CEILINGS,
    INTENSITY_FLOORS,
    type AdvancedNumberField,
    type AdvancedTextField
  } from '../api/advanced'
  import { msToTime, stripRichText } from '../../../../shared/format'
  import { issueSummary, issueTitle } from '../issue-summary'
  import { encore } from '../stores/bridge'
  import AdvancedSearch from './AdvancedSearch.svelte'
  import DiffPips from './DiffPips.svelte'
  import type { ChartTarget } from './Home.svelte'

  /**
   * A row hands its chart to the preview rail beside the list, and the list stays where it is.
   *
   * Explore is where 95,000 charts are scanned, and the rail is what answers the question that
   * scanning asks: the pips, the health dot, the statistics and the highway all say whether this
   * is the version to take. A page swap per row is the wrong weight for a question asked that
   * often, and it costs the filters, the sort and the scroll position every time.
   *
   * There is deliberately nothing here that opens the chart page. The route to it is one control
   * in the rail, beside the chart it would open; the caller is what decides where a chart goes
   * when the rail is too narrow to be drawn at all.
   */
  let { onSelectChart }: { onSelectChart: (target: ChartTarget) => void } = $props()

  // Shared module-scoped store: this view is remounted by every navigation and
  // by opening a chart Detail, and a per-instance store would re-query the API
  // (and drop the pages already loaded) each time.
  const search = browseSearch
  const { results, groups, found, loading, error, searched, expanded, mode, selected } = search
  const { advancedCount, advancedOpen, hasMore, atAutoCap } = search
  const { advancedDropped, advancedDraftCount } = search
  // The applied query, not the draft: the band on screen has to be the band the rows came back
  // for. `advancedDraft` is what the panel is holding, which may never have been asked.
  const { advanced, sort: sortKey } = search
  let inputEl = $state<HTMLInputElement | null>(null)
  // Seeded from the shared store so a remount restores the chips the user set.
  let instrument = $state<string | null>(get(search.filters).instrument)
  let difficulty = $state<string | null>(get(search.filters).difficulty)

  // Which songId groups show their alternate versions also lives in the shared
  // store; see its comment. It used to be a per-instance SvelteSet, which
  // collapsed every open group on the way back from a chart Detail.

  let tableEl = $state<HTMLDivElement | null>(null)
  let sentinelEl = $state<HTMLButtonElement | null>(null)

  /** How far past the edge of the scrolling box the end of the list still counts as reached. */
  const LOOKAHEAD_PX = 400

  /**
   * The box the results scroll in, found rather than assumed.
   *
   * `.table` is that box today, measured in the desktop app: 609px of box around 1219px of rows
   * at 1280x800. The observer's root, the restore below and the scroll listener all have to name
   * the same element, and a layout change that moved the overflow to an ancestor would leave all
   * three pointing at one that clips nothing. That fails quietly rather than visibly, so the
   * element is looked up instead of written down. `tableEl` is the fallback for a document with
   * no scrolling ancestor at all, which is every jsdom test: they apply no CSS.
   */
  function scrollBox(): HTMLElement | null {
    for (let node: HTMLElement | null = tableEl; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node)
      if (overflowY === 'auto' || overflowY === 'scroll') return node
    }
    return tableEl
  }

  /**
   * The offset the restore below wrote, until a scroll event accounts for it.
   *
   * Setting `scrollTop` makes the browser fire a scroll event of its own, and treating that one
   * as the user's would arm auto-append at exactly the offset they left. On a list they had
   * scrolled to the bottom, that is one unasked-for request on every trip back from a chart
   * Detail, spent fetching a page nobody looked for. A scroll to any other offset is theirs.
   */
  let restoredTo: number | null = null
  /**
   * Whether reaching the bottom may fetch.
   *
   * True from the first paint, and false only while a restored offset is still unaccounted for:
   * the thing it guards against is the restore fetching a page nobody asked for, and a list with
   * an offset to restore is by definition long enough to scroll, so a scroll event is a signal
   * that exists there.
   *
   * It used to start false on every mount and wait for a scroll event, which is the defect this
   * replaces. Measured in the desktop app: at 1920x1080 the first 25 charts are 889px of grid in
   * a box 889px tall, and at 2560x1440 1249px in a box 1249px tall. Nothing overflows, so nothing
   * can be scrolled, so no scroll event is ever fired and Explore stopped at one page with the
   * end of the list already on screen. At 1280x800 the same page is 1219px in a 609px box and
   * auto-append worked, which is how this shipped.
   */
  let armed = $state(search.savedScroll() <= 0)
  /** Whether the sentinel is on screen, as the observer last saw it. */
  let atBottom = $state(false)

  // Put the list back where the user left it. Runs once, when bind:this fills
  // tableEl on mount; the rows are already in the DOM by then because the
  // results live in the shared store, so there is nothing to wait for.
  //
  // Not covered by any test: jsdom performs no layout, so scrollTop there is always 0 and a test
  // could only assert that this line ran. Measured in the desktop app instead: a list scrolled to
  // 900px, a chart Detail opened from it and left again, comes back at 900px.
  $effect(() => {
    const box = scrollBox()
    if (!box) return
    const saved = search.savedScroll()
    if (saved <= 0) return
    restoredTo = saved
    box.scrollTop = saved
  })

  // The scroll listener goes on whichever element turns out to scroll, for the reason
  // `scrollBox` exists. In the markup it could only name `.table`.
  $effect(() => {
    const box = scrollBox()
    if (!box) return undefined
    const onScroll = (): void => onTableScroll(box.scrollTop)
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
  })

  function onTableScroll(top: number): void {
    if (restoredTo !== null && top === restoredTo) restoredTo = null
    else armed = true
    search.saveScroll(top)
  }

  /**
   * Watch the button at the end of the list and record whether it is in view.
   *
   * The decision is not taken here, because the callback is not where the guards are; the effect
   * below takes it. `rootMargin` starts the next page a screenful early, so the rows arrive
   * before the user reaches the end rather than after they have stared at the bottom of the list.
   *
   * Held in `observer` so `fillToTheEnd` can ask it again. Not covered by any test as written:
   * jsdom ships no IntersectionObserver and computes no layout, so the tests stub the observer
   * and drive it by hand. What the real one does with this root and this margin was measured in
   * the desktop app: with the first page not filling the box it reports the sentinel visible on
   * the first paint, and reports it gone once an appended page has pushed it past the margin.
   */
  let observer: IntersectionObserver | null = null

  $effect(() => {
    const el = sentinelEl
    if (!el || !tableEl || typeof IntersectionObserver === 'undefined') return undefined
    const watching = new IntersectionObserver(
      (entries) => {
        atBottom = entries.some((entry) => entry.isIntersecting)
      },
      { root: scrollBox(), rootMargin: `${LOOKAHEAD_PX}px 0px` }
    )
    watching.observe(el)
    observer = watching
    return () => {
      watching.disconnect()
      if (observer === watching) observer = null
    }
  })

  /**
   * Load the next page when the end of the list is in view.
   *
   * Every guard here is about spending requests the user did not ask for. `armed` keeps a restored
   * scroll position from fetching; `$loading` keeps one request in flight at a time (the store
   * checks it again, so a scroll that crosses the sentinel twice in a turn still costs one);
   * `$error` stops a failed page being asked for over and over, which is how a rate-limited client
   * stays rate-limited, and leaves the error card's Retry as the way back; `$atAutoCap` is where
   * appending stops and the button takes over.
   */
  $effect(() => {
    if (!armed || !atBottom || $loading || $error || !$hasMore || $atAutoCap) return
    void fillToTheEnd()
  })

  /**
   * One page, then ask the observer where the sentinel is now.
   *
   * The decision is consumed rather than left standing. Left standing it would fire again the
   * instant `$loading` went back to false, which is before the observer has had a chance to say
   * the sentinel moved, and a scroll to the end of a catalog this size would then run pages
   * off as fast as the network answered.
   *
   * That alone stops too early. An observer only speaks when the sentinel crosses the edge of its
   * root, and a page that lands with the end of the list still on screen crosses nothing, so the
   * consumed decision would never be retaken and the list would sit one page long with its end in
   * view. Observing a target again delivers its current state, which is what re-observing here is
   * for: it keeps filling until the sentinel is genuinely past the margin, which is also the point
   * at which there is something to scroll. Every guard above still applies to each page, and the
   * cap still stops it at 500.
   */
  async function fillToTheEnd(): Promise<void> {
    atBottom = false
    await search.loadMore()
    // After the rows are in the DOM: the observer answers from layout, and the page that just
    // landed is what moves the sentinel.
    await tick()
    const el = sentinelEl
    if (!el || !observer) return
    observer.unobserve(el)
    observer.observe(el)
  }

  // chartIds whose name+artist+charter match a local catalog row. A metadata
  // match means "this song by this charter is in your library", not
  // necessarily this exact chart version.
  //
  // Raw names, never stripped: both sides of the comparison are what the chart says, and
  // stripping one side would make an owned chart look missing.
  const inLibraryIds = new SvelteSet<number>()
  let metaGeneration = 0

  $effect(() => {
    const snapshot = $results
    const gen = ++metaGeneration
    if (!snapshot.length) {
      inLibraryIds.clear()
      return
    }
    const keys = snapshot.map((c) => ({ name: c.name, artist: c.artist, charter: c.charter }))
    // The IPC boundary caps batches at 250 keys; loadMore can grow results past
    // that, so chunk and reassemble in order.
    const chunks: Promise<boolean[]>[] = []
    for (let i = 0; i < keys.length; i += 250) {
      chunks.push(encore().existsByMeta(keys.slice(i, i + 250)))
    }
    Promise.all(chunks)
      .then((parts) => parts.flat())
      .then((flags) => {
        // Results changed while the call was in flight: discard the stale response.
        if (gen !== metaGeneration) return
        inLibraryIds.clear()
        flags.forEach((hit, i) => {
          if (hit) inLibraryIds.add(snapshot[i].chartId)
        })
      })
      .catch(() => {
        // Non-fatal: badges are a best-effort enhancement.
      })
  })

  // The global top-bar search drives the query: this runs once on mount (empty
  // query = wildcard browse-all) and again whenever the global query changes.
  // setQuery ignores a query it already answered, which is what makes the
  // on-mount run a no-op, including for the expansion and scroll state the
  // store discards only when a new result set actually replaces the rows.
  $effect(() => {
    search.setQuery($globalQuery)
  })

  function onQueryInput(value: string): void {
    // Sync the local input back to the global store; the $effect above applies
    // it to the search.
    globalQuery.set(value)
  }

  function onFilterChange(kind: 'instrument' | 'difficulty', value: string): void {
    const next = value || null
    if (kind === 'instrument') instrument = next
    else difficulty = next
    search.setFilters(instrument, difficulty)
  }

  /** What to call the chosen instrument out loud, so the band can say what it is a band of. */
  const instrumentLabel = $derived(
    INSTRUMENTS.find((opt) => opt.value === instrument)?.label ?? 'the chosen instrument'
  )

  /**
   * Why the band is off, and what it would mean if it were on.
   *
   * A disabled control with no reason beside it is a dead end. This is the reason, and it is the
   * measurement: with no instrument the endpoint reads the band against every instrument at once
   * and an uncharted one carries -1, so every chart clears any maximum. See ADVANCED_RANGES.
   */
  const bandName = $derived.by(
    () => (end: string) =>
      instrument === null
        ? `${end} intensity. Choose an instrument first: a chart is rated one instrument at a time.`
        : `${end} intensity for ${instrumentLabel}`
  )

  function onIntensityChange(end: 'min' | 'max', value: string): void {
    const numbers = get(search.advanced).numbers
    search.setIntensity(
      end === 'min' ? value : numbers.minIntensity,
      end === 'max' ? value : numbers.maxIntensity
    )
  }

  /**
   * The difficulties as a scale, which is what a row of dots is.
   *
   * Four dots, because there are four difficulties. The endpoint names its whole enum back in
   * the 400 it answers a bad value with: `'expert' | 'hard' | 'medium' | 'easy'`, and an array
   * of two comes back as `received: array` from the same check (measured against the live
   * service on 2026-09-16). So the control is single-select, and `DIFFICULTIES` was already the
   * same four. The approved design draws six dots here; six is the intensity scale its own rows
   * draw six pips of, and two of six toggles over four difficulties would filter nothing.
   *
   * Reversed out of `DIFFICULTIES` rather than written out again, so the list stays in one
   * place. A select puts the most-asked-for option first, which is why that one starts at
   * expert; a row of dots is read left to right as a scale, and a scale runs upwards.
   */
  const named = (opt: FilterOption): opt is FilterOption & { value: string } => opt.value !== null
  const DIFFICULTY_DOTS = DIFFICULTIES.filter(named).reverse()

  /**
   * Pressing the lit dot is how "any difficulty" is asked for, now that no option says it.
   *
   * `aria-pressed` rather than a radio group: a radio group cannot express none-chosen, and
   * none-chosen is the state this control is in nearly all the time. The same idiom the List and
   * Grid pair beside it uses, and the pressed dot is the only lit thing in the group.
   */
  function onDifficultyDot(value: string): void {
    onFilterChange('difficulty', difficulty === value ? '' : value)
  }

  const difficultyName = $derived(
    DIFFICULTY_DOTS.find((opt) => opt.value === difficulty)?.label.toLowerCase() ?? ''
  )

  /**
   * The chips under the search row: the advanced fields the approved design asks in the header.
   *
   * Every one names a field the panel already holds, by the key the panel holds it under, and
   * writes it through `setAdvancedField`, which sets the applied query and the panel's draft in
   * one act. A chip is therefore a second view of one filter and never a second filter; the
   * intensity band beside them has worked that way since it shipped.
   *
   * Two of the design's seven are not here. There is no decade field to chip: the endpoint takes
   * `minYear` and `maxYear` and nothing else, so a Decade chip would be the Year range wearing a
   * different name, which is exactly the second copy this header may not have. The decades are
   * inside the Year chip instead, as presets that fill the range they mean. Sort is not here
   * either: eleven orders already live at the end of the filter row above, and one order needs
   * one control.
   */
  type Chip =
    | { kind: 'text'; field: AdvancedTextField; label: string }
    | {
        kind: 'range'
        field: string
        label: string
        min: AdvancedNumberField
        max: AdvancedNumberField
      }

  const CHIPS: readonly Chip[] = [
    { kind: 'text', field: 'genre', label: 'Genre' },
    { kind: 'range', field: 'year', label: 'Year', min: 'minYear', max: 'maxYear' },
    { kind: 'range', field: 'length', label: 'Length', min: 'minLength', max: 'maxLength' },
    { kind: 'text', field: 'charter', label: 'Charter' },
    { kind: 'text', field: 'album', label: 'Album' }
  ]

  /**
   * The unit the panel labels a range in, read off the panel's own list rather than written here.
   *
   * Length is MINUTES. That is the measurement `ADVANCED_RANGES` records and the reason this
   * reads it rather than restating it: the last time this number was restated it was restated as
   * seconds, a 60x conversion was built on it, and a 3 to 6 minute search answered with charts 3
   * to 6 hours long. The chip converts nothing and sends what was typed, as the panel does.
   */
  function unitOf(min: AdvancedNumberField): string {
    return ADVANCED_RANGES.find((range) => range.min === min)?.unit ?? ''
  }

  /** The decades the Year chip offers, ending at the one we are in. */
  const DECADES = (() => {
    const newest = Math.floor(new Date().getFullYear() / 10) * 10
    const decades: number[] = []
    for (let start = 1950; start <= newest; start += 10) decades.push(start)
    return decades.reverse()
  })()

  /** Which end of a range a chip is bounded at, as three cases rather than four. */
  function rangeText(min: AdvancedNumberField, max: AdvancedNumberField): string {
    const lo = $advanced.numbers[min].trim()
    const hi = $advanced.numbers[max].trim()
    const unit = unitOf(min)
    const tail = unit ? ` ${unit}` : ''
    if (!lo && !hi) return 'Any'
    if (lo && hi) return lo === hi ? `${lo}${tail}` : `${lo} to ${hi}${tail}`
    if (lo) return `${lo}${tail} and up`
    return `up to ${hi}${tail}`
  }

  /**
   * What a chip reads, which has to be what the request says and not what the box holds.
   *
   * An excluded text field is named as an exclusion, because Exclude inverts what the value
   * means and a chip reading "Rock" over a search that is refusing Rock would be the one lie
   * this row can tell. Exact does not change what the word is, so it does not show here; it
   * stays in the panel with the rest of the per-field modifiers.
   *
   * A year range that is exactly one decade is named as that decade, which is the only honest
   * decade this API can answer for: it is the same two fields either way.
   */
  function chipText(chip: Chip): string {
    if (chip.kind === 'text') {
      const filter = $advanced.text[chip.field]
      const value = filter.value.trim()
      if (!value) return 'Any'
      return filter.exclude ? `not ${value}` : value
    }
    if (chip.field === 'year') {
      const lo = Number($advanced.numbers.minYear.trim())
      const hi = Number($advanced.numbers.maxYear.trim())
      if ($advanced.numbers.minYear.trim() && lo % 10 === 0 && hi === lo + 9) return `${lo}s`
    }
    return rangeText(chip.min, chip.max)
  }

  const chipSet = (chip: Chip): boolean => chipText(chip) !== 'Any'

  /** Which chip has its editor open, by field. One at a time, and none is the resting state. */
  let openChip = $state<string | null>(null)
  let pendingText = $state('')
  let pendingLow = $state('')
  let pendingHigh = $state('')

  function toggleChip(chip: Chip): void {
    if (openChip === chip.field) {
      openChip = null
      return
    }
    // Seeded from the applied query, so the editor opens on what the rows on screen came back
    // for rather than on whatever the last chip left in these three variables.
    const applied = get(search.advanced)
    if (chip.kind === 'text') pendingText = applied.text[chip.field].value
    else {
      pendingLow = applied.numbers[chip.min]
      pendingHigh = applied.numbers[chip.max]
    }
    openChip = chip.field
  }

  function applyChip(chip: Chip): void {
    if (chip.kind === 'text') {
      const value = pendingText.trim()
      search.setAdvancedField((query) => {
        query.text[chip.field].value = value
      })
    } else {
      const low = pendingLow.trim()
      const high = pendingHigh.trim()
      search.setAdvancedField((query) => {
        query.numbers[chip.min] = low
        query.numbers[chip.max] = high
      })
    }
    openChip = null
  }

  function clearChip(chip: Chip): void {
    pendingText = ''
    pendingLow = ''
    pendingHigh = ''
    applyChip(chip)
  }

  function pickDecade(chip: Chip, start: number): void {
    pendingLow = String(start)
    pendingHigh = String(start + 9)
    applyChip(chip)
  }

  /**
   * A press anywhere else shuts the open editor.
   *
   * Without it the only ways out are Apply, Escape and another chip, and an editor left hanging
   * over the first rows of the list is a popover the user has to work out how to dismiss.
   * `pointerdown` rather than `click` so it does not race the chip's own press.
   */
  $effect(() => {
    if (openChip === null) return undefined
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Element && e.target.closest('.fdrops')) return
      openChip = null
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  })

  export function focusSearch(): void {
    inputEl?.focus()
  }

  function selectChart(chart: ChartData): void {
    onSelectChart({ kind: 'remote', chart })
  }

  // Album art that 404'd or failed to decode, keyed by md5 the way Home's
  // Latest Charts row keys its own set, so the card falls back to the
  // surface-2 placeholder instead of a broken icon and the dead URL is not
  // requested again.
  //
  // The set is per-visit: Explore is unmounted by every navigation, so a URL
  // that failed is tried once more on the way back. M7 recorded the same about
  // the list views' failure sets: self-healing beats a stale cache of
  // failures, and the cost is one request per remount.
  const artFailed = new SvelteSet<string>()

  function artFor(chart: ChartData): string | null {
    if (!chart.albumArtMd5 || artFailed.has(chart.albumArtMd5)) return null
    return albumArtUrl(chart.albumArtMd5)
  }

  // A row (and a grid card) is a plain container, not a button, so it can hold
  // controls of its own, since a button may not contain one. Enter and Space come
  // from the real <button> around the title inside it; this handler only widens
  // the mouse target back out to the whole row or card, which is what it was
  // when the row itself was the button.
  //
  // Widening it that far means clicks a control inside has already answered
  // arrive here too, so this is the single place that stands aside for them.
  // Without it the title button would hand the same chart over twice, and the
  // version toggle would expand a group and then replace the rail's subject
  // with the group's primary.
  function onRowClick(chart: ChartData, e: MouseEvent): void {
    if (e.target instanceof Element && e.target.closest('button, input, a, select')) return
    selectChart(chart)
  }

  // Every alternate version of a song repeats its title and artist, so a name
  // that stopped at the title would announce them identically. The charter is
  // what distinguishes them.
  //
  // Stripped, like the row it names: a screen reader reading out a colour tag while the eye
  // reads the name is worse than either one alone.
  function chartLabel(chart: ChartData): string {
    const name = stripRichText(chart.name)
    const artist = stripRichText(chart.artist)
    const charter = stripRichText(chart.charter)
    const attribution = [artist ? `by ${artist}` : '', charter ? `charted by ${charter}` : '']
      .filter(Boolean)
      .join(', ')
    return attribution ? `${name} ${attribution}` : name
  }

  // The selected rows, and the subset of them a bulk download would actually
  // fetch. Every selected chartId is in `$results` by construction: the
  // selection is cleared exactly when a run replaces the rows.
  //
  // Nothing here filters out charts already in the download queue. The manager
  // ignores an md5 it is already holding (queued, running, done or errored),
  // so re-adding one is a no-op, and a second copy of that rule in the renderer
  // would be a second place for it to be wrong. What the queue cannot know is
  // what an earlier session downloaded, which is exactly what `inLibraryIds`
  // answers, so that is the one thing left out here.
  /**
   * The groups as the list draws them, which is all of them until Hide owned is on.
   *
   * A group is a song and its alternate versions, and ownership is per chart, so hiding cannot
   * work a group at a time: the case that matters is owning one version of a song and wanting
   * the others. What is dropped is the owned charts, and the first version left standing becomes
   * the one the row is drawn for. A group with nothing left disappears.
   *
   * `songId` is what the {#each} keys on and every chart in a group shares it, so promoting an
   * alternate does not re-key the row; it re-draws it.
   */
  const shownGroups = $derived(
    $hideOwned
      ? $groups.flatMap((group) => {
          const kept = [group.primary, ...group.others].filter((c) => !inLibraryIds.has(c.chartId))
          return kept.length === 0 ? [] : [{ primary: kept[0], others: kept.slice(1) }]
        })
      : $groups
  )

  /** How many loaded charts Hide owned is keeping off the screen, for the line that says so. */
  const hiddenCount = $derived(
    $hideOwned ? $results.length - shownGroups.reduce((n, g) => n + 1 + g.others.length, 0) : 0
  )

  /**
   * Every chart the user can currently point at: the shown primaries, and the alternates of the
   * groups that are open. A collapsed group's alternates are not on screen, which is the same
   * rule `deselectAlternates` enforces in the store.
   */
  const onScreen = $derived(
    new Set(
      shownGroups.flatMap((g) => [
        g.primary.chartId,
        ...(g.primary.songId !== null && $expanded.has(g.primary.songId)
          ? g.others.map((c) => c.chartId)
          : [])
      ])
    )
  )

  /**
   * Hiding a chart takes its checkbox off the screen, so anything ticked among the hidden ones
   * would leave the selection bar counting rows nobody can see and a bulk download fetching a
   * chart the user cannot point at. The same rule collapsing a group already follows, arrived at
   * from the other direction. Every chart this drops is one Encore had already refused to
   * download, so nothing that would have been fetched is lost.
   */
  $effect(() => {
    if (!$hideOwned) return
    for (const chartId of $selected) {
      if (!onScreen.has(chartId)) search.toggleSelected(chartId)
    }
  })

  const picked = $derived($results.filter((c) => $selected.has(c.chartId)))
  const toQueue = $derived(picked.filter((c) => !inLibraryIds.has(c.chartId)))
  const alreadyOwned = $derived(picked.length - toQueue.length)

  let bulkError = $state<string | null>(null)
  let queueing = $state(false)

  // The message is about the batch that was on screen when Download was
  // pressed, so changing the batch retires it rather than leaving a sentence
  // that describes a selection the user has since edited.
  $effect(() => {
    void $selected
    bulkError = null
  })

  async function downloadSelected(): Promise<void> {
    if (queueing || toQueue.length === 0) return
    bulkError = null
    // `downloadAdd` resolves whether or not a library folder is configured: the
    // rejection lives in the download runner, which runs once per queued chart.
    // Enqueuing regardless would therefore put N identical failures in the
    // queue instead of answering the question once, here, having queued
    // nothing. Explore is reachable in this state: the first-run welcome's
    // "Explore charts instead" leads straight to it.
    if ($settings.libraryFolders.length === 0) {
      bulkError =
        'No library folder yet, so there is nowhere to put these charts. Add one in Settings.'
      return
    }
    queueing = true
    const batch = toQueue
    const outcomes = await Promise.allSettled(
      batch.map((c) =>
        encore().downloadAdd({
          md5: c.md5,
          hasVideoBackground: c.hasVideoBackground,
          meta: { name: c.name, artist: c.artist, charter: c.charter }
        })
      )
    )
    queueing = false
    const failed = outcomes.filter((o) => o.status === 'rejected').length
    if (failed > 0) {
      // One sentence for the batch, not one per chart. The selection stays so a
      // retry does not mean picking everything again; the queue's md5 dedupe
      // makes re-adding the ones that did get through harmless.
      bulkError = `Encore could not queue ${failed} of ${batch.length} charts. Try Download again.`
      return
    }
    // Handed over: the download panel is where this batch lives now, and ticks
    // left standing invite a second click the queue would silently swallow.
    search.clearSelected()
  }

  /**
   * The five parts a row draws, and the only five.
   *
   * Chorus returns thirteen `diff_*` fields and the matrix can list ten instruments, but a row
   * is read by scanning down a column and a column only exists if every row has it. Thirteen
   * would be a wall. These five are the band Clone Hero is played in and the five the approved
   * design draws: the six-fret variants and the co-op parts are controller and seating
   * arrangements rather than instruments, and they stay in the chart page's matrix, which has a
   * column per row and room to be complete.
   *
   * Installed still shows three. That is not this list disagreeing with it: Explore's row folds
   * the difficulty onto a line of its own below 800px and Installed's does not, so the two have
   * different room, and Installed is the list of charts you already chose rather than the one
   * you are choosing from.
   */
  const ROW_PARTS: readonly { key: string; label: string }[] = [
    { key: 'guitar', label: 'Guitar' },
    { key: 'bass', label: 'Bass' },
    { key: 'drums', label: 'Drums' },
    { key: 'keys', label: 'Keys' },
    { key: 'vocals', label: 'Vocals' }
  ]

  function tierOf(chart: ChartData, key: string): number | null {
    if (key === 'bass') return chart.diff_bass
    if (key === 'drums') return chart.diff_drums
    if (key === 'keys') return chart.diff_keys
    if (key === 'vocals') return chart.diff_vocals
    return chart.diff_guitar
  }

  /**
   * scan-chart's reading of which tracks the chart contains, empty when it never read it.
   *
   * Vocals is appended rather than read out of the list, because it is never in the list: the
   * scan counts playable note tracks and a lyric track is not one, which is why the chart page's
   * matrix has no vocals row either. `hasVocals` is the same scan's answer to the same question
   * for that one track, so a chart with lyrics reports vocals present and one without reports it
   * absent, which is what the ring beside the pips is for.
   */
  function partsOf(chart: ChartData): readonly string[] {
    const scanned = chart.notesData?.instruments ?? []
    if (!chart.notesData?.hasVocals) return scanned
    return scanned.includes('vocals') ? scanned : [...scanned, 'vocals']
  }

  /**
   * Which difficulties the chart was written at, across every instrument it has.
   *
   * The union rather than one row per instrument: the chart page's matrix answers per part, and
   * what a row has space for is the one question someone scanning a list asks, which is whether
   * there is anything here below expert. Read off `noteCounts`, which is scan-chart's own count
   * of notes on each track, so a difficulty declared in the metadata but empty of notes does not
   * count as charted.
   *
   * Null when the chart was never scanned. A chart with no note data is not a chart with no
   * difficulties, and a badge cannot say "unknown" in four characters.
   */
  const DIFF_LETTERS: readonly { key: string; letter: string; word: string }[] = [
    { key: 'easy', letter: 'E', word: 'easy' },
    { key: 'medium', letter: 'M', word: 'medium' },
    { key: 'hard', letter: 'H', word: 'hard' },
    { key: 'expert', letter: 'X', word: 'expert' }
  ]

  function spreadOf(chart: ChartData): { text: string; title: string } | null {
    const counts = chart.notesData?.noteCounts ?? []
    const present = DIFF_LETTERS.filter((d) =>
      counts.some((c) => c.difficulty === d.key && c.count > 0)
    )
    if (present.length === 0) return null
    const words = present.map((d) => d.word)
    const listed =
      words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
    return {
      // The one-difficulty case named in words, because "X" alone is the thing a beginner most
      // needs to be told and a single letter is the least legible way to tell them.
      text:
        present.length === 1
          ? `${present[0].word.toUpperCase()} ONLY`
          : present.map((d) => d.letter).join('/'),
      title: `Charted at ${listed}.`
    }
  }

  /**
   * The badges, chosen for how rarely they are true.
   *
   * A badge earns its place by splitting the list, and a flag that is set on more than half of
   * Chorus splits nothing. Measured over 100 charts from api.enchor.us on 2026-09-15:
   * hasLyrics 62, hasOpenNotes 61, hasTapNotes 57, hasSoloSections 44. Four badges on most
   * rows would be four things to read past on the way to the title. They are out.
   *
   * These three are in because they are uncommon and because each one changes a decision.
   * VIDEO is most of what a download weighs and Encore can strip it. 2X KICK is a chart a
   * drummer either has the pedals for or does not. MODCHART is rare enough (0 of that 100)
   * that when it is there it is the most surprising thing about the chart.
   *
   * `packName` is not a badge: it was null on all 100. A badge nothing ever sets is markup
   * that only ever costs.
   */
  function badgesFor(chart: ChartData): { key: string; text: string; title: string }[] {
    const badges: { key: string; text: string; title: string }[] = []
    if (chart.hasVideoBackground) {
      badges.push({
        key: 'video',
        text: 'VIDEO',
        title: 'Ships a background video, which is most of the download. Settings can skip it.'
      })
    }
    if (chart.notesData?.has2xKick) {
      badges.push({ key: 'kick', text: '2X KICK', title: 'The drum chart uses a double pedal.' })
    }
    if (chart.modchart) {
      badges.push({
        key: 'mod',
        text: 'MODCHART',
        title: 'Drives scripted effects, not just notes.'
      })
    }
    return badges
  }

  // `explainIssue` needs to know which machine this is, because badVideo is a fault on Linux
  // and a portability note everywhere else. Read once: it cannot change while the app runs.
  const platform = encore().platform

  function healthOf(chart: ChartData): { summary: ReturnType<typeof issueSummary>; title: string } {
    const summary = issueSummary(chart, platform)
    // Chorus Encore is who looked: these issues arrived with the search result, and nothing
    // local has read the chart.
    return { summary, title: issueTitle(summary, 'Chorus') ?? '' }
  }

  /** Artist, album and year on one line, with the separators of the empty fields dropped. */
  function metaOf(chart: ChartData): string {
    return [chart.artist, chart.album, chart.year]
      .map((part) => stripRichText(part ?? ''))
      .filter(Boolean)
      .join(' · ')
  }

  /**
   * Queueing one chart from its own row, next to the selection that queues many.
   *
   * Same call, same guard and same md5 dedupe as `downloadSelected`: the manager ignores an
   * md5 it already holds, so a second press costs nothing, and a library folder that is not
   * set is answered once here rather than as one failure per chart in the queue.
   *
   * The set is what the button reads, so a row that has been queued says so for the rest of
   * the visit. It is not persistence: the download panel is where a queue actually lives, and
   * a chart that finishes downloading turns up as IN LIBRARY on the next visit anyway.
   */
  const queued = new SvelteSet<number>()
  let rowError = $state<string | null>(null)

  async function downloadOne(chart: ChartData): Promise<void> {
    rowError = null
    if ($settings.libraryFolders.length === 0) {
      rowError =
        'No library folder yet, so there is nowhere to put this chart. Add one in Settings.'
      return
    }
    queued.add(chart.chartId)
    try {
      await encore().downloadAdd({
        md5: chart.md5,
        hasVideoBackground: chart.hasVideoBackground,
        meta: { name: chart.name, artist: chart.artist, charter: chart.charter }
      })
    } catch {
      // Taken back out, so the button offers the action again rather than claiming it is done.
      queued.delete(chart.chartId)
      rowError = `Encore could not queue "${stripRichText(chart.name)}". Try again.`
    }
  }

  // Gated on `searched` rather than on the rows alone: the store debounces for 300ms before it
  // requests anything, and during that window an unasked question looks exactly like one that
  // came back empty. `error` has its own card above the table and speaks for itself.
  const showEmpty = $derived($searched && !$loading && !$error && $results.length === 0)
  /** Rows came back and Hide owned left none of them on screen; see the note beside the markup. */
  const allHidden = $derived(!$error && $results.length > 0 && shownGroups.length === 0)
  const activeQuery = $derived($globalQuery.trim())
</script>

<div class="browse">
  <div class="main">
    <div class="searchbar">
      <input
        bind:this={inputEl}
        value={$globalQuery}
        placeholder="Search charts…"
        aria-label="Search charts"
        oninput={(e) => onQueryInput(e.currentTarget.value)}
      />
    </div>
    <!-- The box used to be disabled while filters were applied, with a paragraph here explaining
         the takeover. It is not any more: typing drops the filters instead (see `setQuery`), so
         both search boxes now do what they look like they do. What that owes the user is this
         note. Results changing under someone for a reason they did not ask for is the failure
         this whole rule exists to avoid, and a filter count falling quietly to zero is not a
         reason anyone can see.

         role="status" rather than "alert": it follows something the user just did and is not an
         interruption, and Restore is the way back rather than a warning to heed. -->
    {#if $advancedDropped > 0}
      <p class="dropped" role="status">
        <span>
          Searching cleared {$advancedDropped}
          {$advancedDropped === 1 ? 'advanced filter' : 'advanced filters'}. Chorus Encore does not
          take a search term alongside them.
        </span>
        {#if $advancedDraftCount > 0}
          <!-- The panel still holds every field, so this is the same act as opening it and
               pressing Search, offered where the news is. -->
          <button class="dropped-action" onclick={() => search.restoreAdvanced()}>
            Restore filters
          </button>
        {/if}
        <button class="dropped-action" onclick={() => search.dismissAdvancedDropped()}>
          Dismiss
        </button>
      </p>
    {/if}
    <div class="filters">
      <select
        class="chip"
        aria-label="Filter by instrument"
        value={instrument ?? ''}
        onchange={(e) => onFilterChange('instrument', e.currentTarget.value)}
      >
        {#each INSTRUMENTS as opt (opt.label)}
          <option value={opt.value ?? ''}>{opt.label}</option>
        {/each}
      </select>
      <!-- Four dots rather than a list, which is the shape the approved design draws and the
           count the endpoint has: a bad difficulty comes back as a 400 naming the whole enum,
           `'expert' | 'hard' | 'medium' | 'easy'`, and an array of two is refused by the same
           check as `received: array` (measured 2026-09-16). So one at a time, easy on the left,
           and the design's six dots are the intensity scale its rows draw pips of, not this. -->
      <div class="dots" role="group" aria-label="Filter by difficulty">
        <span class="band-label">Difficulty</span>
        {#each DIFFICULTY_DOTS as opt (opt.value)}
          <button
            class="dot"
            aria-label={opt.label}
            aria-pressed={difficulty === opt.value}
            title={difficulty === opt.value
              ? `Charts written at ${opt.label.toLowerCase()}. Press again for any difficulty.`
              : `Charts written at ${opt.label.toLowerCase()}`}
            onclick={() => onDifficultyDot(opt.value)}
          ></button>
        {/each}
        <!-- The dots carry no visible word, so the chosen one is named here: reading a row of
             dots and knowing which difficulty the third one is otherwise means counting. Only
             while one is chosen. Nothing lit under a label reading Difficulty already says no
             difficulty is being asked for, and this row is at three lines at its narrowest, so a
             word that says what the control already shows is one the header cannot afford. -->
        {#if difficulty !== null}
          <span class="band-to">{difficultyName}</span>
        {/if}
      </div>
      <!-- The third control, and a different question from the two above it. Difficulty is which
           charted difficulties exist; intensity is how hard the chart is, the same number the
           row's pips draw. Without it "expert, but not brutal" cannot be asked, which is the
           question someone learning an instrument has.

           Its two ends are the panel's own `minIntensity` and `maxIntensity`, written through
           the store; see `setIntensity`. Off until an instrument is chosen, because the endpoint
           reads the band against whichever instrument was named and against all of them at once
           when none was; see ADVANCED_RANGES for what that measures out as.

           The lowest list ends in 7+ and the highest at 6. That asymmetry is the honest one:
           ratings run past where Clone Hero's scale is drawn, so the open end says the scale
           carries on, while a maximum is a bound the user picked and Any is already the open
           top. Nothing is clamped: 7+ sends 7, and a chart rated 20 still reads 20 in its pips. -->
      <div class="band" role="group" aria-label="Filter by intensity">
        <span class="band-label">Intensity</span>
        <select
          class="chip tier"
          disabled={instrument === null}
          aria-label={bandName('Lowest')}
          title="7+ is every rating above 6. Charters rate past the top of the drawn scale."
          value={$advanced.numbers.minIntensity}
          onchange={(e) => onIntensityChange('min', e.currentTarget.value)}
        >
          {#each INTENSITY_FLOORS as bound (bound.value)}
            <option value={bound.value}>{bound.label}</option>
          {/each}
        </select>
        <span class="band-to">to</span>
        <select
          class="chip tier"
          disabled={instrument === null}
          aria-label={bandName('Highest')}
          value={$advanced.numbers.maxIntensity}
          onchange={(e) => onIntensityChange('max', e.currentTarget.value)}
        >
          {#each INTENSITY_CEILINGS as bound (bound.value)}
            <option value={bound.value}>{bound.label}</option>
          {/each}
        </select>
        {#if instrument === null}
          <span class="band-why">pick an instrument</span>
        {/if}
      </div>
      <!-- The count is on the button, not only inside the panel, because the panel is shut most
           of the time and a list narrowed by filters nobody can see is a list that looks wrong.
           Clear sits beside it for the same reason: the way out has to be where the evidence is. -->
      <button
        class="adv"
        class:on={$advancedCount > 0}
        aria-expanded={$advancedOpen}
        aria-controls="advanced-panel"
        aria-label={$advancedCount > 0
          ? `Advanced search, ${$advancedCount} ${$advancedCount === 1 ? 'filter' : 'filters'} applied`
          : 'Advanced search'}
        onclick={() => search.setAdvancedOpen(!$advancedOpen)}
      >
        Advanced{#if $advancedCount > 0}<span class="adv-count">{$advancedCount}</span>{/if}
      </button>
      {#if $advancedCount > 0}
        <button class="adv-clear" onclick={() => search.clearAdvanced()}>Clear filters</button>
      {/if}
      <!-- Order and layout, at the far end and grouped: neither one narrows the results, they
           arrange what came back. Everything to their left is a filter. -->
      <div class="arrange">
        <select
          class="chip"
          aria-label="Order results"
          value={$sortKey}
          onchange={(e) => search.setSort(e.currentTarget.value)}
        >
          {#each SORT_OPTIONS as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
        <!-- Two buttons rather than one that toggles: the label of a toggle names
             the state you are leaving or the one you are going to, and which of
             those it means is a coin flip. Here each button names a layout and
             says whether it is the one you are in. -->
        <div class="modes" role="group" aria-label="Result layout">
          <button
            class="mode"
            aria-pressed={$mode === 'list'}
            onclick={() => search.setMode('list')}>List</button
          >
          <button
            class="mode"
            aria-pressed={$mode === 'grid'}
            onclick={() => search.setMode('grid')}>Grid</button
          >
        </div>
      </div>
    </div>
    <!-- The chip row, which is what the approved design puts under the search row: the advanced
         fields people actually reach for, each carrying its current value and lit when it is
         set, so a narrowed list says what narrowed it without the panel being open.

         None of these is a filter of its own. Each writes the panel's own field through
         `setAdvancedField`, which sets the applied query and the draft together, so opening the
         panel shows what a chip set and a keystroke in the panel cannot quietly undo it. -->
    <div class="fdrops">
      {#each CHIPS as chip (chip.field)}
        <div class="fd-wrap">
          <button
            class="fd"
            class:set={chipSet(chip)}
            aria-expanded={openChip === chip.field}
            aria-controls="chip-{chip.field}"
            aria-label="{chip.label}: {chipText(chip)}"
            onclick={() => toggleChip(chip)}
          >
            <em>{chip.label}</em>{chipText(chip)}
          </button>
          {#if openChip === chip.field}
            <!-- svelte-ignore a11y_no_static_element_interactions
                 (Escape on the container, because the key has to work from every control inside
                 it and a handler per input is four copies of one rule.) -->
            <div
              class="pop"
              id="chip-{chip.field}"
              onkeydown={(e) => {
                if (e.key === 'Escape') openChip = null
              }}
            >
              {#if chip.kind === 'text'}
                <!-- One box, and no Exact or Exclude beside it. Those two change what the word
                     means rather than what it is, and the panel is where a modifier belongs;
                     a chip standing over an excluded field says "not Rock" instead. -->
                <input
                  class="text-input"
                  type="text"
                  autocomplete="off"
                  aria-label="{chip.label} contains"
                  value={pendingText}
                  oninput={(e) => (pendingText = e.currentTarget.value)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') applyChip(chip)
                  }}
                />
              {:else}
                {@const unit = unitOf(chip.min)}
                <div class="pop-range">
                  <!-- Named "from" and "to" rather than "lowest" and "highest", which is what the
                       panel's own boxes are called: two controls with one accessible name is one
                       control a screen reader cannot point at, and the panel can be open while
                       this is. No max on either end, for the reason the panel has none. -->
                  <input
                    class="num"
                    type="number"
                    step="1"
                    inputmode="decimal"
                    placeholder="any"
                    aria-label="{chip.label} from{unit ? `, in ${unit}` : ''}"
                    value={pendingLow}
                    oninput={(e) => (pendingLow = e.currentTarget.value)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') applyChip(chip)
                    }}
                  />
                  <span class="pop-to">to</span>
                  <input
                    class="num"
                    type="number"
                    step="1"
                    inputmode="decimal"
                    placeholder="any"
                    aria-label="{chip.label} to{unit ? `, in ${unit}` : ''}"
                    value={pendingHigh}
                    oninput={(e) => (pendingHigh = e.currentTarget.value)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') applyChip(chip)
                    }}
                  />
                  {#if unit}<span class="pop-to">{unit}</span>{/if}
                </div>
                {#if chip.field === 'year'}
                  <!-- The decades, as the two fields they actually are. The design has a Decade
                       chip beside Year; the endpoint has `minYear` and `maxYear` and nothing
                       else, so a second chip over the same pair would be the one thing this
                       header may not have. Here they are a way to fill the range in one press,
                       and the chip reads back "2000s" when the range is exactly a decade. -->
                  <div class="pop-presets">
                    {#each DECADES as start (start)}
                      <button class="preset" onclick={() => pickDecade(chip, start)}
                        >{start}s</button
                      >
                    {/each}
                  </div>
                {/if}
              {/if}
              <div class="pop-actions">
                <button class="pop-apply" onclick={() => applyChip(chip)}>Apply</button>
                <button class="pop-clear" onclick={() => clearChip(chip)}>Clear</button>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
    {#if $advancedOpen}
      <AdvancedSearch {search} />
    {/if}
    <!-- The bar over the list: how many charts came back, what is being left out of the drawing,
         and what to do with the ones that are ticked. It is about the answer, where everything
         above it is about the question.

         There is no "direct downloads only" here, which the design has. Every one of the 66
         fields a search result carries was dumped on 2026-09-16 and none of them distinguishes
         one kind of download from another: Encore fetches every chart from the same
         files.enchor.us address, by md5, so on this source the toggle would be on or off over
         the same list. It is a RhythmVerse idea, where an entry can point at somebody else's
         file host, and Encore does not query RhythmVerse. A control that cannot change the
         answer is worse than a missing one. -->
    <div class="rbar">
      <!-- Not a live region: the list already has one, off screen at the end of it, and two that
           announce the same number is one of them read out twice. -->
      <span class="found">
        {#if $loading && $results.length === 0}
          Searching…
        {:else if $found}
          <b>{$found.toLocaleString()}</b> results
        {/if}
      </span>
      <!-- A button with aria-pressed rather than a checkbox: it is not a field in a form that
           gets submitted, it takes effect on the press, and the pressed state is the thing a
           screen reader has to hear. -->
      <button
        class="cbx"
        aria-pressed={$hideOwned}
        onclick={() => hideOwned.update((on) => !on)}
        title="Leaves out the charts whose song, artist and charter match one already installed."
      >
        <i aria-hidden="true"></i>Hide owned
      </button>
      {#if hiddenCount > 0}
        <!-- Counted over the rows that are loaded, not over the answer: Chorus was not asked
             about the library and its total does not know about it. Saying so is the difference
             between a number and a claim nobody can check. -->
        <span class="hidden-note">{hiddenCount} of the loaded charts hidden</span>
      {/if}
      <!-- Only while there is a selection: an empty selection is the state this
           list is in nearly all the time, and a bar that is always there would
           charge every visit for an occasional action. -->
      {#if $selected.size > 0}
        <div class="selbar">
          <span class="sel-count">{$selected.size} selected</span>
          <button
            class="sel-btn primary"
            disabled={toQueue.length === 0 || queueing}
            onclick={() => void downloadSelected()}
          >
            {toQueue.length > 0 ? `Download ${toQueue.length}` : 'Nothing to download'}
          </button>
          <button
            class="sel-btn"
            aria-label="Clear selection"
            onclick={() => search.clearSelected()}>Clear</button
          >
        </div>
      {/if}
      {#if alreadyOwned > 0}
        <!-- Named rather than quietly dropped: a batch that downloads fewer charts than were
             ticked has to say so, and re-fetching a chart the user already owns is the
             alternative nobody asked for. On a line of its own under the bar, because it is a
             sentence and the bar is a row of chips. -->
        <span class="sel-note"
          >{alreadyOwned} already in your library, so left out of the download</span
        >
      {/if}
      {#if bulkError}
        <span class="sel-error">{bulkError}</span>
      {/if}
    </div>
    <!-- One line for the whole list rather than one inside each row: a download that could not
         be queued has a sentence's worth of reason, and a row has no space for a sentence. It
         sits above the results because that is where the rest of the list's news is.

         role="status" rather than "alert": it follows a button the user just pressed. -->
    {#if rowError}
      <p class="row-error" role="status">
        <span>{rowError}</span>
        <button class="dropped-action" onclick={() => (rowError = null)}>Dismiss</button>
      </p>
    {/if}
    {#if $error}
      <!-- role="alert": a failed search replaces the list with this card and nothing else moves,
           so a screen reader that is not told is left with a list that quietly stopped. -->
      <div class="error" role="alert">
        {$error} <button onclick={() => search.retry()}>Retry</button>
      </div>
    {/if}
    <!-- One definition for the row's checkbox and the card's: the two differ
         only in where they sit, and a second copy is how the accessible name on
         one drifts from the other. -->
    {#snippet pick(c: ChartData)}
      <input
        class="pick"
        type="checkbox"
        aria-label="Select {chartLabel(c)}"
        checked={$selected.has(c.chartId)}
        onchange={() => search.toggleSelected(c.chartId)}
      />
    {/snippet}
    <!-- The four things a result says about a chart, each defined once. The row, the row an
         expanded group adds under it and the grid card all render these, and a second copy of
         any of them is how one layout comes to claim something the other does not. -->
    {#snippet badges(c: ChartData)}
      {#each badgesFor(c) as badge (badge.key)}
        <span class="badge mono" title={badge.title}>{badge.text}</span>
      {/each}
    {/snippet}
    <!-- `icon` is the row's, not the card's. A row draws the group as a ring with the pips under
         it, five across, which is the shape the approved design has and the shape five instruments
         need: five letters in a line read as a word. A card is 148px wide and has no line to give
         a 19px ring, so it keeps the letters. Both draw the same five parts, so switching layout
         changes the shape and not the subject. -->
    {#snippet pips(c: ChartData, icon: boolean)}
      {#each ROW_PARTS as part (part.key)}
        <DiffPips
          instrument={part.key}
          label={part.label}
          instruments={partsOf(c)}
          tier={tierOf(c, part.key)}
          {icon}
        />
      {/each}
    {/snippet}
    <!-- The band under the subtitle: what the chart is, rather than what it is called.
         Length, the difficulties it was written at, the flags that survived the cut above, and
         the charter.
         Two of the design's six are missing and cannot be drawn. The chart format (a Rock Band
         conversion against a native Clone Hero chart) and the download count are not in the
         answer: all 66 fields of a search result were dumped on 2026-09-16 and neither is among
         them, nor is a file size or a rating. Chart Manager has them because it also queries
         RhythmVerse. Encore does not, so a badge for either would be empty on every row.
         "In library" is not here either, and that one is a choice: the row already says it,
         once, where the Download button would otherwise be, which is where the question it
         answers gets asked. -->
    {#snippet band(c: ChartData)}
      {@const spread = spreadOf(c)}
      <span class="badges">
        {#if c.song_length != null && c.song_length >= 0}
          <span class="badge mono length">{msToTime(c.song_length)}</span>
        {/if}
        {#if spread}
          <span class="badge mono" title={spread.title}>{spread.text}</span>
        {/if}
        {@render badges(c)}
        <span class="badge mono charter">{stripRichText(c.charter)}</span>
      </span>
    {/snippet}
    <!-- Nothing at all for a clean chart, which is 60 charts in 100. A mark on every row is a
         mark that means nothing; this one only appears where there is something to say, so the
         eye lands on the rows that have it. Chorus runs scan-chart over everything it ingests
         and sends the findings with the search result, so this costs no request. -->
    {#snippet health(c: ChartData)}
      {@const found = healthOf(c)}
      {#if found.summary.worst !== null}
        <span
          class="dot"
          class:broken={found.summary.worst === 'blocking'}
          role="img"
          aria-label={found.title}
          title={found.title}
        ></span>
      {/if}
    {/snippet}
    <!-- Owned is a statement and downloading is an action, so one is text and one is a button.
         The metadata match behind "IN LIBRARY" means this song by this charter is installed,
         which is why the button is gone rather than merely dimmed: there is nothing useful to
         press. -->
    {#snippet action(c: ChartData)}
      {#if inLibraryIds.has(c.chartId)}
        <span class="lib-badge">IN LIBRARY</span>
      {:else if queued.has(c.chartId)}
        <span class="queued mono">QUEUED</span>
      {:else}
        <button
          class="get"
          aria-label="Download {chartLabel(c)}"
          onclick={() => void downloadOne(c)}>Download</button
        >
      {/if}
    {/snippet}
    <!-- Primary and alternate cards differ only in the version chip and the
         badge, so they share one snippet: two near-identical blocks is how the
         accessible name on one of them drifts from the other. -->
    {#snippet card(c: ChartData, alternates: number, isExpanded: boolean, isAlt: boolean)}
      {@const art = artFor(c)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions
           (As on .row: this widens the mouse target to the whole card, and the
           keyboard path is the .name button inside it.) -->
      <div class="card" class:alt={isAlt} onclick={(e) => onRowClick(c, e)}>
        {@render pick(c)}
        {#if art}
          <img
            class="art"
            src={art}
            alt=""
            loading="lazy"
            onerror={() => c.albumArtMd5 && artFailed.add(c.albumArtMd5)}
          />
        {:else}
          <div class="art placeholder"></div>
        {/if}
        <span class="c-title">
          <button class="name" aria-label={chartLabel(c)} onclick={() => selectChart(c)}
            >{stripRichText(c.name)}</button
          >
          {#if alternates > 0 && c.songId !== null}
            <button
              class="ver-chip"
              onclick={() => search.toggleExpanded(c.songId as number)}
              aria-expanded={isExpanded}
              aria-label="{alternates + 1} versions">+{alternates}</button
            >
          {/if}
          {#if isAlt}
            <span class="alt-badge">OTHER VERSION</span>
          {/if}
          {@render health(c)}
        </span>
        <span class="c-artist">{stripRichText(c.artist)}</span>
        <span class="c-charter">{stripRichText(c.charter)}</span>
        <!-- The pips and the badges are the same two the row draws, so a chart says the same
             thing in both layouts and switching between them is a change of shape, not of
             subject. They wrap, because a card is 148px wide and a row is not. -->
        <span class="c-diffs">{@render pips(c, false)}</span>
        <!-- No badges here, unlike the row. A card is 150px wide at the default window, and a
             badge beside the button either wraps the button onto a line of its own or is clipped
             by the card's edge; measured, the wrap made cards 21px taller than the ones with no
             badge, and card heights in a gallery are what the eye lines up on. The grid is for
             browsing by cover, the list is for comparing charts, and the flags belong with the
             layout that has room to put them in a column. -->
        <span class="c-foot">{@render action(c)}</span>
      </div>
    {/snippet}
    <!-- No `onscroll` here: the listener is attached to the element that actually scrolls, which
         is this one today and is looked up rather than assumed. See `scrollBox`. -->
    <div class="table selectable" bind:this={tableEl}>
      {#if $mode === 'grid'}
        <div class="grid">
          {#each shownGroups as group (group.primary.songId !== null ? group.primary.songId : `c:${group.primary.chartId}`)}
            {@const chart = group.primary}
            {@const isExpanded = chart.songId !== null && $expanded.has(chart.songId)}
            {@render card(chart, group.others.length, isExpanded, false)}
            {#if isExpanded}
              <!-- A card cannot expand in place the way a row does, so the
                   alternates become cards of their own, straight after the one
                   they belong to and marked as versions of it. They are the same
                   `expanded` set the list uses, so a group opened in one layout
                   is open in the other. -->
              {#each group.others as alt (alt.chartId)}
                {@render card(alt, 0, false, true)}
              {/each}
            {/if}
          {/each}
        </div>
      {:else}
        {#each shownGroups as group, i (group.primary.songId !== null ? group.primary.songId : `c:${group.primary.chartId}`)}
          {@const chart = group.primary}
          {@const hasVersions = group.others.length > 0}
          {@const isExpanded = chart.songId !== null && $expanded.has(chart.songId)}
          {@const rowArt = artFor(chart)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions
             (This handler only widens the mouse target; the keyboard path is the .name
             button inside, and giving the container a widget role would put that button
             inside a widget again, which is what this task exists to undo.) -->
          <div class="row" onclick={(e) => onRowClick(chart, e)}>
            {@render pick(chart)}
            <span class="num">{String(i + 1).padStart(2, '0')}</span>
            {#if rowArt}
              <img
                class="cover"
                src={rowArt}
                alt=""
                loading="lazy"
                onerror={() => chart.albumArtMd5 && artFailed.add(chart.albumArtMd5)}
              />
            {:else}
              <div class="cover placeholder"></div>
            {/if}
            <span class="song">
              <span class="title">
                <button
                  class="name"
                  aria-label={chartLabel(chart)}
                  onclick={() => selectChart(chart)}>{stripRichText(chart.name)}</button
                >
                {#if hasVersions && chart.songId !== null}
                  <button
                    class="ver-chip"
                    onclick={() => search.toggleExpanded(chart.songId as number)}
                    aria-expanded={isExpanded}
                    aria-label="{group.others.length + 1} versions">+{group.others.length}</button
                  >
                {/if}
              </span>
              <span class="artist">{metaOf(chart)}</span>
              {@render band(chart)}
            </span>
            <span class="diffs">{@render pips(chart, true)}</span>
            <span class="health">{@render health(chart)}</span>
            <span class="act">{@render action(chart)}</span>
          </div>
          {#if isExpanded}
            {#each group.others as alt (alt.chartId)}
              {@const altArt = artFor(alt)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions
                 (Same as the primary row above.) -->
              <div class="row sub-row" onclick={(e) => onRowClick(alt, e)}>
                {@render pick(alt)}
                <span class="num"></span>
                {#if altArt}
                  <img
                    class="cover"
                    src={altArt}
                    alt=""
                    loading="lazy"
                    onerror={() => alt.albumArtMd5 && artFailed.add(alt.albumArtMd5)}
                  />
                {:else}
                  <div class="cover placeholder"></div>
                {/if}
                <span class="song song-indented">
                  <span class="title text-2"
                    ><button
                      class="name"
                      aria-label={chartLabel(alt)}
                      onclick={() => selectChart(alt)}>{stripRichText(alt.name)}</button
                    ></span
                  >
                  <span class="artist">{metaOf(alt)}</span>
                  {@render band(alt)}
                </span>
                <span class="diffs">{@render pips(alt, true)}</span>
                <span class="health">{@render health(alt)}</span>
                <span class="act">{@render action(alt)}</span>
              </div>
            {/each}
          {/if}
        {/each}
      {/if}
      <!-- One control, two jobs. Reaching it loads the next page on its own until the cap, and
           pressing it loads one past the cap, so a keyboard or screen-reader user who never makes
           a scroll gesture reaches the same rows by tabbing to it and pressing Enter.

           Deliberately not disabled while a page is in flight: disabling the control that has
           focus throws focus back to the document, which loses a keyboard user their place in the
           list every time a page lands. The store ignores a call made while one is already
           running, so a press during a load costs nothing. -->
      {#if !$error && $hasMore}
        <div class="more-row">
          <button bind:this={sentinelEl} class="more" onclick={() => void search.loadMore()}>
            {#if $loading}Loading more…{:else if $atAutoCap}Keep loading{:else}Load more{/if}
          </button>
          {#if $atAutoCap && !$loading}
            <p class="more-note">
              {$results.length.toLocaleString()} of {$found.toLocaleString()} loaded. Explore stops adding
              them on its own here, because everything loaded stays on screen and a list this long is
              what slows down next, not the search.
            </p>
          {/if}
        </div>
      {/if}
      <!-- The rows appear below the fold, so nothing about an appended page is announced without
           this. Rendered from the first paint rather than when the first page lands: a live region
           added to the page at the same moment as its text is not reliably read out. -->
      <p class="sr-only" role="status">
        {#if $loading}
          Loading more charts
        {:else if $results.length}
          {$results.length.toLocaleString()} of {$found.toLocaleString()} charts loaded
        {/if}
      </p>
      {#if showEmpty}
        <p class="empty">
          <!-- Ahead of the query branches, because the endpoint that answered ignores the search
               term when advanced filters are on, so naming the term would credit it for an empty
               answer it had no part in. Reached most often from a chart Detail's tag chips: a
               charter or an album read off an installed chart need not exist on Chorus at all,
               and the branch below would have called that the service having trouble. -->
          {#if $advancedCount > 0}
            No charts on Chorus Encore match those advanced filters. Try turning off Exact for a
            field, or clear the filters.
          {:else if activeQuery && (instrument || difficulty)}
            Nothing matches "{activeQuery}" with those filters on. Try clearing the instrument or
            difficulty first.
          {:else if activeQuery}
            Nothing on Chorus Encore matches "{activeQuery}". Try the artist on its own, or fewer
            words.
          {:else if instrument || difficulty}
            No charts match those filters. Set both back to Any to see everything.
          {:else}
            <!-- No query and no filters is the wildcard listing of the whole remote catalog, so an
                 empty answer is the service's, not the user's. Retry is the only useful action. -->
            Chorus Encore returned no charts at all. It may be having trouble.
            <button class="retry" onclick={() => search.retry()}>Retry</button>
          {/if}
        </p>
      {/if}
      <!-- Charts came back and every one of them is already installed. Without this the list is
           blank with a result count over it, which reads as a bug rather than as an answer, and
           the way out is not the search box but the toggle that emptied it. -->
      {#if allHidden}
        <p class="empty">
          Every chart loaded here is already in your library. Turn off Hide owned to see them, or
          load more.
        </p>
      {/if}
    </div>
  </div>
</div>

<style>
  .browse {
    display: flex;
    height: 100%;
  }
  /* The width the results row lays itself out against. On `.main` and not on `.table`, which
     is the element that scrolls: `container-type` brings layout containment with it, and the
     scroller carries the restore, the scroll listener and the observer root that auto-append
     depends on. `.main` is a flex item with `min-width: 0`, so its inline size already comes
     from the frame around it and containing it changes nothing.

     A container query rather than a media query because window width does not tell you how
     wide this column is. The rail is 374px and shows only above 1120px, so the view is 882px
     at a 1120px window and 509px at a 1121px one. A media query would have to encode that
     backwards step; the container just measures. */
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    container-type: inline-size;
    container-name: results;
  }
  .searchbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 10px;
  }
  input {
    flex: 0 1 380px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    padding: 7px 11px;
    color: var(--text-1);
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    transition: border-color var(--t-fast) var(--ease);
  }
  input:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Wraps, because the header now carries four filters, an order and a layout pair, and the
     column they sit in is 509px at its narrowest (a 1121px window, where the rail takes its
     374px back). A row that could not wrap would either scroll sideways or squeeze the selects
     until their longest option ellipsised, and jsdom can see neither. `row-gap` matches the
     column gap so a wrapped second line is not a different rhythm from the first. */
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 0 16px 10px;
  }
  /* The two ends of one filter, so they are one group with one visible label rather than two
     loose selects that happen to be adjacent. The same idiom the panel's Intensity row uses,
     which is the point: they edit the same two fields. */
  .band {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .band-label {
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  .band-to,
  .band-why {
    font-size: var(--fs-caption);
    color: var(--text-3);
    white-space: nowrap;
  }
  /* The difficulty scale, drawn as the approved design draws it: a label, four round toggles
     and the word for whichever one is lit. */
  .dots {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .dot {
    width: 15px;
    height: 15px;
    padding: 0;
    border-radius: 50%;
    border: 1.5px solid var(--hairline);
    background: var(--surface-1);
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .dot:hover,
  .dot:focus-visible {
    border-color: var(--accent);
  }
  .dot[aria-pressed='true'] {
    background: var(--accent);
    border-color: var(--accent);
  }
  /* The chip row, under the filter row rather than inside it: these are the same kind of thing
     as each other and a different kind from the instrument, difficulty and intensity controls
     above, which are the two the endpoint takes outside the advanced body. It wraps for the
     reason the row above it does, and at the 509px view it is measured at two lines. */
  .fdrops {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 16px 10px;
  }
  /* The anchor the editor hangs off, so the popover is positioned against its own chip rather
     than against the row. */
  .fd-wrap {
    position: relative;
  }
  .fd {
    display: flex;
    align-items: center;
    gap: 7px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    color: var(--text-2);
    padding: 4px 12px;
    cursor: pointer;
    max-width: 240px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .fd:hover,
  .fd:focus-visible {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* The field name, quieter than the value: the value is what changes and what is being read. */
  .fd em {
    font-style: normal;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  /* Lit only when the chip is actually narrowing the answer, which is what `chipText` decides. */
  .fd.set {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text-1);
  }
  .fd.set em {
    color: var(--text-2);
  }
  /* Over the list rather than pushing it down: the header is already the tallest thing on this
     view, and an editor that shifted every row under it would cost the list on every press
     rather than only while it is open. */
  .pop {
    position: absolute;
    z-index: 5;
    top: calc(100% + 6px);
    left: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    min-width: 232px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    box-shadow: var(--elev-3);
  }
  .pop .text-input,
  .pop .num {
    flex: none;
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 5px 9px;
    color: var(--text-1);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
  }
  .pop .num {
    width: 74px;
  }
  .pop-range {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .pop-to {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .pop-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    max-width: 232px;
  }
  .preset {
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    padding: 2px 8px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .preset:hover,
  .preset:focus-visible {
    color: var(--text-1);
    border-color: var(--accent);
  }
  .pop-actions {
    display: flex;
    gap: 6px;
  }
  .pop-apply,
  .pop-clear {
    border-radius: 6px;
    border: 1px solid var(--hairline);
    background: none;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 4px 12px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .pop-apply {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text-1);
  }
  .pop-clear:hover,
  .pop-clear:focus-visible {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* A tier is one or two characters, so this select is sized for its contents rather than for
     its longest label the way the instrument one is. */
  .tier {
    padding-right: 22px;
  }
  .chip:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .chip:disabled:hover {
    color: var(--text-2);
    border-color: var(--hairline);
  }
  .chip {
    appearance: none;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 24px 4px 11px;
    cursor: pointer;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10' fill='none'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' stroke='%238a8a99' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
  }
  .chip:hover,
  .chip:focus {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Sits at the far end of the filter row: these are controls about the results,
     not more things to narrow them by. `margin-left: auto` on the group rather than on the
     layout pair alone, so the order travels with it instead of being stranded among the
     filters. When the row wraps this lands flush right on the line it wraps to. */
  .arrange {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    flex-shrink: 0;
  }
  .modes {
    display: flex;
    gap: 4px;
  }
  .mode {
    appearance: none;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 12px;
    cursor: pointer;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .mode:hover,
  .mode:focus {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* The pressed one is the only lit thing in the row, which is what makes the
     pair readable as "you are here" rather than as two buttons. */
  .mode[aria-pressed='true'] {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text-1);
  }
  /* Error is a quiet card, not accent-coloured text: the accent budget is spent
     on primary actions and active states, not on status copy. */
  .error {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 16px 10px;
    padding: 9px 12px;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .error button {
    margin-left: auto;
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .error button:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Matches Installed's and Asset Studio's empty line, so the three read as one idea. */
  .empty {
    padding: 24px 16px;
    color: var(--text-3);
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    max-width: 60ch;
  }
  .retry {
    margin-left: 8px;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 3px 10px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .retry:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .table {
    flex: 1;
    overflow-y: auto;
    border-top: 1px solid var(--hairline);
  }
  /* The wide row, which is one line of seven tracks: checkbox, index, cover, song, difficulty,
     health, action. The index folds away below 900px and the difficulty onto a line of its own
     below 800px; see the two container queries at the end of this block.

     The charter and the length used to be tracks of their own. They are badges under the
     subtitle now, which is where the approved design puts them, and dropping the two fixed
     tracks is most of what paid for the difficulty column going from 136px to 210px.

     `minmax(0, 1fr)` on the song rather than a bare `1fr`: a grid track's automatic minimum is
     the widest thing in it, so a chart with a long title pushes the row wider than the box
     instead of ellipsising inside it, and the whole list then scrolls sideways. This is the
     rule that keeps Explore from doing that. */
  .row {
    display: grid;
    grid-template-columns: 22px 26px 52px minmax(0, 1fr) 210px 10px 92px;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 7px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
    cursor: pointer;
    position: relative;
    /* On the row, not on `:hover`: declared only under the hover rule, the fade played on the
       way in and snapped on the way out. */
    transition: background var(--t-fast) var(--ease);
  }
  .row:hover {
    background: var(--surface-1);
  }
  /* Fixed rather than aspect-ratio: a square that takes its height from its width is a square
     that changes the row's height when the column does, and rows of two heights are the thing
     the eye trips over when scanning a list. 52px, which is the size in the approved design and
     about what three lines of text beside it come to, so the cover no longer sets the height. */
  .cover {
    width: 52px;
    height: 52px;
    border-radius: 5px;
    object-fit: cover;
    display: block;
    background: var(--surface-2);
  }
  .sub-row {
    background: rgba(255, 255, 255, 0.015);
  }
  /* auto-fill rather than a declared track count: the window is resizable, so a
     fixed number of columns would either strand a gutter or overflow. None of
     this has been seen: jsdom computes no layout, so the tests say nothing
     about how it lands. */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 12px;
    padding: 14px 16px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 6px;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background var(--t-fast) var(--ease);
    /* Anchors the checkbox, which is taken out of flow below. */
    position: relative;
  }
  /* Always visible rather than revealed on hover: a card is 148px of album art
     and there is nowhere in its flow to put a checkbox without pushing the
     title down, so it sits over the art's corner. Revealing it on hover would
     hide it from the keyboard and from anyone who does not think to hover, and
     none of this layout has been seen; see the note on .grid. */
  .card .pick {
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: var(--z-raised);
  }
  /* 16px, not the UA's 13: the tick has to be readable over album art, and 13px was the
     smallest target in the app. The row's track is 22px, which is the design's, so the box is
     centred in it rather than left against the edge of the list. */
  .pick {
    margin: 0;
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .row .pick {
    justify-self: center;
  }
  /* The bar over the list. One line of the things that are about the answer rather than about
     the question: the count, what is being hidden, and what to do with what is ticked. It wraps
     rather than clips, because two of its children are sentences that only appear sometimes. */
  .rbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 13px;
    padding: 8px 16px;
    flex: none;
    border-top: 1px solid var(--hairline);
  }
  .found {
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  .found b {
    font-family: var(--font-mono);
    font-weight: 700;
    color: var(--text-1);
  }
  .hidden-note {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  /* A tick box drawn rather than an <input>, because this is a button: the control is 14px of
     mark with its word beside it, and the whole thing is the target. */
  .cbx {
    display: flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    color: var(--text-2);
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .cbx:hover,
  .cbx:focus {
    color: var(--text-1);
  }
  .cbx i {
    width: 14px;
    height: 14px;
    flex: none;
    display: grid;
    place-items: center;
    border: 1.5px solid var(--border-2);
    border-radius: 4px;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .cbx[aria-pressed='true'] {
    color: var(--text-1);
  }
  .cbx[aria-pressed='true'] i {
    background: var(--accent);
    border-color: var(--accent);
  }
  /* The tick itself: two borders of a box, rotated. Drawn rather than a glyph so it is the same
     mark at the same weight whatever font the platform falls back to. */
  .cbx[aria-pressed='true'] i::after {
    content: '';
    width: 6px;
    height: 3px;
    border-left: 1.8px solid #fff;
    border-bottom: 1.8px solid #fff;
    transform: rotate(-45deg) translate(1px, -1px);
  }
  /* Pushed to the far end of the bar, and lit, because it is the one thing in the row that is
     an action rather than a reading. */
  .selbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    padding: 3px 4px 3px 11px;
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    border-radius: 9px;
  }
  .sel-count {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-1);
  }
  /* Both of these are sentences rather than chips, so they take the whole line under the bar
     instead of squeezing the buttons off the end of it. */
  .sel-note {
    flex-basis: 100%;
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  .sel-error {
    flex-basis: 100%;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  .sel-btn {
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .sel-btn:hover:not(:disabled) {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .sel-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* The one action the bar exists for; Clear stays a ghost beside it. Same
     gradient and weight as Detail's Download, because it is the same action. */
  .sel-btn.primary {
    border: 0;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
  }
  .sel-btn.primary:hover:not(:disabled) {
    color: #fff;
    filter: brightness(1.12);
  }
  .card:hover {
    background: var(--surface-1);
  }
  /* The tint .sub-row gives an alternate row, so both layouts mark the same
     thing the same way. */
  .card.alt {
    background: rgba(255, 255, 255, 0.015);
  }
  /* The background fills the box both for `.placeholder` (no art, or art that
     failed) and for a lazy image that has not decoded yet, so a card never
     flashes a transparent square as the grid scrolls. */
  .art {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 7px;
    object-fit: cover;
    display: block;
    margin-bottom: 6px;
    background: var(--surface-2);
  }
  .c-title {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
  }
  .c-artist {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-charter {
    font-size: var(--fs-caption);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Wraps, now that there are five groups and not three. The old rule was `nowrap`, to stop one
     card standing taller than the ones beside it; what made that a risk was a badge that only
     some charts carry. The difficulty groups are not that: every card draws five of them, so
     every card wraps at the same point and the gallery still lines up.

     `margin-top: auto` on the foot pins the action to the bottom of every card, so a column of
     cards has its buttons on one line whatever length of title each one carries. */
  .c-diffs {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 6px;
    overflow: hidden;
    margin-top: 4px;
  }
  .c-foot {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: auto;
    padding-top: 6px;
  }
  /* Same quiet mono family as .lib-badge and .ver-chip: it labels the card, it
     is not something to click. */
  .alt-badge {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 0 4px;
    line-height: var(--lh-tight);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .num {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .song {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .song-indented {
    padding-left: 14px;
  }
  /* `overflow: hidden` so the chips on this line clip against the cell rather than painting
     over the column beside it and dragging the whole list sideways, and a floor under the
     title below so the thing that gives way is a badge and not the chart's name. */
  .title {
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
  }
  /* The title is the row's own button, and the row around it is a plain container,
     because a button cannot hold the version toggle beside it. Pressing it puts the
     chart in the preview rail, which is what the row's own click does; the name is
     what it is called because the name is what it says. Reset to look like the text
     it replaced, and keep the ellipsis rules that were on that text: they are what
     makes a long title truncate instead of pushing the version chip out of the flex
     row. */
  .name {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Roughly eight characters, and the point at which the chips beside it start losing
       instead. Everything else on this line is `flex-shrink: 0`, so without a floor the title
       is the only thing that can give: measured at a 509px view before the layout below
       existed, a row carrying a version chip and two badges gave its title a 0px box. A row
       that shows no title at all has stopped being a result. */
    min-width: 64px;
    flex: 0 1 auto;
  }
  /* Sub-row title is slightly quieter */
  .title.text-2 {
    font-size: var(--fs-secondary);
    font-weight: 400;
    color: var(--text-2);
  }
  .artist {
    font-size: var(--fs-secondary);
    line-height: var(--lh-tight);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The band under the subtitle. One line, and the charter is what gives.

     It wrapped first, which is what the design does, and that was measured at the narrowest
     column the shell has: at a 1121px window the band is 266px and fourteen rows of twenty-five
     took two lines, so the list ran 102px, 123px, 102px, 123px down the screen. Rows of two
     heights are the thing the eye trips over, and here the cause is a charter's name, which is
     not a reason for a row to be taller than the one above it.

     So the band does not wrap and the charter shrinks into whatever the fixed badges leave it,
     which is 369px at a 960px window and 156px at a 1121px one. An ellipsis on a name is what
     an ellipsis is for. `overflow: hidden` is the belt: a row carrying all three of the rare
     flags at the narrowest width has more badges than 266px holds even with the charter at
     nothing, and clipping that against the cell is better than painting it over the column
     beside it. */
  .badges {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 6px;
    margin-top: 5px;
    min-width: 0;
    overflow: hidden;
  }
  /* A badge like the others now, rather than a column of its own, and the only one in the band
     that gives way. `.badge` holds every other badge at its natural width, so this override is
     what decides which of them ellipsises when the column is narrow: a charter's name, rather
     than the length or the difficulties, because those two are the same four characters on
     every row and a name is the one field here with no bound on it.

     Specificity on purpose: `.badge` is declared after this and sets `flex-shrink: 0`, so the
     two-class selector is what lets this one shrink. */
  .badges .charter {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Version chip: mono, quiet (text-3 + hairline), same family as lib-badge.
     A real <button> since the row stopped being one; appearance:none so the
     platform does not draw its own control underneath, as on .chip above, and
     font-weight:inherit because the UA's `font: 400 …` shorthand would otherwise
     lighten it off the 500 it inherited from .title as a <span>. */
  .ver-chip {
    appearance: none;
    display: inline-flex;
    font-weight: inherit;
    align-items: center;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 0 4px;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    cursor: pointer;
    line-height: var(--lh-tight);
    vertical-align: middle;
    flex-shrink: 0;
  }
  .ver-chip:hover {
    border-color: rgba(255, 255, 255, 0.2);
    color: var(--text-2);
  }
  /* Deliberately quiet (text-3 + hairline, no accent): informational, not a call to action.
     It sits where the Download button would be, because "you have this" is the answer to the
     question that button asks and the two belong in the same place. */
  .lib-badge {
    display: inline-block;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 0 4px;
    vertical-align: middle;
    line-height: var(--lh-tight);
  }
  /* 9px between the five groups, against the 2px between the pips inside one and the 4px that
     separates a group's ring from its own pips. The gap inside a group has to read as smaller
     than the gap between groups or the thirty pips read as one run.

     5 groups of 34px plus 4 gaps of 9px is 206px drawn in a 210px track. The four spare pixels
     are the margin for the subpixel width of a border-boxed circle: `DiffPips` does not shrink,
     by design, so a track one pixel short would paint the fifth guitar over the health mark
     rather than squeezing it. */
  .diffs {
    display: flex;
    gap: 9px;
    min-width: 0;
  }
  .health {
    display: flex;
    justify-content: center;
  }
  /* Hollow for a charting note, filled for breakage. A ring and a disc differ in shape and not
     only in colour, which is what keeps the two apart for a red-green colour blind reader; the
     colours are the second signal, not the only one. */
  .dot {
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid var(--text-3);
    cursor: help;
  }
  .dot.broken {
    border-color: var(--danger);
    background: var(--danger);
  }
  .act {
    display: flex;
    justify-content: flex-end;
    min-width: 0;
  }
  /* A ghost button, not the accent one the selection bar uses. There is one of these on every
     row that is not owned, and ninety accent buttons down a list is a list with no primary
     action at all. */
  .get {
    appearance: none;
    background: none;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 3px 10px;
    cursor: pointer;
    white-space: nowrap;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .get:hover,
  .get:focus {
    color: var(--text-1);
    border-color: var(--accent);
  }
  .queued {
    color: var(--text-3);
    white-space: nowrap;
  }
  /* The flags that survived the cut, drawn like the version chip beside them: they label the
     chart, they are not something to press. */
  /* `--lh-tight` and no vertical padding, so a chip on the title line is 17px against the
     title's own 17.5px and the line does not grow around it. Measured at a 668px view with the
     snug leading these had first: rows with a badge were 70px and rows without were 66px, which
     is a list that steps as you scan it. `.ver-chip` below carries the same two values for the
     same reason, and it is the one that has been making rows tall since 0.1.0. */
  .badge {
    border: 1px solid var(--hairline);
    border-radius: 3px;
    padding: 0 4px;
    color: var(--text-3);
    line-height: var(--lh-tight);
    white-space: nowrap;
    flex-shrink: 0;
    cursor: help;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
  }
  /* The first thing the row gives up when its column is narrow, and why it is this one: the
     index is a position in a list the user is already looking at, and every other track is
     either the chart's identity or a reason to download it. 900px is where the seven tracks
     stop leaving the title a readable share.

     `scripts/measure-explore-row.mjs` reports all of this at every width the shell supports. */
  @container results (max-width: 899px) {
    .row {
      grid-template-columns: 22px 52px minmax(0, 1fr) 210px 10px 92px;
    }
    .row .num {
      display: none;
    }
  }
  /* Where the difficulty stops fitting beside the song and takes a line of its own.

     800px is the measured crossing, not a guessed one: with the six-track layout the song track
     is the column width less 468px, so at 800 the song is 332px against a difficulty column of
     210, and below that the thing the row is a list OF is narrower than the decoration beside
     it. The two widths this actually catches are 722px, which is this column at the 960px window
     minimum, and 668px at 1280px.

     The narrowest it ever gets is 509px: a 1121px window, the first width at which the 374px
     rail appears and takes its share back from a column that had 882px at 1120px. Four tracks
     and two lines hold there with 281px of song, where six tracks on one line would have left
     it 41px. The health mark goes under the button and the difficulty under the song, so the
     row keeps saying all of it and says it down instead of across. */
  @container results (max-width: 799px) {
    .row {
      grid-template-columns: 22px 52px minmax(0, 1fr) 92px;
      grid-template-rows: auto auto;
      row-gap: 4px;
    }
    /* Every child placed by hand rather than two of them placed and the rest left to fall
       where they may. Auto-placement runs in passes, and an item with a definite row and an
       automatic column is resolved in a different pass from one with neither, so the first
       version of this block put the song in a 92px track and the difficulty in a 40px one.
       Seven children into four tracks has no reading that can be left to inference. */
    .row .pick {
      grid-area: 1 / 1 / 3 / 2;
    }
    .row .cover {
      grid-area: 1 / 2 / 3 / 3;
    }
    .row .song {
      grid-area: 1 / 3 / 2 / 4;
    }
    .row .diffs {
      grid-area: 2 / 3 / 3 / 4;
    }
    .row .act {
      grid-area: 1 / 4 / 2 / 5;
    }
    /* On the difficulty's line rather than the button's: the two are what the row says about
       the chart itself, and the button is what the user does about it. */
    .row .health {
      grid-area: 2 / 4 / 3 / 5;
    }
    /* The cover no longer spans the whole row's height once the row is two lines tall, so it is
       pinned to the top of its cell instead of floating in the middle of one. */
    .row .cover,
    .row .pick {
      align-self: start;
    }
  }
  /* The narrowest the column ever gets, 509px at a 1121px window, where the band has 266px and
     the charter is what runs out of room. The length goes, and the 42px it was taking goes to
     the name: measured at this width, keeping it left fourteen charters of twenty-five
     ellipsised and the tightest at 36px.

     The length rather than anything else in the band, and not grudgingly: it is the one field
     here that is also in the rail this width exists to make room for, one click away and in
     full. The row before this one hid it below 900px of column, so it is drawn over a wider
     range now than it used to be, not a narrower one. */
  @container results (max-width: 559px) {
    .row .badges .length {
      display: none;
    }
  }
  .more-row {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 16px 20px;
  }
  .more {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 7px;
    color: var(--text-2);
    padding: 7px 18px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .more:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .more-note {
    margin: 0;
    max-width: 52ch;
    text-align: center;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  /* Advanced sits with the filter chips because it is one, and lights the same way the mode
     buttons and Installed's toggles do when it is on. */
  .adv,
  .adv-clear {
    appearance: none;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 4px 12px;
    cursor: pointer;
    white-space: nowrap;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      background var(--t-fast) var(--ease);
  }
  .adv:hover,
  .adv:focus,
  .adv-clear:hover,
  .adv-clear:focus {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .adv.on {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--text-1);
  }
  /* A number, not a dot: "filters are on" is useful, "three filters are on" is what tells someone
     whether they have found all of them again. */
  .adv-count {
    display: inline-block;
    margin-left: 6px;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    line-height: 16px;
    text-align: center;
  }
  /* Under the search box, so it lands against the control it is about. A wrapping flex row rather
     than a paragraph with buttons after it: measured offscreen at 1280x800, the sentence fills the
     68ch cap over two lines and the two actions wrap onto a third, 20px tall and both on screen.
     The row is what keeps them attached to the note at any width, since this note is the only
     account the user gets of why the results changed. */
  .dropped {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0 16px 8px;
    max-width: 68ch;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  /* Same shape as `.dropped` above, which is the other line in this view that reports
     something the user's last action caused. */
  .row-error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0 16px 8px;
    max-width: 68ch;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .dropped-action {
    appearance: none;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: 999px;
    font-size: var(--fs-caption);
    font-family: var(--font-ui);
    color: var(--text-2);
    padding: 2px 10px;
    cursor: pointer;
    white-space: nowrap;
    transition:
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .dropped-action:hover,
  .dropped-action:focus {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  /* Off screen rather than `display: none`, which takes an element out of the accessibility tree
     along with the layout and would silence the live region entirely. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
