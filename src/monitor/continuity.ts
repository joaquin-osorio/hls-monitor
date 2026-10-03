import type { SegmentRecord } from './segments'

export interface PidContinuity {
  /** `${track}:${level}:${pid}` */
  key: string
  track: string
  level: number
  pid: number
  /** stream_type from the PMT; undefined for PAT/PMT and other non-ES PIDs. */
  streamType?: number
  packets: number
  ccErrors: number
  /** Analyzed segments in which this PID appeared. */
  segments: number
  /** Segments with at least one continuity error on this PID. */
  affectedSegments: number
  lastErrorSn?: number
}

/**
 * Aggregates per-PID continuity statistics over every analyzed segment in `records` (the
 * retention window). Continuity is only checked inside each segment: HLS does not require the
 * counter to continue across segments, and many packagers restart it.
 */
export function continuityByPid(records: readonly SegmentRecord[]): PidContinuity[] {
  const rows = new Map<string, PidContinuity>()
  for (const r of records) {
    if (!r.pids) continue
    for (const p of r.pids) {
      const key = `${r.track}:${r.level}:${p.pid}`
      let row = rows.get(key)
      if (!row) {
        row = { key, track: r.track, level: r.level, pid: p.pid, packets: 0, ccErrors: 0, segments: 0, affectedSegments: 0 }
        rows.set(key, row)
      }
      row.streamType ??= r.streams?.find((s) => s.pid === p.pid)?.streamType
      row.packets += p.packets
      row.ccErrors += p.ccErrors
      row.segments++
      if (p.ccErrors > 0) {
        row.affectedSegments++
        if (row.lastErrorSn === undefined || r.sn > row.lastErrorSn) row.lastErrorSn = r.sn
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.track.localeCompare(b.track) || a.level - b.level || a.pid - b.pid)
}
