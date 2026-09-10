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

export function resolveChartFolderName(template: string, meta: ChartNameMeta): string {
  const resolved = template.replace(/\{(name|artist|charter)\}/g, (_, key: string) => {
    const value = meta[key as keyof ChartNameMeta]
    return value?.trim() || FALLBACKS[key]
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
