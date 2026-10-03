/** Placeholder for a missing or non-finite value. */
export const NONE = '—'

export type CellValue = string | number | boolean | null | undefined

/**
 * Makes a value safe for a GFM table cell: `|` would split the cell and a line break would end
 * the row, so pipes are escaped and line breaks collapsed to a space.
 */
export function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ')
}

function cellText(value: CellValue): string {
  if (value === undefined || value === null || value === '') return NONE
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : NONE
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return escapeCell(value)
}

/** GFM table. Returns a "No data" line instead of a header-only table when `rows` is empty. */
export function table(headers: string[], rows: CellValue[][]): string {
  if (rows.length === 0) return '_No data._'
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [line(headers.map(escapeCell)), line(headers.map(() => '---')), ...rows.map((r) => line(r.map(cellText)))].join('\n')
}

/** `- **Label:** value` bullet list. */
export function fields(entries: [string, CellValue][]): string {
  return entries.map(([label, value]) => `- **${label}:** ${cellText(value)}`).join('\n')
}

/** Rounds to `digits` decimals; undefined for missing or non-finite values (rendered as `—`). */
export function round(value: number | undefined, digits = 0): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** ISO 8601 UTC time of a `performance.now()` timestamp. */
export function isoTime(t: number, timeOrigin: number): string {
  return new Date(timeOrigin + t).toISOString()
}

/** "1h 02m 03s" / "2m 03s" / "3.4 s". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m ${s}s` : `${m}m ${s}s`
}
