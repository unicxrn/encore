<script lang="ts">
  import { onMount } from 'svelte'
  import { settings, patchSettings } from '../stores/settings'
  import { openTour } from '../stores/tour'
  import { assetJobs } from '../stores/assets'
  import { encore } from '../stores/bridge'
  import { formatBytes } from '../../../../shared/format'

  interface SidecarStatus {
    installed: boolean
    version: string | null
    path: string
  }

  // ── folder management ──────────────────────────────────────────────────────
  const addFolder = async (): Promise<void> => {
    const path = await encore().pickFolder()
    if (!path) return
    const folders = [...$settings.libraryFolders]
    if (folders.some((f) => f.path === path)) return
    folders.push({ path, isDefault: folders.length === 0 })
    await patchSettings({ libraryFolders: folders })
  }

  const removeFolder = async (path: string): Promise<void> => {
    let folders = $settings.libraryFolders.filter((f) => f.path !== path)
    if (folders.length && !folders.some((f) => f.isDefault)) {
      folders = folders.map((f, i) => ({ ...f, isDefault: i === 0 }))
    }
    await patchSettings({ libraryFolders: folders })
  }

  const setDefault = async (path: string): Promise<void> => {
    await patchSettings({
      libraryFolders: $settings.libraryFolders.map((f) => ({ ...f, isDefault: f.path === path }))
    })
  }

  // ── sidecar tools ──────────────────────────────────────────────────────────
  let ytdlpStatus = $state<SidecarStatus | null>(null)
  let ffmpegStatus = $state<SidecarStatus | null>(null)

  async function loadSidecarStatus(): Promise<void> {
    const [yt, ff] = await Promise.all([
      encore().sidecarStatus('ytdlp'),
      encore().sidecarStatus('ffmpeg')
    ])
    ytdlpStatus = yt as SidecarStatus
    ffmpegStatus = ff as SidecarStatus
  }

  // Derived: is either sidecar job currently running?
  const ytdlpJob = $derived($assetJobs.get('sidecar:ytdlp'))
  const ytdlpRunning = $derived(ytdlpJob?.status === 'running')
  const ytdlpPercent = $derived(ytdlpJob?.percent ?? null)
  const ffmpegJob = $derived($assetJobs.get('sidecar:ffmpeg'))
  const ffmpegRunning = $derived(ffmpegJob?.status === 'running')
  const ffmpegPercent = $derived(ffmpegJob?.percent ?? null)

  // Refresh status display after a sidecar job completes. Only refresh when a
  // running job was observed during this mount. A stale 'done' entry left in
  // the store from a previous visit would otherwise trigger a redundant fetch.
  let sawYtdlpRunning = false
  $effect(() => {
    if (ytdlpJob?.status === 'running') {
      sawYtdlpRunning = true
    } else if (ytdlpJob?.status === 'done' && sawYtdlpRunning) {
      sawYtdlpRunning = false
      void loadSidecarStatus()
    }
  })
  let sawFfmpegRunning = false
  $effect(() => {
    if (ffmpegJob?.status === 'running') {
      sawFfmpegRunning = true
    } else if (ffmpegJob?.status === 'done' && sawFfmpegRunning) {
      sawFfmpegRunning = false
      void loadSidecarStatus()
    }
  })

  // Both errors surface here rather than in a console nobody reads: an install that fails its
  // pinned-hash check is exactly the case where silence is worst.
  let toolError = $state<string | null>(null)

  async function runSidecarJob(job: Promise<void>): Promise<void> {
    toolError = null
    try {
      await job
    } catch (err) {
      toolError = err instanceof Error ? err.message : String(err)
    }
    await loadSidecarStatus()
  }

  const installYtdlp = (): Promise<void> => runSidecarJob(encore().sidecarInstall('ytdlp'))
  const updateYtdlp = (): Promise<void> => runSidecarJob(encore().sidecarUpdate('ytdlp'))
  const installFfmpeg = (): Promise<void> => runSidecarJob(encore().sidecarInstall('ffmpeg'))
  const updateFfmpeg = (): Promise<void> => runSidecarJob(encore().sidecarUpdate('ffmpeg'))

  // ── undo history ───────────────────────────────────────────────────────────
  /**
   * How much disk the undo store is using, and the one control that reclaims it.
   *
   * Every issue fix copies aside what it replaces so it can be undone, and those copies are kept
   * until the user says otherwise, with no expiry, no rotation and no "last N". That is only an
   * honest default if the cost is visible and the user can act on it, which is what this section
   * is. The measured worst case on a real library is about half a gigabyte to make every
   * repairable chart reversible, so the usual answer to seeing this number will be to leave it
   * alone.
   *
   * Undoing a specific repair lives in the Issues tab, beside the repairs. This is the
   * housekeeping half: what it costs, and how to stop paying it.
   */
  let backupCount = $state(0)
  let backupBytes = $state(0)
  let clearArmed = $state(false)
  let clearing = $state(false)

  async function loadBackups(): Promise<void> {
    try {
      const { backups, totalBytes } = await encore().backupsList()
      backupCount = backups.length
      backupBytes = totalBytes
    } catch {
      // Left at zero, which draws the "nothing to clear" state. A failed listing must not put a
      // Clear button in front of a user over a store whose contents are unknown.
      backupCount = 0
      backupBytes = 0
    }
  }

  /**
   * Two presses, not a dialog.
   *
   * Clearing is the only thing in Encore that makes an already-completed repair permanent, and it
   * cannot itself be undone. The second press is on a button that has changed its own label to say
   * what it will do, which is the smallest confirmation that still stops a mis-click.
   */
  async function clearBackups(): Promise<void> {
    if (!clearArmed) {
      clearArmed = true
      return
    }
    clearing = true
    try {
      await encore().backupsClear()
    } finally {
      clearing = false
      clearArmed = false
      await loadBackups()
    }
  }

  onMount(() => {
    void loadSidecarStatus()
    void loadBackups()
  })
</script>

<div class="settings selectable">
  <h1>Settings</h1>

  <!-- Every group is labelled by its own visible heading. A <section> with no
       accessible name is not a landmark, so without these the page is one flat
       list of controls. -->
  <section aria-labelledby="settings-folders">
    <h2 id="settings-folders">Library folders</h2>
    <!-- The radios already share a `name`, which makes them one group to the
         browser but leaves the group itself unnamed to a screen reader, which
         would announce "radio button, 1 of 3" with no idea what is being
         chosen. -->
    <div role="radiogroup" aria-label="Default download folder">
      {#each $settings.libraryFolders as folder (folder.path)}
        <div class="folder">
          <!-- Every one of these radios carried the same `title`, so all of them
               announced "Default download folder" and none of them said which
               folder. The path is the only thing that tells them apart. -->
          <input
            type="radio"
            name="default"
            checked={folder.isDefault}
            onchange={() => void setDefault(folder.path)}
            aria-label="Download to {folder.path}"
          />
          <span class="path">{folder.path}</span>
          <!-- Same problem as the radios: N buttons all reading "Remove". -->
          <button
            class="rm"
            aria-label="Remove {folder.path}"
            onclick={() => void removeFolder(folder.path)}>Remove</button
          >
        </div>
      {/each}
    </div>
    {#if $settings.libraryFolders.length === 0}
      <p class="hint">Add your Clone Hero Songs folder. Downloads and scans need one.</p>
    {/if}
    <button class="btn-primary add" onclick={() => void addFolder()}>Add folder</button>
  </section>

  <section aria-labelledby="settings-downloads">
    <h2 id="settings-downloads">Downloads</h2>
    <label>
      Parallel downloads
      <input
        type="number"
        min="1"
        max="8"
        value={$settings.downloadConcurrency}
        onchange={(e) => {
          const v = Math.min(8, Math.max(1, Number(e.currentTarget.value) || 1))
          e.currentTarget.value = String(v)
          void patchSettings({ downloadConcurrency: v })
        }}
      />
      <span class="hint">Applies after a restart</span>
    </label>
    <label>
      Folder name template
      <input
        type="text"
        class="wide"
        value={$settings.chartFolderName}
        onchange={(e) => void patchSettings({ chartFolderName: e.currentTarget.value })}
      />
    </label>
  </section>

  <section aria-labelledby="settings-tools">
    <h2 id="settings-tools">Tools</h2>
    <!-- The two rows are identical in structure and their buttons read
         "Install"/"Update" on both, so the tool's name is the only thing that
         tells them apart; it labels the row and the buttons borrow it. -->
    <div class="tool-row" role="group" aria-labelledby="tool-ytdlp">
      <span class="tool-name" id="tool-ytdlp">yt-dlp</span>
      <span class="tool-status mono">
        {#if ytdlpRunning}
          {ytdlpPercent !== null ? `${ytdlpPercent}%` : 'INSTALLING…'}
        {:else if ytdlpStatus === null}
          —
        {:else if ytdlpStatus.installed && ytdlpStatus.version}
          {ytdlpStatus.version}
        {:else}
          NOT INSTALLED
        {/if}
      </span>
      {#if !ytdlpRunning}
        {#if ytdlpStatus?.installed}
          <button class="hairline" aria-label="Update yt-dlp" onclick={() => void updateYtdlp()}>
            Update
          </button>
        {:else}
          <button class="hairline" aria-label="Install yt-dlp" onclick={() => void installYtdlp()}>
            Install
          </button>
        {/if}
      {:else}
        <!-- In-flight guard: button hidden while job is running to prevent concurrent-install race -->
        <button class="hairline" disabled aria-label="Installing yt-dlp">
          {ytdlpPercent !== null ? `${ytdlpPercent}%` : '…'}
        </button>
      {/if}
    </div>

    <div class="tool-row" role="group" aria-labelledby="tool-ffmpeg">
      <span class="tool-name" id="tool-ffmpeg">ffmpeg</span>
      <span class="tool-status mono">
        {#if ffmpegStatus === null}
          —
        {:else if ffmpegStatus.installed && ffmpegStatus.version}
          {ffmpegStatus.version}
        {:else}
          NOT INSTALLED
        {/if}
      </span>
      <!-- The Issues tab offers this install too, beside the rows that need it, which is where
           most people will meet it. It is here as well because a user who wants their tools set
           up before anything goes wrong should not have to break something first. -->
      {#if !ffmpegRunning}
        {#if ffmpegStatus?.installed}
          <button class="hairline" aria-label="Update ffmpeg" onclick={() => void updateFfmpeg()}>
            Update
          </button>
        {:else}
          <button class="hairline" aria-label="Install ffmpeg" onclick={() => void installFfmpeg()}>
            Install
          </button>
        {/if}
      {:else}
        <!-- In-flight guard: button disabled while the job runs to prevent a concurrent-install race -->
        <button class="hairline" disabled aria-label="Installing ffmpeg">
          {ffmpegPercent !== null ? `${ffmpegPercent}%` : '…'}
        </button>
      {/if}
    </div>

    <!-- An install that fails its pinned-hash check is exactly the case where
         silence is worst, and this line is the only report of it. role="alert"
         so it interrupts rather than waiting to be found. -->
    {#if toolError}
      <p class="tool-error mono" role="alert">ERROR: {toolError}</p>
    {/if}
    <p class="hint">
      yt-dlp downloads video backgrounds. ffmpeg converts the ones Clone Hero cannot play on Linux
      to WebM. Encore checks its own copies against a pinned checksum before using them.
    </p>
  </section>

  <section>
    <h2>Undo history</h2>
    <div class="tool-row">
      <span class="tool-name">Fixes</span>
      <span class="tool-status mono">
        {#if backupCount === 0 && backupBytes === 0}
          NOTHING TO UNDO
        {:else}
          {backupCount} UNDOABLE · {formatBytes(backupBytes)}
        {/if}
      </span>
      <!-- Offered on the SIZE, not the count. A backup interrupted between its files and its
           manifest is not undoable and is not listed, and the ones most likely to be interrupted
           are the large ones, so a store can hold a gigabyte with nothing to undo, and a button
           keyed on the count would leave no way to reclaim it. -->
      {#if backupCount > 0 || backupBytes > 0}
        <button class="hairline" disabled={clearing} onclick={() => void clearBackups()}>
          {#if clearing}
            Clearing…
          {:else if clearArmed}
            Delete them permanently
          {:else}
            Clear
          {/if}
        </button>
      {/if}
    </div>
    <p class="hint">
      When Encore fixes an issue it keeps whatever it replaced (the original video, cover, song.ini
      line or deleted file) so the fix can be undone from the Issues tab. Nothing here expires.
      Clearing is the only thing that removes it, and after that those fixes are permanent.
    </p>
  </section>

  <section aria-labelledby="settings-help">
    <h2 id="settings-help">Help</h2>
    <!-- The tour shows itself once, on first run, and most people skip it. This is the way back
         for the ones who later want it. -->
    <button class="hairline sentence" onclick={openTour}>Show the welcome tour again</button>
  </section>
</div>

<style>
  .settings {
    padding: 22px 24px 30px;
    max-width: 660px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  h1 {
    font-size: var(--fs-heading);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
    margin-bottom: 2px;
  }
  /* Section header: mono uppercase micro-caps, same register as Home's rows
     and Detail's card heads. */
  h2 {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    font-weight: 500;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 10px;
  }
  /* Each settings group is a surface-1 card. */
  section {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    padding: 14px 16px 16px;
  }
  .folder {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 0;
  }
  .folder + .folder {
    border-top: 1px solid rgba(255, 255, 255, 0.035);
  }
  /* 16px, not the UA's 13: the same size as Explore's row checkbox, and the smallest control
     in the app otherwise. */
  .folder input[type='radio'] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--accent);
    flex-shrink: 0;
    cursor: pointer;
  }
  .path {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    color: var(--text-2);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Remove stays ghost: destructive actions never take the accent. */
  .rm {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-family: var(--font-ui);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    flex-shrink: 0;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  .rm:hover {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
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
  .add {
    margin-top: 12px;
  }
  label {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--fs-secondary);
    color: var(--text-2);
    margin-bottom: 10px;
  }
  /* Inputs sit one surface up from their card, with the shared focus
     border-brightening. */
  label input[type='number'],
  label input.wide {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-1);
    padding: 6px 9px;
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    transition: border-color var(--t-fast) var(--ease);
  }
  label input[type='number']:focus,
  label input.wide:focus {
    border-color: rgba(255, 255, 255, 0.2);
  }
  label input[type='number'] {
    width: 56px;
  }
  label input.wide {
    flex: 1;
    min-width: 0;
  }
  .hint {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  .tool-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
  }
  .tool-row + .tool-row {
    border-top: 1px solid rgba(255, 255, 255, 0.035);
  }
  .tool-name {
    font-size: var(--fs-secondary);
    color: var(--text-2);
    width: 72px;
    flex-shrink: 0;
  }
  .tool-status {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    color: var(--text-2);
    flex: 1;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
  }
  .tool-error {
    margin-top: 8px;
    font-size: var(--fs-caption);
    color: var(--text-2);
    line-height: var(--lh-prose);
    overflow-wrap: anywhere;
  }
  .hairline {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: 6px;
    color: var(--text-2);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    font-family: var(--font-mono);
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  /* The other hairline buttons here are one mono word beside a mono status. This one is a
     sentence, and reads as one in the UI face, the same as the tour's own Back. */
  .hairline.sentence {
    font-family: var(--font-ui);
  }
  .hairline:hover:not(:disabled) {
    color: var(--text-1);
    border-color: rgba(255, 255, 255, 0.2);
  }
  .hairline:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
