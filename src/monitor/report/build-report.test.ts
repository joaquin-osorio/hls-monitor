import { describe, expect, it } from 'vitest'
import type { SegmentRecord } from '../segments'
import type { MonitorSnapshot, Sample } from '../types'
import { buildMarkdownReport, reportFilename, type ReportContext } from './build-report'

const ORIGIN = Date.UTC(2026, 9, 3, 12, 0, 0)
const URL = 'https://cdn.example.com/live/master.m3u8'

const ctx: ReportContext = { timeOrigin: ORIGIN, now: 60_000, throttle: null, requestedVariant: 'auto', loudnessEnabled: false }

function emptySnapshot(): MonitorSnapshot {
  return {
    source: { url: URL, startedAt: 0, phase: 'loading', mixedContent: false },
    variants: [],
    selection: { auto: true, currentLevel: -1, loadLevel: -1 },
    segments: [],
    parts: [],
    playlists: [],
    samples: [],
    stalls: [],
    errors: [],
    findings: [],
    alignment: null,
    loudness: null,
  }
}

const segment = (sn: number, fields: Partial<SegmentRecord> = {}): SegmentRecord => ({
  t: 1000 + sn,
  key: `main:1:${sn}`,
  sn,
  level: 1,
  track: 'main',
  url: `https://cdn.example.com/live/1/${sn}.ts`,
  duration: 6,
  status: 'ok',
  attempts: 1,
  ...fields,
})

const sample = (t: number, fields: Partial<Sample> = {}): Sample => ({ t, bufferAhead: 10, ...fields })

function populatedSnapshot(): MonitorSnapshot {
  return {
    ...emptySnapshot(),
    source: { url: URL, startedAt: 0, phase: 'ready', kind: 'master', live: true, mixedContent: false },
    variants: [
      { index: 0, url: 'https://cdn.example.com/live/0.m3u8', width: 640, height: 360, codecs: ['avc1.4d401e', 'mp4a.40.2'], bandwidth: 800_000, detectedCodecs: ['avc', 'aac'] },
      { index: 1, url: 'https://cdn.example.com/live/1.m3u8', width: 1280, height: 720, bandwidth: 3_000_000, averageBandwidth: 2_000_000, measuredBitrate: 2_500_000, detectedCodecs: [] },
    ],
    selection: { auto: false, currentLevel: 1, loadLevel: 1 },
    segments: [
      segment(100, {
        ttfbMs: 40.4,
        totalMs: 300,
        bytes: 1_875_000,
        throughputBps: 52_000_000,
        ratio: 0.05,
        headers: [['content-type', 'video/mp2t']],
        streams: [{ pid: 0x100, streamType: 0x1b, family: 'avc', codec: 'avc1.64001f', minPts: 10, maxPts: 15.96, pesCount: 150, duration: 6 }],
        pids: [{ pid: 0x100, kind: 'es', packets: 9000, ccErrors: 2 }],
        ccErrors: 2,
      }),
      segment(101, { status: 'error', httpStatus: 503 }),
      segment(102, { status: 'gap', gapReason: 'missed', attempts: 0 }),
    ],
    playlists: [
      { t: 900, key: 'main:1', url: 'https://cdn.example.com/live/1.m3u8', mediaSequence: 95, lastSn: 100, segmentCount: 6, targetDuration: 6, endList: false, changed: true, missedSns: [], endListAppeared: false },
      { t: 6900, key: 'main:1', url: 'https://cdn.example.com/live/1.m3u8', mediaSequence: 99, lastSn: 104, segmentCount: 6, targetDuration: 6, endList: false, intervalMs: 6000, mediaSequenceAdvance: 4, newSegments: 4, changed: true, missedSns: [101, 102, 103], endListAppeared: false },
    ],
    samples: [
      sample(500, { bufferAhead: 4, droppedFrames: 0, totalFrames: 0, level: 1, liveEdgeDistance: 18, pdtLatency: 20 }),
      sample(1000, { bufferAhead: 8, droppedFrames: 1, totalFrames: 100, level: 1, liveEdgeDistance: 20, pdtLatency: 22 }),
    ],
    stalls: [{ t: 2000, durationMs: 1500 }, { t: 5000 }],
    errors: [
      { id: 0, t: 3000, type: 'http5xx', fatal: false, retries: 1, details: 'fragLoadError', message: 'HTTP 503 | Service Unavailable', url: 'https://cdn.example.com/live/1/101.ts', status: 503 },
      { id: 1, t: 4000, type: 'cors', fatal: false, retries: 0, details: 'levelLoadError', message: 'network', corsConfirmed: true },
    ],
    findings: [
      { checkId: 'ts-continuity', key: 'k1', severity: 'error', message: 'PID 0x0100: 2 continuity errors in segment 100', count: 3, firstSeen: 1100, lastSeen: 1200, url: 'https://cdn.example.com/live/1.m3u8' },
      { checkId: 'discontinuity', key: 'k2', severity: 'info', message: 'EXT-X-DISCONTINUITY before segment 98', count: 1, firstSeen: 900, lastSeen: 900 },
    ],
    alignment: {
      t: 950,
      live: true,
      variants: [
        { level: 0, uri: 'https://cdn.example.com/live/0.m3u8', firstSn: 95, lastSn: 100, segments: 6, durationS: 36, discontinuities: 0 },
        { level: 1, uri: 'https://cdn.example.com/live/1.m3u8', segments: 0, durationS: 0, discontinuities: 0, error: 'HTTP 404' },
      ],
      issues: [{ kind: 'extinf', sn: 97, levels: [1], detail: 'EXTINF 6 vs 5.5' }],
      comparedSns: 6,
      requests: 4,
    },
  }
}

/** Lines of the table that follows `heading` (up to the next blank line). */
function tableAfter(report: string, heading: string): string[] {
  const lines = report.split('\n')
  const start = lines.findIndex((l, i) => i > lines.indexOf(heading) && l.startsWith('|'))
  const end = lines.findIndex((l, i) => i > start && !l.startsWith('|'))
  return lines.slice(start, end === -1 ? undefined : end)
}

describe('buildMarkdownReport', () => {
  it('emits every section even for an empty session', () => {
    const report = buildMarkdownReport(emptySnapshot(), ctx)
    const headings = report.split('\n').filter((l) => l.startsWith('## '))
    expect(headings).toEqual([
      '## Session',
      '## Summary',
      '## Variants',
      '## Buffer and stalls',
      '## Live latency',
      '## Dropped frames',
      '## Loudness (BS.1770 / EBU R128)',
      '## Segments',
      '## Playlists',
      '## LL-HLS',
      '## MPEG-TS continuity',
      '## Variant alignment',
      '## Spec checks',
      '## Errors',
      '## Appendix A: Samples',
      '## Appendix B: Loudness series',
      '## Appendix C: Segment details',
    ])
    expect(report).toContain('_No data._')
  })

  it('reports the session context, including state that is not in the snapshot', () => {
    const report = buildMarkdownReport(populatedSnapshot(), {
      ...ctx,
      throttle: { downKbps: 1500, latencyMs: 200 },
      requestedVariant: 1,
    })
    expect(report).toContain('- **Generated:** 2026-10-03T12:01:00.000Z')
    expect(report).toContain('- **Duration:** 1m 00s')
    expect(report).toContain('- **Type:** LIVE')
    expect(report).toContain('- **Network simulation:** 1500 kbps, +200 ms latency')
    expect(report).toContain('**Network simulation was on**')
    expect(report).toContain('- **Requested variant:** 1')
    expect(report).toContain('- **Playing level:** 1 (720p)')
    expect(report).toContain('- **Loudness meter:** off')
  })

  it('includes every collected record', () => {
    const snapshot = populatedSnapshot()
    const report = buildMarkdownReport(snapshot, ctx)
    // Header + separator + one row per record.
    expect(tableAfter(report, '## Segments')).toHaveLength(2 + snapshot.segments.length)
    expect(tableAfter(report, '### All loads')).toHaveLength(2 + snapshot.playlists.length)
    expect(tableAfter(report, '## Errors')).toHaveLength(2 + snapshot.errors.length)
    expect(tableAfter(report, '### Findings')).toHaveLength(2 + snapshot.findings.length)
    expect(tableAfter(report, '### Stalls')).toHaveLength(2 + snapshot.stalls.length)
    expect(tableAfter(report, '## Appendix A: Samples')).toHaveLength(2 + snapshot.samples.length)
    expect(tableAfter(report, '### Issues')).toHaveLength(3)
    expect(report).toContain('| 2026-10-03T12:00:01.100Z | main | 1 | 100 | 6 | ok | 1 | — | — | 40 | 300 | 1875000 | 52000 | 0.05 | — |')
    expect(report).toContain('| gap (missed) |')
    expect(report).toContain('HTTP 503 \\| Service Unavailable')
    expect(report).toContain('server reachable: CORS')
    expect(report).toContain('| 101–103 |')
    expect(report).toContain('### main · level 1 · SN 100')
    expect(report).toContain('| 0x0100 | H.264 (0x1b) | avc1.64001f |')
    expect(report).toContain('| content-type | video/mp2t |')
  })

  it('computes the same aggregates as the panels', () => {
    const report = buildMarkdownReport(populatedSnapshot(), ctx)
    expect(report).toContain('| Segments | 3 (1 ok, 0 slow, 1 error, 1 gap) |')
    expect(report).toContain('| Stalls | 2 (1.5 s total, one ongoing) |')
    expect(report).toContain('| Dropped frames | 1 of 100 (1.00 %) |')
    // Measured vs AVERAGE-BANDWIDTH when present.
    expect(report).toContain('| 1 | 1280x720 | — | 3000 | 2000 | 2500 | 125 % |')
    expect(report).toContain('| Behind live edge (s) | 20 | 18 | 19 | 20 |')
    expect(report).toContain('| main:1 | 2 | 6000 | 6 | 0 | 3 | 99 | no |')
    expect(report).toContain('| main | 1 | 0x0100 | H.264 | 9000 | 2 | 1 | 1 | 100 |')
    expect(report).toContain('| MPEG-TS continuity counters | error | 1 |')
    expect(report).toContain('| LL-HLS parts within PART-TARGET | n/a | 0 |')
  })

  it('reports loudness only while the meter is on', () => {
    const snapshot: MonitorSnapshot = {
      ...emptySnapshot(),
      loudness: {
        status: 'measuring',
        values: { momentary: -22.04, shortTerm: -23.1, integrated: -23, truePeakMax: Number.NEGATIVE_INFINITY },
        series: [{ t: 500, momentary: -22, shortTerm: -23 }, { t: 1000 }],
      },
    }
    expect(buildMarkdownReport(snapshot, ctx)).toContain('_Meter off')
    const report = buildMarkdownReport(snapshot, { ...ctx, loudnessEnabled: true })
    expect(report).toContain('- **Integrated (LUFS):** -23')
    expect(report).toContain('- **Max true peak (dBTP):** —')
    expect(tableAfter(report, '## Appendix B: Loudness series')).toHaveLength(4)
  })
})

describe('reportFilename', () => {
  it('uses the stream host and a UTC timestamp', () => {
    expect(reportFilename(URL, Date.UTC(2026, 9, 3, 7, 5, 9))).toBe('hls-report-cdn.example.com-20261003-070509.md')
  })

  it('falls back for unparsable URLs', () => {
    expect(reportFilename('not a url', 0)).toBe('hls-report-stream-19700101-000000.md')
  })
})
