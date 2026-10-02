/** Wall-clock time (HH:MM:SS) of a `performance.now()` timestamp. */
export function formatClock(t: number): string {
  return new Date(performance.timeOrigin + t).toLocaleTimeString(undefined, { hour12: false })
}

/** Bits per second → "850 kbps" / "4.20 Mbps". */
export function formatBitrate(bps: number | undefined): string {
  if (bps === undefined || !Number.isFinite(bps)) return '—'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`
  return `${Math.round(bps / 1000)} kbps`
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}

export function formatSeconds(s: number | undefined, digits = 1): string {
  if (s === undefined || !Number.isFinite(s)) return '—'
  return `${s.toFixed(digits)} s`
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
