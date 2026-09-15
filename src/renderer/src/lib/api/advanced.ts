/**
 * The advanced search Chorus Encore offers, as a shape the renderer can bind to and a body the
 * API accepts.
 *
 * Two different things live here on purpose. `AdvancedQuery` is what the panel edits: every field
 * present, every value a string, so a `<input>` can bind straight to it and a blank box reads as
 * "not set". `advancedBody` is what goes on the wire: only the fields the user actually filled in,
 * in the types the endpoint validates against. Nothing else in the app converts between the two.
 *
 * Verified against the live service on 2026-09-12. `POST /search/advanced` answers with the same
 * shape as `/search` (`found`, `out_of`, `page`, `data`) and a 201. `/search` itself accepts every
 * field below and silently ignores all of them, which is why none of this worked before: a request
 * that looks answered comes back describing the whole catalog.
 */

/** One text field as the endpoint wants it. All three keys are required; see `advancedBody`. */
export interface TextFilter {
  value: string
  /** Match the whole field rather than a substring. */
  exact: boolean
  /** Return the charts that do NOT match, rather than the ones that do. */
  exclude: boolean
}

/**
 * The six text fields, in the order the panel lists them.
 *
 * `year` is here as well as in the numeric ranges below because the endpoint takes both: the text
 * field matches the `year` string a chart carries (which is free text and often is not a bare
 * year), while `minYear`/`maxYear` compare the number parsed out of it.
 */
export const ADVANCED_TEXT_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'genre', label: 'Genre' },
  { key: 'year', label: 'Year' },
  { key: 'charter', label: 'Charter' }
] as const satisfies readonly { key: string; label: string }[]

export type AdvancedTextField = (typeof ADVANCED_TEXT_FIELDS)[number]['key']

export type AdvancedNumberField =
  | 'minLength'
  | 'maxLength'
  | 'minIntensity'
  | 'maxIntensity'
  | 'minAverageNPS'
  | 'maxAverageNPS'
  | 'minMaxNPS'
  | 'maxMaxNPS'
  | 'minYear'
  | 'maxYear'

export interface RangeSpec {
  readonly min: AdvancedNumberField
  readonly max: AdvancedNumberField
  readonly label: string
  /** Shown after the pair, and named in each box's accessible label. Empty where there is none. */
  readonly unit: string
  /**
   * The `step` attribute.
   *
   * Whole numbers except where a field is genuinely fractional. On intensity it is load-bearing
   * rather than cosmetic: a fractional `minIntensity` is a 500 from the endpoint every time
   * (measured), so the box must not offer one. Length takes a fraction happily (`minLength: 3.5`
   * answers with 59,830 charts), so there the step is only coarse.
   */
  readonly step: string
}

/**
 * The numeric ranges, paired.
 *
 * A range is one filter made of two boxes, which is why these are pairs rather than ten separate
 * fields: "between 3 and 6 minutes" is the question people have, and two loose boxes labelled
 * minLength and maxLength are two filters that happen to sit next to each other.
 *
 * Every one of these goes out as the user typed it, length included. `minLength`/`maxLength` are
 * MINUTES, re-measured against the live service on 2026-09-13: `{minLength: 4, maxLength: 4}`
 * answers with 55 charts whose `song_length` is 240000 ms exactly, and `{minLength: 3, maxLength:
 * 6}` with 63,408 that all sit in that band. The panel therefore converts nothing. An earlier
 * reading of this as seconds multiplied by 60, which asked for 3 to 6 HOURS and found 16 charts,
 * and a lone maximum of 360 matched 95,284 of the 95,299 charts there are.
 */
/**
 * Intensity is per instrument, and only reads as one when an instrument is named.
 *
 * Measured against the live service on 2026-09-15. With `instrument: 'guitar'` the bounds mean
 * exactly what they say: `minIntensity: 5` answers with `diff_guitar` of 5, 6 and 7, and
 * `maxIntensity: 2` with 1 and 2, every row. With no instrument they mean "some instrument is
 * in this band", and since an uncharted instrument carries -1, every chart satisfies any
 * maximum: `maxIntensity: 1` alone answers with 95,093 of the 95,299 charts there are, and
 * `{minIntensity: 5, maxIntensity: 5}` answers with the same 23,859 as `minIntensity: 5` on its
 * own. That is why Explore's header disables its intensity control until an instrument is
 * chosen, and why choosing "Any instrument" clears it.
 */
export const ADVANCED_RANGES: readonly RangeSpec[] = [
  { min: 'minLength', max: 'maxLength', label: 'Length', unit: 'min', step: '1' },
  { min: 'minIntensity', max: 'maxIntensity', label: 'Intensity', unit: '', step: '1' },
  { min: 'minAverageNPS', max: 'maxAverageNPS', label: 'Average NPS', unit: '', step: '0.1' },
  { min: 'minMaxNPS', max: 'maxMaxNPS', label: 'Peak NPS', unit: '', step: '0.1' },
  { min: 'minYear', max: 'maxYear', label: 'Year', unit: '', step: '1' }
]

/**
 * Where the intensity scale is drawn to stop, which is not where the data stops.
 *
 * Clone Hero's own scale runs 0 to 6 and `DiffPips` saturates its six bars there. The ratings
 * do not: `{instrument: 'guitar', minIntensity: 7}` answers with 2,419 charts whose
 * `diff_guitar` reads 7, 8, 9 and 20 (measured 2026-09-15). So the header's lowest-intensity
 * list ends in an open "7+" rather than at 6, and that open end is what says the scale carries
 * on; the highest list stopping at 6 is a bound the user chose, not a claim about the scale.
 * Nothing is clamped anywhere: a real 20 is still a 20 in the row's pips and in its name.
 */
export const INTENSITY_SCALE_TOP = 6

/** One entry of the header's two intensity lists. A blank value is "not bounded at this end". */
export interface IntensityBound {
  readonly value: string
  readonly label: string
}

const TIERS = Array.from({ length: INTENSITY_SCALE_TOP }, (_, i) => String(i + 1))

/**
 * Lowest intensity, as the header offers it.
 *
 * 1 to 6 and then 7+, which sends `minIntensity: 7` and has no upper end.
 */
export const INTENSITY_FLOORS: readonly IntensityBound[] = [
  { value: '', label: 'Any' },
  ...TIERS.map((tier) => ({ value: tier, label: tier })),
  { value: String(INTENSITY_SCALE_TOP + 1), label: `${INTENSITY_SCALE_TOP + 1}+` }
]

/**
 * Highest intensity, as the header offers it.
 *
 * Stops at 6 on purpose and offers no open top, because an open top is what "Any" already is.
 * 0 is missing from both lists: it is a real tier, and "at least 0" and "at most 0" are not
 * questions a header has to answer. The panel's two boxes take any integer, this one included.
 */
export const INTENSITY_CEILINGS: readonly IntensityBound[] = [
  { value: '', label: 'Any' },
  ...TIERS.map((tier) => ({ value: tier, label: tier }))
]

export type AdvancedSingleField = 'modifiedAfter' | 'hash' | 'trackHash'

export interface SingleSpec {
  readonly key: AdvancedSingleField
  readonly label: string
  readonly type: 'date' | 'text'
  readonly hint: string
}

export const ADVANCED_SINGLES: readonly SingleSpec[] = [
  {
    key: 'modifiedAfter',
    label: 'Updated after',
    type: 'date',
    hint: 'Charts changed since this date'
  },
  { key: 'hash', label: 'Chart hash', type: 'text', hint: 'Finds one exact chart' },
  { key: 'trackHash', label: 'Track hash', type: 'text', hint: 'Finds one exact instrument track' }
]

export type AdvancedFlag =
  | 'hasSoloSections'
  | 'hasForcedNotes'
  | 'hasOpenNotes'
  | 'hasTapNotes'
  | 'hasRollLanes'
  | 'has2xKick'
  | 'hasLyrics'
  | 'hasVocals'
  | 'hasVideoBackground'
  | 'modchart'
  | 'hasIssues'

export interface FlagSpec {
  readonly key: AdvancedFlag
  readonly label: string
}

export const ADVANCED_FLAGS: readonly FlagSpec[] = [
  { key: 'hasSoloSections', label: 'Solo sections' },
  { key: 'hasForcedNotes', label: 'Forced notes' },
  { key: 'hasOpenNotes', label: 'Open notes' },
  { key: 'hasTapNotes', label: 'Tap notes' },
  { key: 'hasRollLanes', label: 'Roll lanes' },
  { key: 'has2xKick', label: '2x kick' },
  { key: 'hasLyrics', label: 'Lyrics' },
  { key: 'hasVocals', label: 'Vocals' },
  { key: 'hasVideoBackground', label: 'Video background' },
  { key: 'modchart', label: 'Modchart' },
  { key: 'hasIssues', label: 'Has issues' }
]

/**
 * What the panel edits.
 *
 * Numbers and dates are strings because that is what an `<input>` holds, and because a blank
 * string is the only "not set" a number box has: 0 is a real minimum length and `null` is not a
 * value a text input can carry.
 *
 * A flag is a plain boolean and off means "do not filter on this", not "must not have it". The
 * endpoint does accept `false` as "must not have it", but a checkbox has two states and the third
 * one would have to be invented; Chorus Encore's own form makes the same choice.
 */
export interface AdvancedQuery {
  text: Record<AdvancedTextField, TextFilter>
  numbers: Record<AdvancedNumberField, string>
  flags: Record<AdvancedFlag, boolean>
  singles: Record<AdvancedSingleField, string>
}

const NUMBER_FIELDS: readonly AdvancedNumberField[] = ADVANCED_RANGES.flatMap((r) => [r.min, r.max])

export function emptyAdvanced(): AdvancedQuery {
  const text = {} as Record<AdvancedTextField, TextFilter>
  for (const field of ADVANCED_TEXT_FIELDS) {
    text[field.key] = { value: '', exact: false, exclude: false }
  }
  const numbers = {} as Record<AdvancedNumberField, string>
  for (const field of NUMBER_FIELDS) numbers[field] = ''
  const flags = {} as Record<AdvancedFlag, boolean>
  for (const flag of ADVANCED_FLAGS) flags[flag.key] = false
  const singles = {} as Record<AdvancedSingleField, string>
  for (const single of ADVANCED_SINGLES) singles[single.key] = ''
  return { text, numbers, flags, singles }
}

/** A copy nothing else holds a reference into, so the panel's draft and the applied query cannot
 * drift into each other once one of them is edited. */
export function cloneAdvanced(query: AdvancedQuery): AdvancedQuery {
  const text = {} as Record<AdvancedTextField, TextFilter>
  for (const field of ADVANCED_TEXT_FIELDS) text[field.key] = { ...query.text[field.key] }
  return {
    text,
    numbers: { ...query.numbers },
    flags: { ...query.flags },
    singles: { ...query.singles }
  }
}

/**
 * The fields to send, and only those.
 *
 * Every filled-in text field goes out with all three keys, always. The endpoint validates the
 * object and answers a 400 naming the missing path (`{"path":["name","exclude"]}`) when either
 * flag is left out, so an object trimmed down to the keys that are "interesting" is not a smaller
 * request, it is a failed one. That is the single trap in this endpoint and it is why the flags
 * are stored beside the value rather than derived at send time.
 *
 * A field the user left blank is omitted rather than sent empty: `{value: '', ...}` is accepted
 * and matches everything, so sending it would make "filters are active" impossible to read off
 * the body.
 */
export function advancedBody(query: AdvancedQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {}

  for (const field of ADVANCED_TEXT_FIELDS) {
    const filter = query.text[field.key]
    const value = filter.value.trim()
    if (!value) continue
    body[field.key] = { value, exact: filter.exact, exclude: filter.exclude }
  }

  for (const field of NUMBER_FIELDS) {
    const raw = query.numbers[field].trim()
    if (!raw) continue
    const parsed = Number(raw)
    // A half-typed "-" or "1e" parses to NaN, and JSON.stringify writes NaN as null, which the
    // endpoint rejects for a field it expects a number in. Dropping it leaves the box on screen
    // with what the user typed and the results unfiltered by it.
    if (!Number.isFinite(parsed)) continue
    // The number the user typed, in the unit the box is labelled in. Every range the endpoint
    // takes is already in that unit, length included; see ADVANCED_RANGES.
    body[field] = parsed
  }

  for (const flag of ADVANCED_FLAGS) {
    if (query.flags[flag.key]) body[flag.key] = true
  }

  for (const single of ADVANCED_SINGLES) {
    const value = query.singles[single.key].trim()
    if (value) body[single.key] = value
  }

  return body
}

/**
 * How many filters are on, for the badge the closed panel carries.
 *
 * Counted off the body rather than off the form, so it counts what the request is actually
 * narrowed by. A range with both ends filled in counts as two, which is what the panel shows and
 * what "clear" would undo.
 */
export function advancedCount(query: AdvancedQuery): number {
  return Object.keys(advancedBody(query)).length
}
