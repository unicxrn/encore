import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ScoreFolderReport } from '../../shared/score-folder'

/**
 * Where Clone Hero keeps the files Encore reads: `scorestats.json`, and the two score files.
 *
 * They are in two unrelated places, and the first half of this module is about the first of them.
 * `scorestats.json` sits in Clone Hero's own user-data root; `scoredata.bin` and `scoresext.bin`
 * sit in Unity's `persistentDataPath`, which is somewhere else entirely on every platform. See
 * `scoreDataDirCandidates` at the bottom for the second location and what backs it.
 *
 * ---
 *
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
 *   not an inference. The wiki's "Data Locations" page gives
 *   `~/.config/unity3d/srylain Inc_/Clone Hero` instead, and that page is about a DIFFERENT file:
 *   it names `scoredata.bin`, which a v1.1 install really does keep there, written the same
 *   minute as `scorestats.json` (verified 2026-09-12 on the same install). So the page is right
 *   about the file it describes and says nothing about this one. `scoreDataDirCandidates` below
 *   is where that other location lives.
 *
 * - **macOS**: `~/Clone Hero`. Established for the user-data root by three wiki pages and the
 *   official blog, all agreeing that v1.0 moved everything out of
 *   `~/Library/Application Support/com.srylain.CloneHero` and into `~/Clone Hero`. Only one
 *   candidate is listed, since the pre-v1 location cannot hold a file that did not exist until
 *   v1.1.
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

/** Clone Hero's high score table: one chart per record, and the only record of an old play. */
export const SCORE_DATA_FILE = 'scoredata.bin'

/** The companion file holding the score the game actually reports. See play/scoredata.ts. */
export const SCORES_EXT_FILE = 'scoresext.bin'

/**
 * The copy Clone Hero keeps of each file, one save behind.
 *
 * The game writes these itself, beside the primaries, and Encore reads one only when the primary
 * it belongs to refuses to parse (play/score-watcher.ts). A backup is older than its primary by
 * definition, so it is never preferred; it is what there is when the alternative is nothing.
 */
export const SCORE_DATA_BACKUP_FILE = 'scoredata_backup.bin'
export const SCORES_EXT_BACKUP_FILE = 'scoresext_backup.bin'

/**
 * Every name Encore reads, in the order a user should be told about them.
 *
 * The game's own metadata names three more: `scores.bin`, which predates the pair above and which
 * nothing here decodes, and the two quarantine names below. None of the three is read, and a
 * folder holding only those is not a folder Encore can use.
 */
export const SCORE_FILE_NAMES = [
  SCORE_DATA_FILE,
  SCORES_EXT_FILE,
  SCORE_DATA_BACKUP_FILE,
  SCORES_EXT_BACKUP_FILE
]

/**
 * What Clone Hero renames a score file to when it decides the file is damaged.
 *
 * `scoredata_corrupted_0.bin`, `scoresext_corrupted_1.bin`, and so on. Encore never reads one,
 * and the reason is not squeamishness: the game renamed the file because IT could not read it,
 * which makes it the least likely of anything in the folder to parse; the index carries no
 * ordering anyone has documented, so "the newest quarantined file" is not a thing that can be
 * picked; and a number recovered from one would be presented beside live ones with nothing to
 * say it came from a file the game threw away. They are reported to the user, so a folder that
 * holds only these can be explained rather than called empty, and that is the whole of their use.
 */
const CORRUPTED_SCORE_FILE = /^score(?:data|sext)_corrupted_.*\.bin$/i

/**
 * The files read as a set: the pair, and the backup of each.
 *
 * `scoreData` and `scoresExt` are the primaries and are what the UI reports as "where Encore
 * looked". The two backups are Clone Hero's own and are only read when their primary refuses.
 */
export interface ScoreDataPaths {
  scoreData: string
  scoresExt: string
  scoreDataBackup: string
  scoresExtBackup: string
}

/** The four paths inside one directory. The only place the set is composed. */
export function scoreDataPathsIn(dir: string): ScoreDataPaths {
  return {
    scoreData: join(dir, SCORE_DATA_FILE),
    scoresExt: join(dir, SCORES_EXT_FILE),
    scoreDataBackup: join(dir, SCORE_DATA_BACKUP_FILE),
    scoresExtBackup: join(dir, SCORES_EXT_BACKUP_FILE)
  }
}

/**
 * Unity's company folder for Clone Hero, and the product folder inside it.
 *
 * `srylain Inc.` with the dot rewritten as an underscore is Unity's own sanitising of the
 * company name, not a typo, and it is what the directory on disk is actually called.
 */
const UNITY_COMPANY = 'srylain Inc_'
const UNITY_PRODUCT = 'Clone Hero'

/**
 * Every directory worth probing for the two score files, best-supported first.
 *
 * These files are NOT in Clone Hero's user-data root. They are in Unity's `persistentDataPath`,
 * which the engine composes per platform as `<platform root>/<company>/<product>`, and which
 * moves with the engine rather than with the game's own layout. That is why this is a second,
 * independent resolver rather than another file name appended to `scoreStatsCandidates`: a
 * correction to one of the two locations must not move the other.
 *
 * - **Linux**: `~/.config/unity3d/srylain Inc_/Clone Hero`. **The only verified entry.** The
 *   owner's install holds both files there, written the same minute as
 *   `~/.clonehero/scorestats.json`, against Clone Hero v1.1.0.6142-final on 2026-09-12. The
 *   wiki's "Data Locations" page names the same directory for `scoredata.bin`.
 *
 * - **Windows**: `%USERPROFILE%/AppData/LocalLow/srylain Inc_/Clone Hero`. Verified against a
 *   real Windows install on 2026-09-13: both `scoredata.bin` and `scoresext.bin` are there, and
 *   `scorestats.json` is not, so the two locations split on Windows exactly as they do on Linux.
 *   The `srylain Inc_` spelling is Unity sanitising the trailing period in the company name, and
 *   it is the same on both platforms.
 *
 * - **macOS**: `~/Library/Application Support/srylain Inc_/Clone Hero`, Unity's own macOS
 *   `persistentDataPath`, followed by `~/Library/Application Support/com.srylain.CloneHero`,
 *   which is the shape Unity used before it switched to company-and-product folders and is what
 *   an install carried over from an older build may still be reading. Neither is verified.
 *
 * The shape is the one `scoreStatsCandidates` already uses for an unverifiable platform: a list
 * that is probed rather than a single path committed to, and an empty list where there is no
 * evidence at all, so an unknown platform can be told apart from a missing install.
 */
export function scoreDataDirCandidates(home: string, platform: NodeJS.Platform): string[] {
  switch (platform) {
    case 'linux':
      return [join(home, '.config', 'unity3d', UNITY_COMPANY, UNITY_PRODUCT)]
    case 'win32':
      return [join(home, 'AppData', 'LocalLow', UNITY_COMPANY, UNITY_PRODUCT)]
    case 'darwin':
      return [
        join(home, 'Library', 'Application Support', UNITY_COMPANY, UNITY_PRODUCT),
        join(home, 'Library', 'Application Support', 'com.srylain.CloneHero')
      ]
    default:
      return []
  }
}

/**
 * The two score-file paths to read and watch, or null on a platform with no candidates.
 *
 * Picks the first candidate directory holding EITHER file, and falls back to the first candidate
 * when none does, for the same reason `scoreStatsPath` does: most machines running Encore have no
 * Clone Hero at all, and the watcher still needs a directory to watch in case one appears.
 *
 * Any of the four files rather than all of them, because one is enough to identify the directory
 * and they are not always in step: `scoresext.bin` is the newer of the pair, so an install that
 * has not written it yet has the right directory and only one file in it, and an install whose
 * primary the game has quarantined may have only a backup left. What to do about a half present
 * set is the reader's problem, not the locator's (play/score-watcher.ts).
 */
export function scoreDataPaths(
  home: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync
): ScoreDataPaths | null {
  const dirs = scoreDataDirCandidates(home, platform)
  if (dirs.length === 0) return null
  const dir = dirs.find((d) => SCORE_FILE_NAMES.some((name) => exists(join(d, name)))) ?? dirs[0]
  return scoreDataPathsIn(dir)
}

/**
 * The folder the user pointed Encore at, or null when they have not.
 *
 * One rule in one place, because two callers need the same answer: the resolver below, and the
 * status that says whether a user is looking at their own choice or at Encore's probe. Trimmed
 * because a path that is only whitespace is somebody's cleared setting, not a folder.
 */
export function scoreFolderOverride(setting: string | null | undefined): string | null {
  const trimmed = (setting ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Where to read the score files, honouring the user's setting over the probe.
 *
 * The override wins outright and is not probed for plausibility: it was checked when it was
 * chosen (`inspectScoreFolder`), and a folder that has since gone missing must keep resolving to
 * itself rather than silently sliding back to a guess. Clearing the setting returns to the probe,
 * which is the only way back.
 *
 * This is also the answer for a portable Windows install and for a Clone Hero on a second drive,
 * neither of which any probe can find: the user says where it is.
 */
export function resolveScoreDataPaths(
  override: string | null | undefined,
  home: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync
): ScoreDataPaths | null {
  const chosen = scoreFolderOverride(override)
  if (chosen !== null) return scoreDataPathsIn(chosen)
  return scoreDataPaths(home, platform, exists)
}

/**
 * List a directory, or null when there is nothing there to list.
 *
 * Null covers both "no such directory" and "cannot be read": either way the folder is no use and
 * the report says so. A read that throws for any other reason would be a bug worth seeing, but
 * there is nothing a user could do about it here either, so it is the same answer.
 */
function listDir(dir: string): string[] | null {
  try {
    return readdirSync(dir)
  } catch {
    return null
  }
}

/**
 * What one folder holds, so a user can be told before Encore commits to it.
 *
 * Reads names, never contents: this answers "is this folder any use" and the parse is the
 * watcher's job. Matching is case insensitive because Windows and macOS filesystems usually are,
 * and a `Scoredata.bin` that the game reads fine must not be reported as missing; the name put in
 * the report is the one on disk, so a user is never told about a file spelled differently from
 * the one they can see.
 *
 * `list` is injected for the same reason `exists` is above: the states worth testing are a folder
 * that does not exist and a folder holding only quarantined files, and neither needs a real one.
 */
export function inspectScoreFolder(
  folder: string | null,
  list: (dir: string) => string[] | null = listDir
): ScoreFolderReport {
  const report: ScoreFolderReport = {
    folder,
    exists: false,
    lookedFor: [...SCORE_FILE_NAMES],
    found: [],
    quarantined: [],
    usable: false
  }
  if (folder === null) return report
  const entries = list(folder)
  if (entries === null) return report
  report.exists = true
  const wanted = new Set(SCORE_FILE_NAMES.map((name) => name.toLowerCase()))
  for (const entry of entries) {
    const lower = entry.toLowerCase()
    if (wanted.has(lower)) report.found.push(entry)
    else if (CORRUPTED_SCORE_FILE.test(entry)) report.quarantined.push(entry)
  }
  // Sorted so the message does not change with the order the filesystem happened to return.
  report.found.sort()
  report.quarantined.sort()
  report.usable = report.found.length > 0
  return report
}
