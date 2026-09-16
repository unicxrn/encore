<script lang="ts">
  import { albumArtUrl, type ChartData } from '../api/enchor'
  import { artUrl } from '../../../../shared/art'
  import { msToTime, fallbackChartName, stripRichText } from '../../../../shared/format'
  import { explainIssue, type IssueSeverity } from '../../../../shared/issue-labels'
  import Icon from './Icon.svelte'
  import { diffMatrix, partMatrix, type MaxNpsEntry } from '../matrix'
  import { emptyAdvanced, type AdvancedTextField } from '../api/advanced'
  import { encore } from '../stores/bridge'
  import { globalQuery } from '../stores/global-search'
  import { browseSearch } from '../stores/search'
  import { recordVerdicts, verdicts } from '../stores/updates'
  import DiffMatrix from './DiffMatrix.svelte'
  import PreviewPane from './PreviewPane.svelte'
  import type { ChartTarget } from './Home.svelte'
  import type { ViewId } from './Sidebar.svelte'
  import type { ChartRecord } from '../../../../shared/schemas'
  import type { ChartVerdict } from '../../../../shared/updates'

  /**
   * The chart page, which since step five is no longer where a chart is looked at.
   *
   * The preview rail answers "is this the one": cover, the highway, one instrument and one
   * difficulty, three numbers about that track, and whether the chart is missing anything. It
   * carries the route here, and the only reason to take it is that the rail was not enough. So
   * this page is the reference, and everything on it is something the rail has no room for: the
   * whole grid of parts and difficulties rather than one square of it, the song.ini fields
   * nothing else shows, what the chart is made of, where it lives on disk and what identifies
   * it, and for a chart on Chorus, what scan-chart found wrong with it.
   *
   * What it deliberately no longer carries is the four stat cards, which were LENGTH, NOTES,
   * INSTRUMENTS and YEAR. The rail prints length and a note count of its own, the grid below
   * shows every note count there is and has one row per instrument, and the year is a search
   * chip and a metadata row. Four cards restating them in a larger font is the thing this step
   * was for.
   */
  let {
    target,
    onBack,
    onNavigate
  }: {
    target: ChartTarget
    onBack: () => void
    onNavigate: (id: ViewId) => void
  } = $props()

  type TabId = 'overview' | 'preview'

  const chart = $derived<ChartData | null>(target.kind === 'remote' ? target.chart : null)
  const record = $derived<ChartRecord | null>(target.kind === 'local' ? target.record : null)

  let tab = $state<TabId>('overview')
  let artFailed = $state(false)
  // Metadata match ("this song by this charter is in your library"), not an
  // exact-version match; same semantics as the Explore list badge.
  let inLibrary = $state(false)

  // Keyed on `target` rather than onMount so reopening Detail with a different
  // chart (without an intermediate unmount) still refreshes the badge.
  $effect(() => {
    const t = target
    artFailed = false
    tab = 'overview'
    inLibrary = false
    let stale = false
    if (t.kind === 'remote') {
      const c = t.chart
      encore()
        .existsByMeta([{ name: c.name, artist: c.artist, charter: c.charter }])
        .then((flags) => {
          // Target changed while the call was in flight: discard the response.
          if (!stale) inLibrary = flags[0] === true
        })
        .catch(() => {
          // Non-fatal: the badge is a best-effort enhancement.
        })
    }
    return () => {
      stale = true
    }
  })

  // Chorus version check. Explicitly NOT run on mount: one check is one request against a
  // 50-per-minute budget, and opening a chart is not the user asking to spend it.
  //
  // The verdict itself is read from the session map in stores/updates.ts, not kept here: main
  // remembers every check of the session, and a chart the Installed list already badges has an
  // answer before this view opens. Reading it costs nothing, so the card shows it at once, with
  // Check still offered for a fresh answer. `versionState` is only the lifecycle of a check run
  // from this card; a verdict on screen with the state idle is one the session already held.
  let versionState = $state<'idle' | 'checking' | 'done' | 'error'>('idle')
  let versionError = $state('')
  const versionVerdict = $derived<ChartVerdict | null>(
    record ? ($verdicts.get(record.path) ?? null) : null
  )

  $effect(() => {
    // Reset when the viewed chart changes: an in-flight check's error or spinner must not
    // outlive the chart it was about. The verdict needs no reset, being keyed on the path.
    void target
    versionState = 'idle'
    versionError = ''
  })

  async function checkVersions(): Promise<void> {
    const path = record?.path
    if (path === undefined) return
    versionState = 'checking'
    versionError = ''
    try {
      const summary = await encore().updatesCheck([path])
      // Into the shared map, so Installed badges this chart on the way back without a replay.
      recordVerdicts(summary.verdicts)
      versionState = 'done'
    } catch (err) {
      versionError = err instanceof Error ? err.message : String(err)
      versionState = 'error'
    }
  }

  const title = $derived(
    stripRichText(chart?.name ?? record?.name) ||
      (record ? fallbackChartName(record.path) : null) ||
      'Unknown chart'
  )
  // Stripped before `openArtist` sends it to Explore as well as before it is drawn. The button
  // says "search for this artist", and the artist the user read is the one the search has to
  // run: Chorus matches text, and no chart there is filed under a colour tag.
  const artist = $derived(stripRichText(chart?.artist ?? record?.artist))

  // Remote covers come from the Encore CDN, local ones from our own art cache over the
  // encore-art scheme. `artFailed` is a single flag rather than a per-md5 set because this
  // view only ever shows one chart, and the $effect above clears it when the target changes.
  const coverUrl = $derived.by<string | null>(() => {
    if (artFailed) return null
    if (chart?.albumArtMd5) return albumArtUrl(chart.albumArtMd5)
    return artUrl(record?.albumArtMd5)
  })

  /**
   * What the cover box shows when there is no cover, written the way the rail writes it.
   *
   * The page keeps a cover at all, beside the title rather than as a card of its own, because
   * below the shell's breakpoint there is no rail: a row click lands here directly, and a
   * reference page with nothing but text at the top of it is one the eye cannot place. It is
   * identification, not the artwork at a size worth looking at, which is why it is 88px.
   */
  const monogram = $derived.by(() => {
    for (const ch of title) if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase()
    return ''
  })

  // One source for every notes-derived fact: the catalog stores noteCounts under the same
  // field names the API returns, so nothing below is remote-only. Undefined or empty means
  // "not read yet" for both sources, which is a different claim from "there is nothing there".
  const noteCounts = $derived(chart?.notesData?.noteCounts ?? record?.noteCounts)
  const notesRead = $derived((noteCounts ?? []).length > 0)
  const maxNps = $derived<readonly MaxNpsEntry[]>(chart?.notesData?.maxNps ?? record?.maxNps ?? [])

  /**
   * song.ini's ratings, keyed by the instrument names the note counts use.
   *
   * The catalog carries ten of these and the search API five, which is the first thing this
   * page knows that the rail does not: the rail picks one instrument and shows what that track
   * is made of, and never says the chart claims a rhythm part at 5 or a GHL bass at 2.
   *
   * `vocals`, `band` and `drumsreal` are not here. They have no note track to sit beside, so
   * they are metadata rows below rather than grid rows; see the ABOUT list.
   */
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

  const partRows = $derived(partMatrix({ noteCounts, maxNps, ratings }))

  // The preview pane still wants the playable-tracks reading of the same data: its instrument
  // and difficulty selects must not offer a track the player cannot open. See partMatrix.
  const matrixRows = $derived(diffMatrix(noteCounts))

  /**
   * The two sentences the grid cannot write for itself, because only this file knows which of
   * the two sources the chart came from.
   *
   * "Run Scan library" is true of a catalog row and false of a chart on Chorus: scanning the
   * library would not change an unprocessed search result by one byte.
   */
  const matrixUnread = $derived(
    record
      ? "This chart's notes have not been read yet. Run Scan library to read them."
      : 'Chorus Encore has not counted this chart yet, so only the ratings its song.ini carries are known.'
  )
  const matrixEmpty = $derived(
    notesRead ? 'The notes were read and no instrument in this chart carries any.' : matrixUnread
  )

  const yearText = $derived(
    chart?.year?.trim() || (record?.year != null ? String(record.year) : '')
  )

  // Every field this renders is a song.ini string, and a charter can style any of them, so the
  // markup comes off here rather than at each of the dozen rows. The `title` tooltip on the row
  // reads the same value, so the two cannot disagree.
  const dash = (value: string | null | undefined): string => {
    const stripped = stripRichText(value)
    return stripped ? stripped : '—'
  }

  // The catalog stores scan-chart's own enum names. They are jargon on screen, since a player
  // knows the kit layouts as 4-lane / 4-lane Pro / 5-lane. An unrecognised name falls
  // through to itself rather than to a dash, so a future scan-chart value stays visible
  // instead of silently reading as "no drums".
  const DRUM_TYPE_LABELS: Record<string, string> = {
    fourLane: '4-lane',
    fourLanePro: '4-lane Pro',
    fiveLane: '5-lane'
  }

  const formatDate = (value: string | number): string => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
  }

  interface AboutRow {
    label: string
    value: string
    mono?: boolean
    ellipsis?: boolean
  }

  const aboutRows = $derived.by<AboutRow[]>(() => {
    if (chart) {
      const rows: AboutRow[] = [
        { label: 'ALBUM', value: dash(chart.album) },
        { label: 'GENRE', value: dash(chart.genre) },
        { label: 'YEAR', value: dash(chart.year), mono: true },
        { label: 'LENGTH', value: msToTime(chart.song_length), mono: true },
        { label: 'CHARTER', value: dash(chart.charter) }
      ]
      if (chart.modifiedTime) {
        rows.push({ label: 'UPDATED', value: formatDate(chart.modifiedTime), mono: true })
      }
      if (chart.diff_vocals != null && chart.diff_vocals >= 0) {
        rows.push({ label: 'VOCALS', value: String(chart.diff_vocals), mono: true })
      }
      return rows
    }
    if (!record) return []
    const rows: AboutRow[] = [
      { label: 'ALBUM', value: dash(record.album) },
      { label: 'GENRE', value: dash(record.genre) },
      { label: 'YEAR', value: record.year != null ? String(record.year) : '—', mono: true },
      { label: 'LENGTH', value: msToTime(record.songLength), mono: true },
      { label: 'CHARTER', value: dash(record.charter) },
      // song.ini's "unset" sentinels (-1, 16000, '') are normalized to null in the scanner,
      // so a null here means the charter left the field out. String() it only when set,
      // the same way YEAR above does. Track 0 is a real value and must not dash out.
      {
        label: 'ALBUM TRACK',
        value: record.albumTrack != null ? String(record.albumTrack) : '—',
        mono: true
      },
      {
        label: 'PLAYLIST TRACK',
        value: record.playlistTrack != null ? String(record.playlistTrack) : '—',
        mono: true
      },
      { label: 'ICON', value: dash(record.icon) },
      {
        label: 'DRUMS',
        value: dash(record.drumType && (DRUM_TYPE_LABELS[record.drumType] ?? record.drumType))
      },
      // 0 is a legitimate preview start (from the top), which msToTime renders as 0:00.
      { label: 'PREVIEW AT', value: msToTime(record.previewStartTime), mono: true },
      { label: 'LOADING PHRASE', value: dash(record.loadingPhrase) }
    ]
    // The three ratings with no note track to sit beside, so the grid above cannot hold them.
    //
    // Vocals cannot join the E/M/H/X grid: scan-chart's instrument union excludes it, so
    // noteCounts never carries it and any grid row for it would be invented. The row's
    // PRESENCE is what says "this chart has a vocal track"; the value only reports the rating,
    // so an unrated one dashes like any other unset song.ini field. `diffVocals` is checked
    // too because rows scanned before hasVocals was stored still carry a rating.
    if (record.hasVocals || record.diffVocals != null) {
      rows.push({
        label: 'VOCALS',
        value: record.diffVocals != null ? String(record.diffVocals) : '—',
        mono: true
      })
    }
    // Band and pro drums are ratings of the whole chart and of a kit layout, not of a track.
    // Drawn only when set, because unlike vocals their absence says nothing: no field of the
    // chart means "this song has a band".
    if (record.diffBand != null) {
      rows.push({ label: 'BAND', value: String(record.diffBand), mono: true })
    }
    if (record.diffDrumsReal != null) {
      rows.push({ label: 'PRO DRUMS', value: String(record.diffDrumsReal), mono: true })
    }
    return rows
  })

  /**
   * What the chart is made of, which is the half of scan-chart's reading the rail turned down.
   *
   * The rail keeps only has2xKick, and only on a drum chart, because a flag set on half of
   * Chorus separates nothing when the question is "is this the chart I want". Here the question
   * is "what am I about to play", where every one of them is a fact somebody wants: a tap-note
   * chart is a different evening from one without, and flex lanes decide whether a chart works
   * on a second controller.
   *
   * Three states, not two. A local row whose notes were never read carries `false` in all nine
   * columns by schema default, and reporting nine noes about a chart nobody has opened is the
   * misreading this guard exists to stop. On the remote side each flag is separately optional,
   * so each is judged on its own.
   */
  interface Feature {
    label: string
    state: 'yes' | 'no' | 'unknown'
  }

  const featureState = (value: boolean | undefined, known: boolean): Feature['state'] => {
    if (!known || value === undefined) return 'unknown'
    return value ? 'yes' : 'no'
  }

  const features = $derived.by<Feature[]>(() => {
    if (chart) {
      const notes = chart.notesData
      // `modchart` is a field of the result rather than of notesData, and it is sent whether or
      // not the chart was processed, so it is not gated on the notes having been read.
      const known = notes != null
      return [
        { label: 'Modchart', state: featureState(chart.modchart, true) },
        { label: '2x kick', state: featureState(notes?.has2xKick, known) },
        { label: 'Solo sections', state: featureState(notes?.hasSoloSections, known) },
        { label: 'Open notes', state: featureState(notes?.hasOpenNotes, known) },
        { label: 'Tap notes', state: featureState(notes?.hasTapNotes, known) },
        { label: 'Forced notes', state: featureState(notes?.hasForcedNotes, known) },
        { label: 'Flex lanes', state: featureState(notes?.hasFlexLanes, known) }
      ]
    }
    if (!record) return []
    const known = notesRead
    return [
      { label: 'Modchart', state: featureState(record.modchart, known) },
      { label: '2x kick', state: featureState(record.has2xKick, known) },
      { label: 'Pro drums', state: featureState(record.proDrums, known) },
      { label: '5-lane drums', state: featureState(record.fiveLaneDrums, known) },
      { label: 'Solo sections', state: featureState(record.hasSoloSections, known) },
      { label: 'Open notes', state: featureState(record.hasOpenNotes, known) },
      { label: 'Tap notes', state: featureState(record.hasTapNotes, known) },
      { label: 'Forced notes', state: featureState(record.hasForcedNotes, known) },
      { label: 'Flex lanes', state: featureState(record.hasFlexLanes, known) }
    ]
  })

  /**
   * Where the chart is and what identifies it.
   *
   * The format row is first because it is the one thing about a chart on disk that changes what
   * every other feature has to do: a folder and a `.sng` archive are both charts, and the page
   * says which this is rather than leaving the user to read it off the end of the path.
   *
   * Two hashes and not four. `folderHash` and `tempoMapHash` are Encore's own bookkeeping and
   * nothing the user can act on. These two are answers to questions people actually have: which
   * chart a recorded play belongs to, and what the Chorus check above is comparing.
   */
  interface IdentityRow {
    label: string
    value: string
    full?: string
    note?: string
  }

  const shortHash = (value: string | null): string =>
    value === null ? '—' : value.length > 14 ? `${value.slice(0, 12)}…` : value

  const identityRows = $derived.by<IdentityRow[]>(() => {
    if (chart) {
      return [
        { label: 'SOURCE', value: 'CHORUS ENCORE' },
        { label: 'CHART ID', value: String(chart.chartId) },
        { label: 'PACK', value: chart.packName?.trim() ? chart.packName : '—' },
        { label: 'MD5', value: shortHash(chart.md5), full: chart.md5 }
      ]
    }
    if (!record) return []
    return [
      { label: 'FORMAT', value: record.chartType === 'sng' ? 'Archive (.sng)' : 'Folder' },
      { label: 'PATH', value: record.path, full: record.path },
      { label: 'SCANNED', value: formatDate(record.modifiedTime) },
      {
        label: 'PLAY KEY',
        value: shortHash(record.cloneHeroChecksum),
        full: record.cloneHeroChecksum ?? undefined,
        note: 'What Clone Hero writes beside a score, and the only thing that joins a play to this chart.'
      },
      {
        label: 'CHART HASH',
        value: shortHash(record.chartHash),
        full: record.chartHash ?? undefined,
        note: 'What the Chorus check compares. Album art, video and lyrics you add do not move it.'
      }
    ]
  })

  /**
   * What scan-chart found, as Chorus Encore already reported it on the search result.
   *
   * Nothing is requested for this: the three arrays arrive with every result, and Explore's row
   * already reduces them to one dot. The dot says a chart has problems; this says which, what
   * each one means, and how many of them there are, which is the difference between knowing a
   * chart is marked and knowing whether to download it.
   *
   * Identical codes are folded together with a count. A chart with 200 `babySustain` rows would
   * otherwise fill the page with one sentence repeated 200 times.
   *
   * `platform` decides one code: `badVideo` is breakage on Linux and a portability note
   * elsewhere. Read with a fallback because the preload exposes it synchronously and a renderer
   * test stubbing only the calls it needs has no reason to carry it; an empty string lands on
   * the "nobody has checked this platform" branch, which is the honest reading of not knowing.
   */
  interface IssueRow {
    code: string
    label: string
    meaning: string
    severity: IssueSeverity
    count: number
  }

  const SEVERITY_ORDER: Record<IssueSeverity, number> = {
    blocking: 0,
    portability: 1,
    quality: 2
  }
  const SEVERITY_WORD: Record<IssueSeverity, string> = {
    blocking: 'BREAKS',
    portability: 'PORTABILITY',
    quality: 'CRAFT'
  }

  // Only a chart whose result actually carried the arrays can be called clean. A hand-built
  // ChartData with all three absent has not been checked, and saying "nothing wrong" about it
  // would be inventing a clean bill of health.
  const issuesReported = $derived(
    chart !== null &&
      (chart.folderIssues !== undefined ||
        chart.metadataIssues !== undefined ||
        chart.notesData?.chartIssues !== undefined)
  )

  const issueRows = $derived.by<IssueRow[]>(() => {
    if (chart === null) return []
    const platform = encore()?.platform ?? ''
    const found = [
      ...(chart.folderIssues ?? []).map((i) => ({
        code: i.folderIssue,
        description: i.description
      })),
      ...(chart.metadataIssues ?? []).map((i) => ({
        code: i.metadataIssue,
        description: i.description
      })),
      ...(chart.notesData?.chartIssues ?? []).map((i) => ({
        code: i.noteIssue,
        description: i.description
      }))
    ]
    // Linear search over the rows built so far rather than a lookup table. scan-chart has a few
    // dozen codes and a chart carries a handful of them, so the search is over a list of that
    // size whatever the occurrence count is, and it keeps the output in the order it was found
    // before the sort below reorders it by severity.
    const rows: IssueRow[] = []
    for (const issue of found) {
      const seen = rows.find((row) => row.code === issue.code)
      if (seen) {
        seen.count++
        continue
      }
      const { label, meaning, severity } = explainIssue(issue.code, issue.description, platform)
      rows.push({ code: issue.code, label, meaning, severity, count: 1 })
    }
    return rows.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  })

  // Keyed by field name, not by text: two chips can legitimately carry the same
  // value (e.g. album == genre), which would break an each-key on the string.
  //
  // `field` is an advanced-search text field rather than a free string, because each chip runs a
  // search on that field. A field this page shows but the endpoint does not take would fail the
  // build here rather than clicking through to a filter nothing honours.
  const chips = $derived.by(() => {
    const out: { field: AdvancedTextField; value: string }[] = []
    // Stripped for the same reason the artist button is: the chip's text and the search it runs
    // are the same string, and it goes to Chorus, not to the local catalog.
    const charter = stripRichText(chart?.charter ?? record?.charter)
    if (charter) out.push({ field: 'charter', value: charter })
    if (yearText) out.push({ field: 'year', value: yearText })
    const album = stripRichText(chart?.album ?? record?.album)
    if (album) out.push({ field: 'album', value: album })
    const genre = stripRichText(chart?.genre ?? record?.genre)
    if (genre) out.push({ field: 'genre', value: genre })
    return out
  })

  const download = (): void => {
    if (!chart) return
    encore()
      .downloadAdd({
        md5: chart.md5,
        hasVideoBackground: chart.hasVideoBackground,
        meta: { name: chart.name, artist: chart.artist, charter: chart.charter }
      })
      .catch((err: unknown) => console.error('downloadAdd failed', err))
  }

  const openArtist = (): void => {
    if (!artist.trim()) return
    globalQuery.set(artist.trim())
    onNavigate('browse')
  }

  /**
   * Run one metadata tag as an advanced search on Explore.
   *
   * The tag replaces the whole filter set rather than joining it. "Search this charter" means
   * charts by that charter, not that charter narrowed by whatever an earlier search left behind,
   * and a chip that quietly ANDed itself onto a stale filter would answer a question nobody asked.
   *
   * Exact, because the value came out of the catalog verbatim rather than being typed. Measured
   * against the live service: a loose album match on "Utopia" also returns "Dystopia: Road to
   * Utopia" and "Black Utopia", while the exact one returns the album the user pointed at.
   *
   * The plain search term is cleared as part of this, by `applyAdvanced` rather than here:
   * `/search/advanced` ignores the term (see `searchCharts`), so emptying the box is half of the
   * one rule the store keeps, the other half being that typing a term drops the filters.
   */
  const searchTag = (field: AdvancedTextField, value: string): void => {
    const query = emptyAdvanced()
    query.text[field] = { value, exact: true, exclude: false }
    browseSearch.setAdvancedDraft(query)
    browseSearch.applyAdvanced()
    // Opened, not left to the closed panel's badge. The badge counts to one without saying one of
    // what, and arriving at a changed result set with no visible reason for it is the failure this
    // feature would otherwise introduce. Open, the panel names the field, the value and the Exact
    // tick, and is also where the user edits or drops them.
    browseSearch.setAdvancedOpen(true)
    onNavigate('browse')
  }
</script>

<div class="detail selectable">
  <header class="head">
    <button class="back" onclick={onBack}><Icon name="chevron-left" size={14} /> Back</button>
    <div class="ident">
      {#if coverUrl}
        <!-- A cached cover can 404 if the art file was swept while this view is open. -->
        <img class="art" src={coverUrl} alt="Album art" onerror={() => (artFailed = true)} />
      {:else}
        <div class="art placeholder" aria-hidden="true">{monogram}</div>
      {/if}
      <div class="names">
        <h1>{title}</h1>
        {#if artist.trim()}
          <button class="artist" onclick={openArtist} title="Search charts by {artist}">
            {artist}
          </button>
        {/if}
      </div>
    </div>
    {#if chips.length > 0 || inLibrary}
      <div class="chips">
        <!-- aria-label rather than the bare value: "Numbuh681" does not tell anyone what the
             control does, and naming the field says which of the four searches this is. The
             visible text is inside the label, so the two do not disagree. -->
        {#each chips as chip (chip.field)}
          <button
            class="chip tag"
            aria-label="Search charts with {chip.field} {chip.value}"
            title="Search charts with {chip.field} {chip.value}"
            onclick={() => searchTag(chip.field, chip.value)}
          >
            {chip.value}
          </button>
        {/each}
        {#if inLibrary}
          <span class="chip lib mono">IN LIBRARY</span>
        {/if}
      </div>
    {/if}
    <div class="actions">
      {#if chart}
        {#if inLibrary}
          <button class="btn-primary owned mono" disabled>IN LIBRARY</button>
        {:else}
          <button class="btn-primary" onclick={download}>Download</button>
        {/if}
      {/if}
      <button class="btn-ghost" onclick={() => (tab = 'preview')}>Preview</button>
    </div>
  </header>

  <!-- A tablist, not site navigation: <nav> can't carry role="tablist". -->
  <div class="tabs" role="tablist">
    <button
      class="tab mono"
      role="tab"
      id="tab-overview"
      aria-controls="panel-overview"
      aria-selected={tab === 'overview'}
      class:active={tab === 'overview'}
      onclick={() => (tab = 'overview')}
    >
      OVERVIEW
    </button>
    <button
      class="tab mono"
      role="tab"
      id="tab-preview"
      aria-controls="panel-preview"
      aria-selected={tab === 'preview'}
      class:active={tab === 'preview'}
      onclick={() => (tab = 'preview')}
    >
      PREVIEW
    </button>
  </div>

  {#if tab === 'overview'}
    <div class="cols" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
      <!-- First on the page and in its own slot, because it is the thing the rail sent the user
           here for: the rail shows one instrument at one difficulty, and this is all of them at
           once with what each track is made of. The slot is what the two container queries below
           move; the grid itself never has to know where it landed. -->
      <div class="slot grid-slot">
        <DiffMatrix rows={partRows} empty={matrixEmpty} unread={matrixUnread} />
      </div>

      <div class="slot col-a">
        <section class="card about">
          <h2 class="card-head mono">ABOUT</h2>
          <dl>
            {#each aboutRows as row (row.label)}
              <div class="about-row">
                <dt class="mono">{row.label}</dt>
                <dd class:mono={row.mono} class:ellipsis={row.ellipsis} title={row.value}>
                  {row.value}
                </dd>
              </div>
            {/each}
          </dl>
        </section>

        <section class="card idents">
          <h2 class="card-head mono">{chart ? 'ON CHORUS' : 'ON DISK'}</h2>
          <dl>
            {#each identityRows as row (row.label)}
              <div class="ident-row">
                <dt class="mono">{row.label}</dt>
                <dd class="mono ellipsis" title={row.full ?? row.value}>{row.value}</dd>
                {#if row.note}
                  <p class="ident-note">{row.note}</p>
                {/if}
              </div>
            {/each}
          </dl>
        </section>
      </div>

      <div class="slot col-b">
        <section class="card feats">
          <h2 class="card-head mono">WHAT IS IN THE CHART</h2>
          <ul>
            {#each features as feature (feature.label)}
              <li class="feat" data-state={feature.state}>
                <span class="dot" aria-hidden="true"></span>
                <span class="feat-label">{feature.label}</span>
                <!-- The word, not only the dot: colour is the second signal here and never the
                     only one, and "unknown" has no colour that could carry it on its own. -->
                <span class="feat-state mono">
                  {feature.state === 'yes' ? 'YES' : feature.state === 'no' ? 'NO' : 'UNKNOWN'}
                </span>
              </li>
            {/each}
          </ul>
        </section>

        {#if record}
          <section class="card versions">
            <div class="versions-head">
              <h2 class="card-head mono flush">CHORUS VERSION</h2>
              <button
                class="version-btn"
                onclick={checkVersions}
                disabled={versionState === 'checking'}
              >
                {versionState === 'checking' ? 'Checking…' : 'Check'}
              </button>
            </div>

            <!-- Idle copy only when there is nothing to show. A verdict the session already holds
                 renders through the same branches a fresh check does; while a re-check is in
                 flight the old verdict stays up rather than blanking the card. -->
            {#if versionState === 'idle' && versionVerdict === null}
              <p class="version-note">
                Asks Chorus Encore whether it has a different version of this chart.
              </p>
            {:else if versionState === 'error'}
              <p class="version-note error">{versionError}</p>
            {:else if versionVerdict?.kind === 'current'}
              <p class="version-note">Chorus Encore serves these exact notes. Nothing to update.</p>
            {:else if versionVerdict?.kind === 'unknown'}
              <p class="version-note">
                Chorus Encore has no chart by this charter under this title. It may be a private
                chart, or renamed since.
              </p>
            {:else if versionVerdict?.kind === 'alternate'}
              <!-- Deliberately "different", not "newer". Chorus exposes nothing that orders two
                   uploads of a chart, so claiming one supersedes the other would be inventing a
                   fact; the note counts and dates below are what the user judges on. -->
              <p class="version-note">
                Chorus Encore has a different version of this chart by the same charter. Your copy
                has
                {(record.noteCounts ?? []).reduce((sum, n) => sum + n.count, 0)} notes.
              </p>
              {#each versionVerdict.alternates as alt (alt.chartId)}
                <div class="version-row">
                  <span class="mono version-notes">{alt.noteCount} notes</span>
                  <span class="mono version-date">
                    {alt.modifiedTime ? alt.modifiedTime.slice(0, 10) : '—'}
                  </span>
                </div>
              {/each}
              <p class="version-note">
                Downloading it adds a second copy. Your current chart, and any art, video or lyrics
                you added to it, is left untouched.
              </p>
            {/if}
          </section>
        {/if}

        {#if issuesReported}
          <section class="card issues">
            <h2 class="card-head mono">WHAT CHORUS FOUND</h2>
            {#if issueRows.length === 0}
              <p class="issue-none">
                Chorus Encore ran scan-chart over this chart and found nothing wrong with it.
              </p>
            {:else}
              <ul>
                {#each issueRows as issue (issue.code)}
                  <li class="issue" data-severity={issue.severity}>
                    <div class="issue-head">
                      <span class="issue-label">{issue.label}</span>
                      {#if issue.count > 1}
                        <span class="issue-count mono">{issue.count}×</span>
                      {/if}
                      <span class="issue-sev mono">{SEVERITY_WORD[issue.severity]}</span>
                    </div>
                    <p class="issue-meaning">{issue.meaning}</p>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}
      </div>
    </div>
  {:else}
    <!-- Mounted only while the Preview tab is active: unmounting unregisters the
         viewport, which closes the preview (playback is view-bound). -->
    <div role="tabpanel" id="panel-preview" aria-labelledby="tab-preview">
      <PreviewPane {target} instruments={matrixRows} />
    </div>
  {/if}
</div>

<style>
  /**
   * The page measures itself, not the window.
   *
   * Its column is 469px wide at a 1121px window and 842px at a 1120px one, because that is where
   * the rail appears and takes 374px back. A media query cannot express "this column is narrow"
   * across that jump, since the same window width means two different things on either side of
   * it. A container query asks the box itself, which is the only question with one answer.
   */
  .detail {
    container-type: inline-size;
    container-name: detail;
    padding: 16px 20px 26px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .mono {
    font-family: var(--font-mono);
  }

  /* Header */
  .back {
    align-self: flex-start;
    /* Flex so the chevron sits on the label's centre line; the 2px gap is what the space
       character gave before the glyph became an icon. */
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: transparent;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 5px 12px;
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .back:hover {
    color: var(--text-1);
    border-color: var(--border-2);
  }
  .head {
    display: flex;
    flex-direction: column;
  }
  .ident {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 14px;
  }
  /* 88px, the rail's own cover step. Identification rather than artwork: the 320px card this
     replaces put the cover above the difficulty grid in the narrow column, which spent a third
     of the first screen on the one thing the rail was already showing. */
  .art {
    width: 88px;
    height: 88px;
    flex-shrink: 0;
    display: block;
    object-fit: cover;
    border-radius: var(--radius);
    background: var(--ground-2);
    box-shadow: var(--elev-2);
  }
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
  .names {
    min-width: 0;
  }
  h1 {
    font-size: var(--fs-display);
    font-weight: 700;
    line-height: var(--lh-display);
    letter-spacing: var(--ls-tight);
    color: var(--text-1);
    /* Three lines, then an ellipsis. A chart title is free text out of song.ini and the longest
       of them will otherwise push the grid off the first screen on its own. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
  }
  .artist {
    margin-top: 4px;
    max-width: 100%;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-emphasis);
    color: var(--text-2);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color var(--t-fast) var(--ease);
  }
  .artist:hover {
    color: var(--accent-hi);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .chip {
    border: 1px solid var(--hairline);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: var(--fs-secondary);
    color: var(--text-2);
    background: var(--ground-3);
  }
  /* A <button> inherits none of the page's font and brings its own, so the family is restated
     here; everything else the .chip rule above already sets applies to either element. */
  .chip.tag {
    font-family: var(--font-ui);
    cursor: pointer;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .chip.tag:hover {
    color: var(--text-1);
    border-color: var(--border-2);
  }
  .chip.lib {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    background: none;
    padding: 4px 8px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
  .btn-primary,
  .btn-ghost {
    border-radius: var(--radius-sm);
    padding: 8px 20px;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    cursor: pointer;
    transition:
      filter var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .btn-primary {
    border: 0;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
  }
  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .btn-primary.owned {
    background: none;
    border: 1px solid var(--hairline);
    color: var(--text-3);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    font-weight: 500;
    cursor: default;
  }
  .btn-ghost {
    background: var(--ground-3);
    border: 1px solid var(--hairline);
    color: var(--text-2);
  }
  .btn-ghost:hover {
    color: var(--text-1);
    border-color: var(--border-2);
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 18px;
    border-bottom: 1px solid var(--hairline);
  }
  .tab {
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    padding: 0 0 8px;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    cursor: pointer;
    margin-bottom: -1px;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .tab:hover {
    color: var(--text-2);
  }
  .tab.active {
    color: var(--text-1);
    border-bottom-color: var(--accent);
  }

  /* Overview layout */
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    align-items: start;
  }
  .slot {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  /**
   * Three arrangements, and the middle one exists because of a measurement.
   *
   * The grid's rating column and its four squares are fixed at 78 and 62px, so the instrument
   * column is whatever is left, and "Guitar co-op" needs about 115px of it. That puts the grid's
   * floor at roughly 443px. Splitting the page in two at 1.3 to 1 gives the left column less than
   * that until the page itself is about 843px wide, and a 1440px window is 773px: measured at
   * that width with the grid in the left column, five of ten instrument names ellipsised, the
   * tightest at 72px. So between 700 and 850 the grid takes the full width and only the cards
   * below it split, and above 850 it moves into the left column with room to spare.
   *
   * Every placement is explicit rather than left to auto-flow, because auto-flow would put the
   * second column of cards on a new row the moment the grid stopped spanning.
   */
  @container detail (min-width: 700px) {
    .cols {
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
    }
    .grid-slot {
      grid-column: 1 / -1;
      grid-row: 1;
    }
    .col-a {
      grid-column: 1;
      grid-row: 2;
    }
    .col-b {
      grid-column: 2;
      grid-row: 2;
    }
  }
  @container detail (min-width: 850px) {
    .grid-slot {
      grid-column: 1;
    }
    .col-b {
      grid-row: 1 / span 2;
    }
  }
  .card {
    background: var(--ground-3);
    border: 1px solid var(--border-1);
    border-radius: var(--radius);
    box-shadow: var(--elev-2);
  }
  .card-head {
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    padding: 12px 14px 0;
  }
  .card-head.flush {
    padding: 0;
  }
  .about dl,
  .idents dl {
    padding: 6px 14px 12px;
  }
  .about-row {
    display: grid;
    /* Sized for the longest label, "LOADING PHRASE". JetBrains Mono advances 0.6em, so
       at --fs-caption (12px) that is 14 x 7.2px = 100.8px, plus --ls-caps (0.96px a
       character) = ~114px. */
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 10px;
    align-items: baseline;
    padding: 7px 0;
    border-bottom: 1px solid var(--border-1);
  }
  .about-row:last-child {
    border-bottom: 0;
  }
  dt {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  dd {
    font-size: var(--fs-secondary);
    color: var(--text-1);
    min-width: 0;
  }
  dd.ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }

  /* What is in the chart */
  .feats ul {
    list-style: none;
    padding: 6px 14px 12px;
  }
  .feat {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }
  .feat-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .feat-state {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-3);
  }
  .feat[data-state='yes'] .dot {
    background: var(--accent);
  }
  /* A no is not a fault and gets no colour for one. Half these flags are absent from most
     charts, and an amber row nine times over would read as nine things to fix. */
  .feat[data-state='no'] .dot {
    background: var(--ground-5);
  }
  .feat[data-state='unknown'] .dot {
    background: var(--ground-5);
    border: 1px solid var(--border-2);
  }

  /* On disk / on Chorus */
  .ident-row {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 10px;
    align-items: baseline;
    padding: 7px 0;
    border-bottom: 1px solid var(--border-1);
  }
  .ident-row:last-child {
    border-bottom: 0;
  }
  .idents dd {
    font-size: var(--fs-caption);
  }
  /* Under the pair rather than beside it: the note is a sentence and the value is a hash, and
     a sentence in a 12px mono column beside a hash is unreadable at any of these widths. */
  .ident-note {
    grid-column: 1 / -1;
    margin-top: 3px;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }

  .versions {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .versions-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .version-btn {
    font: inherit;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    padding: 3px 10px;
    color: var(--text-2);
    background: var(--ground-4);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .version-btn:hover:not(:disabled) {
    color: var(--text-1);
  }
  .version-btn:disabled {
    cursor: default;
    color: var(--text-3);
  }
  .version-note {
    margin: 0;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .version-note.error {
    color: var(--danger);
  }
  .version-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    font-size: var(--fs-caption);
    color: var(--text-2);
  }
  .version-date {
    color: var(--text-3);
  }

  /* What Chorus found */
  .issues ul {
    list-style: none;
    padding: 6px 14px 12px;
  }
  .issue {
    padding: 7px 0;
    border-bottom: 1px solid var(--border-1);
  }
  .issue:last-child {
    border-bottom: 0;
  }
  .issue-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .issue-label {
    flex: 1;
    min-width: 0;
    font-size: var(--fs-secondary);
    color: var(--text-1);
  }
  .issue-count {
    font-size: var(--fs-caption);
    color: var(--text-3);
    flex-shrink: 0;
  }
  .issue-sev {
    flex-shrink: 0;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .issue[data-severity='blocking'] .issue-sev {
    color: var(--danger);
  }
  .issue[data-severity='portability'] .issue-sev {
    color: var(--warning);
  }
  .issue-meaning {
    margin-top: 2px;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .issue-none {
    padding: 6px 14px 12px;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
</style>
