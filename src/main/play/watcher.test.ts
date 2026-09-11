import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpDir } from '../../../test/helpers/tmp'
import type { PlayRecord } from './scorestats'
import { PlayWatcher } from './watcher'

const CHECKSUM = 'e54e9a0521444e81bd1fed4f3f3a3201'

function scoreStats(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    game_version: 'v1.1.0.6142-final',
    checksum: CHECKSUM.toUpperCase(),
    song_name: 'Skrting On The Surface',
    artist_name: 'The Smile',
    charter_name: 'Mech',
    playback_speed: 100,
    game_mode: 'Quickplay',
    score_timestamp: '2026-09-10T22:23:37.1089500Z',
    band_score: 40122,
    band_stars: 2,
    player_count: 1,
    players: [
      {
        instrument: 'Guitar',
        difficulty: 'Expert',
        profile_name: 'Aevyx',
        score: 40122,
        notes_hit: 795,
        total_notes: 1529,
        max_streak: 12,
        stars: 2,
        avg_multiplier: 0.52,
        is_fc: false,
        is_pfc: false
      }
    ],
    ...over
  })
}

/** A watcher over a scratch directory, with an in-memory stand-in for the store. */
function harness(opts: { dirExists?: boolean } = {}): {
  path: string
  watcher: PlayWatcher
  recorded: PlayRecord[]
  onPlay: ReturnType<typeof vi.fn>
} {
  const root = tmpDir('play-watcher')
  const dir = join(root, 'clonehero')
  if (opts.dirExists !== false) mkdirSync(dir, { recursive: true })
  const path = join(dir, 'scorestats.json')
  const recorded: PlayRecord[] = []
  const onPlay = vi.fn()
  // The real "already recorded" rule is the plays table's UNIQUE constraint; this reproduces it
  // so the watcher's own behaviour can be seen without a database.
  const record = (play: PlayRecord): boolean => {
    const key = `${play.checksum}|${play.playedAt}`
    if (recorded.some((r) => `${r.checksum}|${r.playedAt}` === key)) return false
    recorded.push(play)
    return true
  }
  return { path, watcher: new PlayWatcher({ path, record, onPlay }), recorded, onPlay }
}

const open: PlayWatcher[] = []
afterEach(async () => {
  for (const w of open.splice(0)) await w.stop()
})

/** Waits for a condition the watcher will satisfy asynchronously, or gives up. */
async function eventually(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  expect.fail('condition was never met')
}

describe('PlayWatcher.refresh', () => {
  it('records the play in the file', async () => {
    const { path, watcher, recorded, onPlay } = harness()
    writeFileSync(path, scoreStats())
    expect(await watcher.refresh()).toBe(true)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].checksum).toBe(CHECKSUM)
    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(watcher.reason).toBe('ok')
  })

  it('reports an absent file as the ordinary case it is', async () => {
    // No Clone Hero, or Clone Hero with no score yet. This is most users, and it is not an error.
    const { watcher } = harness()
    expect(await watcher.refresh()).toBe(false)
    expect(watcher.reason).toBe('noFile')
  })

  it('survives the whole directory being absent', async () => {
    const { watcher } = harness({ dirExists: false })
    expect(await watcher.refresh()).toBe(false)
    expect(watcher.reason).toBe('noFile')
  })

  it('reports malformed content as present-but-unusable, not as missing', async () => {
    // A status saying "no file" would send a user looking for an install they already have.
    const { path, watcher } = harness()
    writeFileSync(path, 'not json at all')
    expect(await watcher.refresh()).toBe(false)
    expect(watcher.reason).toBe('unreadable')
  })

  it('survives a half-written file and recovers on the next read', async () => {
    const { path, watcher, recorded } = harness()
    const full = scoreStats()
    writeFileSync(path, full.slice(0, 120))
    expect(await watcher.refresh()).toBe(false)
    expect(watcher.reason).toBe('unreadable')
    expect(recorded).toEqual([])
    // Clone Hero finishes its write; the next event fixes it with no intervention.
    writeFileSync(path, full)
    expect(await watcher.refresh()).toBe(true)
    expect(recorded).toHaveLength(1)
  })

  it('does not re-announce a play it has already recorded', async () => {
    // The common case by a wide margin: chokidar emits several events per save, and the file is
    // unchanged between them.
    const { path, watcher, recorded, onPlay } = harness()
    writeFileSync(path, scoreStats())
    expect(await watcher.refresh()).toBe(true)
    expect(await watcher.refresh()).toBe(false)
    expect(await watcher.refresh()).toBe(false)
    expect(recorded).toHaveLength(1)
    expect(onPlay).toHaveBeenCalledTimes(1)
    // Still `ok`: the file read fine, there was simply nothing new in it.
    expect(watcher.reason).toBe('ok')
  })

  it('watches nothing and says so when the platform has no known location', async () => {
    const watcher = new PlayWatcher({ path: null, record: () => true })
    expect(await watcher.refresh()).toBe(false)
    expect(watcher.reason).toBe('unknownPlatform')
    expect(watcher.watchedPath).toBeNull()
    // start() must still resolve, so callers need no platform check of their own.
    await expect(watcher.start()).resolves.toBeUndefined()
    await watcher.stop()
  })
})

describe('PlayWatcher.start', () => {
  it('picks up a play made while Encore was closed', async () => {
    const { path, watcher, recorded } = harness()
    open.push(watcher)
    writeFileSync(path, scoreStats())
    await watcher.start()
    // The immediate read is what makes this work; the file predates the watch.
    expect(recorded).toHaveLength(1)
  })

  it('records a play written after it started', async () => {
    const { path, watcher, recorded } = harness()
    open.push(watcher)
    await watcher.start()
    expect(recorded).toEqual([])
    writeFileSync(path, scoreStats())
    await eventually(() => recorded.length === 1)
    expect(recorded[0].checksum).toBe(CHECKSUM)
  })

  it('keeps recording across a delete-and-recreate rewrite', async () => {
    // The reason this watches the DIRECTORY rather than the file: a watch on the file itself
    // survives the first unlink and then follows an inode nothing will ever touch again, and
    // the user plays all evening while Encore records nothing.
    const { path, watcher, recorded } = harness()
    open.push(watcher)
    writeFileSync(path, scoreStats())
    await watcher.start()
    expect(recorded).toHaveLength(1)

    rmSync(path)
    writeFileSync(path, scoreStats({ score_timestamp: '2026-09-11T10:00:00.0000000Z' }))
    await eventually(() => recorded.length === 2)
    expect(recorded[1].playedAt).toBe('2026-09-11T10:00:00.0000000Z')
  })

  it('starts without complaint when Clone Hero is not installed at all', async () => {
    // The directory does not exist, so there is nothing to watch. This must not reject, or
    // startup would surface an error to everyone who does not play the game on this machine.
    const { watcher } = harness({ dirExists: false })
    open.push(watcher)
    await expect(watcher.start()).resolves.toBeUndefined()
    expect(watcher.reason).toBe('noFile')
  })

  it('is safe to stop when it was never started, and to restart', async () => {
    const { path, watcher, recorded } = harness()
    open.push(watcher)
    await watcher.stop()
    await watcher.start()
    await watcher.start()
    writeFileSync(path, scoreStats())
    await eventually(() => recorded.length === 1)
    await watcher.stop()
    await watcher.stop()
  })
})
