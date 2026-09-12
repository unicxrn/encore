<script lang="ts">
  /**
   * The changelog, on screen.
   *
   * One component for the three ways it is reached, because they are the same question asked at
   * different moments: "Show what's new" in Settings, the first launch after an update, and the
   * "What's new" button beside an update the check has found. The only thing that differs is which
   * version it leads with, and whether that version is one this build has an entry for.
   *
   * A modal on the welcome tour's pattern rather than a view of its own, for the same reason: the
   * launch case has to appear over whatever the app opened on, and the Settings case over Settings.
   * Escape is NOT handled here either. App owns the dismiss order, and a second listener would
   * race it; `onclose` is what the backdrop, the close button and Done all call.
   *
   * The changelog is bundled, not fetched. See lib/changelog.ts for why, and for the one import
   * that does it.
   */
  import { CHANGELOG } from '../changelog'
  import {
    releasedOnly,
    releaseFor,
    type ChangelogItem,
    type ChangelogRelease
  } from '../../../../shared/changelog'
  import { APP_VERSION } from '../../../../shared/constants'
  import { takeFocus, wrapTab } from '../focus-trap'
  import Icon from './Icon.svelte'

  let { version, offered, onclose }: { version: string; offered: boolean; onclose: () => void } =
    $props()

  /** The entry for the version this was opened on, or null when the build carries none. */
  const focused = $derived<ChangelogRelease | null>(releaseFor(CHANGELOG, version))

  /**
   * The one line at the top that says why this is on screen, or null when the list speaks for
   * itself.
   *
   * The case that needs it is an update the check has found. A build ships the changelog it was
   * built from, so it has no entry for a release published after it, and no amount of parsing
   * changes that. Saying so, and pointing at the page that does have the notes, is the honest
   * answer; drawing an empty section under the new version's number would not be.
   */
  const lead = $derived.by(() => {
    if (offered && focused === null) {
      return `Encore ${version} is available. This build carries the notes for ${APP_VERSION} and the releases before it, so what changed in ${version} is on its release page.`
    }
    if (!offered && focused === null) {
      return `This build carries no changelog entry for ${version}.`
    }
    return null
  })

  /** Only for a version nothing here can describe, which is the only case a link helps. */
  const releasePage = $derived(
    focused === null ? `https://github.com/unicxrn/encore/releases/tag/v${version}` : null
  )

  let card = $state<HTMLElement | null>(null)

  /** Focus in on open, back to the opener on close. Same as the tour and the shortcut sheet. */
  $effect(() => {
    const el = card
    if (!el) return undefined
    return takeFocus(el)
  })

  function onKeydown(event: KeyboardEvent): void {
    if (!card) return
    wrapTab(event, card)
  }
</script>

{#snippet spans(item: ChangelogItem)}{#each item as span, i (i)}{#if span.code}<code
        >{span.text}</code
      >{:else}{span.text}{/if}{/each}{/snippet}

<div class="whats-new">
  <!-- Click-outside-to-dismiss, and nothing else; see the shortcut sheet for why it is a button
       and why it is hidden from the keyboard and assistive tech. -->
  <button class="backdrop" tabindex="-1" aria-hidden="true" onclick={onclose}></button>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="whats-new-title"
    tabindex="-1"
    bind:this={card}
    onkeydown={onKeydown}
  >
    <div class="head">
      <h2 class="title" id="whats-new-title">What's new</h2>
      <button class="icon-btn" aria-label="Close what's new" onclick={onclose}>
        <Icon name="x" size={14} />
      </button>
    </div>

    <div class="scroll selectable">
      {#if lead}
        <p class="lead">{lead}</p>
        {#if releasePage}
          <!-- target="_blank" is how every external link leaves this app: main's
               setWindowOpenHandler denies the new window and hands the URL to the system browser,
               so nothing remote is ever loaded inside Encore. -->
          <p class="lead">
            <a href={releasePage} target="_blank" rel="noreferrer">
              Read the notes for {version} on GitHub
            </a>
          </p>
        {/if}
      {/if}

      <!-- `releasedOnly`, because between releases CHANGELOG.md leads with an `## [Unreleased]`
           heading. A build from such a checkout would otherwise draw it as a release nobody can
           install, dated nothing. -->
      {#each releasedOnly(CHANGELOG) as release (release.version)}
        <section class="release" aria-labelledby="whats-new-{release.version}">
          <div class="release-head">
            <h3 class="version" id="whats-new-{release.version}">Encore {release.version}</h3>
            {#if release.version === APP_VERSION}
              <!-- Which of these the user is actually running. Worth saying on a list that can
                   hold several, and the only thing on screen that says it. -->
              <span class="chip mono">INSTALLED</span>
            {/if}
            {#if release.date}
              <span class="date mono">{release.date}</span>
            {/if}
          </div>
          {#each release.sections as section, i (i)}
            {#if section.title === null}
              {#each section.items as item, j (j)}
                <p class="prose">{@render spans(item)}</p>
              {/each}
            {:else}
              <h4 class="section mono">{section.title}</h4>
              <ul>
                {#each section.items as item, j (j)}
                  <li>{@render spans(item)}</li>
                {/each}
              </ul>
            {/if}
          {/each}
        </section>
      {/each}
    </div>

    <div class="foot">
      <button class="btn-primary" onclick={onclose}>Done</button>
    </div>
  </div>
</div>

<style>
  /* Same overlay geometry as the welcome tour, and the same layer: the two never draw together
     (App renders this only when the tour is closed), and both sit under the shortcut sheet so ?
     still works over either. */
  .whats-new {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    border: 0;
    padding: 0;
    cursor: default;
  }
  /* Wider than the tour's 560 because this one carries running prose in a list, and taller
     because the whole point is reading rather than stepping. The scroll is on the middle
     section, so the heading and Done stay put. */
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(640px, 100%);
    max-height: 100%;
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  }
  .card:focus-visible {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px 12px 20px;
    border-bottom: 1px solid var(--hairline);
  }
  .title {
    font-size: var(--fs-heading);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
    line-height: var(--lh-display);
    color: var(--text-1);
  }
  .head .icon-btn {
    margin-left: auto;
  }
  .scroll {
    overflow-y: auto;
    padding: 16px 20px 18px;
  }
  .lead {
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
    margin-bottom: 12px;
  }
  .lead a {
    color: var(--accent-text);
  }
  .release + .release {
    margin-top: 20px;
    padding-top: 18px;
    border-top: 1px solid var(--hairline);
  }
  .release-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 10px;
  }
  .version {
    font-size: var(--fs-emphasis);
    font-weight: 600;
    letter-spacing: var(--ls-tight);
    line-height: var(--lh-tight);
    color: var(--text-1);
  }
  .chip {
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-flat);
    color: var(--accent-text);
    background: var(--accent-dim);
    border-radius: 4px;
    padding: 3px 6px;
  }
  .date {
    margin-left: auto;
    letter-spacing: var(--ls-caps);
    line-height: var(--lh-flat);
    color: var(--text-3);
  }
  /* Same mono micro-caps as the section heads in Settings. */
  .section {
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    line-height: var(--lh-tight);
    color: var(--text-3);
    margin: 12px 0 7px;
  }
  .prose {
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  ul {
    list-style: none;
  }
  li {
    position: relative;
    padding-left: 16px;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  li + li {
    margin-top: 6px;
  }
  /* A hairline dash rather than a disc: the same mark the rest of the app uses for a list that is
     prose rather than data, and it does not pull the eye off the first word. */
  li::before {
    content: '';
    position: absolute;
    left: 2px;
    /* Half the prose line box (13 x 1.6), so the dash sits on the first line's centre. */
    top: calc(var(--fs-secondary) * 1.6 / 2);
    width: 7px;
    height: 1px;
    background: var(--text-3);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
  }
  code {
    font-family: var(--font-mono);
    /* One step down: JetBrains Mono at the same nominal size reads larger than Archivo beside it,
       and the inline runs here are file names sitting inside a sentence. */
    font-size: var(--fs-caption);
    color: var(--text-1);
    background: var(--surface-2);
    border-radius: 4px;
    padding: 1px 4px;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    padding: 12px 20px 14px;
    border-top: 1px solid var(--hairline);
  }
  .btn-primary {
    border: 0;
    border-radius: 6px;
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    padding: 6px 14px;
    cursor: pointer;
    transition: filter var(--t-fast) var(--ease);
  }
  .btn-primary:hover {
    filter: brightness(1.12);
  }
</style>
