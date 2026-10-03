import type { RequestRecord } from './loader'
import { TimeWindowBuffer } from './ring-buffer'
import { networkMetrics } from './segments'

/** Aggressive LL-HLS (several parts/s per track) can still hit this before `RETENTION_MS`. */
const PART_CAPACITY = 20_000

export interface PartRecord {
  /** `performance.now()` of the first attempt. */
  t: number
  /** `${track}:${level}:${sn}.${part}` */
  key: string
  sn: number
  part: number
  level: number
  track: string
  url: string
  /** Part DURATION in seconds. */
  duration: number
  independent: boolean
  status: 'ok' | 'error'
  httpStatus?: number
  attempts: number
  /**
   * Time to first byte of the latest attempt. For a part requested from a preload hint this is
   * mostly server hold time (the part did not exist yet), not network latency.
   */
  ttfbMs?: number
  totalMs?: number
  bytes?: number
}

/** LL-HLS part requests, one record per (track, level, SN, part), kept for the retention window (`RETENTION_MS`). */
export class PartLog {
  private readonly buf = new TimeWindowBuffer<PartRecord>(PART_CAPACITY)

  /** Returns false for requests that are not part loads (or are aborts). */
  recordAttempt(req: RequestRecord): boolean {
    if (req.part === undefined || req.sn === undefined || req.level === undefined || req.outcome === 'abort') return false
    const track = req.track ?? 'main'
    const key = `${track}:${req.level}:${req.sn}.${req.part}`
    const { ttfbMs, totalMs } = networkMetrics(req)
    const ok = req.outcome === 'success'
    const fields = { status: ok ? ('ok' as const) : ('error' as const), httpStatus: req.status, ttfbMs, totalMs, bytes: ok ? req.bytes : undefined }
    const updated = this.buf.update(
      (r) => r.key === key,
      (r) => ({ ...r, ...fields, attempts: r.attempts + 1 }),
    )
    if (!updated) {
      this.buf.push({
        t: req.start,
        key,
        sn: req.sn,
        part: req.part,
        level: req.level,
        track,
        url: req.url,
        duration: req.partDuration ?? 0,
        independent: req.independent ?? false,
        attempts: 1,
        ...fields,
      })
    }
    return true
  }

  toArray(): PartRecord[] {
    return this.buf.toArray()
  }
}
