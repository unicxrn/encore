import { describe, expect, it } from 'vitest'
import { toCsv } from './csv'

describe('toCsv', () => {
  it('renders plain rows without quoting', () => {
    const result = toCsv([
      ['chartPath', 'kind', 'code', 'description'],
      ['/lib/song', 'folder', 'noAudio', 'No audio file found']
    ])
    expect(result).toBe(
      'chartPath,kind,code,description\r\n/lib/song,folder,noAudio,No audio file found\r\n'
    )
  })

  it('has a trailing CRLF', () => {
    const result = toCsv([['a', 'b']])
    expect(result.endsWith('\r\n')).toBe(true)
  })

  it('wraps fields containing commas in double-quotes', () => {
    const result = toCsv([['a,b', 'c']])
    expect(result).toBe('"a,b",c\r\n')
  })

  it('escapes double-quotes as ""', () => {
    const result = toCsv([['say "hello"', 'ok']])
    expect(result).toBe('"say ""hello""",ok\r\n')
  })

  it('wraps fields containing newlines in double-quotes', () => {
    const result = toCsv([['line1\nline2', 'ok']])
    expect(result).toBe('"line1\nline2",ok\r\n')
  })

  it('wraps fields containing carriage returns in double-quotes', () => {
    const result = toCsv([['line1\rline2', 'ok']])
    expect(result).toBe('"line1\rline2",ok\r\n')
  })

  it('handles empty cells without quoting', () => {
    const result = toCsv([['', 'a', '']])
    expect(result).toBe(',a,\r\n')
  })

  it('handles unicode characters without quoting', () => {
    const result = toCsv([['café', '日本語', '🎸']])
    expect(result).toBe('café,日本語,🎸\r\n')
  })

  it('handles multiple rows with CRLF separation', () => {
    const result = toCsv([['a'], ['b'], ['c']])
    expect(result).toBe('a\r\nb\r\nc\r\n')
  })

  it('handles a single empty row with one cell', () => {
    const result = toCsv([['']])
    expect(result).toBe('\r\n')
  })

  it('handles field with both quotes and commas', () => {
    const result = toCsv([['"hello", world']])
    expect(result).toBe('"""hello"", world"\r\n')
  })
})
