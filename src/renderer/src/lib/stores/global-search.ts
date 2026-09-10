import { writable } from 'svelte/store'

/**
 * Query typed into the top-bar global search. App writes it (and routes to the
 * Explore view); Browse mirrors it into its own search store and syncs its
 * local input back, so both inputs stay consistent.
 */
export const globalQuery = writable('')
