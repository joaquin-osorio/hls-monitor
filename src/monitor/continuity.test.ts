import { describe, expect, it } from 'vitest'
import { continuityByPid } from './continuity'
import type { SegmentRecord } from './segments'

function seg(sn: number, level: number, pids: SegmentRecord['pids']): SegmentRecord {
  return {
    t: sn,
    key: `main:${level}:${sn}`,
    sn,
    level,
    track: 'main',
    duration: 4,
    status: 'ok',
    attempts: 1,
    pids,
    streams: [{ pid: 256, streamType: 0x1b, family: 'avc' }],
  }
}

describe('continuityByPid', () => {
  it('sums packets and errors per level and PID across segments', () => {
    const rows = continuityByPid([
      seg(1, 0, [{ pid: 256, packets: 100, ccErrors: 2 }]),
      seg(2, 0, [{ pid: 256, packets: 120, ccErrors: 0 }]),
      seg(3, 0, [{ pid: 256, packets: 90, ccErrors: 1 }]),
      seg(3, 1, [{ pid: 256, packets: 50, ccErrors: 0 }]),
    ])
    expect(rows).toEqual([
      expect.objectContaining({ level: 0, pid: 256, streamType: 0x1b, packets: 310, ccErrors: 3, segments: 3, affectedSegments: 2, lastErrorSn: 3 }),
      expect.objectContaining({ level: 1, pid: 256, packets: 50, ccErrors: 0, affectedSegments: 0 }),
    ])
    expect(rows[1].lastErrorSn).toBeUndefined()
  })

  it('ignores segments that were not analyzed', () => {
    expect(continuityByPid([seg(1, 0, undefined)])).toEqual([])
  })
})
