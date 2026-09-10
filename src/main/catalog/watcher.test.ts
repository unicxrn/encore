import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryWatcher } from './watcher'
import { tmpDir } from '../../../test/helpers/tmp'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('LibraryWatcher', () => {
  let watcher: LibraryWatcher | null = null
  afterEach(async () => {
    await watcher?.stop()
    watcher = null
  })

  it('fires once (debounced) after changes settle', async () => {
    const root = tmpDir('watch')
    let fired = 0
    watcher = new LibraryWatcher({ debounceMs: 50, onChange: () => fired++ })
    await watcher.start([root])
    mkdirSync(join(root, 'New Song'))
    writeFileSync(join(root, 'New Song/song.ini'), '[song]\nname = X\n')
    writeFileSync(join(root, 'New Song/notes.chart'), '[Song]\n')
    await wait(300)
    expect(fired).toBe(1)
  })

  it('ignores .encore-tmp activity', async () => {
    const root = tmpDir('watch2')
    mkdirSync(join(root, '.encore-tmp'))
    let fired = 0
    watcher = new LibraryWatcher({ debounceMs: 50, onChange: () => fired++ })
    await watcher.start([root])
    writeFileSync(join(root, '.encore-tmp/x.part'), 'partial')
    await wait(300)
    expect(fired).toBe(0)
  })

  it('restarts cleanly on start() with new roots', async () => {
    const a = tmpDir('watch3')
    const b = tmpDir('watch4')
    let fired = 0
    watcher = new LibraryWatcher({ debounceMs: 50, onChange: () => fired++ })
    await watcher.start([a])
    await watcher.start([b]) // replaces
    writeFileSync(join(a, 'ignored.sng'), '')
    writeFileSync(join(b, 'seen.sng'), '')
    await wait(300)
    expect(fired).toBe(1)
  })
})
