<script lang="ts">
  import { albumArtUrl, INSTRUMENTS, type ChartData, type NoteCount } from '../api/enchor'
  import { artUrl } from '../../../../shared/art'
  import { msToTime, fallbackChartName, stripRichText } from '../../../../shared/format'
  import Icon from './Icon.svelte'
  import { countInstruments, diffMatrix } from '../matrix'
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

  // One source for every notes-derived stat: the catalog stores noteCounts under the same
  // field names the API returns, so the matrix is no longer remote-only. Undefined/empty
  // means "not read yet" for both. See countInstruments.
  const noteCounts = $derived(chart?.notesData?.noteCounts ?? record?.noteCounts)

  const matrixRows = $derived(diffMatrix(noteCounts))

  // A total across every instrument AND difficulty is a number no player ever
  // sees (a 4-instrument chart would read ~22k when the hardest guitar track is
  // ~1.4k). Report ONE track instead (the hardest charted guitar difficulty,
  // or the single largest track of any instrument when guitar is absent) and
  // caption it so it's unambiguous which track is being counted. Reads the shared source for
  // the same reason matrixRows does: a local chart showing a full matrix beside a dashed-out
  // NOTES reads as a bug, and the catalog stores the identical shape.
  const noteStat = $derived.by<NoteCount | null>(() => {
    const counts = noteCounts?.filter((entry) => entry.count > 0)
    if (!counts || counts.length === 0) return null
    for (const difficulty of ['expert', 'hard', 'medium', 'easy']) {
      const hit = counts.find((c) => c.instrument === 'guitar' && c.difficulty === difficulty)
      if (hit) return hit
    }
    return counts.reduce((best, c) => (c.count > best.count ? c : best), counts[0])
  })

  const instrumentLabel = (key: string): string =>
    INSTRUMENTS.find((opt) => opt.value === key)?.label ?? key

  const noteCaption = $derived(
    noteStat
      ? `${instrumentLabel(noteStat.instrument)} · ${noteStat.difficulty}`.toUpperCase()
      : null
  )

  // Counts instruments that actually carry notes, not song.ini difficulty ratings. A rating
  // can be present for an instrument the chart never got a track for, and vice versa. null
  // when the chart's notes have not been read, which the stat dashes out; the matrix beside it
  // says so in words, but this column is read as an assertion on its own.
  const instrumentCount = $derived(countInstruments(noteCounts))

  const lengthMs = $derived(chart?.song_length ?? record?.songLength ?? null)
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
      { label: 'ICON', value: dash(record.icon) },
      {
        label: 'DRUMS',
        value: dash(record.drumType && (DRUM_TYPE_LABELS[record.drumType] ?? record.drumType))
      },
      // 0 is a legitimate preview start (from the top), which msToTime renders as 0:00.
      { label: 'PREVIEW AT', value: msToTime(record.previewStartTime), mono: true },
      { label: 'LOADING PHRASE', value: dash(record.loadingPhrase) }
    ]
    // Vocals cannot join the E/M/H/X matrix: scan-chart's instrument union excludes it, so
    // noteCounts never carries it and any matrix row for it would be invented. It gets a
    // metadata row instead, and the row's PRESENCE is what says "this chart has a vocal
    // track". The value only reports the rating, so an unrated one dashes like any other
    // unset song.ini field. `diffVocals` is checked too because rows scanned before
    // hasVocals was stored still carry a rating.
    if (record.hasVocals || record.diffVocals != null) {
      rows.push({
        label: 'VOCALS',
        value: record.diffVocals != null ? String(record.diffVocals) : '—',
        mono: true
      })
    }
    rows.push(
      // Catalog modifiedTime is stamped at scan time, so "SCANNED", not the
      // chart's own last-updated date.
      { label: 'SCANNED', value: formatDate(record.modifiedTime), mono: true },
      { label: 'PATH', value: record.path, mono: true, ellipsis: true }
    )
    return rows
  })

  const stats = $derived<{ label: string; value: string; caption?: string | null }[]>([
    { label: 'LENGTH', value: msToTime(lengthMs) },
    {
      label: 'NOTES',
      value: noteStat ? noteStat.count.toLocaleString() : '—',
      caption: noteCaption
    },
    { label: 'INSTRUMENTS', value: instrumentCount != null ? String(instrumentCount) : '—' },
    { label: 'YEAR', value: yearText || '—' }
  ])

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
    <h1>{title}</h1>
    {#if artist.trim()}
      <button class="artist" onclick={openArtist} title="Search charts by {artist}">
        {artist}
      </button>
    {/if}
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
      <div class="left">
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
        <section class="stats">
          {#each stats as stat (stat.label)}
            <div class="card stat">
              <span class="stat-label mono">{stat.label}</span>
              <span class="stat-value mono">{stat.value}</span>
              {#if stat.caption}
                <span class="stat-caption mono">{stat.caption}</span>
              {/if}
            </div>
          {/each}
        </section>
      </div>

      <aside class="right">
        <div class="art-card">
          {#if coverUrl}
            <!-- A cached cover can 404 if the art file was swept while this view is open. -->
            <img class="art" src={coverUrl} alt="Album art" onerror={() => (artFailed = true)} />
          {:else}
            <div class="art placeholder"></div>
          {/if}
        </div>

        {#if matrixRows.length === 0 && record}
          <p class="card no-notes">
            This chart's notes have not been read yet. Run Scan library to read them.
          </p>
        {:else}
          <DiffMatrix rows={matrixRows} />
        {/if}

        {#if record}
          <div class="card versions">
            <div class="versions-head">
              <span class="mono meta-label">CHORUS VERSION</span>
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
          </div>
        {/if}

        {#if chart}
          <div class="card meta-list">
            <div class="meta-row">
              <span class="mono meta-label">MD5</span>
              <span class="mono meta-value" title={chart.md5}>{chart.md5.slice(0, 12)}…</span>
            </div>
            <div class="meta-row">
              <span class="mono meta-label">SOURCE</span>
              <span class="mono meta-value">CHORUS ENCORE</span>
            </div>
          </div>
        {/if}
      </aside>
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
  .detail {
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
    border-radius: 7px;
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
    border-color: rgba(255, 255, 255, 0.2);
  }
  h1 {
    margin-top: 14px;
    font-size: var(--fs-display);
    font-weight: 700;
    line-height: var(--lh-display);
    letter-spacing: var(--ls-tight);
    color: var(--text-1);
  }
  .artist {
    align-self: flex-start;
    margin-top: 4px;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-emphasis);
    color: var(--text-2);
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .artist:hover {
    color: var(--accent-hi);
  }
  .head {
    display: flex;
    flex-direction: column;
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
    background: var(--surface-1);
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
    border-color: rgba(255, 255, 255, 0.2);
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
    border-radius: 7px;
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
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    color: var(--text-2);
  }
  .btn-ghost:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
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
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 18px;
    align-items: start;
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .right {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }
  .card-head {
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    padding: 12px 14px 0;
  }
  .about dl {
    padding: 6px 14px 12px;
  }
  .about-row {
    display: grid;
    /* Sized for the longest label, "LOADING PHRASE". JetBrains Mono advances 0.6em, so
       at --fs-caption (12px) that is 14 x 7.2px = 100.8px, plus --ls-caps (0.96px a
       character) = ~114px. The column was 104px when the label was 10px (~95px); left
       alone it would now wrap the label and break the baseline this grid aligns on.
       Measured at 120px in the running app: no wrap at any of 960/1280/1600. */
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 10px;
    align-items: baseline;
    padding: 7px 0;
    border-bottom: 1px solid var(--hairline);
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
    font-size: var(--fs-secondary);
    color: var(--text-2);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    min-width: 0;
  }
  .stat-label {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
  }
  .stat-value {
    font-size: var(--fs-emphasis);
    font-weight: 600;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Names the exact track the NOTES figure counts. Without it the number is
     ambiguous across instruments and difficulties. */
  .stat-caption {
    margin-top: -2px;
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .art-card {
    border-radius: var(--radius);
    overflow: hidden;
    border: 1px solid var(--hairline);
  }
  .art {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
  }
  .art.placeholder {
    background: var(--surface-2);
  }

  .meta-list {
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .meta-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .meta-label {
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    color: var(--text-3);
    /* Was 60px, sized for these labels at 10px; --fs-caption needs the extra 12. */
    width: 72px;
    flex-shrink: 0;
  }
  .meta-value {
    font-size: var(--fs-caption);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .versions {
    padding: 10px 14px;
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
    background: var(--surface-2);
    border: 1px solid var(--border-1);
    border-radius: 4px;
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
    color: var(--danger, var(--text-2));
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

  /* Sits where DiffMatrix would: same card shell, but sentence case and wrapping, because
     it is an instruction to the user rather than one of the matrix's mono status labels. */
  .no-notes {
    padding: 16px 12px;
    text-align: center;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
</style>
