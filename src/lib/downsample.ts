/**
 * Thins a time series for charting, keeping its shape: the data is split into equal-count
 * buckets and each bucket keeps the points holding the min and max of every key, so spikes
 * survive. A point where a key is missing (or not finite) is also kept, so line gaps stay
 * visible. The first and last points are always kept, so the x-axis range doesn't change.
 *
 * Returns `data` itself when it already has at most `maxPoints` points. The result never
 * exceeds `maxPoints`.
 */
export function downsample<T extends { t: number }>(data: T[], keys: readonly (keyof T)[], maxPoints = 1000): T[] {
  const n = data.length
  if (n <= maxPoints) return data
  // Per bucket: a min and a max per key plus one gap point. Two slots go to the endpoints.
  const buckets = Math.max(1, Math.floor((maxPoints - 2) / (2 * keys.length + 1)))
  const keep = new Set<number>([0, n - 1])
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets)
    const end = Math.floor(((b + 1) * n) / buckets)
    let gap = -1
    for (const key of keys) {
      let min = -1
      let max = -1
      for (let i = start; i < end; i++) {
        const v = data[i][key]
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          if (gap < 0) gap = i
          continue
        }
        if (min < 0 || v < (data[min][key] as number)) min = i
        if (max < 0 || v > (data[max][key] as number)) max = i
      }
      if (min >= 0) keep.add(min).add(max)
    }
    if (gap >= 0) keep.add(gap)
  }
  return [...keep].sort((a, b) => a - b).map((i) => data[i])
}
