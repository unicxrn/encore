/**
 * Minimal RFC-4180-style CSV serialiser.
 *
 * Rules:
 * - Fields containing " , \n or \r are wrapped in double-quotes.
 * - Internal double-quotes are escaped as "".
 * - Rows are joined with CRLF (\r\n).
 * - A single trailing CRLF is appended after the last row.
 */
export function toCsv(rows: string[][]): string {
  const lines: string[] = []
  for (const row of rows) {
    const fields = row.map((field) => {
      const needsQuoting =
        field.includes('"') || field.includes(',') || field.includes('\n') || field.includes('\r')
      if (needsQuoting) {
        return '"' + field.replace(/"/g, '""') + '"'
      }
      return field
    })
    lines.push(fields.join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
