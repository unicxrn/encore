import { describe, expect, it } from 'vitest'
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
})
