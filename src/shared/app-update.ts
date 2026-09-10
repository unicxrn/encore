/**
 * Updating Encore itself.
 *
 * Not to be confused with `shared/updates.ts`, which is about chart versions on Chorus. This
 * module is the app's own release channel: the GitHub releases of `unicxrn/encore` that
 * electron-updater reads.
 *
 * Everything here is a plain type or a pure function, so the renderer, the main process and the
 * suite all read one definition of what a target can do and what the user is told about it.
 */

/**
 * How this copy of Encore was installed, which is what decides whether it can replace itself.
 *
 * These are the cases electron-updater itself distinguishes, in the same order it distinguishes
 * them (see `detectUpdateTarget`). Naming a case Encore never builds, such as rpm or pacman,
 * would be inventing a state nothing can produce, so anything unrecognised is `unknown`.
 */
export type UpdateTarget =
  /** Windows, installed by the NSIS setup executable. */
  | 'nsis'
  /** Linux, running as an AppImage. */
  | 'appimage'
  /** Linux, installed from the .deb. */
  | 'deb'
  /** Linux, installed from the Snap Store. */
  | 'snap'
  /** macOS, which Encore publishes no build for. */
  | 'macos'
  /** Running from source, or from an unpacked build. */
  | 'unpackaged'
  /** Packaged, but not as anything Encore knows how to replace. */
  | 'unknown'

/**
 * Where a check, download or install has got to.
 *
 * A discriminated union rather than a bag of booleans, for the reason `ChartVerdict` is one: the
 * states are mutually exclusive, and a UI reading three independent flags can draw a combination
 * that never happens. Every state carries exactly what the screen has to print.
 */
export type AppUpdateState =
  /** Nothing has been asked yet this session. */
  | { kind: 'idle' }
  /** A check is in flight. */
  | { kind: 'checking' }
  /** The check finished and this build is the latest release. */
  | { kind: 'current' }
  /** A newer release exists. `version` is its version, not the running one. */
  | { kind: 'available'; version: string }
  /** Downloading that release. `percent` is null until the first progress event arrives. */
  | { kind: 'downloading'; version: string; percent: number | null }
  /** Downloaded and staged. Nothing changes until the user restarts. */
  | { kind: 'ready'; version: string }
  /** The check or the download failed. `message` is written to be acted on, not logged. */
  | { kind: 'error'; message: string }

/** Everything the Settings row needs, in one payload, so state and capability cannot disagree. */
export interface AppUpdateStatus {
  /** The version running right now. */
  currentVersion: string
  target: UpdateTarget
  /**
   * Whether Encore can fetch a release and apply it to this copy of itself.
   *
   * False is not a failure and is not hidden: it is the honest answer for a snap, for a build run
   * from source, and for packaging Encore does not recognise. The UI shows `note` instead of a
   * button, because a button that cannot work is worse than no button.
   */
  canApply: boolean
  /** One sentence about what this packaging means for updates. Always shown, never empty. */
  note: string
  state: AppUpdateState
}

/** What Encore can do about updates for one packaging, and what it says about it. */
export interface TargetCapability {
  canApply: boolean
  note: string
}

/**
 * The one place each target's answer is written down.
 *
 * The two halves belong together: a `canApply: false` whose sentence did not explain itself would
 * leave a user staring at a panel with no controls and no reason, which is the failure this whole
 * section exists to avoid.
 */
export function targetCapability(target: UpdateTarget): TargetCapability {
  switch (target) {
    case 'nsis':
      return {
        canApply: true,
        note: 'Encore downloads the installer and runs it when you restart.'
      }
    case 'appimage':
      return {
        canApply: true,
        note: 'Encore downloads the new AppImage and replaces this one when you restart.'
      }
    case 'deb':
      // The install shells out to dpkg, falling back to apt, through pkexec or sudo. Both of
      // those need root, so the desktop will ask for a password, and apt can still refuse a
      // local unsigned package. Saying so before the button is pressed is the difference between
      // an expected prompt and one that looks like something went wrong.
      return {
        canApply: true,
        note: 'Installing the update needs administrator rights, so your system asks for your password. If the package manager refuses it, install the deb from the releases page yourself.'
      }
    case 'snap':
      // electron-updater disables itself when SNAP is set (AppImageUpdater.isUpdaterActive), so
      // a check here would resolve to nothing at all. The snap store owns this install.
      return {
        canApply: false,
        note: 'This copy came from the Snap Store, which updates it for you. To update it now, run snap refresh encore.'
      }
    case 'macos':
      return {
        canApply: false,
        note: 'Encore publishes no macOS build, so there is no release for this copy to update to.'
      }
    case 'unpackaged':
      return {
        canApply: false,
        note: 'This copy runs from source rather than from an installed build, so there is nothing for Encore to replace.'
      }
    case 'unknown':
      return {
        canApply: false,
        note: 'Encore cannot tell how this copy was installed, so it will not try to replace it. The releases page has the current build.'
      }
  }
}
