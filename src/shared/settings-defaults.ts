import type { Settings } from './schemas'

/**
 * Settings defaults as a plain literal, deliberately free of any zod import.
 *
 * The renderer needs exactly this one value to seed its settings store. When it
 * came from `schemas.ts` (as `SettingsSchema.parse({})`) the whole zod runtime
 * and every schema in the app landed in the renderer's startup bundle:
 * measured at 461 kB, and 294 kB once this import was cut. That is 167 kB of JS
 * parsed and compiled on every launch for one object.
 *
 * `SettingsSchema` derives its `.default()`s from here, and schemas.test.ts
 * asserts `SettingsSchema.parse({})` still equals `defaultSettings()`, so there
 * is one source of truth rather than two lists that can drift.
 */
export const SETTINGS_DEFAULTS = {
  downloadFormat: 'sng',
  downloadConcurrency: 3,
  downloadVideos: false,
  chartFolderName: '{artist} - {name} ({charter})',
  previewVolume: 50,
  /**
   * Whether the welcome tour has been shown. Finishing OR skipping sets it: a tour that came
   * back on every launch until it was walked to the end would be a nag, not an introduction.
   * False here also covers a settings.json from before the field existed, so anyone upgrading
   * sees the tour once.
   */
  tourSeen: false,
  /**
   * The version whose changelog entry has already been put in front of this user, which is what
   * makes the "what's new" panel appear once after an update and not again. Empty means nothing
   * has been recorded yet: a fresh install, or an upgrade from a build that predates this field.
   * `whatsNewOnLaunch` in shared/changelog.ts is what tells those two apart.
   */
  lastSeenVersion: ''
} as const

/** A fresh Settings object; `libraryFolders` is a new array on every call. */
export const defaultSettings = (): Settings => ({
  libraryFolders: [],
  ...SETTINGS_DEFAULTS
})
