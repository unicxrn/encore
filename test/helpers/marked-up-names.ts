/**
 * Two names exactly as they sit in the owner's own library, for the tests that check a name
 * reaches the screen as text.
 *
 * Verbatim on purpose. A made-up `<b>x</b>` would pass against a stripper that handled one tag
 * and nothing else, and the name that started this is the eight-tag one: every letter carries
 * its own colour, so a view that forgets to strip shows a line of hex codes rather than a
 * charter. Each constant comes with the text a reader should see beside it, so a test can pin
 * both halves without restating the markup.
 */

/** The FireStarter charter, from the owner's play history: one colour tag per letter. */
export const EIGHT_TAG_CHARTER =
  '<b><color=#7B0000>W</color><color=#8E0000>I</color><color=#A31616>l</color>' +
  '<color=#B82A2A>I</color><color=#CC3F3F>M</color><color=#E05555>a</color>' +
  '<color=#F5A9A9>y</color><color=#FFFFFF>I</color></b>'

/** What a reader should see in place of `EIGHT_TAG_CHARTER`. */
export const EIGHT_TAG_CHARTER_TEXT = 'WIlIMayI'

/** The commoner single-tag form, from the same library. */
export const TAGGED_CHARTER = '<color=#8200f3>SirMonkfish</color>'

/** What a reader should see in place of `TAGGED_CHARTER`. */
export const TAGGED_CHARTER_TEXT = 'SirMonkfish'
