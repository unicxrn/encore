<script lang="ts">
  import { msToTime, fallbackChartName, stripRichText } from '../../../../shared/format'
  import {
    SETLISTS_ARE_ENCORES,
    SETLIST_NAME_MAX,
    type SetlistEntry
  } from '../../../../shared/setlists'
  import type { ChartRecord } from '../../../../shared/schemas'
  import { encore } from '../stores/bridge'
  import {
    createSetlist,
    deleteSetlist,
    moveSetlistEntry,
    reloadSetlists,
    renameSetlist,
    setlists,
    setSetlistEntry
  } from '../stores/setlists'
  import type { ChartTarget } from './Home.svelte'

  /**
   * The Setlists view: where a setlist is read and edited.
   *
   * ## What a setlist is here, and the one thing it is not
   *
   * Clone Hero has no setlist format. That was checked rather than assumed, and shared/setlists.ts
   * lists what was looked at. So this screen says so, once, under its own title and nowhere else:
   * a user who builds a setlist and then goes looking for it in the game has to meet that sentence
   * before they build one, not after. It is not repeated on the rail's button or on each row,
   * because a caveat a user reads four times is one they stop reading.
   *
   * ## Why the shape is a picker over a list
   *
   * The list is the thing. A setlist is an ORDER, and an order is only readable as one column of
   * rows you can run your eye down, which is why the setlists themselves are a strip across the
   * top rather than a second column beside them: at 1280 the view pane is 668px between the
   * sidebar and the rail, and a master column would take a third of that off the only part of the
   * screen whose width does any work.
   *
   * ## Why the rows are not the Installed row
   *
   * Installed's row is a chart the catalog holds, drawn from a record. Half the rows here may have
   * no record at all: a setlist entry is three names (shared/setlists.ts), so it survives the chart
   * being deleted, and it can be made for a chart on Chorus that was never downloaded. A row that
   * needed a record would have nothing to draw for exactly the entries this screen exists to keep.
   * So a row is drawn from the ENTRY, and the catalog's answer is what adds the length, the play
   * and the rail hand-off to the ones the library has.
   */
  let {
    onSelectChart
  }: {
    /** Hand a chart the library holds to the preview rail, as Installed and Explore do. */
    onSelectChart?: (target: ChartTarget) => void
  } = $props()

  let openId = $state<string | null>(null)
  let loadError = $state<string | null>(null)
  let actionError = $state<string | null>(null)
  let newName = $state('')
  let renaming = $state(false)
  let renameValue = $state('')
  /** The setlist a delete is waiting on. Confirmed in place; see the button's comment. */
  let confirmingDelete = $state<string | null>(null)

  /**
   * The catalog's answer about the open setlist, by entry index.
   *
   * Asked per open rather than per launch, because it is the one part of a setlist that depends on
   * what is currently on disk. Kept beside the entries rather than merged into them so an entry
   * the library does not hold stays an entry: null here means "your library has nothing under
   * these names", which is an ordinary thing for a setlist to contain.
   */
  let charts = $state<(ChartRecord | null)[]>([])

  const open = $derived($setlists.find((list) => list.id === openId) ?? null)

  /**
   * Open the first setlist when nothing is open, and close one that has gone.
   *
   * Reading `$setlists` rather than owning a copy is what makes a setlist deleted in this view and
   * one deleted from the rail's panel behave the same way: the list is main's answer, and this
   * follows it.
   */
  $effect(() => {
    const lists = $setlists
    if (lists.length === 0) {
      openId = null
      return
    }
    if (openId === null || !lists.some((list) => list.id === openId)) openId = lists[0].id
  })

  $effect(() => {
    const id = openId
    charts = []
    let stale = false
    const abandon = (): void => {
      stale = true
    }
    if (id === null) return abandon
    encore()
      .setlistsCharts({ id })
      .then((answer) => {
        // The open setlist changed while the read was in flight. Keeping the answer would draw one
        // setlist's lengths against another setlist's names.
        if (!stale) charts = answer
      })
      .catch(() => {
        // Left empty on purpose: every row still draws from its entry, and the only thing lost is
        // the length and the play. A message about a failed join would be a screen-wide alarm for
        // a column of dashes.
      })
    return abandon
  })

  $effect(() => {
    void reloadSetlists().catch((err: unknown) => {
      loadError = err instanceof Error ? err.message : String(err)
    })
  })

  const entryTitle = (entry: SetlistEntry, record: ChartRecord | null): string =>
    stripRichText(entry.name) || (record ? fallbackChartName(record.path) : entry.name)

  /**
   * What the open setlist adds up to, in one line.
   *
   * The running time counts only the entries the library holds AND has a length for, and says so
   * rather than presenting a total that quietly omits a third of the list. A setlist whose charts
   * are all missing says that instead of "0:00", which would read as a list of silent songs.
   */
  const summary = $derived.by(() => {
    const list = open
    if (list === null) return ''
    const total = list.entries.length
    if (total === 0) return 'Nothing in this setlist yet.'
    const held = charts.filter((c) => c !== null).length
    const timed = charts.filter((c) => c !== null && c.songLength !== null)
    const ms = timed.reduce((sum, c) => sum + (c?.songLength ?? 0), 0)
    const parts = [`${total} ${total === 1 ? 'chart' : 'charts'}`]
    if (held < total) parts.push(`${total - held} not in your library`)
    if (timed.length > 0) {
      parts.push(
        timed.length === total
          ? `${msToTime(ms)} of music`
          : `${msToTime(ms)} across the ${timed.length} that are timed`
      )
    }
    return `${parts.join(' · ')}.`
  })

  async function act(work: () => Promise<void>): Promise<void> {
    actionError = null
    try {
      await work()
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    }
  }

  async function submitNew(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const wanted = newName
    await act(async () => {
      await createSetlist(wanted)
      newName = ''
      // Open what was just made. The store's list is main's answer, so the new setlist is the one
      // in it that was not there before rather than the last by any order this view assumes.
      openId = $setlists.find((list) => list.name === wanted.trim())?.id ?? openId
    })
  }

  async function submitRename(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const list = open
    if (list === null) return
    await act(async () => {
      await renameSetlist(list.id, renameValue)
      renaming = false
    })
  }
</script>

<div class="setlists">
  <header class="s-head">
    <h1 class="s-title">Setlists</h1>
    <!-- Said once, here, and nowhere else in the app. See the component comment. -->
    <p class="s-note">{SETLISTS_ARE_ENCORES}</p>
  </header>

  <form class="s-new" onsubmit={(e) => void submitNew(e)}>
    <label class="s-label" for="setlist-new">New setlist</label>
    <input
      id="setlist-new"
      class="s-input"
      type="text"
      bind:value={newName}
      maxlength={SETLIST_NAME_MAX}
      placeholder="Friday night"
    />
    <button class="hairline" type="submit" disabled={newName.trim() === ''}>Create</button>
  </form>

  {#if loadError !== null}
    <p class="s-error" role="alert">Encore could not read your setlists: {loadError}</p>
  {/if}
  {#if actionError !== null}
    <p class="s-error" role="alert">{actionError}</p>
  {/if}

  {#if $setlists.length === 0}
    <p class="s-empty">
      You have no setlists yet. Make one above, then add charts to it from the button beside the
      heart in the chart column.
    </p>
  {:else}
    <!-- A strip rather than a column, so the list below keeps the whole width. `aria-pressed`
         rather than a tablist: these are buttons that change what the page is about, and the
         panel under them is the page rather than a tab panel inside it. -->
    <div class="s-picker" role="group" aria-label="Your setlists">
      {#each $setlists as list (list.id)}
        <button
          class="s-tab"
          aria-pressed={list.id === openId}
          onclick={() => {
            openId = list.id
            renaming = false
            confirmingDelete = null
          }}
        >
          <span class="s-tab-name">{list.name}</span>
          {#if list.entries.length > 0}
            <!-- The same rule the sidebar's counts follow: a figure only when it is above zero,
                 because a zero beside a name reads as a fault rather than as an empty list. -->
            <span class="s-tab-count mono">{list.entries.length}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if open !== null}
    <section class="s-open" aria-label={open.name}>
      <div class="s-open-head">
        {#if renaming}
          <form class="s-rename" onsubmit={(e) => void submitRename(e)}>
            <label class="s-label" for="setlist-rename">Rename</label>
            <input
              id="setlist-rename"
              class="s-input"
              type="text"
              bind:value={renameValue}
              maxlength={SETLIST_NAME_MAX}
            />
            <button class="hairline" type="submit">Save</button>
            <button class="hairline" type="button" onclick={() => (renaming = false)}>Cancel</button
            >
          </form>
        {:else}
          <h2 class="s-open-name">{open.name}</h2>
          <div class="s-open-acts">
            <button
              class="hairline"
              onclick={() => {
                renameValue = open.name
                renaming = true
                confirmingDelete = null
              }}>Rename</button
            >
            <!-- Confirmed in place rather than in a dialog. Deleting a setlist takes nothing off
                 disk (catalog/setlists.ts holds no path to take), so the whole cost of getting it
                 wrong is retyping a name and re-adding charts, which a second button covers and a
                 modal would over-dress. -->
            {#if confirmingDelete === open.id}
              <button class="hairline danger" onclick={() => void act(() => deleteSetlist(open.id))}
                >Delete {open.name}, charts stay</button
              >
              <button class="hairline" onclick={() => (confirmingDelete = null)}>Keep it</button>
            {:else}
              <button class="hairline" onclick={() => (confirmingDelete = open.id)}>Delete</button>
            {/if}
          </div>
        {/if}
      </div>
      <p class="s-summary">{summary}</p>

      {#if open.entries.length > 0}
        <ol class="s-list">
          {#each open.entries as entry, index (`${entry.name} ${entry.artist} ${entry.charter}`)}
            {@const record = charts[index] ?? null}
            <li class="s-row" class:missing={record === null}>
              <span class="s-pos mono">{index + 1}</span>
              <span class="s-meta">
                <span class="s-name">{entryTitle(entry, record)}</span>
                <span class="s-sub"
                  >{[entry.artist, entry.charter].filter(Boolean).join(' · ') ||
                    'No artist or charter'}</span
                >
              </span>
              <span class="s-len mono"
                >{record?.songLength != null ? msToTime(record.songLength) : '—'}</span
              >
              {#if record === null}
                <!-- Not an error and not a warning. The entry is doing exactly what it was
                     designed to do: hold onto a chart the library does not currently have. -->
                <span class="s-gone">Not in your library</span>
              {:else if onSelectChart}
                <button
                  class="hairline"
                  onclick={() => onSelectChart({ kind: 'local', record })}
                  title="Show this chart in the column on the right">Preview</button
                >
              {/if}
              <span class="s-move">
                <button
                  class="icon"
                  aria-label="Move {entryTitle(entry, record)} up"
                  disabled={index === 0}
                  onclick={() => void act(() => moveSetlistEntry(open.id, entry, -1))}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>
                </button>
                <button
                  class="icon"
                  aria-label="Move {entryTitle(entry, record)} down"
                  disabled={index === open.entries.length - 1}
                  onclick={() => void act(() => moveSetlistEntry(open.id, entry, 1))}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 10 6 6 6-6" /></svg>
                </button>
                <button
                  class="icon"
                  aria-label="Take {entryTitle(entry, record)} out of {open.name}"
                  onclick={() => void act(() => setSetlistEntry(open.id, entry, false))}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg>
                </button>
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  {/if}
</div>

<style>
  .setlists {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px 24px;
    min-width: 0;
  }
  .s-head {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .s-title {
    margin: 0;
    font-size: var(--fs-heading);
    line-height: var(--lh-display);
    letter-spacing: var(--ls-tight);
    font-weight: 600;
    color: var(--text-1);
  }
  /* Capped at the same measure every other explanatory paragraph in the app is, so the sentence
     that does the most work on this screen is the one shape a reader already knows. */
  .s-note {
    margin: 0;
    max-width: 78ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .s-new,
  .s-rename {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .s-label {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
  }
  .s-input {
    flex: 1 1 200px;
    min-width: 0;
    max-width: 320px;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-1);
    background: var(--ground-3);
    color: var(--text-1);
    font: inherit;
  }
  .s-input:focus-visible {
    border-color: var(--accent);
  }
  .s-error {
    margin: 0;
    max-width: 78ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-snug);
    color: var(--warning);
  }
  .s-empty,
  .s-summary {
    margin: 0;
    max-width: 78ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  /* Wraps rather than scrolling, and the tabs are not capped.
     Measured with `scripts/measure-setlists.mjs` at 1280x800: four ordinary names are 112px at
     the widest and sit on one line; four names at the 60-character cap are 412px each and take
     four lines, which pushes the list down about 144px and clips nothing. A max-width would trade
     that for an ellipsis in the one place a setlist is picked BY its name, which is the worse
     half: the name is the user's own word and the strip is above a page that already scrolls. */
  .s-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .s-tab {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 11px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-1);
    background: var(--ground-3);
    color: var(--text-2);
    font: inherit;
    cursor: pointer;
    min-width: 0;
  }
  .s-tab:hover {
    border-color: var(--border-2);
    color: var(--text-1);
  }
  .s-tab[aria-pressed='true'] {
    border-color: var(--accent);
    color: var(--text-1);
    background: var(--accent-dim);
  }
  /* The name gives way before the figure does: a truncated name is still recognisable and a
     truncated count is a different number. */
  .s-tab-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .s-tab-count {
    flex: none;
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .s-open {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .s-open-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .s-open-name {
    margin: 0;
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--text-1);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .s-open-acts {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .s-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  /* One grid so every row's columns line up down the list, which is what makes an ORDER readable
     as one. The title takes what is left; everything else is sized to its own content.
     Measured at 1280x800, where the sidebar and the rail leave this view 653px: an ordinary title
     gets 379px and the longest title on Chorus gets 364px, both whole, and the artist and charter
     line under it is what gives way first, ellipsised by 124px in the long case. That is the right
     one to lose: the title is what a reader runs their eye down. No row scrolls sideways at any of
     960, 1280 or 1920, and neither does the document. */
  .s-row {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: 10px;
    padding: 7px 4px;
    border-bottom: 1px solid var(--ground-3);
    min-width: 0;
  }
  .s-pos {
    font-size: var(--fs-caption);
    color: var(--text-3);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .s-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .s-name,
  .s-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .s-name {
    font-size: var(--fs-body);
    color: var(--text-1);
  }
  .s-sub {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  /* Dimmed rather than struck through or coloured as a fault: the entry is intact and the library
     is what is missing, which is a difference the row has to keep. */
  .s-row.missing .s-name {
    color: var(--text-2);
  }
  .s-len {
    font-size: var(--fs-caption);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .s-gone {
    font-size: var(--fs-caption);
    color: var(--text-3);
    white-space: nowrap;
  }
  .s-move {
    display: flex;
    gap: 3px;
    flex: none;
  }
  .mono {
    font-family: var(--font-mono);
    letter-spacing: var(--ls-caps);
  }
  .hairline {
    background: var(--ground-4);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit;
    font-size: var(--fs-secondary);
    height: 28px;
    padding: 0 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .hairline:hover:not(:disabled) {
    border-color: var(--border-2);
    color: var(--text-1);
  }
  .hairline:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .hairline.danger:hover {
    border-color: var(--warning);
    color: var(--warning);
  }
  .icon {
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-1);
    background: var(--ground-4);
    color: var(--text-3);
    cursor: pointer;
    padding: 0;
  }
  .icon:hover:not(:disabled) {
    border-color: var(--border-2);
    color: var(--text-1);
  }
  .icon:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .icon svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
