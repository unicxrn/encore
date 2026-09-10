import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Settings, SettingsSchema, defaultSettings } from '../shared/schemas'

export function loadSettings(filePath: string): Settings {
  try {
    return SettingsSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch (error) {
    if (existsSync(filePath)) {
      // The file is present but unreadable or invalid. Rescue it so the next
      // save doesn't silently overwrite recoverable settings (libraryFolders).
      try {
        renameSync(filePath, `${filePath}.bak`)
      } catch {
        // Best effort: a failed rescue must not prevent falling back.
      }
      console.warn(`Failed to load settings from ${filePath}, rescued to .bak:`, error)
    }
    return defaultSettings()
  }
}

export function saveSettings(filePath: string, settings: Settings): void {
  const validated = SettingsSchema.parse(settings)
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(validated, null, '\t'))
  renameSync(tmp, filePath)
}
