import { buildSng } from '../../src/main/downloads/sng-write'

/**
 * Fixture builders for .sng (SNGPKG v1) archives.
 *
 * The format logic lives in src/main/downloads/sng-write.ts. Fixtures and production code
 * share one writer, so these tests exercise the code that repacks real charts.
 */

/** Fixture alias. Production code calls buildSng directly. */
export const makeSng = buildSng

/**
 * A .sng shaped like the ones Chorus actually ships: NO song.ini entry, all song details in
 * the archive header. The chart itself carries no title either, so anything that reaches the
 * catalog had to come from the header, which only happens if the extractor generates
 * song.ini from it.
 */
export function makeHeaderMetadataSng(): Buffer {
  const encoder = new TextEncoder()
  return makeSng(
    [
      {
        fileName: 'notes.chart',
        data: encoder.encode(
          '[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
        )
      }
    ],
    {
      name: 'Header Song',
      artist: 'Header Artist',
      charter: 'Header Charter',
      diff_guitar: '5',
      // -1 is song.ini's "this instrument has no rating". Real charts ship it constantly.
      diff_bass: '-1',
      preview_start_time: '45000'
    }
  )
}

export function makeFixtureSng(): Buffer {
  const encoder = new TextEncoder()
  return makeSng([
    {
      fileName: 'song.ini',
      data: encoder.encode(
        '[song]\nname = Sng Song\nartist = Sng Artist\ncharter = Tester\ndiff_guitar = 3\n'
      )
    },
    {
      fileName: 'notes.chart',
      data: encoder.encode(
        '[Song]\n{\n  Name = "Sng Song"\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n[ExpertSingle]\n{\n  192 = N 0 0\n  384 = N 1 0\n  576 = N 2 96\n}\n'
      )
    }
  ])
}
