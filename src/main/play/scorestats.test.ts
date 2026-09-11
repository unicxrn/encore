import { describe, expect, it } from 'vitest'
import { parseScoreStats } from './scorestats'

/**
 * A scorestats.json body of the exact shape Clone Hero v1.1.0.6142-final writes.
 *
 * Copied from the real file's structure rather than reduced to the fields the parser reads: the
 * fields it ignores are the ones a future version is most likely to change, and a fixture
 * trimmed to what we use could not catch a parser that started depending on one of them.
 */
function realShaped(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    game_version: 'v1.1.0.6142-final',
    checksum: 'E54E9A0521444E81BD1FED4F3F3A3201',
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
        modifiers: ['None'],
        remote_network_player: false,
        lefty_flip: false,
        no_fail: true,
        video_calibration: 0,
        audio_calibration: 0,
        controller_type: 'Guitar',
        score: 40122,
        base_score: 76450,
        solo_bonus_total: 0,
        squeezed_score: 0,
        clean_play_bonus: 22,
        note_score: 39750,
        sustain_score: 0,
        sp_score: 0,
        combo_score: 350,
        notes_hit: 795,
        total_notes: 1529,
        max_streak: 12,
        end_streak: 0,
        excess_hits: 893,
        sp_phrases_earned: 0,
        sp_phrases_total: 17,
        sp_activations: 0,
        time_in_sp: 0,
        sp_ticks_accumulated: 0,
        sp_bar_ticks: 5760,
        stars: 2,
        avg_multiplier: 0.524525821,
        squeezed_notes: 0,
        squeeze_note_losses: 0,
        frets_ghosted: 9,
        accent_notes_hit: 0,
        accent_notes_total: 0,
        ghost_notes_hit: 0,
        ghost_notes_total: 0,
        is_fc: false,
        versus_winner: true,
        is_bot: false,
        is_pfc: false,
        failed_in_run_time: 15145,
        section_count: 1,
        section_stats: [{ section_name: 'Intro A', notes_hit: 44, notes_count: 66 }]
      }
    ],
    ...overrides
  })
}

describe('parseScoreStats', () => {
  it('reads the fields the catalog stores out of a real-shaped file', () => {
    expect(parseScoreStats(realShaped())).toEqual({
      // Clone Hero writes upper hex; everything downstream compares lower.
      checksum: 'e54e9a0521444e81bd1fed4f3f3a3201',
      playedAt: '2026-09-10T22:23:37.1089500Z',
      songName: 'Skrting On The Surface',
      artistName: 'The Smile',
      charterName: 'Mech',
      gameVersion: 'v1.1.0.6142-final',
      gameMode: 'Quickplay',
      playbackSpeed: 100,
      bandScore: 40122,
      bandStars: 2,
      playerCount: 1,
      instrument: 'Guitar',
      difficulty: 'Expert',
      profileName: 'Aevyx',
      score: 40122,
      notesHit: 795,
      totalNotes: 1529,
      maxStreak: 12,
      isFc: false,
      isPfc: false,
      stars: 2,
      avgMultiplier: 0.524525821
    })
  })

  it('keeps the timestamp byte for byte rather than round-tripping it through Date', () => {
    // .NET writes seven fractional digits and JavaScript's Date holds three. Losing the last
    // four would make two plays seconds apart collide on the table's UNIQUE key, and the second
    // would be silently discarded as "already recorded".
    const play = parseScoreStats(realShaped())
    expect(play!.playedAt).toBe('2026-09-10T22:23:37.1089500Z')
    expect(new Date(play!.playedAt).toISOString()).not.toBe(play!.playedAt)
  })

  it('returns null for a truncated write caught mid-save', () => {
    const full = realShaped()
    // Every prefix of a valid JSON document, which is what a reader racing the game sees.
    for (const cut of [1, 10, 100, 400, full.length - 1]) {
      expect(parseScoreStats(full.slice(0, cut)), `prefix of ${cut} bytes`).toBeNull()
    }
  })

  it('returns null for malformed and empty input', () => {
    expect(parseScoreStats('')).toBeNull()
    expect(parseScoreStats('   ')).toBeNull()
    expect(parseScoreStats('not json at all')).toBeNull()
    expect(parseScoreStats('{ "checksum": }')).toBeNull()
    // Valid JSON, wrong kind of thing.
    expect(parseScoreStats('null')).toBeNull()
    expect(parseScoreStats('42')).toBeNull()
    expect(parseScoreStats('"a string"')).toBeNull()
    expect(parseScoreStats('[]')).toBeNull()
  })

  it('returns null when the play cannot name a chart', () => {
    expect(parseScoreStats(realShaped({ checksum: undefined }))).toBeNull()
    expect(parseScoreStats(realShaped({ checksum: '' }))).toBeNull()
    expect(parseScoreStats(realShaped({ checksum: 'not-a-checksum' }))).toBeNull()
    expect(parseScoreStats(realShaped({ checksum: 12345 }))).toBeNull()
  })

  it('returns null when the play has no usable timestamp', () => {
    // Without one there is no identity, so the row would either duplicate on every re-read or
    // collide with a real play.
    expect(parseScoreStats(realShaped({ score_timestamp: undefined }))).toBeNull()
    expect(parseScoreStats(realShaped({ score_timestamp: 'yesterday' }))).toBeNull()
    expect(parseScoreStats(realShaped({ score_timestamp: 0 }))).toBeNull()
  })

  it('returns null when there is no player to read', () => {
    expect(parseScoreStats(realShaped({ players: [] }))).toBeNull()
    expect(parseScoreStats(realShaped({ players: undefined }))).toBeNull()
    expect(parseScoreStats(realShaped({ players: 'Aevyx' }))).toBeNull()
    expect(parseScoreStats(realShaped({ players: [null] }))).toBeNull()
  })

  it('nulls individual fields it cannot read rather than losing the whole play', () => {
    // A future Clone Hero that renames or drops a stat must cost that column, not the play.
    const play = parseScoreStats(
      realShaped({
        song_name: undefined,
        artist_name: '',
        band_score: 'forty thousand',
        players: [{ instrument: 'Guitar', score: 1, is_fc: true }]
      })
    )
    expect(play).not.toBeNull()
    expect(play!.songName).toBeNull()
    expect(play!.artistName).toBeNull()
    expect(play!.bandScore).toBeNull()
    expect(play!.difficulty).toBeNull()
    expect(play!.notesHit).toBeNull()
    expect(play!.score).toBe(1)
    expect(play!.isFc).toBe(true)
    // Absent, not false: a missing flag means "did not happen", which is the same answer.
    expect(play!.isPfc).toBe(false)
  })

  it('reads the first player and records how many there were', () => {
    const play = parseScoreStats(
      realShaped({
        player_count: 2,
        players: [
          { instrument: 'Guitar', profile_name: 'Aevyx', score: 100 },
          { instrument: 'Drums', profile_name: 'Someone Else', score: 999_999 }
        ]
      })
    )
    // The second player is a different human on a different controller; attributing their score
    // to this user's history would be wrong. player_count is kept so a band play is not
    // presented as a solo one.
    expect(play!.profileName).toBe('Aevyx')
    expect(play!.score).toBe(100)
    expect(play!.playerCount).toBe(2)
  })
})
