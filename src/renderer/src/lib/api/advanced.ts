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
  /**
   * Multiplied into the typed number before it is sent. 60 for length, which the API counts in
   * seconds and everybody else says in minutes; see `unit`.
   */
  readonly scale: number
  /** Shown after the pair, and named in each box's accessible label. Empty where there is none. */
  readonly unit: string
  /** The `step` attribute. Whole numbers unless a field is genuinely fractional. */
  readonly step: string
}

/**
 * The numeric ranges, paired.
 *
 * A range is one filter made of two boxes, which is why these are pairs rather than ten separate
 * fields: "between 3 and 6 minutes" is the question people have, and two loose boxes labelled
 * minLength and maxLength are two filters that happen to sit next to each other.
 */
export const ADVANCED_RANGES: readonly RangeSpec[] = [
  { min: 'minLength', max: 'maxLength', label: 'Length', scale: 60, unit: 'min', step: '1' },
  { min: 'minIntensity', max: 'maxIntensity', label: 'Intensity', scale: 1, unit: '', step: '1' },
  {
    min: 'minAverageNPS',
    max: 'maxAverageNPS',
    label: 'Average NPS',
    scale: 1,
    unit: '',
    step: '0.1'
  },
  { min: 'minMaxNPS', max: 'maxMaxNPS', label: 'Peak NPS', scale: 1, unit: '', step: '0.1' },
  { min: 'minYear', max: 'maxYear', label: 'Year', scale: 1, unit: '', step: '1' }
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

const rangeFor = (field: AdvancedNumberField): RangeSpec =>
  ADVANCED_RANGES.find((r) => r.min === field || r.max === field) as RangeSpec

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
    body[field] = parsed * rangeFor(field).scale
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
