import { describe, expect, it } from 'vitest'
import {
  ADVANCED_FLAGS,
  ADVANCED_RANGES,
  ADVANCED_SINGLES,
  ADVANCED_TEXT_FIELDS,
  advancedBody,
  advancedCount,
  cloneAdvanced,
  emptyAdvanced
} from './advanced'

describe('advancedBody', () => {
  it('sends nothing at all for an untouched form', () => {
    // This is what decides the endpoint. A form nobody has filled in has to produce an empty body
    // or every plain search would be routed to /search/advanced, which ignores the search term.
    expect(advancedBody(emptyAdvanced())).toEqual({})
    expect(advancedCount(emptyAdvanced())).toBe(0)
  })

  it('writes all three keys of a text field, even when both flags are off', () => {
    // The endpoint answers 400 naming the missing path when either flag is left out, so a text
    // object trimmed to what looks interesting is not a smaller request, it is a failed one.
    const query = emptyAdvanced()
    query.text.name.value = 'bloom'
    expect(advancedBody(query)).toEqual({ name: { value: 'bloom', exact: false, exclude: false } })
  })

  it('writes all three keys for every text field the form has', () => {
    const query = emptyAdvanced()
    for (const field of ADVANCED_TEXT_FIELDS) query.text[field.key].value = 'x'
    const body = advancedBody(query)
    for (const field of ADVANCED_TEXT_FIELDS) {
      expect(Object.keys(body[field.key] as object).sort()).toEqual(['exact', 'exclude', 'value'])
    }
  })

  it('carries exact and exclude through as set', () => {
    const query = emptyAdvanced()
    query.text.name.value = 'bloom'
    query.text.name.exact = true
    query.text.name.exclude = true
    expect(advancedBody(query).name).toEqual({ value: 'bloom', exact: true, exclude: true })
  })

  it('leaves out a text field that holds only whitespace, and trims the rest', () => {
    // An empty value is accepted by the endpoint and matches everything, so sending it would make
    // "is anything narrowing this" unreadable off the body, which is what the badge counts.
    const query = emptyAdvanced()
    query.text.name.value = '   '
    query.text.artist.value = '  Foo Fighters  '
    const body = advancedBody(query)
    expect(body.name).toBeUndefined()
    expect(body.artist).toEqual({ value: 'Foo Fighters', exact: false, exclude: false })
  })

  it('keeps a text field whose only setting is exclude out of the body while its value is empty', () => {
    const query = emptyAdvanced()
    query.text.charter.exclude = true
    expect(advancedBody(query)).toEqual({})
  })

  it('converts length from the minutes it is typed in to the seconds the API counts', () => {
    const query = emptyAdvanced()
    query.numbers.minLength = '10'
    query.numbers.maxLength = '12'
    expect(advancedBody(query)).toEqual({ minLength: 600, maxLength: 720 })
  })

  it('sends the other ranges unscaled', () => {
    const query = emptyAdvanced()
    query.numbers.minYear = '1994'
    query.numbers.maxAverageNPS = '8.5'
    expect(advancedBody(query)).toEqual({ minYear: 1994, maxAverageNPS: 8.5 })
  })

  it('keeps a zero, which is a real lower bound and not a blank box', () => {
    const query = emptyAdvanced()
    query.numbers.minIntensity = '0'
    expect(advancedBody(query)).toEqual({ minIntensity: 0 })
  })

  it('drops a half-typed number rather than sending null', () => {
    // JSON.stringify writes NaN as null, and the endpoint rejects null for a number field, so a
    // box mid-keystroke would fail the whole search rather than not filtering by it yet.
    const query = emptyAdvanced()
    query.numbers.minYear = '-'
    expect(advancedBody(query)).toEqual({})
  })

  it('sends only the flags that are on, and sends them as true', () => {
    const query = emptyAdvanced()
    query.flags.modchart = true
    query.flags.hasVideoBackground = true
    expect(advancedBody(query)).toEqual({ modchart: true, hasVideoBackground: true })
  })

  it('never sends a flag as false, because off means "do not filter on this"', () => {
    const query = emptyAdvanced()
    for (const flag of ADVANCED_FLAGS) query.flags[flag.key] = false
    expect(advancedBody(query)).toEqual({})
  })

  it('sends the single fields as plain strings', () => {
    const query = emptyAdvanced()
    query.singles.modifiedAfter = '2026-09-01'
    query.singles.hash = 'a'.repeat(32)
    expect(advancedBody(query)).toEqual({
      modifiedAfter: '2026-09-01',
      hash: 'a'.repeat(32)
    })
  })

  it('covers every field the panel offers', () => {
    // A field added to one of the descriptor lists and forgotten in the builder would sit on
    // screen doing nothing, which is the exact failure the old /search had.
    const query = emptyAdvanced()
    for (const field of ADVANCED_TEXT_FIELDS) query.text[field.key].value = 'x'
    for (const range of ADVANCED_RANGES) {
      query.numbers[range.min] = '1'
      query.numbers[range.max] = '2'
    }
    for (const flag of ADVANCED_FLAGS) query.flags[flag.key] = true
    for (const single of ADVANCED_SINGLES) query.singles[single.key] = '2026-09-01'
    const body = advancedBody(query)
    const expected = [
      ...ADVANCED_TEXT_FIELDS.map((f) => f.key),
      ...ADVANCED_RANGES.flatMap((r) => [r.min, r.max]),
      ...ADVANCED_FLAGS.map((f) => f.key),
      ...ADVANCED_SINGLES.map((s) => s.key)
    ]
    expect(Object.keys(body).sort()).toEqual(expected.sort())
  })
})

describe('advancedCount', () => {
  it('counts each end of a range separately, as the panel shows them', () => {
    const query = emptyAdvanced()
    query.numbers.minLength = '3'
    query.numbers.maxLength = '6'
    query.flags.hasLyrics = true
    expect(advancedCount(query)).toBe(3)
  })
})

describe('cloneAdvanced', () => {
  it('shares nothing with the query it copied, down to the text objects', () => {
    // The panel's draft and the applied query are the same shape, and an edit to one leaking into
    // the other would change the filters the rows on screen were fetched with.
    const original = emptyAdvanced()
    original.text.name.value = 'bloom'
    const copy = cloneAdvanced(original)
    copy.text.name.value = 'everlong'
    copy.text.name.exact = true
    copy.numbers.minYear = '1994'
    copy.flags.modchart = true
    copy.singles.hash = 'abc'
    expect(original.text.name).toEqual({ value: 'bloom', exact: false, exclude: false })
    expect(original.numbers.minYear).toBe('')
    expect(original.flags.modchart).toBe(false)
    expect(original.singles.hash).toBe('')
  })
})
