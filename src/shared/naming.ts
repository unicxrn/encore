import { stripRichText } from './format'

export interface ChartNameMeta {
  name?: string | null
  artist?: string | null
  charter?: string | null
}

const FALLBACKS: Record<string, string> = {
  name: 'Unknown Name',
  artist: 'Unknown Artist',
  charter: 'Unknown Charter'
}

/**
 * The folder (or .sng) a download lands in, and the only name the downloads queue shows.
 *
 * Clone Hero's markup comes off before the sanitiser below runs, because the sanitiser strips
 * `<` and `>` and nothing else: a charter who colours their name one letter at a time would
 * otherwise get a folder called `bcolor=#7B0000Wcolor...`, which is both the path on disk and
 * the line in the queue. Only names that carry real tags change; a title like `Rock <3 Roll`
 * keeps every character it kept before, since the sanitiser is still what drops its bracket.
 */
export function resolveChartFolderName(template: string, meta: ChartNameMeta): string {
  const resolved = template.replace(/\{(name|artist|charter)\}/g, (_, key: string) => {
    const value = stripRichText(meta[key as keyof ChartNameMeta])
    return value || FALLBACKS[key]
  })
  let sanitized = resolved
    // eslint-disable-next-line no-control-regex -- stripping control chars is intentional here
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) {
    sanitized += '_'
  }
  return sanitized || 'Unknown Chart'
}
