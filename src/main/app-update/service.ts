import {
  targetCapability,
  type AppUpdateState,
  type AppUpdateStatus,
  type UpdateTarget
} from '../../shared/app-update'

/**
 * The slice of electron-updater's `AppUpdater` this service uses.
 *
 * Narrow on purpose. electron-updater talks to GitHub, writes into a cache directory and, on the
 * last call, replaces the running application, so none of it can be exercised in a unit test.
 * Depending on this shape instead means every rule below is testable against a fake, and the real
 * `autoUpdater` satisfies it structurally without an adapter.
 */
export interface Updater {
  /** Set false in the constructor: a download is something the user asked for. */
  autoDownload: boolean
  /** Set false in the constructor: quitting must not silently run an installer. */
  autoInstallOnAppQuit: boolean
  checkForUpdates: () => Promise<UpdateCheck | null>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

/** What `checkForUpdates` resolves with, narrowed to the two fields that decide anything. */
export interface UpdateCheck {
  isUpdateAvailable: boolean
  updateInfo: { version: string }
}

/** The updater's own emitter, wired to this service by whoever owns the real one. */
export interface UpdaterHandlers {
  onProgress: (percent: number) => void
  onError: (err: unknown) => void
}

export interface AppUpdateDeps {
  updater: Updater
  target: UpdateTarget
  /** `app.getVersion()`. Shown as-is; nothing here parses it. */
  currentVersion: string
  /** Called on every state change, including the ones nothing awaited. */
  onState: (status: AppUpdateStatus) => void
  /**
   * Subscribes this service to the updater's events. Injected so the suite can drive them: the
   * download's promise carries its result, but progress and mid-flight errors arrive only here.
   */
  subscribe?: (handlers: UpdaterHandlers) => void
}

/** What a repository with no release published yet answers a check with. */
const NO_RELEASE = 'No release has been published yet, so there is nothing to update to.'

/**
 * What electron-updater threw, turned into something a user can act on.
 *
 * Its own messages are written for a maintainer reading a log, and the one every user will meet
 * first is the worst of them: a repository with no published release. Verbatim, it reads as a
 * fault in Encore rather than the ordinary state of a project that has not cut a release.
 *
 * The message is consulted as well as the code, because the code is not reliable for exactly that
 * case. `GitHubProvider.getLatestVersion` reads the releases atom feed and asks for its first
 * `<entry>`; on an empty feed that goes through `XElement.element`, which throws with the code
 * `ERR_XML_MISSED_ELEMENT` and only the *message* "No published versions on GitHub". The
 * dedicated `ERR_UPDATER_NO_PUBLISHED_VERSIONS` exists but belongs to a different branch of the
 * same file. Measured, not read: a real check from this app against this repository produced the
 * XML code, and a code-only match printed the raw string on screen.
 *
 * Anything unrecognised falls through to its own message rather than to a generic sentence. A
 * wrong guess about what went wrong is worse than an unpolished but accurate one.
 */
export function describeUpdateError(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? String(Reflect.get(err, 'code') ?? '') : ''
  const raw = err instanceof Error ? err.message : String(err)

  // Before the codes: both of GitHubProvider's "there is nothing there" paths say this, and only
  // one of them carries a code that says so.
  if (raw.includes('No published versions on GitHub')) return NO_RELEASE
  // `newError` sets the property, but a rejection that has crossed a boundary can arrive carrying
  // the code in its text alone.
  if (raw.includes('ERR_UPDATER_LATEST_VERSION_NOT_FOUND')) return NO_RELEASE

  switch (code) {
    case 'ERR_UPDATER_NO_PUBLISHED_VERSIONS':
    case 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND':
      return NO_RELEASE
    case 'ERR_UPDATER_NO_FILES_PROVIDED':
    case 'ERR_UPDATER_ASSET_NOT_FOUND':
      return 'The latest release has no build for this platform. The releases page has what there is.'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case 'ENETUNREACH':
      return 'Could not reach GitHub. Check your connection and try again.'
    default:
      return raw.trim() === '' ? 'The update check failed for an unknown reason.' : raw
  }
}

/**
 * Owns what Encore knows about its own next release.
 *
 * Three rules shape it.
 *
 * Nothing happens without being asked. `autoDownload` and `autoInstallOnAppQuit` are both turned
 * off, so a check reports and stops: the download is a second press and the install is a third.
 * An app that swaps its own binary out from under a user mid-session, or runs an installer
 * because they closed the window, is doing something they did not choose.
 *
 * Nothing throws at the caller. Every failure lands in the `error` state and is delivered the
 * same way a success is. The startup check has no one to catch it, and a rejected promise there
 * would be an unhandled rejection in the main process for a network blip.
 *
 * A target that cannot apply an update never reaches the network. `check()` on a snap returns the
 * capability's sentence without a request, because electron-updater would disable itself and
 * resolve with null anyway, and "nothing happened" is not something a UI can render honestly.
 */
export class AppUpdateService {
  private state: AppUpdateState = { kind: 'idle' }
  private checking: Promise<AppUpdateStatus> | null = null

  constructor(private deps: AppUpdateDeps) {
    deps.updater.autoDownload = false
    deps.updater.autoInstallOnAppQuit = false
    deps.subscribe?.({
      onProgress: (percent) => this.reportProgress(percent),
      onError: (err) => this.reportError(err)
    })
  }

  /** The current answer, with no side effects. What the Settings panel reads on mount. */
  status(): AppUpdateStatus {
    const { canApply, note } = targetCapability(this.deps.target)
    return {
      currentVersion: this.deps.currentVersion,
      target: this.deps.target,
      canApply,
      note,
      state: this.state
    }
  }

  /**
   * Ask GitHub whether a newer release exists.
   *
   * Concurrent calls share one request rather than queueing a second: the startup check and a
   * user pressing the button a moment later are the same question, and electron-updater's own
   * `checkForUpdates` already collapses them, so racing it here would only produce two state
   * sequences for one network round trip.
   */
  check(): Promise<AppUpdateStatus> {
    if (!targetCapability(this.deps.target).canApply) {
      // Deliberately leaves the state alone rather than setting an error. There is nothing wrong
      // here; the capability sentence beside the row is the whole answer.
      return Promise.resolve(this.status())
    }
    if (this.checking !== null) return this.checking

    this.set({ kind: 'checking' })
    const run = this.deps.updater
      .checkForUpdates()
      .then((result) => {
        if (result === null) {
          // isUpdaterActive() said no after we decided the target could apply an update. The two
          // disagreeing is a bug in the probe, not something the user did, so it says so plainly
          // rather than claiming the app is up to date.
          this.set({
            kind: 'error',
            message:
              'Encore cannot update this copy of itself. Get the current build from the releases page.'
          })
        } else if (!result.isUpdateAvailable) {
          this.set({ kind: 'current' })
        } else {
          this.set({ kind: 'available', version: result.updateInfo.version })
        }
      })
      .catch((err: unknown) => {
        this.set({ kind: 'error', message: describeUpdateError(err) })
      })
      .then(() => {
        this.checking = null
        return this.status()
      })

    this.checking = run
    return run
  }

  /**
   * Fetch the release found by the last check.
   *
   * Only ever from `available`. Anything else is a stale button in a window the user left open,
   * and starting a download for a version that is no longer the answer would report progress
   * towards something nothing asked for.
   */
  async download(): Promise<AppUpdateStatus> {
    const started: AppUpdateState = this.state
    if (started.kind !== 'available') return this.status()
    const { version } = started
    this.set({ kind: 'downloading', version, percent: null })
    try {
      await this.deps.updater.downloadUpdate()
      // The emitter can have reported an error mid-download; that already moved the state, and
      // overwriting it with `ready` would offer a restart into a file that was never finished.
      //
      // Annotated rather than inferred, and read into a local, because otherwise the narrowing
      // from the guard above still stands here: TypeScript has no reason to think `this.set`
      // reassigns the field it is guarding on, so `this.state.kind` would be typed as the value
      // it held four lines earlier and this comparison would not compile.
      const now: AppUpdateState = this.state
      if (now.kind === 'downloading') this.set({ kind: 'ready', version })
    } catch (err) {
      this.set({ kind: 'error', message: describeUpdateError(err) })
    }
    return this.status()
  }

  /**
   * Quit and apply what was downloaded.
   *
   * Only from `ready`, because electron-updater's own contract is that `quitAndInstall` follows
   * `update-downloaded`. Calling it earlier closes every window and then finds nothing to run.
   * Returns whether it went ahead, so the IPC layer does not have to guess.
   */
  install(): boolean {
    if (this.state.kind !== 'ready') return false
    this.deps.updater.quitAndInstall()
    return true
  }

  /**
   * A download-progress event.
   *
   * Ignored unless a download is running. electron-updater emits progress from the differential
   * downloader too, and a percent arriving against `ready` or `error` would put the row back into
   * a state it has already left.
   */
  reportProgress(percent: number): void {
    if (this.state.kind !== 'downloading') return
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    this.set({ kind: 'downloading', version: this.state.version, percent: clamped })
  }

  /**
   * An error from the updater's own emitter.
   *
   * electron-updater emits `error` as well as rejecting, so this is usually the second report of
   * something already handled; setting the same state twice is harmless. What it must not do is
   * clobber a finished state, so it only applies while something is in flight. Outside that, an
   * emitted error belongs in the log, not in front of a user who is not waiting on anything.
   */
  reportError(err: unknown): void {
    if (this.state.kind !== 'checking' && this.state.kind !== 'downloading') return
    this.set({ kind: 'error', message: describeUpdateError(err) })
  }

  private set(state: AppUpdateState): void {
    this.state = state
    this.deps.onState(this.status())
  }
}
