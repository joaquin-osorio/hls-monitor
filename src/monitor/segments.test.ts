import { describe, expect, it } from 'vitest'
import type { RequestRecord } from './loader'
import { measuredBitrates, networkMetrics, SegmentLog, segmentKey } from './segments'

function frag(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    kind: 'fragment',
    url: 'https://cdn/s10.ts',
    outcome: 'success',
    status: 200,
    start: 1000,
    first: 1100,
    end: 2000,
    bytes: 1_000_000,
    sn: 10,
    level: 1,
    track: 'main',
    duration: 4,
    ...overrides,
  }
}

describe('networkMetrics', () => {
  it('computes TTFB, total time, throughput and ratio', () => {
    expect(networkMetrics(frag())).toEqual({
      ttfbMs: 100,
      totalMs: 1000,
      throughputBps: (1_000_000 * 8) / 0.9, // over the 900 ms after the first byte
      ratio: 0.25,
    })
  })

  it('falls back to total time when the body arrives with the headers', () => {
    expect(networkMetrics(frag({ first: 2000 })).throughputBps).toBe(8_000_000)
  })
})

describe('SegmentLog', () => {
  it('classifies by download ratio', () => {
    const log = new SegmentLog()
    log.recordAttempt(frag({ sn: 1, end: 2000 })) // 1 s for 4 s → ok
    log.recordAttempt(frag({ sn: 2, end: 3000 })) // 2 s for 4 s → slow (≥ 0.5)
    log.recordAttempt(frag({ sn: 3, outcome: 'error', status: 503, bytes: 0 }))
    expect(log.toArray().map((r) => [r.sn, r.status])).toEqual([
      [1, 'ok'],
      [2, 'slow'],
      [3, 'error'],
    ])
  })

  it('folds retries into one record and keeps the latest outcome', () => {
    const log = new SegmentLog()
    log.recordAttempt(frag({ outcome: 'timeout', status: undefined }))
    log.recordAttempt(frag({ start: 9000, first: 9050, end: 9500 }))
    const [record] = log.toArray()
    expect(record).toMatchObject({ attempts: 2, status: 'ok', httpStatus: 200, totalMs: 500 })
  })

  it('ignores aborts, init segments and non-fragment requests', () => {
    const log = new SegmentLog()
    expect(log.recordAttempt(frag({ outcome: 'abort' }))).toBe(false)
    expect(log.recordAttempt(frag({ sn: undefined }))).toBe(false)
    expect(log.recordAttempt(frag({ kind: 'level' }))).toBe(false)
    expect(log.toArray()).toEqual([])
  })

  it('adds gaps once and never over a loaded segment', () => {
    const log = new SegmentLog()
    log.recordAttempt(frag({ sn: 10 }))
    expect(log.markGap('main', 1, 10, 4, 'missed', 5000)).toBe(false)
    expect(log.markGap('main', 1, 11, 4, 'tag', 5000)).toBe(true)
    expect(log.markGap('main', 1, 11, 4, 'tag', 9000)).toBe(false)
    expect(log.toArray().map((r) => [r.sn, r.status, r.gapReason])).toEqual([
      [10, 'ok', undefined],
      [11, 'gap', 'tag'],
    ])
  })

  it('attaches the TS analysis to its segment', () => {
    const log = new SegmentLog()
    log.recordAttempt(frag())
    log.attachAnalysis(segmentKey('main', 1, 10), {
      packets: 10,
      syncErrors: 0,
      ccErrors: 2,
      pids: [{ pid: 256, packets: 9, ccErrors: 2 }],
      families: ['avc', 'aac'],
      streams: [
        { pid: 257, streamType: 0x0f, family: 'aac', minPts: 9.9, maxPts: 13.9 },
        { pid: 256, streamType: 0x1b, family: 'avc', minPts: 10, maxPts: 13.96, duration: 4 },
      ],
    })
    expect(log.toArray()[0]).toMatchObject({ codecs: ['avc', 'aac'], ptsStart: 10, ptsEnd: 13.96, measuredDuration: 4, ccErrors: 2, pids: [{ pid: 256, packets: 9, ccErrors: 2 }] })
  })
})

describe('measuredBitrates', () => {
  it('averages bytes over EXTINF per level, skipping errors', () => {
    const log = new SegmentLog()
    log.recordAttempt(frag({ sn: 1, bytes: 1_000_000, duration: 4 }))
    log.recordAttempt(frag({ sn: 2, bytes: 3_000_000, duration: 4 }))
    log.recordAttempt(frag({ sn: 3, outcome: 'error', bytes: 0 }))
    log.recordAttempt(frag({ sn: 1, level: 0, bytes: 500_000, duration: 4 }))
    expect(measuredBitrates(log.toArray())).toEqual(
      new Map([
        [1, 4_000_000],
        [0, 1_000_000],
      ]),
    )
  })
})
