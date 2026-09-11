import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where Clone Hero keeps `scorestats.json`, the file it rewrites after every play.
 *
 * **No source anywhere gives this file's path.** The wiki has no page for it (a search for
 * "scorestats" returns nothing), the release notes that introduce it do not say where it goes,
 * and no GitHub issue names one. What IS established is Clone Hero's user-data ROOT per
 * platform, which `catalog/detect-library.ts` already resolves in order to find `<root>/Songs`.
 * This module reuses that root and adds the file name to it, so a correction to either lands in
 * both.
 *
 * Three independent signals put the file in that root rather than somewhere else:
 *
 * 1. The owner's Linux install has it at `~/.clonehero/scorestats.json`, directly beside
 *    `settings.ini`, `profiles.ini`, `Songs/` and `Logs/`. Verified 2026-09-11 against Clone
 *    Hero v1.1.0.6142-final.
 * 2. The release note that introduced it pairs it with the Replays feature, whose folder the
 *    same note writes as `Clone Hero/Replays` — the root under its own name.
 * 3. CHSuite, the one third-party tool known to touch the file, migrates it as a top-level
 *    sibling of `GameData/`, `PlayerData/` and `profiles.ini` rather than inside any of them.
 *
 * The feature is new, which is why nothing documents it: it first appeared in v1.1.0.4990-PTB
 * (2025-05-21, "Implement scorestats.json score export at the end of a song") and reached stable
 * in v1.1.0.6085-final (2026-05-01). A user on an older Clone Hero has no such file at all, and
 * that is one of the ordinary "nothing to show" cases rather than a fault.
 *
 * Because the file name is inferred on every platform but Linux, this resolves a LIST of
 * candidates and probes them, rather than committing to one path that would fail silently. See
 * `scoreStatsCandidates` for what each platform's list is and what backs it.
 */

/** The file name Clone Hero writes into its user-data root. */
export const SCORE_STATS_FILE = 'scorestats.json'

/**
 * Every path worth probing for a platform, best-supported first.
 *
 * - **Linux**: `~/.clonehero`. Verified directly; this is the one entry on any platform that is
 *   not an inference. Note the stale wiki "Data Locations" page claims
 *   `~/.config/unity3d/srylain Inc_/Clone Hero` instead — that page is at revision 2 from
 *   2023-06-02 and describes the pre-v1 Unity layout and a different file (`scoredata.bin`). Its
 *   Linux path is demonstrably wrong for a v1.1 install, which is the reason nothing else it
 *   says is trusted here either.
 *
 * - **macOS**: `~/Clone Hero`. Established for the user-data root by three wiki pages and the
 *   official blog, all agreeing that v1.0 moved everything out of
 *   `~/Library/Application Support/com.srylain.CloneHero` and into `~/Clone Hero`. The
 *   "Application Support still holds scores" claim that contradicts this traces to the same
 *   stale Data Locations page as above, and to nothing else. Only one candidate is listed, since
 *   the pre-v1 location cannot hold a file that did not exist until v1.1.
 *
 * - **Windows**: `<Documents>/Clone Hero` first, per the wiki's Installation page ("settings,
 *   profiles, custom content, and songs go into Documents > Clone Hero"), which is the same root
 *   detect-library resolves Songs under. `AppData/LocalLow/srylain Inc_/Clone Hero` follows it
 *   because the migration guide says "score saves and other hidden data are stored" there, and
 *   this is a score file. Which of the two actually receives it is NOT documented; probing both
 *   is cheaper than being wrong, and the order encodes which is likelier rather than a guess
 *   about which is possible.
 *
 * `documents` is a parameter because OneDrive commonly redirects the Windows Documents folder
 * and Clone Hero's own troubleshooting treats the redirected folder as the game's real one, so
 * main passes Electron's resolved known folder rather than `<home>/Documents`.
 *
 * Not covered, and deliberately: a portable Windows install, which keeps its data in the game's
 * own directory and has no fixed path. detect-library documents the same gap for Songs.
 */
export function scoreStatsCandidates(
  home: string,
  platform: NodeJS.Platform,
  documents: string = join(home, 'Documents')
): string[] {
  switch (platform) {
    case 'linux':
      return [join(home, '.clonehero', SCORE_STATS_FILE)]
    case 'darwin':
      return [join(home, 'Clone Hero', SCORE_STATS_FILE)]
    case 'win32':
      return [
        join(documents, 'Clone Hero', SCORE_STATS_FILE),
        join(home, 'AppData', 'LocalLow', 'srylain Inc_', 'Clone Hero', SCORE_STATS_FILE)
      ]
    default:
      // An unrecognised platform gets no guess. A probe of an invented path finds nothing and
      // leaves the user with no explanation of why; a null path at least lets the UI say that
      // Encore does not know where to look here.
      return []
  }
}

/**
 * The scorestats.json path to watch, or null when the platform has no candidates at all.
 *
 * Picks the first candidate that exists. When none does — the common case, since most users have
 * no Clone Hero on the machine running Encore — it falls back to the FIRST candidate rather than
 * to null, so the watcher has somewhere to watch and picks the file up if it appears later. That
 * fallback is why `null` here means only "this platform is unknown to us", never "not installed":
 * the two need different wording, and the second is not the user's problem to solve.
 *
 * `exists` is injected, as it is in detect-library, so tests can drive every platform's list
 * without an install of it.
 */
export function scoreStatsPath(
  home: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
  documents: string = join(home, 'Documents')
): string | null {
  const candidates = scoreStatsCandidates(home, platform, documents)
  if (candidates.length === 0) return null
  return candidates.find(exists) ?? candidates[0]
}
