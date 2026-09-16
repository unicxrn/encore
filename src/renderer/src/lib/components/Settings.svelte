<script lang="ts">
  import { onMount } from 'svelte'
  import { settings, patchSettings } from '../stores/settings'
  import { openTour } from '../stores/tour'
  import { assetJobs } from '../stores/assets'
  import {
    appUpdate,
    checkAppUpdate,
    downloadAppUpdate,
    installAppUpdate,
    refreshAppUpdate
  } from '../stores/app-update'
  import { openOfferedWhatsNew, openWhatsNew } from '../stores/whats-new'
  import { encore } from '../stores/bridge'
  import { formatBytes } from '../../../../shared/format'
  import { APP_VERSION } from '../../../../shared/constants'
  import { resolveChartFolderName } from '../../../../shared/naming'
  import { describeScoreFolder, type ScoreFolderReport } from '../../../../shared/score-folder'
  import { describeGameExecutable, type GameExecutableReport } from '../../../../shared/game-launch'

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

  // ── Clone Hero's score folder ──────────────────────────────────────────────
  /**
   * Where Encore reads Clone Hero's score files, and the user's own answer when the search is
   * wrong.
   *
   * Only the Linux location has ever been seen; Windows and macOS follow Unity's convention and
   * nobody has confirmed them, and a portable install or a game on a second drive is in neither
   * place. So the search is shown rather than assumed correct: a user can see where Encore is
   * looking before deciding whether to point it somewhere else.
   *
   * A chosen folder is checked before it is stored, and a folder with no score files in it is
   * refused with what was looked for and what was there. Storing it and saying nothing is the
   * failure this whole setting exists to prevent, and it would look exactly like the bug it is
   * meant to fix.
   */
  let scoreFolder = $state<ScoreFolderReport | null>(null)
  let scoreFolderError = $state<string | null>(null)

  // Asks about the folder in use, whether that is the user's or the search's. Main answers from
  // the watcher, so this is where Encore is reading, not where it would read if restarted.
  async function loadScoreFolder(): Promise<void> {
    scoreFolder = await encore().scoreFolderReport('')
  }

  const chooseScoreFolder = async (): Promise<void> => {
    const path = await encore().pickFolder()
    if (!path) return
    const report = await encore().scoreFolderReport(path)
    if (!report.usable) {
      // Refused, not stored. The message names the four files and what the folder held instead.
      scoreFolderError = describeScoreFolder(report)
      return
    }
    scoreFolderError = null
    await patchSettings({ scoreFolder: path })
    await loadScoreFolder()
  }

  const clearScoreFolder = async (): Promise<void> => {
    scoreFolderError = null
    await patchSettings({ scoreFolder: '' })
    await loadScoreFolder()
  }

  // ── Clone Hero itself ──────────────────────────────────────────────────────
  /**
   * The program the Launch button in the title bar starts.
   *
   * There is no probe behind this one, which is what makes it different from every other path in
   * this view. Encore knows where the songs are because the user named a folder it scans, and it
   * knows where the score files are because the game writes them to a fixed place per platform.
   * The executable is wherever its owner installed it: Steam, an extracted zip, an AppImage in a
   * downloads folder. So the only honest starting state is empty, and the only way out of it is
   * for the user to say.
   *
   * A chosen path is checked before it is stored, on the same terms the score folder is and for
   * the same reason: an AppImage with no execute bit, or a folder picked instead of the program
   * inside it, would be stored happily and then turn Launch into a button that never works.
   */
  let gameExe = $state<GameExecutableReport | null>(null)
  let gameExeError = $state<string | null>(null)

  // Asks about whatever is stored, so the row describes where Encore would actually look rather
  // than what was true when the path was chosen.
  async function loadGameExe(): Promise<void> {
    gameExe = await encore().gameExecutable('')
  }

  const chooseGameExe = async (): Promise<void> => {
    const path = await encore().pickExecutable()
    if (!path) return
    const report = await encore().gameExecutable(path)
    if (!report.usable) {
      // Refused, not stored. The message says what was wrong with the path that was picked.
      gameExeError = describeGameExecutable(report)
      return
    }
    gameExeError = null
    await patchSettings({ gamePath: path })
    await loadGameExe()
  }

  const clearGameExe = async (): Promise<void> => {
    gameExeError = null
    await patchSettings({ gamePath: '' })
    await loadGameExe()
  }

  // ── the folder a download lands in ─────────────────────────────────────────
  /**
   * The template as it is being typed, which feeds the example line and nothing else.
   *
   * The stored value is still written on `change`, exactly as it was before the example existed.
   * Moving the write to `input` would put a row on disk on every keystroke and would store the
   * half-typed template of anyone who walked away mid-edit. Null means nothing has been typed
   * this visit, so the example reads what is stored.
   */
  let templateDraft = $state<string | null>(null)

  const folderNameExample = $derived(
    resolveChartFolderName(templateDraft ?? $settings.chartFolderName, {
      artist: 'Rush',
      name: 'YYZ',
      charter: 'Harmonix'
    })
  )

  // The queue appends `.sng` itself when that is the download format (downloads/download.ts), so
  // an example that stopped at the folder name would name something the user will not find.
  const downloadExample = $derived(
    $settings.downloadFormat === 'sng' ? `${folderNameExample}.sng` : folderNameExample
  )

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

  // ── Encore's own updates ───────────────────────────────────────────────────
  /**
   * The row that says whether a newer Encore exists, and the controls that act on it.
   *
   * `status` is main's, not this component's. The check runs once at startup, from main, and its
   * answer survives navigating away and back, so mounting reads it rather than starting a second
   * one. A check the user asks for is the only thing here that touches the network.
   */
  const status = $derived($appUpdate)
  const updateState = $derived($appUpdate?.state ?? { kind: 'idle' as const })
  const updateBusy = $derived(updateState.kind === 'checking' || updateState.kind === 'downloading')

  /**
   * The mono line beside the row name, in the same register as the sidecars' NOT INSTALLED.
   *
   * Every state has a line, including the one before main has answered, which draws the same
   * placeholder the two sidecar rows use. That state is neither up to date nor out of date, and
   * a view opened in the first moment of a session is genuinely in it.
   */
  const updateStatusLine = $derived.by(() => {
    if (status === null) return '—'
    const running = status.currentVersion === '' ? '' : `${status.currentVersion} · `
    switch (updateState.kind) {
      case 'checking':
        return 'CHECKING…'
      case 'current':
        return `${status.currentVersion} · UP TO DATE`
      case 'available':
        return `${updateState.version} AVAILABLE`
      case 'downloading':
        return updateState.percent !== null ? `${updateState.percent}%` : 'DOWNLOADING…'
      case 'ready':
        return `${updateState.version} READY`
      case 'error':
        return `${running}CHECK FAILED`
      default:
        return status.currentVersion
    }
  })

  const updateError = $derived(updateState.kind === 'error' ? updateState.message : null)

  // ── undo history ───────────────────────────────────────────────────────────
  /**
   * How much disk the undo store is using, and the one control that reclaims it.
   *
   * Every issue fix copies aside what it replaces so it can be undone, and those copies are kept
   * until the user says otherwise, with no expiry, no rotation and no "last N". That is only an
   * honest default if the cost is visible and the user can act on it, which is what this group
   * is. The measured worst case on a real library is about half a gigabyte to make every
   * repairable chart reversible, so the usual answer to seeing this number will be to leave it
   * alone.
   *
   * Undoing a specific repair lives in the Issues tab, beside the repairs. This is the
   * housekeeping half: what it costs, and how to stop paying it. Last of the four groups for
   * that reason, and because it holds the only action here that cannot be taken back.
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
    void loadScoreFolder()
    void loadGameExe()
    // A read of what main already concluded, not a second check, and not the only caller of it:
    // App subscribes at launch and reads once there, which is what makes the launch prompt a
    // launch prompt. Asking GitHub again on every visit to this view would spend a request to be
    // told the same thing.
    void refreshAppUpdate()
  })
</script>

<!--
  Four groups, named for what somebody came here to do rather than for the subsystem that owns
  the value: where my songs are, what happens when Encore downloads, which Encore this is, and
  what the repairs are costing me on disk.

  What that moved. The two sidecar rows used to sit beside Encore's own update row, on the
  grounds that yt-dlp, ffmpeg and Encore are the three things this app fetches and installs. That
  is true of the code and not of the question: nobody arrives wanting "the things that install
  themselves". yt-dlp fetches video backgrounds and ffmpeg converts them, so both are part of
  downloading, and the Encore group is left holding one subject instead of two.
-->
<div class="settings selectable">
  <header class="page">
    <h1>Settings</h1>
    <p class="lede">
      Where Encore looks for your songs, what it does when it downloads, and what it is keeping on
      disk so repairs can be undone.
    </p>
  </header>

  <!-- Every group is labelled by its own visible heading. A <section> with no
       accessible name is not a landmark, so without these the page is one flat
       list of controls. -->
  <section class="group" aria-labelledby="settings-library">
    <div class="group-head">
      <h2 id="settings-library">Library</h2>
      <p class="group-note prose">
        Encore scans these folders, downloads into the one you pick, and refuses to write to any
        chart outside them. Everything the catalog holds is scoped to them, so this is the
        highest-consequence setting in the app.
      </p>
    </div>

    <div class="block">
      <h3 class="block-head">Song folders</h3>
      {#if $settings.libraryFolders.length === 0}
        <p class="hint prose">Add your Clone Hero Songs folder. Downloads and scans need one.</p>
      {:else}
        <p class="hint prose">The selected folder is the one downloads land in.</p>
      {/if}
      <!-- The radios already share a `name`, which makes them one group to the
           browser but leaves the group itself unnamed to a screen reader, which
           would announce "radio button, 1 of 3" with no idea what is being
           chosen. -->
      <div
        class="folders"
        class:empty={$settings.libraryFolders.length === 0}
        role="radiogroup"
        aria-label="Default download folder"
      >
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
      <div class="block-actions">
        <button class="btn-primary" onclick={() => void addFolder()}>Add folder</button>
        <p class="hint prose">
          Removing a folder leaves the files where they are. Encore stops scanning it, and a write
          to a chart inside it is refused from then on.
        </p>
      </div>
    </div>

    <div class="block">
      <h3 class="block-head">Clone Hero scores</h3>
      <p class="hint prose">
        Encore reads Clone Hero's own score files to show what you played before Encore was
        installed. It reads them and nothing else: nothing is ever written into this folder.
      </p>
      <p class="score-folder">{scoreFolder ? describeScoreFolder(scoreFolder) : '—'}</p>
      {#if $settings.scoreFolder}
        <p class="hint prose">
          You chose this folder. Clearing it puts Encore back on its own search, which is right on
          Linux and a good guess everywhere else.
        </p>
      {:else}
        <p class="hint prose">
          This is where Encore looked. Only the Linux location has been confirmed against a real
          install, so if your scores are somewhere else, say where.
        </p>
      {/if}
      {#if scoreFolderError}
        <!-- The refusal. Nothing was stored, and this says what was looked for and what was in
             the folder instead. -->
        <p class="tool-error" role="alert">{scoreFolderError}</p>
      {/if}
      <div class="score-actions">
        <button class="btn-primary" onclick={() => void chooseScoreFolder()}>
          Choose score folder
        </button>
        {#if $settings.scoreFolder}
          <button class="hairline sentence" onclick={() => void clearScoreFolder()}>
            Use Encore's search
          </button>
        {/if}
      </div>
    </div>

    <div class="block">
      <h3 class="block-head">Clone Hero itself</h3>
      <p class="hint prose">
        Point Encore at the program you start Clone Hero with, and Launch Clone Hero in the title
        bar starts it. Encore does not look for this one: the game is installed wherever you put it,
        so there is nothing to search and a wrong guess would be worse than asking.
      </p>
      <p class="score-folder">{gameExe ? describeGameExecutable(gameExe) : '—'}</p>
      {#if gameExe?.supported}
        <p class="hint prose">
          {#if $settings.gamePath}
            Encore starts it and lets go of it: closing Encore does not close the game.
          {:else}
            On Linux that is the AppImage or the <span class="mono">Clone Hero</span> file in the
            folder you extracted, and on Windows it is
            <span class="mono">Clone Hero.exe</span>.
          {/if}
        </p>
      {/if}
      {#if gameExeError}
        <!-- The refusal. Nothing was stored, and this says what was wrong with the path. -->
        <p class="tool-error" role="alert">{gameExeError}</p>
      {/if}
      {#if gameExe?.supported}
        <div class="score-actions">
          <button class="btn-primary" onclick={() => void chooseGameExe()}>
            Choose Clone Hero
          </button>
          {#if $settings.gamePath}
            <button class="hairline sentence" onclick={() => void clearGameExe()}>Forget it</button>
          {/if}
        </div>
      {/if}
    </div>
  </section>

  <section class="group" aria-labelledby="settings-downloads">
    <div class="group-head">
      <h2 id="settings-downloads">Downloads</h2>
      <p class="group-note prose">
        How much of your connection a queue takes, what a download is called when it lands, and the
        two tools a video background needs.
      </p>
    </div>

    <div class="block">
      <div class="row">
        <div class="row-text">
          <label class="row-label" for="download-concurrency">Parallel downloads</label>
          <p class="hint">Applies after a restart</p>
        </div>
        <input
          id="download-concurrency"
          class="count"
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
      </div>

      <div class="row">
        <div class="row-text">
          <label class="row-label" for="chart-folder-name">Folder name template</label>
          <p class="hint">
            {'{artist}'}, {'{name}'} and {'{charter}'} are filled in. Everything else is kept as typed,
            less the characters a filename cannot hold.
          </p>
        </div>
        <input
          id="chart-folder-name"
          type="text"
          class="wide"
          value={$settings.chartFolderName}
          oninput={(e) => (templateDraft = e.currentTarget.value)}
          onchange={(e) => {
            templateDraft = e.currentTarget.value
            void patchSettings({ chartFolderName: e.currentTarget.value })
          }}
        />
      </div>
      <!-- The template is the most opaque control in this view: it is written in a syntax, and
           what it produces is a name on disk nobody sees until a download has finished. This is
           that name, on the settings the queue would actually run with. -->
      <p class="example">
        A download of Rush's YYZ lands in <span class="mono">{downloadExample}</span>
      </p>
    </div>

    <div class="block">
      <h3 class="block-head">Video tools</h3>
      <!-- The two rows are identical in structure and their buttons read
           "Install"/"Update" on both, so the tool's name is the only thing that
           tells them apart; it labels the row and the buttons borrow it. -->
      <!-- Three states, not two. A binary that is on disk but did not answer the version probe (it
           exited non-zero, printed nothing, or ran past the probe's timeout and was killed) used to
           fall through to NOT INSTALLED, which is the one thing it certainly is not, and which
           sits next to an Update button that only appears because it IS installed. -->
      <div class="tool-row" role="group" aria-labelledby="tool-ytdlp">
        <span class="tool-name" id="tool-ytdlp">yt-dlp</span>
        <span class="tool-status mono">
          {#if ytdlpRunning}
            {ytdlpPercent !== null ? `${ytdlpPercent}%` : 'INSTALLING…'}
          {:else if ytdlpStatus === null}
            —
          {:else if ytdlpStatus.installed && ytdlpStatus.version}
            {ytdlpStatus.version}
          {:else if ytdlpStatus.installed}
            VERSION UNKNOWN
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
            <button
              class="hairline"
              aria-label="Install yt-dlp"
              onclick={() => void installYtdlp()}
            >
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
          {:else if ffmpegStatus.installed}
            VERSION UNKNOWN
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
            <button
              class="hairline"
              aria-label="Install ffmpeg"
              onclick={() => void installFfmpeg()}
            >
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
      <p class="hint prose">
        yt-dlp downloads video backgrounds. ffmpeg converts the ones Clone Hero cannot play on Linux
        to WebM. Encore checks its own copies against a pinned checksum before using them.
      </p>
    </div>
  </section>

  <section class="group" aria-labelledby="settings-encore">
    <div class="group-head">
      <h2 id="settings-encore">Encore</h2>
      <p class="group-note prose">
        The version that is running, where a newer one comes from, and the way back to what changed.
      </p>
    </div>

    <div class="block">
      <!-- Name, mono status, one button, the same shape the two tool rows use. What differs is
           that on some installs there is no button, and the sentence below says why rather than
           leaving a dead control on screen. -->
      <div class="tool-row" role="group" aria-labelledby="tool-encore">
        <span class="tool-name" id="tool-encore">Encore</span>
        <span class="tool-status mono">{updateStatusLine}</span>
        {#if status !== null && status.canApply}
          {#if updateState.kind === 'available'}
            <!-- Before Download, and in that order on purpose: reading what is in a release is the
                 step that comes first, and a user who has to press Download to find out what they
                 are getting has not been given a choice. -->
            <button
              class="hairline"
              aria-label="What is new in Encore {updateState.version}"
              onclick={() => openOfferedWhatsNew(updateState.version)}
            >
              What's new
            </button>
            <button
              class="hairline"
              aria-label="Download Encore {updateState.version}"
              onclick={() => void downloadAppUpdate()}
            >
              Download
            </button>
          {:else if updateState.kind === 'ready'}
            <!-- The label names what pressing it does. Nothing has changed on disk that the user
                 can see yet, and "Install" would imply it happens where they are standing. -->
            <button
              class="hairline"
              aria-label="Restart Encore to finish the update"
              onclick={() => void installAppUpdate()}
            >
              Restart
            </button>
          {:else if updateBusy}
            <!-- In-flight guard, matching the tool rows: pressing again during a check would
                 join the same request, and during a download would be refused, so the button says
                 where it is instead of pretending to be pressable. The label names which of the two
                 is running, because the visible text is a percent or an ellipsis either way. -->
            <button
              class="hairline"
              disabled
              aria-label={updateState.kind === 'downloading'
                ? `Downloading Encore ${updateState.version}`
                : 'Checking for an Encore update'}
            >
              {updateState.kind === 'downloading' && updateState.percent !== null
                ? `${updateState.percent}%`
                : '…'}
            </button>
          {:else}
            <button
              class="hairline"
              aria-label="Check for an Encore update"
              onclick={() => void checkAppUpdate()}
            >
              Check
            </button>
          {/if}
        {/if}
      </div>

      <!-- Same treatment as a failed sidecar install: the one report of it, and it interrupts. -->
      {#if updateError}
        <p class="tool-error mono" role="alert">ERROR: {updateError}</p>
      {/if}

      <!-- Always shown, on every target. On Windows and the AppImage it sets the expectation that
           a restart is involved; on the deb it warns about the password prompt before the button is
           pressed; on a snap it is the whole answer, and the reason there is no button above. -->
      {#if status !== null}
        <p class="hint prose">{status.note}</p>
      {/if}
      {#if updateState.kind === 'ready'}
        <p class="hint prose">
          The update is downloaded. Encore stays on this version until you restart it.
        </p>
      {/if}
    </div>

    <!-- The two things that showed themselves once and then went away. Both are doors back to
         something already in this build: the changelog is bundled with it, so it describes the
         version named on the button and needs no network, and the tour is the same walkthrough
         first run offered. Neither is a setting, which is why they sit under the group's rule
         rather than in the row above it. -->
    <div class="block doors">
      <button class="hairline sentence" onclick={() => openWhatsNew()}>
        What's new in Encore {APP_VERSION}
      </button>
      <button class="hairline sentence" onclick={openTour}>Show the welcome tour again</button>
    </div>
  </section>

  <section class="group" aria-labelledby="settings-undo">
    <div class="group-head">
      <h2 id="settings-undo">Undo history</h2>
      <p class="group-note prose">
        What the repairs are costing you on disk, and the one control that reclaims it.
      </p>
    </div>

    <div class="block">
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
          <button
            class="hairline destructive"
            disabled={clearing}
            onclick={() => void clearBackups()}
          >
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
      <p class="hint prose">
        When Encore fixes an issue it keeps whatever it replaced (the original video, cover,
        song.ini line or deleted file) so the fix can be undone from the Issues tab. Nothing here
        expires. Clearing is the only thing that removes it, and after that those fixes are
        permanent.
      </p>
    </div>
  </section>
</div>

<style>
  /* One column, centred, and capped at a measure rather than stretched to the view.
     The view column is 509px at its narrowest (a 1121px window, where the rail has just
     appeared) and over 1300px on a wide one; a settings row 1300px across puts its label and its
     control at opposite ends of the screen. Centring also stops the four cards from reading as a
     left-hand list when the window is wide. */
  .settings {
    padding: 22px 24px 36px;
    max-width: 768px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .page {
    margin-bottom: 2px;
  }
  h1 {
    font-size: var(--fs-heading);
    font-weight: 700;
    letter-spacing: var(--ls-tight);
    line-height: var(--lh-display);
  }
  .lede {
    margin-top: 6px;
    max-width: 62ch;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  /* Each group is a card: surface-1 on the window's ground, at the elevation the token file
     names for a card. */
  .group {
    background: var(--surface-1);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    box-shadow: var(--elev-2);
    padding: 16px 18px 18px;
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
  }
  /* The head is the card's own rule: the heading plus one sentence saying what the group is for,
     then a hairline. Without the sentence a settings card is a heading over controls, and the
     controls are the part a first-time reader is least able to interpret. */
  .group-head {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-1);
  }
  .group-note {
    margin-top: 6px;
    font-size: var(--fs-secondary);
    line-height: var(--lh-prose);
    color: var(--text-2);
  }
  /* A group's internal divisions. Two blocks in one card are two subjects that belong to one
     question (song folders and score folders are both "where Encore looks"), separated by the
     same hairline the head uses rather than by a second card. */
  .block {
    padding-top: 14px;
  }
  .block + .block {
    margin-top: 14px;
    border-top: 1px solid var(--border-1);
  }
  .block-head {
    font-size: var(--fs-secondary);
    font-weight: 600;
    color: var(--text-1);
    margin-bottom: 6px;
  }
  /* The folder list is a well: it is the one place in this view holding user content rather than
     controls, and --ground-0 is the token scale's recessed step, for exactly that. */
  .folders {
    margin-top: 10px;
    background: var(--ground-0);
    border: 1px solid var(--border-1);
    border-radius: var(--radius-sm);
  }
  /* No folders yet, so no well: an empty box under the hint would read as a list that failed to
     load rather than as one nothing has been added to. */
  .folders.empty {
    display: none;
  }
  .folder {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 11px;
  }
  .folder + .folder {
    border-top: 1px solid var(--border-1);
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
  /* Wraps rather than ellipsises, which is the change worth arguing for: a library path is the
     longest string in this view and it is also the content of the row. An ellipsised path in a
     list of three that differ only in their last segment tells the user nothing, and there are
     never more than a handful of these rows, so the height a wrap costs is affordable here in a
     way it is not in a thousand-row list. */
  .path {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    line-height: var(--lh-snug);
    color: var(--text-2);
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* Ghost, because destructive actions never take the accent, and red only on hover: the row is
     read far more often than it is acted on, and a list of three permanently red buttons reads
     as three warnings. */
  .rm {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
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
    color: var(--danger);
    border-color: var(--danger);
  }
  .btn-primary {
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--accent-grad);
    color: #fff;
    font-weight: 600;
    font-size: var(--fs-secondary);
    font-family: var(--font-ui);
    padding: 6px 14px;
    cursor: pointer;
    flex-shrink: 0;
    transition: filter var(--t-fast) var(--ease);
  }
  .btn-primary:hover {
    filter: brightness(1.12);
  }
  /* The action and the consequence on one line while there is room for both, and stacked when
     there is not. The sentence is beside the button rather than under the list because it is
     about Remove, which is the control a user is least likely to have thought through. */
  .block-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .block-actions .hint {
    flex: 1 1 260px;
    min-width: 0;
  }
  /* A control row: its name and its explanation on the left, the control itself on the right,
     and the control dropping to its own line when the pair no longer fits. */
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .row + .row {
    margin-top: 14px;
  }
  .row-text {
    flex: 1 1 200px;
    min-width: 0;
  }
  .row-label {
    display: block;
    font-size: var(--fs-secondary);
    color: var(--text-1);
  }
  .row-text .hint {
    margin-top: 3px;
  }
  /* Inputs sit one surface up from their card, with the shared focus
     border-brightening. */
  .row input {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    padding: 6px 9px;
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    transition: border-color var(--t-fast) var(--ease);
  }
  .row input:focus {
    border-color: var(--border-2);
  }
  .row input.count {
    flex: 0 0 auto;
    margin-left: auto;
    width: 56px;
  }
  /* Grows into whatever the row has left, and takes a line of its own once that is under 260px.
     The stored templates are long: the default alone is 38 characters. */
  .row input.wide {
    flex: 1 1 260px;
    min-width: 0;
  }
  .example {
    margin-top: 10px;
    font-size: var(--fs-caption);
    line-height: var(--lh-prose);
    color: var(--text-3);
  }
  .example .mono {
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .hint {
    font-size: var(--fs-caption);
    color: var(--text-3);
  }
  /* A sentence rather than a label, so it wraps as prose instead of running under the card. */
  .prose {
    max-width: 68ch;
    line-height: var(--lh-prose);
  }
  /* The path and the file names are the content of this line, so it is mono like every other
     path in Settings, and it breaks anywhere: these paths are long and nested. */
  .score-folder {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    color: var(--text-2);
    line-height: var(--lh-prose);
    margin: 10px 0;
    overflow-wrap: anywhere;
  }
  .score-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .tool-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
  }
  .tool-row + .tool-row {
    border-top: 1px solid var(--border-1);
  }
  .tool-name {
    font-size: var(--fs-secondary);
    color: var(--text-1);
    width: 72px;
    flex-shrink: 0;
  }
  .tool-status {
    font-family: var(--font-mono);
    font-size: var(--fs-secondary);
    color: var(--text-2);
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
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
  .tool-row + .hint,
  .tool-error + .hint {
    margin-top: 10px;
  }
  .hairline {
    background: var(--surface-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: var(--fs-secondary);
    padding: 4px 11px;
    cursor: pointer;
    font-family: var(--font-mono);
    flex-shrink: 0;
    transition:
      color var(--t-fast) var(--ease),
      border-color var(--t-fast) var(--ease);
  }
  /* The other hairline buttons here are one mono word beside a mono status. These are
     sentences, and read as ones in the UI face, the same as the tour's own Back. */
  .hairline.sentence {
    font-family: var(--font-ui);
  }
  /* Same rule as Remove: the colour arrives on hover, once the pointer is on the control that
     makes a completed repair permanent, rather than sitting on the card as a standing warning
     about a store most people will never clear. It stays on the armed second press too, which is
     the one that actually deletes. */
  .hairline.destructive:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }
  .hairline:hover:not(:disabled) {
    color: var(--text-1);
    border-color: var(--border-2);
  }
  .hairline:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Two ways back into something this build already carries, side by side while they fit and
     stacked when they do not. */
  .doors {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
</style>
