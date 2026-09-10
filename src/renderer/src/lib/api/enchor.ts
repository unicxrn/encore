import { ENCHOR_FILES_URL } from '../../../../shared/constants'

export const ENCHOR_API = 'https://api.enchor.us'
export const ENCHOR_FILES = ENCHOR_FILES_URL

export interface SearchParams {
  search: string
  page?: number
  instrument?: string | null
  difficulty?: string | null
  sort?: { type: string; direction: 'asc' | 'desc' }
}

export interface FilterOption {
  readonly value: string | null
  readonly label: string
}

export const INSTRUMENTS: readonly FilterOption[] = [
  { value: null, label: 'Any instrument' },
  { value: 'guitar', label: 'Guitar' },
  { value: 'bass', label: 'Bass' },
  { value: 'drums', label: 'Drums' },
  { value: 'keys', label: 'Keys' },
  { value: 'rhythm', label: 'Rhythm' },
  { value: 'guitarcoop', label: 'Guitar co-op' },
  { value: 'guitarghl', label: 'Guitar (GHL)' },
  { value: 'bassghl', label: 'Bass (GHL)' },
  { value: 'rhythmghl', label: 'Rhythm (GHL)' },
  { value: 'guitarcoopghl', label: 'Co-op (GHL)' }
]

export const DIFFICULTIES: readonly FilterOption[] = [
  { value: null, label: 'Any difficulty' },
  { value: 'expert', label: 'Expert' },
  { value: 'hard', label: 'Hard' },
  { value: 'medium', label: 'Medium' },
  { value: 'easy', label: 'Easy' }
]

// Real notesData shape as returned by api.enchor.us search responses (verified live 2026-09-07):
// notesData.noteCounts: { instrument: string; difficulty: string; count: number }[]
// notesData.maxNps:     { instrument: string; difficulty: string; nps: number; time: number }[]
// notesData.instruments: string[]  (array of present instrument names)
// notesData may be null on some responses (e.g. unprocessed charts).
export interface NoteCount {
  instrument: string
  difficulty: string
  count: number
}

export interface MaxNps {
  instrument: string
  difficulty: string
  nps: number
  time: number
}

export interface NotesData {
  instruments?: string[]
  noteCounts?: NoteCount[]
  maxNps?: MaxNps[]
  hasSoloSections?: boolean
  hasLyrics?: boolean
  hasVocals?: boolean
  hasForcedNotes?: boolean
  hasTapNotes?: boolean
  hasOpenNotes?: boolean
  has2xKick?: boolean
}

export interface ChartData {
  chartId: number
  songId: number | null
  md5: string
  albumArtMd5: string | null
  hasVideoBackground: boolean
  name: string
  artist: string
  album: string
  genre: string
  year: string
  charter: string
  song_length: number | null
  diff_guitar: number | null
  diff_bass: number | null
  diff_drums: number | null
  diff_keys: number | null
  diff_vocals: number | null
  modifiedTime?: string
  notesData?: NotesData | null
}

export interface SearchResult {
  found: number
  out_of: number
  page: number
  data: ChartData[]
}

const MAX_ATTEMPTS = 4

export interface SearchOpts {
  retryDelayMs?: number
  signal?: AbortSignal
}

const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'

export async function searchCharts(
  params: SearchParams,
  fetchFn: typeof fetch = fetch,
  opts: SearchOpts = {}
): Promise<SearchResult> {
  const body = JSON.stringify({
    search: params.search,
    per_page: 25,
    page: params.page ?? 1,
    instrument: params.instrument ?? null,
    difficulty: params.difficulty ?? null,
    drumType: null,
    drumsReviewed: true,
    sort: params.sort ?? null,
    source: 'api'
  })
  let lastError: Error = new Error('unreachable')
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetchFn(`${ENCHOR_API}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: opts.signal
    }).catch((err: unknown) => err)
    if (isAbort(response)) throw response
    if (response instanceof Response && response.ok) {
      return (response.json() as Promise<SearchResult>).catch(() => {
        throw new Error('Search failed: invalid response')
      })
    }
    // Client errors are terminal: retrying cannot change the answer, and for
    // 429 it actively makes things worse. api.enchor.us allows 50 requests per
    // window (measured: request 51 returns 429), so four attempts per search
    // keeps a rate-limited client over the limit indefinitely. Every Explore
    // search fails and the view looks broken until the user stops touching it.
    if (response instanceof Response && response.status >= 400 && response.status < 500) {
      throw new Error(
        response.status === 429
          ? 'Too many searches. Chorus Encore limits how often it can be asked. Wait a moment and retry.'
          : `Search failed: ${response.status}`
      )
    }
    lastError =
      response instanceof Error
        ? response
        : response instanceof Response
          ? new Error(`Search failed: ${response.status}`)
          : new Error(String(response))
    if (attempt < MAX_ATTEMPTS) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, (opts.retryDelayMs ?? 1000) * 2 ** (attempt - 1))
      )
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    }
  }
  throw lastError
}

export function chartDownloadUrl(md5: string, stripVideo: boolean): string {
  return `${ENCHOR_FILES}/${md5}${stripVideo ? '_novideo' : ''}.sng`
}

export function albumArtUrl(albumArtMd5: string): string {
  return `${ENCHOR_FILES}/${albumArtMd5}.jpg`
}
