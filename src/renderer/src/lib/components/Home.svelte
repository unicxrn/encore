<script lang="ts" module>
  import type { ChartData } from '../api/enchor'
  import type { ChartRecord } from '../../../../shared/schemas'

  /**
   * What a Home row click hands back to App. Task 5's Detail page accepts both
   * variants: remote charts come from the Enchor API, local ones from the
   * catalog (no ChartData exists for a scanned folder).
   */
  export type ChartTarget =
    { kind: 'remote'; chart: ChartData } | { kind: 'local'; record: ChartRecord }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { albumArtUrl } from '../api/enchor'
  import { artUrl } from '../../../../shared/art'
  import { msToTime, fallbackChartName, stripRichText } from '../../../../shared/format'
  import { issueSummary, issueTitle } from '../issue-summary'
  import { encore } from '../stores/bridge'
  import { globalQuery } from '../stores/global-search'
  import { latestCharts, loadLatestCharts } from '../stores/latest-charts'
  import { cancelScan, scanProgress, startScan } from '../stores/scan'
  import { settings } from '../stores/settings'
  import { libraryGap } from '../empty-state'
  import DiffPips from './DiffPips.svelte'
  import type { ViewId } from './Sidebar.svelte'

  /**
   * A row hands its chart to the preview rail, exactly as an Explore row does.
   *
   * Home is the other place charts are scanned rather than read, so it answers a row the same
   * way Explore does: the rail takes the chart, the page stays where it is, and the route to the
   * chart page is the rail's own control beside it. App is what decides between the two, because
   * App owns the rail, and below the shell's breakpoint there is no rail to fill.
   */
  let {
    onNavigate,
    onSelectChart
  }: {
    onNavigate: (id: ViewId) => void
    onSelectChart: (target: ChartTarget) => void
  } = $props()

  const ARTIST_COUNT = 8
  /**
   * How many charts each chart row lists.
   *
   * Six rather than the ten the stores hold, because a Home row is a sample and not a list: at
   * 55px a row, ten of them twice over is 1100px of chart under a hero, and the box Home gets at
   * the default 1280x800 window is 680px tall once the topbar and the player bar have taken
   * theirs. Measured at six, at that window: the first chart's row ends 256px in and the artists
   * strip's heading at 551px, both on screen, and the page is 1090px in the 680px box. See all
   * is the way to the rest, which is what the whole list is for.
   */
  const ROW_COUNT = 6

  /**
   * The three parts a row draws, in Explore's order, so the two lists read the same.
   *
   * Explore draws five and this draws three, for the reason Library.svelte's own list records:
   * Explore's row folds the difficulty onto a line of its own when its column is narrow and
   * this one never does, so five groups here come straight off the title at every width. The
   * price is written down beside the track width below.
   */
  const ROW_PARTS: readonly { key: string; label: string }[] = [
    { key: 'guitar', label: 'Guitar' },
    { key: 'bass', label: 'Bass' },
    { key: 'drums', label: 'Drums' }
  ]

  // `explainIssue` needs to know which machine this is, because badVideo is a fault on Linux and
  // a portability note everywhere else. Read once: it cannot change while the app runs.
  const platform = encore().platform

  // The latest-charts row lives in a module store: App recreates Home on every
  // navigation back to it, and a component-owned fetch spent one of the API's
  // 50 requests/minute on each visit.
  const latest = $derived($latestCharts.charts)
  const latestLoading = $derived($latestCharts.loading)
  const latestError = $derived($latestCharts.error)
  // Total charts the API reports for the wildcard query, which is the only honest
  // number for the hero's third figure. Stays null (and the figure is omitted) when
  // the request fails or the field is missing.
  const totalCharts = $derived($latestCharts.total)

  let local = $state<ChartRecord[]>([])
  let localLoading = $state(true)
  let localError = $state<string | null>(null)

  /**
   * The two numbers the hero is about, and why they are these two.
   *
   * `libraryTotal` is the whole catalog rather than `local.length`, which stops at ROW_COUNT.
   * `needWork` is the count Asset Studio lists: a chart missing any of album art, background,
   * video or lyrics. Both are `catalogCount` over SQL the catalog already indexes, so the pair
   * costs two counts and no row bodies whatever the library's size.
   *
   * What the hero deliberately does NOT draw, having looked:
   *
   * - Play data. It moved to its own tab and Home stopped asking for it; a hero figure would put
   *   a bridge subscription and a read back on a view that draws no play block.
   * - An issue count. `issuesLast` is a main-process cache that is null until the Issues tab has
   *   run a scan in THIS launch, so the figure would be absent on nearly every visit, and
   *   reading it copies the whole report across IPC to count its rows.
   * - When the library was last scanned. Nothing persists that: no catalog column and no
   *   setting records a scan's time, so the only honest answer is the live one already here,
   *   which is whether a scan is running now.
   */
  let libraryTotal = $state<number | null>(null)
  let needWork = $state<number | null>(null)

  // Art that 404'd or failed to decode; keyed by md5 so a failed image falls back to the
  // surface-2 placeholder instead of a broken icon.
  const artFailed = new SvelteSet<string>()
  // Local covers get their own set: the same md5 can name a remote cover on the CDN and a
  // cached local one, and the two are fetched from different places, so one being gone says
  // nothing about the other.
  const localArtFailed = new SvelteSet<string>()

  const scanning = $derived($scanProgress?.status === 'running')

  /**
   * Why the library is empty, `null` when it is not, and `undefined` while nobody knows yet.
   *
   * The third state is the one that had to exist. App recreates Home on every navigation back to
   * it, so the count is re-asked every visit, and a gap computed from a count of zero before the
   * count has answered would flash "nothing scanned yet" across the top of a full library each
   * time. Treating unknown as empty is the same guess App refuses to make between Home and the
   * folder picker, for the same reason.
   *
   * `libraryTotal` is the count with nothing filtering it, which is what libraryGap asks for: both
   * rows bottom out on this catalog, so no second query is needed to tell an empty library from
   * an emptied one.
   */
  const gap = $derived(
    libraryTotal === null
      ? undefined
      : libraryGap({
          folderCount: $settings.libraryFolders.length,
          libraryTotal,
          scanFinished: $scanProgress?.status === 'done'
        })
  )

  /**
   * Whether the hero's button asks for a folder or offers a scan.
   *
   * Decided on the folder list alone rather than on `gap`, which waits for the catalog. App only
   * renders Home once settings have loaded, so this is known on the first frame and the button
   * does not change under the pointer a moment after the page appears.
   */
  const noFolder = $derived($settings.libraryFolders.length === 0)

  /**
   * One shape for a chart row, whichever side the chart came from.
   *
   * The remote row and the local row differ in four fields and in nothing else the eye can see,
   * so they are normalized here and drawn once. Two copies of the row markup is how one of them
   * comes to claim something the other does not.
   */
  interface Row {
    key: string
    target: ChartTarget
    /** Which failure set a broken cover belongs in; see the two sets above. */
    scope: 'remote' | 'local'
    md5: string | null
    name: string
    /** Artist, album and year on one line, with the separators of the empty fields dropped. */
    meta: string
    charter: string
    length: string
    instruments: readonly string[]
    tiers: Record<string, number | null>
    /**
     * What the chart's own issues amount to, or null when nobody has looked.
     *
     * Only the remote side can fill this. Chorus runs scan-chart over everything it ingests and
     * sends the findings with each search result, so a latest-charts row knows for free. A
     * scanned local folder carries no such record: the Issues view's report is a per-launch
     * cache in main, so a dot on a library row would be absent far more often than it was right.
     */
    health: string | null
    /** Breakage rather than a charting note, which is the difference the dot's shape carries. */
    broken: boolean
  }

  const joined = (parts: (string | number | null | undefined)[]): string =>
    parts
      .map((part) => stripRichText(part === null || part === undefined ? '' : String(part)))
      .filter(Boolean)
      .join(' · ')

  const latestRows = $derived.by(() =>
    latest.slice(0, ROW_COUNT).map((chart): Row => {
      const summary = issueSummary(chart, platform)
      return {
        key: String(chart.chartId),
        target: { kind: 'remote', chart },
        scope: 'remote',
        md5: chart.albumArtMd5,
        name: stripRichText(chart.name),
        meta: joined([chart.artist, chart.album, chart.year]),
        charter: stripRichText(chart.charter),
        length: msToTime(chart.song_length),
        instruments: chart.notesData?.instruments ?? [],
        tiers: {
          guitar: chart.diff_guitar,
          bass: chart.diff_bass,
          drums: chart.diff_drums
        },
        health: summary.worst === null ? null : issueTitle(summary, 'Chorus'),
        broken: summary.worst === 'blocking'
      }
    })
  )

  const localRows = $derived.by(() =>
    local.slice(0, ROW_COUNT).map((record): Row => ({
      key: record.path,
      target: { kind: 'local', record },
      scope: 'local',
      md5: record.albumArtMd5,
      name: stripRichText(record.name) || fallbackChartName(record.path),
      meta: joined([record.artist, record.album, record.year]),
      charter: stripRichText(record.charter),
      length: msToTime(record.songLength),
      instruments: record.instruments,
      tiers: {
        guitar: record.diffGuitar,
        bass: record.diffBass,
        drums: record.diffDrums
      },
      health: null,
      broken: false
    }))
  )

  // One entry per artist in first-seen order, carrying that artist's first
  // chart so the card can reuse its album art as the avatar.
  const artists = $derived.by(() => {
    // Plain array lookup rather than a Set: at most LATEST_COUNT entries, and a
    // Set here would be flagged as non-reactive state inside a derived.
    const seen: string[] = []
    const out: { name: string; chart: ChartData }[] = []
    for (const chart of latest) {
      const name = chart.artist?.trim()
      if (!name || seen.includes(name.toLowerCase())) continue
      seen.push(name.toLowerCase())
      out.push({ name, chart })
      if (out.length === ARTIST_COUNT) break
    }
    return out
  })

  /** Every asset the Asset Studio can add. A chart missing any one of them is a chart it lists. */
  const NEEDS_WORK = ['albumArt', 'background', 'video', 'lyrics'] as const

  async function loadLocal(): Promise<void> {
    localLoading = true
    localError = null
    try {
      // One round trip each, in parallel: the page is three independent facts about the same
      // catalog and serializing them would show the hero settling a figure at a time.
      const [rows, total, missing] = await Promise.all([
        encore().catalogQuery({ search: '', offset: 0, limit: ROW_COUNT }),
        encore().catalogCount({}),
        encore().catalogCount({ missing: [...NEEDS_WORK], missingMode: 'any' })
      ])
      local = rows
      libraryTotal = total
      needWork = missing
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err)
    } finally {
      localLoading = false
    }
  }

  // A scan that has stopped changes the catalog under us; refresh just that row.
  // The `mounted` guard keeps a already-'done' scan status from firing a second
  // loadLocal() on top of the onMount one.
  //
  // 'canceled' counts too: a cancelled scan keeps every row it wrote, so the catalog really has
  // moved and this row would otherwise sit stale until the next full scan.
  let mounted = false
  $effect(() => {
    const status = $scanProgress?.status
    if (mounted && (status === 'done' || status === 'canceled')) void loadLocal()
  })

  onMount(() => {
    // Independent: a network failure must still leave the library row rendered.
    // loadLatestCharts is a no-op while its cached row is fresh.
    void loadLatestCharts()
    void loadLocal()
    mounted = true
  })

  function openArtist(name: string): void {
    globalQuery.set(name)
    onNavigate('browse')
  }

  /**
   * The cover, or null for a chart with none and for one whose cover would not load.
   *
   * The art protocol answers 404 when a row's md5 has no cached file (cache cleared, or a
   * sweep raced the catalog row) and 400 when the md5 is malformed; both arrive here as a
   * failed load, so local covers need the same failure bookkeeping as remote ones.
   */
  function artFor(row: Row): string | null {
    if (row.md5 === null) return null
    const failed = row.scope === 'remote' ? artFailed : localArtFailed
    if (failed.has(row.md5)) return null
    return row.scope === 'remote' ? albumArtUrl(row.md5) : artUrl(row.md5)
  }

  function noteArtFailed(row: Row): void {
    if (row.md5 === null) return
    ;(row.scope === 'remote' ? artFailed : localArtFailed).add(row.md5)
  }

  function remoteArtFor(chart: ChartData): string | null {
    if (!chart.albumArtMd5 || artFailed.has(chart.albumArtMd5)) return null
    return albumArtUrl(chart.albumArtMd5)
  }

  /**
   * A row is a plain container rather than a button, for the reason Explore's is: the title
   * inside it is the real button, so Enter and Space have one target and a screen reader is
   * handed one control per chart instead of a control wrapping a control. This widens the mouse
   * target back out to the whole row, and stands aside for any control inside that has already
   * answered the click.
   */
  function onRowClick(row: Row, e: MouseEvent): void {
    if (e.target instanceof Element && e.target.closest('button, input, a, select')) return
    onSelectChart(row.target)
  }

  /** Every alternate version of a song repeats its title, so the charter is what tells them apart. */
  function rowLabel(row: Row): string {
    const attribution = [row.meta, row.charter ? `charted by ${row.charter}` : '']
      .filter(Boolean)
      .join(', ')
    return attribution ? `${row.name} ${attribution}` : row.name
  }
</script>

<!-- The one row shape, rendered by both chart rows. -->
{#snippet chartRow(row: Row)}
  {@const art = artFor(row)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="row" onclick={(e) => onRowClick(row, e)}>
    {#if art}
      <img class="cover" src={art} alt="" loading="lazy" onerror={() => noteArtFailed(row)} />
    {:else}
      <div class="cover placeholder"></div>
    {/if}
    <span class="song">
      <span class="title">
        <button class="name" aria-label={rowLabel(row)} onclick={() => onSelectChart(row.target)}
          >{row.name}</button
        >
      </span>
      <span class="meta">{row.meta}</span>
    </span>
    <span class="charter">{row.charter}</span>
    <span class="diffs">
      {#each ROW_PARTS as part (part.key)}
        <DiffPips
          instrument={part.key}
          label={part.label}
          instruments={row.instruments}
          tier={row.tiers[part.key]}
          icon
        />
      {/each}
    </span>
    <!-- Nothing at all for a clean chart, which is most of them. A mark on every row is a mark
         that means nothing; this one only appears where there is something to say. -->
    <span class="health">
      {#if row.health !== null}
        <span
          class="dot"
          class:broken={row.broken}
          role="img"
          aria-label={row.health}
          title={row.health}
        ></span>
      {/if}
    </span>
    <span class="len mono">{row.length}</span>
  </div>
{/snippet}

<div class="home selectable">
  <!-- The hero is the state of the library rather than a wordmark: the first thing on screen is
       what you have, what still needs something done to it, and how big the catalog you can pull
       from is. Each figure is a count the app can actually produce; see `libraryTotal` for the
       three that were considered and left out. -->
  <section class="hero" aria-labelledby="hero-heading">
    <div class="hero-main">
      <h1 id="hero-heading">YOUR LIBRARY</h1>
      {#if gap === undefined}
        <!-- The count has not answered. The line keeps its height (see .figure) so the hero does
             not grow under the pointer when it does, and says nothing until it can say something
             true. -->
        <p class="figure"></p>
      {:else if gap === null && libraryTotal !== null}
        <p class="figure">
          <span class="n">{libraryTotal.toLocaleString()}</span>
          <span class="unit">{libraryTotal === 1 ? 'chart' : 'charts'}</span>
        </p>
      {:else}
        <!-- Every empty case reads as a starting point rather than as a failure: it says what
             there is so far, and the button beside it is the next step. The row below carries
             the long form, naming the folder and the scan; two copies of that paragraph on one
             screen is one too many. -->
        <p class="figure">
          <span class="n none">
            {#if gap === 'no-folder'}
              No folder yet
            {:else if gap === 'scan-found-nothing'}
              No charts found
            {:else}
              Nothing scanned yet
            {/if}
          </span>
        </p>
      {/if}
      <p class="facts">
        {#if scanning}
          <span class="live"
            >Scanning, <span class="mono">{$scanProgress?.percent ?? 0}</span>%</span
          >
        {:else if gap === null && needWork !== null && needWork > 0}
          <button class="fact-link" onclick={() => onNavigate('assets')}>
            <span class="mono">{needWork.toLocaleString()}</span> missing art, video or lyrics
          </button>
        {:else if gap === null && needWork === 0}
          <!-- Plain text, not a link: there is nowhere useful to send someone whose library has
               nothing left to add to it. -->
          <span>Every chart has its art, video and lyrics.</span>
        {/if}
        {#if totalCharts !== null}
          <button class="fact-link" onclick={() => onNavigate('browse')}>
            <span class="mono">{totalCharts.toLocaleString()}</span> on Chorus Encore
          </button>
        {/if}
      </p>
    </div>
    <div class="hero-actions">
      {#if noFolder}
        <button class="btn-primary" onclick={() => onNavigate('settings')}>Add your folder</button>
      {:else}
        <button class="btn-primary" disabled={scanning} onclick={() => void startScan()}>
          {scanning ? 'Scanning…' : 'Scan library'}
        </button>
      {/if}
      <!-- Only while a scan is in flight. This is the view a first-run user is on for the
           whole of their first scan (Welcome closes as soon as the scan has started), so it
           needs its own way out rather than sending them to the Installed tab to find one. -->
      {#if scanning}
        <button class="btn-ghost" onclick={() => void cancelScan()}>Cancel</button>
      {/if}
      <button class="btn-ghost" onclick={() => onNavigate('browse')}>Explore charts</button>
    </div>
  </section>

  <!-- Each row is a labelled region. A <section> with no accessible name is not
       a landmark at all, so without this the page is one undifferentiated run of
       cards and the headings are decoration. -->
  <section class="row-block" aria-labelledby="row-latest">
    <header class="row-head">
      <h2 id="row-latest">LATEST CHARTS</h2>
      <button class="see-all" onclick={() => onNavigate('browse')}>See all</button>
    </header>
    <!-- These three swap for one another as an async request settles, with
         nothing on screen to tell you it happened. role="status" is the polite
         one: it waits for a gap rather than interrupting. -->
    {#if latestLoading}
      <p class="status" role="status">LOADING…</p>
    {:else if latestError}
      <p class="err" role="status">Encore could not load the latest charts: {latestError}</p>
    {:else if latest.length === 0}
      <!-- The request succeeded and the catalog answered with nothing, which for a wildcard
           query means the service, not the user. Retrying is automatic and worth saying:
           loadLatestCharts only holds a cached row when it has charts in it, so an empty one is
           re-requested on the next visit rather than kept for the five-minute TTL. -->
      <p class="err" role="status">
        Chorus Encore returned no charts just now. This row asks again each time you open Home.
      </p>
    {:else}
      <div class="rows">
        {#each latestRows as row (row.key)}
          {@render chartRow(row)}
        {/each}
      </div>
    {/if}
  </section>

  {#if artists.length > 0}
    <section class="row-block" aria-labelledby="row-artists">
      <header class="row-head">
        <h2 id="row-artists">ARTISTS</h2>
      </header>
      <!-- The one row that stays a strip of covers rather than a list. An artist is a name and a
           face, with none of the six facts a chart row carries, so a full-width row per artist
           would be eight lines of white space with a word in each. -->
      <div class="scroller">
        {#each artists as entry (entry.name)}
          {@const art = remoteArtFor(entry.chart)}
          <button class="artist-card" onclick={() => openArtist(entry.name)}>
            {#if art}
              <img
                class="avatar"
                src={art}
                alt=""
                loading="lazy"
                onerror={() => entry.chart.albumArtMd5 && artFailed.add(entry.chart.albumArtMd5)}
              />
            {:else}
              <div class="avatar placeholder"></div>
            {/if}
            <span class="a-name">{stripRichText(entry.name)}</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <section class="row-block" aria-labelledby="row-library">
    <header class="row-head">
      <h2 id="row-library">IN YOUR LIBRARY</h2>
      <button class="see-all" onclick={() => onNavigate('library')}>See all</button>
    </header>
    {#if localLoading}
      <p class="status" role="status">LOADING…</p>
    {:else if localError}
      <p class="err" role="status">Encore could not read the catalog: {localError}</p>
    {:else if local.length === 0}
      <p class="err" role="status">
        {#if gap === 'no-folder'}
          No library folder yet. Add your Clone Hero Songs folder in Settings, then use Scan library
          above.
        {:else if gap === 'scan-found-nothing'}
          That scan found no charts in your library folder. A chart is a folder holding notes.chart,
          notes.mid or song.ini, or a .sng file.
        {:else}
          Nothing scanned yet. Scan library above reads every chart in your library folder.
        {/if}
      </p>
    {:else}
      <div class="rows">
        {#each localRows as row (row.key)}
          {@render chartRow(row)}
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  /* A container rather than a media query, for the reason Explore's results column is one: the
     window's width does not tell you how wide this column is. The rail is 374px and shows only
     above 1120px, so the view is 882px at a 1120px window and 509px at a 1121px one, and a media
     query would have to encode that backwards step. */
  .home {
    padding: 16px 20px 26px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    container-type: inline-size;
    container-name: home;
  }
  .mono {
    font-family: var(--font-mono);
  }

  /* Hero: accent gradient with a left-weighted dark overlay so the figures and the heading keep
     large-text contrast.

     It is the one block on this page whose height answers to nothing but its own content, so it
     is the one that can push the first chart off the window. Measured across every width the
     shell supports: 121px at 960, 1120 and 1920 wide, 144px at 1280 where the two facts wrap to
     a second line, and 173px at 1121, the narrowest column there is, where the buttons stack
     under the figures. The worst of those still leaves the first row ending 285px into a 480px
     box at the shortest window the shell allows. */
  .hero {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 20px;
    border-radius: var(--radius);
    background: var(--accent-grad);
    overflow: hidden;
    isolation: isolate;
    padding: 16px 20px 18px;
  }
  .hero::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(0, 0, 0, 0.62) 0%, rgba(0, 0, 0, 0.18) 100%);
    z-index: -1;
  }
  .hero-main {
    min-width: 0;
    flex: 1;
  }
  /* The same mono micro-caps the row heads below use, so the hero is labelled the way the
     sections are rather than shouting in a second voice. */
  h1 {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-tight);
    color: rgba(255, 255, 255, 0.72);
  }
  /* 46px is the 40px figure at its own leading, so the line is the same height before the count
     lands as after it. */
  .figure {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-height: 46px;
    margin-top: 4px;
    color: #fff;
  }
  .n {
    font-size: var(--fs-hero);
    font-weight: 700;
    line-height: var(--lh-display);
    letter-spacing: var(--ls-tighter);
  }
  /* An empty library says a phrase where a full one says a number, and a phrase set at 40px
     wraps the hero onto a second line at every width below 1120. One step down fits. */
  .n.none {
    font-size: var(--fs-display);
    letter-spacing: var(--ls-tight);
  }
  .unit {
    font-size: var(--fs-emphasis);
    color: rgba(255, 255, 255, 0.78);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 14px;
    margin-top: 6px;
    font-size: var(--fs-secondary);
    line-height: var(--lh-tight);
    color: rgba(255, 255, 255, 0.78);
  }
  /* A figure that leads somewhere is a button, and one that does not is text. The two are drawn
     alike on purpose: both are facts about the library, and only one of them has an answer to
     act on, which the underline on hover is what says. */
  .fact-link {
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    line-height: var(--lh-tight);
    color: rgba(255, 255, 255, 0.78);
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .fact-link:hover {
    color: #fff;
    text-decoration: underline;
  }
  .live {
    color: #fff;
  }
  .hero-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .btn-primary,
  .btn-ghost {
    border-radius: 7px;
    padding: 8px 16px;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .btn-primary {
    background: var(--text-1);
    border: 1px solid var(--text-1);
    color: var(--bg);
    font-weight: 600;
  }
  .btn-primary:hover:not(:disabled) {
    background: #fff;
  }
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .btn-ghost {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.34);
    color: #fff;
  }
  .btn-ghost:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.55);
  }

  /* Rows */
  .row-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 6px;
  }
  h2 {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
  }
  .see-all {
    margin-left: auto;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    color: var(--text-2);
    cursor: pointer;
    transition: color var(--t-fast) var(--ease);
  }
  .see-all:hover {
    color: var(--accent-hi);
  }
  .status,
  .err {
    font-size: var(--fs-secondary);
    padding: 10px 0;
  }
  .status {
    font-family: var(--font-mono);
    /* Exception: 0.1em, wider than --ls-caps. A single mono status word set alone on a
       line, where the caps tracking used for inline labels reads too tight. */
    letter-spacing: 0.1em;
    color: var(--text-3);
  }
  .err {
    color: var(--text-2);
    line-height: var(--lh-prose);
    max-width: 60ch;
  }

  /* Explore's row, at Explore's proportions: a 40px cover in a 55px row, the name over its
     metadata, the charter, the three parts as pips, and a mark only where there is something to
     say. Home carries no checkbox, no index and no per-row action, so its grid is Explore's
     with those tracks taken out: the action a row leads to is the rail's, beside the chart it
     is showing, which is the arrangement Explore settled on.

     The cover stays 40px against Explore's 52px, and that is the row height talking rather than
     a disagreement about covers. Explore's row is 71px because it carries a badge band under the
     subtitle, so a 52px square sits in it with room either side. This row is two lines and 55px,
     and `MODE=full scripts/measure-home.mjs` at 52px puts it at 67px: six rows a section, so the
     artists strip moves from 551px to 623px and "In your library" from 713px to 785px at the
     default 1280px window, on a page that already runs 410px past its box. The cover is the box
     the row is built around and the two rows are different shapes; the difficulty display is the
     information, and that is the part that now matches.

     124px of difficulty: 3 groups of 34px plus 2 gaps of 9px is 120px, and the four spare pixels
     are Explore's own margin at 210px for five. It was 136px when the three groups were letters,
     so the ring form gave the title 12px back: measured at 1280, 261px to 273px, and at 960 the
     name goes from 4 of 12 rows ellipsised to 2 of 12.

     Five groups would want 210px, and this row never folds the difficulty onto a line of its own,
     so all 74px of the difference comes off the title at every width: 327 to 241 at 960, 487 to
     401 at 1120, 254 to 168 at the 1121px window the rail appears at, 273 to 187 at 1280, 497 to
     411 at 1600 and 817 to 731 at 1920. The subtitle crosses at 1120 and at 1600, 6 of 12 rows
     ellipsised against 12 of 12. A 168px title on the page whose whole job is to show you six
     charts is the measurement that settled it. */
  .rows {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) minmax(0, 150px) 124px 10px 46px;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 7px 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.035);
    cursor: pointer;
    /* On the row, not on `:hover`: declared only under the hover rule, the fade played on the
       way in and snapped on the way out. */
    transition: background var(--t-fast) var(--ease);
  }
  .row:hover {
    background: var(--surface-1);
  }
  /* Fixed rather than aspect-ratio: a square that takes its height from its width is a square
     that changes the row's height when the column does, and rows of two heights are the thing
     the eye trips over when scanning a list. The background fills the box for a placeholder and
     for a lazy image that has not decoded yet alike, so a row never flashes a transparent
     square as the page scrolls. */
  .cover {
    width: 40px;
    height: 40px;
    border-radius: 5px;
    object-fit: cover;
    display: block;
    background: var(--surface-2);
  }
  .song {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    display: flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    font-size: var(--fs-body);
    font-weight: 600;
    line-height: var(--lh-tight);
    color: var(--text-1);
  }
  /* The title is the row's own button and the row around it is a plain container; see
     `onRowClick`. Reset to look like the text it replaced, and carrying the ellipsis rules
     that were on that text. */
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
    min-width: 64px;
    flex: 0 1 auto;
  }
  .meta,
  .charter {
    font-size: var(--fs-secondary);
    line-height: var(--lh-tight);
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .charter {
    color: var(--text-3);
  }
  /* 9px between the groups, the gap Explore's row uses, so the pips read as groups and not as
     one run. `nowrap` because the width of this thing is the information it carries. */
  .diffs {
    display: flex;
    flex-wrap: nowrap;
    gap: 9px;
  }
  .health {
    display: flex;
    justify-content: center;
  }
  /* Explore's mark, drawn the same way here: hollow for a charting note, filled for breakage.
     A ring and a disc differ in shape and not only in colour, which is what keeps the two apart
     for a red-green colour blind reader. Same mark, same meaning, in both lists. */
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
  .len {
    font-size: var(--fs-caption);
    color: var(--text-3);
    text-align: right;
  }

  .scroller {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 4px 0 8px;
    /* No scrollbar rules of its own: the thin, hairline-thumbed scrollbar is set once on
       `html` in tokens.css and inherits here. The `--surface-2` thumb this row used to paint
       measured 1.3:1 against --bg, a scrollbar that was there and could not be seen. */
  }
  .artist-card {
    flex: 0 0 96px;
    width: 96px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    background: none;
    border: 0;
    padding: 4px 0;
    color: inherit;
    font-family: var(--font-ui);
    cursor: pointer;
  }
  .avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    object-fit: cover;
    border: 1px solid var(--hairline);
    display: block;
    transition: border-color var(--t-fast) var(--ease);
  }
  .avatar.placeholder {
    background: var(--surface-2);
  }
  .artist-card:hover .avatar {
    border-color: var(--accent);
  }
  .a-name {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    text-align: center;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color var(--t-fast) var(--ease);
  }
  .artist-card:hover .a-name {
    color: var(--text-1);
  }

  /* The two widths where the row has to give something up, at the thresholds Explore's row uses,
     so one window narrows both lists at the same moment.

     What goes, in order. The length goes first: the rail shows it for the chart being looked at,
     and it is the only fact here that is repeated somewhere a click away. The charter goes last
     of the text, because two versions of a song are told apart by nothing else. Measured at
     1280x800, which is the default window and lands in the first of these: the charter's 110px
     leaves the title and its metadata a 261px box each. */
  @container home (max-width: 899px) {
    .row {
      grid-template-columns: 40px minmax(0, 1fr) minmax(0, 110px) 124px 10px;
    }
    .row .len {
      display: none;
    }
  }
  /* 509px of column, which is a 1121px window with the rail back in it: the narrowest this page
     is ever asked to be. The hero stacks its actions under its figures rather than squeezing
     them, and the row is down to the three things that identify a chart. */
  @container home (max-width: 559px) {
    .hero {
      flex-direction: column;
      align-items: stretch;
    }
    .row {
      grid-template-columns: 40px minmax(0, 1fr) 124px;
    }
    .row .charter,
    .row .health {
      display: none;
    }
  }
</style>
