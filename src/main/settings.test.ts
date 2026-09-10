import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSettings, saveSettings } from './settings'
import { tmpDir } from '../../test/helpers/tmp'

const tmpFile = (): string => join(tmpDir('settings'), 'settings.json')

describe('settings persistence', () => {
  it('returns defaults when the file does not exist', () => {
    expect(loadSettings(tmpFile()).downloadFormat).toBe('sng')
  })
  it('round-trips saved settings', () => {
    const file = tmpFile()
    saveSettings(file, { ...loadSettings(file), downloadConcurrency: 5 })
    expect(loadSettings(file).downloadConcurrency).toBe(5)
  })
  it('recovers defaults from corrupt JSON', () => {
    const file = tmpFile()
    writeFileSync(file, '{not json')
    expect(loadSettings(file).previewVolume).toBe(50)
  })
  it('rescues an unreadable settings file to .bak before falling back to defaults', () => {
    const file = tmpFile()
    writeFileSync(file, '{not json')
    expect(loadSettings(file).downloadFormat).toBe('sng')
    expect(existsSync(`${file}.bak`)).toBe(true)
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('{not json')
  })
  it('does not create a .bak when loading a nonexistent path', () => {
    const file = tmpFile()
    expect(loadSettings(file).downloadFormat).toBe('sng')
    expect(existsSync(`${file}.bak`)).toBe(false)
  })
  it('loads a settings file written before tourSeen existed with the tour unseen', () => {
    // Every settings.json on disk today predates the field. The schema default is what makes that
    // file load at all; this pins that it loads as "not yet seen" rather than throwing or rescuing
    // a perfectly good file to .bak.
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ libraryFolders: [{ path: '/songs', isDefault: true }] }))
    const loaded = loadSettings(file)
    expect(loaded.tourSeen).toBe(false)
    expect(loaded.libraryFolders).toEqual([{ path: '/songs', isDefault: true }])
    expect(existsSync(`${file}.bak`)).toBe(false)
  })
  it('round-trips tourSeen, which is what keeps the tour to one showing', () => {
    const file = tmpFile()
    saveSettings(file, { ...loadSettings(file), tourSeen: true })
    expect(loadSettings(file).tourSeen).toBe(true)
  })
  it('writes valid JSON to disk', () => {
    const file = tmpFile()
    saveSettings(file, loadSettings(file))
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()
  })
})
