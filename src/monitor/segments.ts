import type { CodecFamily } from './codecs'
import type { RequestRecord } from './loader'
import { TimeWindowBuffer } from './ring-buffer'
import type { TsAnalysis } from './ts/parse-ts'

/** A segment is `slow` when its download takes at least this fraction of its own duration. */
export const SLOW_RATIO = 0.5

/** Upper bound on segment records kept (the 30 min window usually binds first). */
const SEGMENT_CAPACITY = 5000

export type SegmentStatus = 'ok' | 'slow' | 'error' | 'gap'

export interface SegmentRecord {
  /** `performance.now()` when the record was created (first attempt or gap detection). */
  t: number
  /** `${track}:${level}:${sn}` */
  key: string
  sn: number
  level: number
  track: string
  url?: string
  /** EXTINF in seconds. */
  duration: number
  status: SegmentStatus
  /** Why a `gap` segment is a gap: tagged with EXT-X-GAP, or removed before it could be seen. */
  gapReason?: 'tag' | 'missed'
  /** Network attempts, including retries. Aborts (e.g. on level switch) are not counted. */
  attempts: number
  httpStatus?: number
  /** Metrics of the latest attempt. */
  ttfbMs?: number
  totalMs?: number
  bytes?: number
  /** Download throughput in bits per second, measured from first byte to end. */
  throughputBps?: number
  /** Total download time / segment duration. Above 1 the client cannot keep up. */
  ratio?: number
  /** From the MPEG-TS worker, when the segment was analyzed. */
  codecs?: CodecFamily[]
  ptsStart?: number
  ptsEnd?: number
  ccErrors?: number
  tsError?: string
}

export interface NetworkMetrics {
  ttfbMs?: number
  totalMs: number
  throughputBps?: number
  ratio?: number
}

export function networkMetrics(req: RequestRecord): NetworkMetrics {
  const totalMs = req.end - req.start
  const ttfbMs = req.first !== undefined ? req.first - req.start : undefined
  // Small or cached responses can arrive in the same tick as their headers; fall back to the
  // total time rather than reporting an absurd throughput.
  const transferMs = req.first !== undefined && req.end - req.first >= 1 ? req.end - req.first : totalMs
  const throughputBps = req.bytes > 0 && transferMs > 0 ? (req.bytes * 8 * 1000) / transferMs : undefined
  const ratio = req.duration ? totalMs / (req.duration * 1000) : undefined
  return { ttfbMs, totalMs, throughputBps, ratio }
}

export function segmentKey(track: string, level: number, sn: number): string {
  return `${track}:${level}:${sn}`
}

function statusOf(req: RequestRecord, ratio: number | undefined): SegmentStatus {
  if (req.outcome !== 'success') return 'error'
  return ratio !== undefined && ratio >= SLOW_RATIO ? 'slow' : 'ok'
}

/** Per-segment view of fragment requests, kept for the last 30 minutes. */
export class SegmentLog {
  private readonly buf = new TimeWindowBuffer<SegmentRecord>(SEGMENT_CAPACITY)

  /** Folds a fragment attempt into its segment record. Returns false for requests it ignores. */
  recordAttempt(req: RequestRecord): boolean {
    if (req.kind !== 'fragment' || req.sn === undefined || req.level === undefined || req.outcome === 'abort') {
      return false
    }
    const key = segmentKey(req.track ?? 'main', req.level, req.sn)
    const metrics = networkMetrics(req)
    const fields = {
      url: req.url,
      status: statusOf(req, metrics.ratio),
      gapReason: undefined,
      httpStatus: req.status,
      bytes: req.outcome === 'success' ? req.bytes : undefined,
      ...metrics,
    }
    const updated = this.buf.update(
      (r) => r.key === key,
      (r) => ({ ...r, ...fields, attempts: r.attempts + 1 }),
    )
    if (!updated) {
      this.buf.push({
        t: req.start,
        key,
        sn: req.sn,
        level: req.level,
        track: req.track ?? 'main',
        duration: req.duration ?? 0,
        attempts: 1,
        ...fields,
      })
    }
    return true
  }

  /**
   * Adds a `gap` record unless the segment is already known (gaps are re-announced on every
   * playlist refresh while they stay in the window). Returns whether a record was added.
   */
  markGap(track: string, level: number, sn: number, duration: number, reason: 'tag' | 'missed', t: number): boolean {
    const key = segmentKey(track, level, sn)
    if (this.buf.findLast((r) => r.key === key)) return false
    this.buf.push({ t, key, sn, level, track, duration, status: 'gap', gapReason: reason, attempts: 0 })
    return true
  }

  attachAnalysis(key: string, result: TsAnalysis | { error: string }): boolean {
    return this.buf.update(
      (r) => r.key === key,
      (r) => {
        if ('error' in result) return { ...r, tsError: result.error }
        const video = result.streams.find((s) => s.family === 'avc' || s.family === 'hevc')
        const reference = video ?? result.streams.find((s) => s.firstPts !== undefined)
        return {
          ...r,
          codecs: result.families,
          ptsStart: reference?.firstPts,
          ptsEnd: reference?.lastPts,
          ccErrors: result.ccErrors,
        }
      },
    )
  }

  toArray(): SegmentRecord[] {
    return this.buf.toArray()
  }

  clear(): void {
    this.buf.clear()
  }
}

/**
 * Measured media bitrate per level (bits/s): Σ bytes × 8 / Σ EXTINF over successfully loaded main
 * segments. This is the stream's real bitrate, comparable to BANDWIDTH / AVERAGE-BANDWIDTH; it is
 * unrelated to network throughput.
 */
export function measuredBitrates(records: readonly SegmentRecord[]): Map<number, number> {
  const sums = new Map<number, { bits: number; seconds: number }>()
  for (const r of records) {
    if (r.track !== 'main' || r.bytes === undefined || r.duration <= 0) continue
    if (r.status === 'error' || r.status === 'gap') continue
    const s = sums.get(r.level) ?? { bits: 0, seconds: 0 }
    s.bits += r.bytes * 8
    s.seconds += r.duration
    sums.set(r.level, s)
  }
  const out = new Map<number, number>()
  for (const [level, s] of sums) out.set(level, s.bits / s.seconds)
  return out
}
