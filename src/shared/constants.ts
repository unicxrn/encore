/**
 * Download staging dir placed inside each library folder (same volume keeps renameSync
 * atomic). A crash can leak files here; whatever is left gets swept at startup, and the
 * scanner skips the directory.
 */
export const ENCORE_TMP_DIR = '.encore-tmp'

/** Base URL for Chorus Encore's chart/art CDN. */
export const ENCHOR_FILES_URL = 'https://files.enchor.us'

/** Replaced at build time with package.json's `version` (see electron.vite.config.ts). */
declare const __APP_VERSION__: string

/** App version shown in chrome (sidebar status card). Bump it in package.json. */
export const APP_VERSION = __APP_VERSION__
