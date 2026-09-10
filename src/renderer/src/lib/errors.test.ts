import { describe, expect, it, vi } from 'vitest'
import { copyText, errorHeadline, errorReport } from './errors'

describe('errorHeadline', () => {
  it('uses the message of an Error', () => {
    expect(errorHeadline(new Error('chart is on fire'))).toBe('chart is on fire')
  })

  it('falls back to the name when the message is empty', () => {
    // `new Error()` renders a blank headline otherwise, which tells the user nothing at all.
    expect(errorHeadline(new Error())).toBe('Error')
    expect(errorHeadline(new TypeError(''))).toBe('TypeError')
  })

  it('passes a thrown string through', () => {
    expect(errorHeadline('nope')).toBe('nope')
  })

  it('names null and undefined rather than rendering them as text', () => {
    expect(errorHeadline(null)).toBe('null was thrown')
    expect(errorHeadline(undefined)).toBe('undefined was thrown')
  })

  it('serialises a thrown object instead of showing [object Object]', () => {
    expect(errorHeadline({ code: 'EACCES' })).toBe('{"code":"EACCES"}')
  })

  it('survives a cyclic thrown object', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(errorHeadline(cyclic)).toBe('[object Object]')
  })
})

describe('errorReport', () => {
  it('leads with the app version and the context, then the headline', () => {
    const report = errorReport(new Error('boom'), 'Tools view')
    const [first, second] = report.split('\n')
    expect(first).toMatch(/^Encore \d/)
    expect(first).toContain('Tools view')
    expect(second).toBe('boom')
  })

  it('includes the stack, which is the whole reason Copy exists', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at Detail.svelte:12:3'
    expect(errorReport(err, 'Detail')).toContain('at Detail.svelte:12:3')
  })

  it('still produces a report for a non-Error with no stack', () => {
    const report = errorReport('plain string', 'somewhere')
    expect(report).toContain('plain string')
    expect(report.split('\n')).toHaveLength(2)
  })
})

describe('copyText', () => {
  it('reports false when the clipboard API is unavailable', async () => {
    // jsdom has no navigator.clipboard; a packaged build without focus can also refuse.
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('reports false rather than throwing when writeText rejects', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('not focused')) }
    })
    await expect(copyText('x')).resolves.toBe(false)
    vi.unstubAllGlobals()
  })

  it('reports true and writes the text when the clipboard accepts it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyText('report body')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('report body')
    vi.unstubAllGlobals()
  })
})
