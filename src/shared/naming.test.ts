import { describe, expect, it } from 'vitest'
import {
  EIGHT_TAG_CHARTER,
  EIGHT_TAG_CHARTER_TEXT,
  TAGGED_CHARTER,
  TAGGED_CHARTER_TEXT
} from '../../test/helpers/marked-up-names'
import { resolveChartFolderName } from './naming'

describe('resolveChartFolderName', () => {
  const meta = { name: 'Everlong', artist: 'Foo Fighters', charter: 'GHS' }

  it('substitutes template variables', () => {
    expect(resolveChartFolderName('{artist} - {name} ({charter})', meta)).toBe(
      'Foo Fighters - Everlong (GHS)'
    )
  })
  it('strips characters invalid in filenames', () => {
    expect(resolveChartFolderName('{name}', { ...meta, name: 'AC/DC: Live?' })).toBe('ACDC Live')
  })
  it('falls back to Unknown for missing fields and never returns empty', () => {
    expect(resolveChartFolderName('{artist}', {})).toBe('Unknown Artist')
    expect(resolveChartFolderName('  ', meta)).toBe('Unknown Chart')
  })
  it('trims trailing dots and spaces (Windows)', () => {
    expect(resolveChartFolderName('{name}', { ...meta, name: 'Song...' })).toBe('Song')
  })
  it('strips control characters', () => {
    expect(resolveChartFolderName('{name}', { ...meta, name: 'a\x00b\x1fc' })).toBe('abc')
  })
  it('guards Windows reserved device names', () => {
    expect(resolveChartFolderName('{name}', { ...meta, name: 'CON' })).toBe('CON_')
  })
  it("reads a charter's Clone Hero markup rather than pasting it into the path", () => {
    // The sanitiser below only drops < and >, so without the stripper these two read as
    // `Foo Fighters - Everlong (color=#8200f3SirMonkfishcolor)` and a line of hex codes. This
    // name is the folder on disk AND the only name the downloads queue shows.
    expect(
      resolveChartFolderName('{artist} - {name} ({charter})', { ...meta, charter: TAGGED_CHARTER })
    ).toBe(`Foo Fighters - Everlong (${TAGGED_CHARTER_TEXT})`)
    expect(resolveChartFolderName('{charter}', { ...meta, charter: EIGHT_TAG_CHARTER })).toBe(
      EIGHT_TAG_CHARTER_TEXT
    )
  })
  it('leaves a bracket that is not a tag to the sanitiser, as before', () => {
    // `<3` is not markup, so the stripper keeps it and the filename rule takes the bracket:
    // the same answer this gave before the stripper existed.
    expect(resolveChartFolderName('{name}', { ...meta, name: 'Rock <3 Roll' })).toBe('Rock 3 Roll')
  })
})
