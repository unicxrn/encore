import { rewriteSngPlan } from '../assets/sng-asset'
import { withChartLock, writeChartAsset } from '../assets/write'
import { chartTypeAt, scanChartIssues } from '../catalog/issues'
import { readRepackPlan } from '../downloads/sng-repack'
import { readChartIniFiles, type ChartIniFiles } from '../issues/chart-ini'
import { assertChartHashUnchanged, assertCloneHeroChecksumUnchanged } from '../issues/fix'
import {
  assertKeyIsNotHashed,
  HASHED_INI_KEYS,
  readSongIniKey,
  setSongIniKey
} from '../issues/ini-edit'
import {
  EDITABLE_INI_KEYS,
  yearRefusal,
  type ChartMetadataFields,
  type EditableIniKey
} from '../../shared/metadata-fields'
import type { ChartListMove } from '../../shared/chart-key'
import type { ChartRecord } from '../../shared/schemas'

/**
 * Writing the six `song.ini` fields the Issues view refuses to repair.
 *
 * `missingValue` is the one scan-chart code Encore reports and deliberately offers no fix for: a
 * Chorus entry matched by exact hash is built from this same upload and carries the same blank,
 * measured across all 78 rows of the reference library (`FIX_ACTIONS` in issues/fix.ts). The
 * conclusion there was that nothing can fill those fields from a button. It was never that
 * nothing can fill them: the person who owns the chart knows what album it is from. This module
 * is that, and nothing wider. See shared/metadata-fields.ts for why those six and not others.
 *
 * ## What it is not allowed to do
 *
 * The same rule every writer in this app is under, and the reason this is a new module rather
 * than a new fix action: **a write may not change what Clone Hero matches charts by.** Two
 * identities are asserted afterwards and success is refused unless both are byte-identical, on
 * the terms `applyFix` set out: `cloneHeroChecksum`, the MD5 the game itself records for a chart
 * (catalog/chart-checksum.ts), and scan-chart's `chartHash`, which additionally covers the seven
 * gameplay ini keys.
 *
 * Unlike a repair, this edit CANNOT move either one, and that is worth being precise about rather
 * than leaning on. `getChartHash` hashes the chart file's bytes plus seven named ini keys, none of
 * which is among the six offered here, and `cloneHeroChecksum` is the chart file's bytes alone.
 * So retitling a song costs the user nothing: not multiplayer, and not the play history, which is
 * joined on `cloneHeroChecksum` and therefore survives any change to song.ini at all.
 *
 * The assertions stay for what they catch when that reasoning stops being true. A `.sng` edit is
 * a whole-archive repack, and an archive rebuilt with a damaged chart entry moves both numbers; a
 * line editor that ran off the end of the line it meant to edit would take the next key with it,
 * and if that key were `pro_drums` only `chartHash` would see it. Neither is a hypothetical the
 * user should have to discover in a lobby.
 *
 * Three guards stand in front of the write as well as the two behind it:
 * `assertKeyIsNotHashed` refuses any of the seven before a byte is read, the IPC boundary parses
 * the field names against `EDITABLE_INI_KEYS`, and `setSongIniKey` refuses a value carrying a
 * line break.
 *
 * ## Why there is no backup
 *
 * Every repair in `issues/` copies aside what it replaces, because a repair is Encore acting on
 * its own judgement and the user has no way to know what the old value was. Here the old value is
 * on the screen, in the box, when they type over it: the undo is retyping it, and an undo list
 * carrying "changed the album" beside a video conversion would say the two are the same kind of
 * event. What the store would still buy is protection against a write that succeeds and produces
 * something nobody asked for, and `assertFieldsLanded` below is the answer to that: the chart is
 * re-read after the write and success is refused unless every field says exactly what was asked
 * for. A backup proves nothing about the file that is now on disk; that does.
 */

/** What the editor shows for one chart before anything is typed. */
export interface ChartMetadataRead {
  chartPath: string
  chartType: 'folder' | 'sng'
  /** The `.ini` scan-chart reads, or null when the chart has none. */
  iniName: string | null
  /**
   * True when the values live in the archive's header rather than in a packed file, which is
   * how Chorus ships `.sng` charts and what makes the edit a repack. See `ChartIniFiles`.
   */
  synthetic: boolean
  /** The raw values, exactly as the file or the header holds them. `''` means unset. */
  fields: ChartMetadataFields
  /**
   * The gameplay keys this chart sets, with their values, so the form can show what it refuses
   * to edit rather than pretend those fields do not exist.
   *
   * Filtered from `HASHED_INI_KEYS`, which is nine names for seven values: two of the seven have
   * a legacy spelling scan-chart falls back to, and a chart that uses one really does feed the
   * hash through it. So a chart can list `hopofreq` here, and that row is this chart's
   * `hopo_frequency`.
   *
   * A key the chart does not set is absent, which is also how the hash treats it: `getChartHash`
   * filters to the modifiers that DIFFER from `defaultMetadata` before hashing any of them.
   */
  gameplay: { key: string; value: string }[]
  /** Why this chart cannot be edited at all, in words the form can show, or null. */
  refusal: string | null
}

/**
 * One metadata save: which chart, and only the fields the user changed.
 *
 * Declared here rather than beside the IPC handler that parses it, and that placement is load
 * bearing: the preload imports this type, and the renderer's TypeScript project follows the
 * preload's imports. A request shape living in `main/ipc.ts` would pull the whole IPC surface,
 * and every type it names, into the renderer's compilation.
 */
export interface ChartMetadataWriteRequest {
  path: string
  chartType: 'folder' | 'sng'
  fields: Partial<ChartMetadataFields>
}

/** What a save changed, and the two numbers proving it changed nothing else. */
export interface ChartMetadataWrite {
  chartPath: string
  chartType: 'folder' | 'sng'
  /** The fields whose value on disk is now different. Empty when the form matched the file. */
  changed: EditableIniKey[]
  chartHash: string | null
  cloneHeroChecksum: string | null
}

export interface ChartMetadataSaved extends ChartMetadataWrite {
  /**
   * The chart's catalog row after main re-indexed it, or null when the catalog has no row for
   * this path.
   *
   * Returned rather than left to a second call, on the same reasoning as `rescanCharts`: these
   * six values are what every list in Encore shows, so a save that resolved before the row caught
   * up would leave the user looking at the old album on the page they just corrected.
   */
  record: ChartRecord | null
  /**
   * What the save did to the user's own lists, or null when it did nothing to them.
   *
   * Three of the six fields this editor writes are the three a favourite and a setlist entry are
   * keyed by, so a save can rename the thing those rows name. `main/catalog/rekey.ts` carries them
   * across and this is its report; `describeChartListMove` turns it into the sentence the form
   * prints. Null covers both "the three did not move" and "they moved and nothing was on a list",
   * which are the same non-event to a reader.
   */
  listMove: ChartListMove | null
}

/**
 * A `.sng` that packs its own `song.ini` as well as header metadata, refused in the same words
 * `extraValue` refuses it and for the same reason.
 *
 * scan-chart reads the packed file and Clone Hero's song list reads the header, so there are two
 * answers to "what is this chart's album" and editing one would leave the other contradicting it.
 * Editing both is two changes to a chart the user asked one thing about.
 */
function packedIniRefusal(chartPath: string): string {
  return (
    `${chartPath} packs its own song.ini as well as header metadata, and Encore will not ` +
    `guess which of the two Clone Hero reads. Remove the packed song.ini and re-scan.`
  )
}

/** Refuse a key the renderer should never have sent, before anything is read. */
function assertEditableKey(key: string): asserts key is EditableIniKey {
  // The hashed check first, so a key that is both unknown and hashed is refused with the sentence
  // that says why rather than with the generic one.
  assertKeyIsNotHashed(key)
  if (!(EDITABLE_INI_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Encore's metadata editor does not edit "${key}" in song.ini.`)
  }
}

/** Every editable key at `''`, which is what an unset field reads as. */
function emptyFields(): ChartMetadataFields {
  return Object.fromEntries(EDITABLE_INI_KEYS.map((key) => [key, ''])) as ChartMetadataFields
}

/**
 * Read the six fields and the seven gameplay values, from whichever of the two places this
 * chart's metadata lives in.
 *
 * Reads rather than scans: `scanChartIssues` would hand back scan-chart's interpretation, where
 * an unset album is the string `Unknown Album` and an unset year is `Unknown Year`. Writing those
 * back would put those words in the user's file. The editor's job is to show what is there.
 */
export async function readChartMetadata(
  chartPath: string,
  chartType: 'folder' | 'sng'
): Promise<ChartMetadataRead> {
  const ini = await readChartIniFiles(chartPath, chartType)
  const base = {
    chartPath,
    chartType,
    iniName: ini.reads,
    synthetic: ini.synthetic,
    fields: emptyFields(),
    gameplay: [] as { key: string; value: string }[]
  }
  if (ini.reads === null || ini.data === null) {
    return {
      ...base,
      refusal:
        `${chartPath} has no song.ini for Encore to edit. Clone Hero reads a chart's song ` +
        `details from that file, so there is nothing here to correct.`
    }
  }
  if (chartType === 'sng' && !ini.synthetic) {
    return { ...base, refusal: packedIniRefusal(chartPath) }
  }

  // A `.sng`'s values are read from the header rather than from the ini the reader synthesised
  // out of it, because the header is what a save writes back to. Going through the generated file
  // would lose every key it omits for holding its default, and the editor would then show an
  // empty box for a field the archive really does set.
  if (ini.synthetic) {
    const { metadata } = await readRepackPlan(chartPath)
    const fields = emptyFields()
    for (const key of EDITABLE_INI_KEYS) fields[key] = metadata[key] ?? ''
    return {
      ...base,
      fields,
      gameplay: HASHED_INI_KEYS.filter((key) => Object.hasOwn(metadata, key)).map((key) => ({
        key,
        value: metadata[key]
      })),
      refusal: null
    }
  }

  const fields = emptyFields()
  for (const key of EDITABLE_INI_KEYS) fields[key] = readSongIniKey(ini.data, key)
  const gameplay: { key: string; value: string }[] = []
  for (const key of HASHED_INI_KEYS) {
    const value = readSongIniKey(ini.data, key)
    if (value !== '') gameplay.push({ key, value })
  }
  return { ...base, fields, gameplay, refusal: null }
}

/**
 * Write the named fields into one chart's `song.ini`, then prove nothing else moved.
 *
 * The order is `applyFix`'s, minus the backup and plus a check of its own, and every step of it
 * is load-bearing:
 *
 * 1. Resolve the chart's shape, which throws if the chart is no longer there. A caller about to
 *    write to a path needs that as a refusal, not as an ENOENT from four frames down.
 * 2. Take the chart's write lock. Everything below reads and writes one chart, and an asset write
 *    or a repair landing in the middle would make the before/after comparison meaningless.
 * 3. Read both identities INSIDE the lock. Reading them outside would compare against a chart
 *    some other writer had already changed, and blame this edit for theirs.
 * 4. Build the new bytes, refuse a value the file cannot hold, and return early when the form
 *    matched the file. A write that changes nothing still rewrites the chart's mtime and, for a
 *    `.sng`, copies the whole archive.
 * 5. Write, through `writeChartAsset` for a folder and `rewriteSngPlan` for an archive. There is
 *    no third path and there must not be one.
 * 6. Re-scan that one chart and refuse unless BOTH identities are identical.
 * 7. Re-read the fields and refuse unless every one of them says what was asked for.
 *
 * There is no rollback, for the reason `applyFix` gives: it would be code that only ever runs in
 * the situation we have already established we do not understand, and it has no test that could
 * exercise it honestly. A failure leaves the message and the chart as it stands.
 */
export async function writeChartMetadata(
  chartPath: string,
  fields: Partial<ChartMetadataFields>,
  libraryFolders: { path: string }[]
): Promise<ChartMetadataWrite> {
  for (const key of Object.keys(fields)) assertEditableKey(key)
  const yearRefused = fields.year === undefined ? null : yearRefusal(fields.year)
  if (yearRefused !== null) throw new Error(yearRefused)

  const chartType = chartTypeIfPresent(chartPath)
  return withChartLock(chartPath, async () => {
    const before = await scanChartIssues(chartPath, chartType)
    const ini = await requireEditableIni(chartPath, chartType)

    const changed = ini.synthetic
      ? await writeSngHeaderFields(chartPath, fields, libraryFolders)
      : writeIniFileFields(chartPath, ini, fields, libraryFolders)

    if (changed.length === 0) {
      return {
        chartPath,
        chartType,
        changed,
        chartHash: before.chartHash,
        cloneHeroChecksum: before.cloneHeroChecksum
      }
    }

    const after = await scanChartIssues(chartPath, chartType)
    // Clone Hero's own number first, scan-chart's model second, which is the order and the
    // reasoning `applyFix` uses: between them they partition the failures, and each has one this
    // edit could produce that the other would not report in the game's terms.
    assertCloneHeroChecksumUnchanged(chartPath, before.cloneHeroChecksum, after.cloneHeroChecksum)
    assertChartHashUnchanged(chartPath, before.chartHash, after.chartHash)
    await assertFieldsLanded(chartPath, chartType, fields)
    return {
      chartPath,
      chartType,
      changed,
      chartHash: after.chartHash,
      cloneHeroChecksum: after.cloneHeroChecksum
    }
  })
}

/**
 * The chart's shape, or a refusal naming the path.
 *
 * `chartTypeAt` stats the path and throws a bare ENOENT for a chart that has been moved, renamed
 * or deleted since the form was opened, which is the likeliest way this call fails and the one a
 * user has the most chance of recognising. The editor is a form somebody may leave open, so this
 * is not an exotic case.
 */
function chartTypeIfPresent(chartPath: string): 'folder' | 'sng' {
  try {
    return chartTypeAt(chartPath)
  } catch {
    throw new Error(
      `${chartPath} is not there any more, so Encore has not changed anything. It may have been ` +
        `moved, renamed or removed since this chart was opened. Scan the library again.`
    )
  }
}

/** The chart's ini situation, with the cases this module refuses already turned into errors. */
async function requireEditableIni(
  chartPath: string,
  chartType: 'folder' | 'sng'
): Promise<ChartIniFiles & { reads: string; data: Uint8Array }> {
  const ini = await readChartIniFiles(chartPath, chartType)
  if (ini.reads === null || ini.data === null) {
    throw new Error(`${chartPath} has no song.ini to edit. Scan the library again and retry.`)
  }
  if (chartType === 'sng' && !ini.synthetic) throw new Error(packedIniRefusal(chartPath))
  return { ...ini, reads: ini.reads, data: ini.data }
}

/**
 * Edit a folder chart's ini file and write it back under the name it already had.
 *
 * One write for however many fields changed, rather than one per field: the alternative would
 * leave the chart holding half an edit if the second write failed, and would cost a rename per
 * field for no gain. `writeChartAsset` is the folder half of the one write path, and the name it
 * is given is the name scan-chart reads (`readChartIniFiles`), which for a chart carrying a
 * `desktop.ini` and no `song.ini` really is `desktop.ini`.
 */
function writeIniFileFields(
  chartPath: string,
  ini: { reads: string; data: Uint8Array },
  fields: Partial<ChartMetadataFields>,
  libraryFolders: { path: string }[]
): EditableIniKey[] {
  let bytes = ini.data
  const changed: EditableIniKey[] = []
  for (const [key, value] of Object.entries(fields) as [EditableIniKey, string][]) {
    const write = setSongIniKey(bytes, key, value.trim())
    if (!write.changed) continue
    bytes = write.bytes
    changed.push(key)
  }
  if (changed.length === 0) return changed
  // The same name back, so no stale-sibling sweep is needed and no other file is disturbed.
  writeChartAsset(chartPath, ini.reads, bytes, libraryFolders)
  return changed
}

/**
 * Edit a `.sng`'s header metadata and repack around it.
 *
 * An empty value DELETES the key rather than writing an empty one, which is the same choice
 * `removeFromSngHeader` made for `extraValue` and for the same reason: `generateSongIniText`
 * omits a key holding an empty value, so the two are identical to every reader, and one of them
 * leaves the header carrying a field that means "unset" where there should be no field at all.
 *
 * `verifyRepack` compares the rebuilt archive against the plan it was BUILT from, so a
 * deliberately changed key verifies as correct. What it still proves is that the archive on disk
 * is exactly the one that was asked for, key for key and byte for byte, and that the rebuild
 * invented no key of its own.
 */
async function writeSngHeaderFields(
  chartPath: string,
  fields: Partial<ChartMetadataFields>,
  libraryFolders: { path: string }[]
): Promise<EditableIniKey[]> {
  const changed: EditableIniKey[] = []
  const { metadata } = await readRepackPlan(chartPath)
  const next: Record<string, string> = { ...metadata }
  for (const [key, value] of Object.entries(fields) as [EditableIniKey, string][]) {
    const wanted = value.trim()
    const current = Object.hasOwn(metadata, key) ? metadata[key] : ''
    if (current === wanted) continue
    if (wanted === '') delete next[key]
    else next[key] = wanted
    changed.push(key)
  }
  if (changed.length === 0) return changed
  // A fresh object rather than a mutation of the plan's own: the caller's plan describes the
  // archive still on disk, and it is what a failed rebuild leaves behind.
  await rewriteSngPlan(chartPath, (plan) => ({ ...plan, metadata: next }), libraryFolders)
  return changed
}

/**
 * Refuse to report a save whose values are not the ones now on disk.
 *
 * The check a backup would not have made. Both identity assertions can pass over a chart whose
 * album is now something nobody typed: neither of them looks at these six keys, which is the
 * whole reason those keys are safe to edit. So the last thing this does is read the chart back
 * the way the form will read it and compare.
 *
 * Trimmed on both sides because `parseIni` trims a value as it reads it, so a field saved with
 * trailing spaces comes back without them and is still exactly what was asked for.
 *
 * Exported for its own test. Nothing this module writes can make it fire, which is exactly why
 * it is here and why a test would otherwise have no way to show that it works: driving it
 * directly, against a chart that says something other than what was asked for, is the only
 * honest demonstration that the check between a wrong write and a reported success is real.
 */
export async function assertFieldsLanded(
  chartPath: string,
  chartType: 'folder' | 'sng',
  fields: Partial<ChartMetadataFields>
): Promise<void> {
  const back = await readChartMetadata(chartPath, chartType)
  for (const [key, value] of Object.entries(fields) as [EditableIniKey, string][]) {
    if (back.fields[key] === value.trim()) continue
    throw new Error(
      `Encore wrote ${chartPath} but it does not read back as asked: "${key}" is now ` +
        `${JSON.stringify(back.fields[key])} and should be ${JSON.stringify(value.trim())}. The ` +
        `chart has NOT been restored. This is a bug in Encore, not something you did.`
    )
  }
}
