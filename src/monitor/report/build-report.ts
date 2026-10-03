import type { VariantSelection } from '@/lib/query-state'
import { summarizeChecks, type Severity } from '../checks'
import { continuityByPid } from '../continuity'
import type { MonitorErrorType } from '../errors'
import { framesByLevel } from '../frames'
import type { ThrottleProfile } from '../network-shaper'
import { sessionUsesLlHls } from '../playlist/ll-hls'
import { RETENTION_MS } from '../ring-buffer'
import type { SegmentRecord, SegmentStatus } from '../segments'
import { formatPid, pidLabel, streamTypeName } from '../ts/stream-types'
import type { MonitorSnapshot, Sample, SourceInfo } from '../types'
import { fields, formatDuration, isoTime, round, table, type CellValue } from './markdown'

/** What the report needs besides the snapshot. Injected so the output is deterministic in tests. */
export interface ReportContext {
  /** `performance.timeOrigin`: turns snapshot timestamps into wall-clock time. */
  timeOrigin: number
  /** `performance.now()` when the report is generated. */
  now: number
  /** Active network simulation; every timing in the snapshot is simulated while it is on. */
  throttle: ThrottleProfile | null
  /** `?variant=` from the URL. */
  requestedVariant: VariantSelection
  loudnessEnabled: boolean
}

const PHASE_TEXT: Record<SourceInfo['phase'], string> = {
  loading: 'loading',
  ready: 'playing',
  fatal: 'stopped (fatal error)',
  unsupported: 'MSE not supported',
}

const SEGMENT_STATUSES: SegmentStatus[] = ['ok', 'slow', 'error', 'gap']
const ERROR_TYPES: MonitorErrorType[] = ['cors', 'http4xx', 'http5xx', 'timeout', 'decode', 'parse']
const SEVERITIES: Severity[] = ['error', 'warn', 'info']

interface Stats {
  last: number
  min: number
  avg: number
  max: number
}

function stats(values: number[]): Stats | undefined {
  if (values.length === 0) return undefined
  return {
    last: values[values.length - 1],
    min: Math.min(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    max: Math.max(...values),
  }
}

function statsRow(label: string, s: Stats | undefined, digits: number): CellValue[] {
  return [label, round(s?.last, digits), round(s?.min, digits), round(s?.avg, digits), round(s?.max, digits)]
}

const kbps = (bps: number | undefined) => round(bps === undefined ? undefined : bps / 1000)
const percent = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(2)} %` : undefined)

/** `hls-report-<host>-<YYYYMMDD-HHMMSS>.md`, UTC. */
export function reportFilename(url: string, epochMs: number): string {
  let host = 'stream'
  try {
    host = new URL(url).hostname || host
  } catch {
    // keep the fallback for unparsable URLs
  }
  const stamp = new Date(epochMs).toISOString().slice(0, 19).replace(/-|:/g, '').replace('T', '-')
  return `hls-report-${host.replace(/[^a-zA-Z0-9.-]/g, '-')}-${stamp}.md`
}

/**
 * Renders everything the session has collected (everything still inside the retention window)
 * as a Markdown document: summaries mirroring the panels, full tables of every record, and raw
 * time series in appendices. Pure: all inputs come from `snapshot` and `ctx`.
 */
export function buildMarkdownReport(snapshot: MonitorSnapshot, ctx: ReportContext): string {
  const at = (t: number) => isoTime(t, ctx.timeOrigin)
  const sections = [
    header(snapshot, ctx, at),
    sessionSection(snapshot, ctx, at),
    summarySection(snapshot),
    variantsSection(snapshot),
    bufferSection(snapshot, at),
    latencySection(snapshot),
    framesSection(snapshot),
    loudnessSection(snapshot, ctx),
    segmentsSection(snapshot, at),
    playlistsSection(snapshot, at),
    llHlsSection(snapshot, at),
    continuitySection(snapshot),
    alignmentSection(snapshot, at),
    checksSection(snapshot, at),
    errorsSection(snapshot, at),
    samplesAppendix(snapshot, at),
    loudnessAppendix(snapshot, at),
    segmentDetailsAppendix(snapshot),
  ]
  return `${sections.join('\n\n')}\n`
}

type At = (t: number) => string

function header({ source }: MonitorSnapshot, ctx: ReportContext, at: At): string {
  const from = Math.max(source.startedAt, ctx.now - RETENTION_MS)
  return [
    '# HLS Monitor report',
    fields([
      ['Stream', source.url],
      ['Generated', at(ctx.now)],
    ]),
    `> Covers everything the monitor still holds: the last ${RETENTION_MS / 60_000} minutes of the session ` +
      `(${at(from)} to ${at(ctx.now)}). Times are UTC.` +
      (ctx.throttle ? ' **Network simulation was on**: request timings, throughput and ABR reflect the simulated link.' : ''),
  ].join('\n\n')
}

function sessionSection({ source, selection, variants }: MonitorSnapshot, ctx: ReportContext, at: At): string {
  const fatal = source.fatal
  const corsProbe =
    fatal?.type !== 'cors' ? undefined : fatal.corsConfirmed === undefined ? 'probe pending' : fatal.corsConfirmed ? 'CORS rejection confirmed' : 'server unreachable'
  const level = (i: number) => (i < 0 ? 'none yet' : `${i}${variants[i]?.height ? ` (${variants[i].height}p)` : ''}`)
  return [
    '## Session',
    fields([
      ['URL', source.url],
      ['Status', PHASE_TEXT[source.phase]],
      ['Playlist', source.kind ?? 'unknown'],
      ['Type', source.live === undefined ? 'unknown' : source.live ? 'LIVE' : 'VOD'],
      ['Started', at(source.startedAt)],
      ['Duration', formatDuration(ctx.now - source.startedAt)],
      ['Mixed content', source.mixedContent],
      ['Fatal error', fatal ? `${fatal.type} · ${fatal.details} · ${fatal.message}${corsProbe ? ` (${corsProbe})` : ''}` : 'none'],
      ['Network simulation', ctx.throttle ? `${ctx.throttle.downKbps} kbps, +${ctx.throttle.latencyMs} ms latency` : 'off'],
      ['Requested variant', ctx.requestedVariant === 'auto' ? 'auto (ABR)' : String(ctx.requestedVariant)],
      ['ABR', selection.auto ? 'on' : 'off'],
      ['Playing level', level(selection.currentLevel)],
      ['Loading level', level(selection.loadLevel)],
      ['Loudness meter', ctx.loudnessEnabled ? 'on' : 'off'],
    ]),
  ].join('\n\n')
}

function droppedTotals(samples: readonly Sample[]): { dropped: number; total: number } {
  return framesByLevel(samples).reduce((acc, l) => ({ dropped: acc.dropped + l.dropped, total: acc.total + l.total }), { dropped: 0, total: 0 })
}

function summarySection(s: MonitorSnapshot): string {
  const count = <T>(list: readonly T[], pred: (x: T) => boolean) => list.filter(pred).length
  const bytes = s.segments.reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  const finishedStalls = s.stalls.filter((x) => x.durationMs !== undefined)
  const stallMs = finishedStalls.reduce((sum, x) => sum + (x.durationMs ?? 0), 0)
  const ongoing = s.stalls.length - finishedStalls.length
  const frames = droppedTotals(s.samples)
  const rows: CellValue[][] = [
    ['Segments', `${s.segments.length} (${SEGMENT_STATUSES.map((st) => `${count(s.segments, (r) => r.status === st)} ${st}`).join(', ')})`],
    ['Segment bytes', bytes],
    ['Errors', `${s.errors.length} (${count(s.errors, (e) => e.fatal)} fatal; ${ERROR_TYPES.map((t) => `${count(s.errors, (e) => e.type === t)} ${t}`).join(', ')})`],
    ['Stalls', `${s.stalls.length} (${formatDuration(stallMs)} total${ongoing ? ', one ongoing' : ''})`],
    ['Spec findings', `${s.findings.length} (${SEVERITIES.map((sev) => `${count(s.findings, (f) => f.severity === sev)} ${sev}`).join(', ')})`],
    ['Dropped frames', frames.total > 0 ? `${frames.dropped} of ${frames.total} (${percent(frames.dropped, frames.total)})` : undefined],
    ['Playlist loads', s.playlists.length],
    ['LL-HLS part requests', s.parts.length],
    ['Alignment issues', s.alignment ? s.alignment.issues.length : undefined],
  ]
  return ['## Summary', table(['Metric', 'Value'], rows)].join('\n\n')
}

function variantsSection({ variants }: MonitorSnapshot): string {
  const rows = variants.map((v) => {
    const reference = v.averageBandwidth ?? v.bandwidth
    return [
      v.index,
      v.width && v.height ? `${v.width}x${v.height}` : undefined,
      v.codecs?.join(', '),
      kbps(v.bandwidth),
      kbps(v.averageBandwidth),
      kbps(v.measuredBitrate),
      v.measuredBitrate !== undefined && reference ? `${Math.round((v.measuredBitrate / reference) * 100)} %` : undefined,
      v.detectedCodecs.join(', '),
      v.url,
    ]
  })
  return [
    '## Variants',
    'Measured = Σ bytes × 8 / Σ EXTINF of loaded segments; % compares it with AVERAGE-BANDWIDTH, or BANDWIDTH when absent.',
    table(['Level', 'Resolution', 'CODECS', 'BANDWIDTH (kbps)', 'AVERAGE-BANDWIDTH (kbps)', 'Measured (kbps)', 'Measured %', 'Detected codecs', 'URL'], rows),
  ].join('\n\n')
}

function bufferSection({ samples, stalls }: MonitorSnapshot, at: At): string {
  const buffer = stats(samples.map((x) => x.bufferAhead))
  return [
    '## Buffer and stalls',
    table(['Metric', 'Last', 'Min', 'Avg', 'Max'], buffer ? [statsRow('Buffer ahead (s)', buffer, 2)] : []),
    '### Stalls',
    'Playback waiting for data after it had started; startup and seeks excluded.',
    table(
      ['#', 'Start', 'Duration (ms)'],
      stalls.map((x, i) => [i + 1, at(x.t), x.durationMs === undefined ? 'ongoing' : round(x.durationMs)]),
    ),
  ].join('\n\n')
}

function latencySection({ source, samples }: MonitorSnapshot): string {
  if (!source.live) return '## Live latency\n\n_Only available for live streams._'
  const pick = (f: (x: Sample) => number | undefined) => samples.map(f).filter((v): v is number => v !== undefined)
  return [
    '## Live latency',
    'PDT latency = wall clock − PROGRAM-DATE-TIME at the playhead; it depends on the client clock being in sync.',
    table(
      ['Metric', 'Last', 'Min', 'Avg', 'Max'],
      [statsRow('Behind live edge (s)', stats(pick((x) => x.liveEdgeDistance)), 2), statsRow('Latency vs PDT (s)', stats(pick((x) => x.pdtLatency)), 2)],
    ),
  ].join('\n\n')
}

function framesSection({ samples }: MonitorSnapshot): string {
  const rows = framesByLevel(samples).map((l) => [l.level < 0 ? 'unknown' : l.level, l.total, l.dropped, percent(l.dropped, l.total)])
  return ['## Dropped frames', 'Per level playing at each sample (one 500 ms sample of slack around switches).', table(['Level', 'Frames', 'Dropped', 'Dropped %'], rows)].join('\n\n')
}

function loudnessSection({ loudness }: MonitorSnapshot, ctx: ReportContext): string {
  if (!ctx.loudnessEnabled || !loudness) return '## Loudness (BS.1770 / EBU R128)\n\n_Meter off: no loudness data (it is discarded when the meter is stopped)._'
  const v = loudness.values
  return [
    '## Loudness (BS.1770 / EBU R128)',
    fields([
      ['Status', loudness.status + (loudness.pausedReason ? ` (${loudness.pausedReason})` : '') + (loudness.error ? ` · ${loudness.error}` : '')],
      ['Integrated (LUFS)', round(v.integrated, 1)],
      ['Momentary (LUFS)', round(v.momentary, 1)],
      ['Short-term (LUFS)', round(v.shortTerm, 1)],
      ['Max true peak (dBTP)', round(v.truePeakMax, 1)],
    ]),
  ].join('\n\n')
}

function segmentsSection({ segments }: MonitorSnapshot, at: At): string {
  const rows = segments.map((r) => [
    at(r.t),
    r.track,
    r.level,
    r.sn,
    r.duration,
    r.gapReason ? `${r.status} (${r.gapReason})` : r.status,
    r.attempts,
    r.partsLoaded !== undefined ? `${r.partsLoaded} ok / ${r.partErrors ?? 0} err` : undefined,
    r.httpStatus,
    round(r.ttfbMs),
    round(r.totalMs),
    r.bytes,
    kbps(r.throughputBps),
    round(r.ratio, 2),
    round(r.measuredDuration, 3),
    r.codecs?.join(', '),
    r.ccErrors,
    r.tsError,
    r.url,
  ])
  return [
    '## Segments',
    'Metrics of the latest attempt. Ratio = total download time / EXTINF.',
    table(
      ['Time', 'Track', 'Level', 'SN', 'EXTINF (s)', 'Status', 'Attempts', 'Parts', 'HTTP', 'TTFB (ms)', 'Total (ms)', 'Bytes', 'Throughput (kbps)', 'Ratio', 'Measured (s)', 'Codecs', 'CC errors', 'TS error', 'URL'],
      rows,
    ),
  ].join('\n\n')
}

/** `1, 2, 3` → `1–3`; non-contiguous lists are joined. */
function snRange(sns: readonly number[]): string | undefined {
  if (sns.length === 0) return undefined
  const contiguous = sns.every((sn, i) => i === 0 || sn === sns[i - 1] + 1)
  return contiguous && sns.length > 1 ? `${sns[0]}–${sns[sns.length - 1]}` : sns.join(', ')
}

function playlistsSection({ playlists }: MonitorSnapshot, at: At): string {
  const byKey = new Map<string, typeof playlists>()
  for (const r of playlists) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r])
  const summary = [...byKey].map(([key, list]) => {
    const intervals = list.flatMap((r) => (r.intervalMs === undefined ? [] : [r.intervalMs]))
    const last = list[list.length - 1]
    return [
      key,
      list.length,
      round(stats(intervals)?.avg),
      last.targetDuration ?? 'missing',
      list.filter((r) => r.intervalMs !== undefined && !r.changed).length,
      list.reduce((n, r) => n + r.missedSns.length, 0),
      last.mediaSequence,
      last.endList,
    ]
  })
  const rows = playlists.map((r) => [
    at(r.t),
    r.key,
    round(r.intervalMs),
    r.targetDuration,
    r.mediaSequence,
    r.mediaSequenceAdvance,
    r.lastSn,
    r.segmentCount,
    r.newSegments,
    r.changed,
    snRange(r.missedSns),
    r.endList,
    r.endListAppeared,
    r.url,
  ])
  return [
    '## Playlists',
    'Media playlist loads, tracked per role (`main:<level>`, `audio:<id>`, `subtitle:<id>`). Live playlists should refresh about once per target duration.',
    table(['Playlist', 'Loads', 'Avg interval (ms)', 'TARGETDURATION (s)', 'Unchanged refreshes', 'Missed SNs', 'Last MEDIA-SEQUENCE', 'ENDLIST'], summary),
    '### All loads',
    table(
      ['Time', 'Playlist', 'Interval (ms)', 'TARGETDURATION (s)', 'MEDIA-SEQUENCE', 'Advance', 'Last SN', 'Segments', 'New', 'Changed', 'Missed SNs', 'ENDLIST', 'ENDLIST appeared', 'URL'],
      rows,
    ),
  ].join('\n\n')
}

function llHlsSection({ playlists, parts }: MonitorSnapshot, at: At): string {
  if (!sessionUsesLlHls(playlists, parts.length)) return '## LL-HLS\n\n_Not a low-latency stream._'
  const withLl = playlists.filter((r) => r.ll)
  const ll = (withLl.findLast((r) => r.key.startsWith('main:')) ?? withLl.at(-1))?.ll
  const sc = ll?.serverControl
  const blocking = withLl.filter((r) => r.ll?.blocking?.msn !== undefined)
  const out = ['## LL-HLS']
  if (ll) {
    out.push(
      fields([
        ['PART-TARGET (s)', ll.partTarget],
        ['PART-HOLD-BACK (s)', sc?.partHoldBack],
        ['HOLD-BACK (s)', sc?.holdBack],
        ['CAN-BLOCK-RELOAD', sc?.canBlockReload ?? false],
        ['CAN-SKIP-UNTIL (s)', sc?.canSkipUntil],
        ['Parts listed', `${ll.partCount} (${ll.pendingParts} pending)`],
        ['Preload hints', ll.preloadHints.map((h) => `${h.type} ${h.uri}`).join(', ') || 'none'],
        ['Rendition reports', ll.renditionReports],
        ['Preload hints fulfilled / unfulfilled', `${ll.hintsFulfilled} / ${ll.hintsUnfulfilled}`],
      ]),
    )
  }
  out.push(
    '### Blocking reloads',
    'Playlist requests with `_HLS_msn`; hold = TTFB. Satisfied = the response contains the requested MSN/part.',
    table(
      ['Time', 'Playlist', '_HLS_msn', '_HLS_part', '_HLS_skip', 'Hold (ms)', 'Satisfied'],
      blocking.map((r) => {
        const b = r.ll!.blocking!
        return [at(r.t), r.key, b.msn, b.part, b.skip, round(b.holdMs), b.satisfied]
      }),
    ),
    '### Part requests',
    'For parts requested from a preload hint, TTFB is mostly server hold time.',
    table(
      ['Time', 'Track', 'Level', 'SN.part', 'Duration (s)', 'Independent', 'Status', 'HTTP', 'Attempts', 'TTFB (ms)', 'Total (ms)', 'Bytes', 'URL'],
      parts.map((p) => [at(p.t), p.track, p.level, `${p.sn}.${p.part}`, p.duration, p.independent, p.status, p.httpStatus, p.attempts, round(p.ttfbMs), round(p.totalMs), p.bytes, p.url]),
    ),
  )
  return out.join('\n\n')
}

function continuitySection({ segments }: MonitorSnapshot): string {
  const rows = continuityByPid(segments).map((p) => [
    p.track,
    p.level,
    formatPid(p.pid),
    pidLabel(p.pid, p.streamType, p.kind),
    p.packets,
    p.ccErrors,
    p.segments,
    p.affectedSegments,
    p.lastErrorSn,
  ])
  return [
    '## MPEG-TS continuity',
    'Continuity counter jumps inside each analyzed segment (not across segments). fMP4 and encrypted segments are not analyzed.',
    table(['Track', 'Level', 'PID', 'Type', 'Packets', 'CC errors', 'Segments', 'Affected segments', 'Last error SN'], rows),
  ].join('\n\n')
}

function alignmentSection({ alignment, source }: MonitorSnapshot, at: At): string {
  if (source.kind === 'media') return '## Variant alignment\n\n_Not applicable: the source is a single media playlist._'
  if (!alignment) return '## Variant alignment\n\n_No probe yet (needs a master playlist with more than one variant)._'
  return [
    '## Variant alignment',
    fields([
      ['Last probe', at(alignment.t)],
      ['Live', alignment.live],
      ['SNs listed by every variant', alignment.comparedSns],
      ['Playlist requests made by the prober', alignment.requests],
      ['Issues', alignment.issues.length],
    ]),
    table(
      ['Level', 'First SN', 'Last SN', 'Segments', 'Duration (s)', 'Discontinuities', 'First PDT', 'Error', 'URI'],
      alignment.variants.map((v) => [
        v.level,
        v.firstSn,
        v.lastSn,
        v.segments,
        round(v.durationS, 3),
        v.discontinuities,
        v.firstPdt !== undefined ? new Date(v.firstPdt).toISOString() : undefined,
        v.error,
        v.uri,
      ]),
    ),
    '### Issues',
    table(
      ['Kind', 'SN', 'Levels', 'Detail'],
      alignment.issues.map((i) => [i.kind, i.sn, i.levels.join(', '), i.detail]),
    ),
  ].join('\n\n')
}

const STATUS_TEXT: Record<string, string> = { pass: 'ok', na: 'n/a' }

function checksSection({ findings, playlists, parts }: MonitorSnapshot, at: At): string {
  const summary = summarizeChecks(findings, sessionUsesLlHls(playlists, parts.length))
  return [
    '## Spec checks',
    table(
      ['Check', 'Status', 'Findings'],
      summary.map((c) => [c.label, STATUS_TEXT[c.status] ?? c.status, c.findings.length]),
    ),
    '### Findings',
    'Count = distinct occurrences (usually segments); repeats on later live refreshes are not counted.',
    table(
      ['Severity', 'Check', 'Count', 'First seen', 'Last seen', 'Message', 'URL'],
      summary.flatMap((c) => c.findings.map((f) => [f.severity, c.label, f.count, at(f.firstSeen), at(f.lastSeen), f.message, f.url])),
    ),
  ].join('\n\n')
}

function errorsSection({ errors }: MonitorSnapshot, at: At): string {
  const probe = (c: boolean | undefined) => (c === undefined ? undefined : c ? 'server reachable: CORS' : 'server unreachable')
  return [
    '## Errors',
    table(
      ['Time', 'Type', 'Fatal', 'Retries', 'HTTP', 'Details', 'Message', 'CORS probe', 'URL'],
      errors.map((e) => [at(e.t), e.type, e.fatal, e.retries, e.status, e.details, e.message, e.type === 'cors' ? probe(e.corsConfirmed) : undefined, e.url]),
    ),
  ].join('\n\n')
}

function samplesAppendix({ samples }: MonitorSnapshot, at: At): string {
  return [
    '## Appendix A: Samples',
    'One sample every 500 ms. Frame counters are cumulative and reset by the browser on media attach.',
    table(
      ['Time', 'Buffer ahead (s)', 'Behind live edge (s)', 'Latency vs PDT (s)', 'Dropped frames', 'Total frames', 'Level'],
      samples.map((x) => [at(x.t), round(x.bufferAhead, 3), round(x.liveEdgeDistance, 3), round(x.pdtLatency, 3), x.droppedFrames, x.totalFrames, x.level]),
    ),
  ].join('\n\n')
}

function loudnessAppendix({ loudness }: MonitorSnapshot, at: At): string {
  return [
    '## Appendix B: Loudness series',
    table(
      ['Time', 'Momentary (LUFS)', 'Short-term (LUFS)'],
      (loudness?.series ?? []).map((p) => [at(p.t), round(p.momentary, 1), round(p.shortTerm, 1)]),
    ),
  ].join('\n\n')
}

function segmentDetails(r: SegmentRecord): string {
  const out = [`### ${r.track} · level ${r.level} · SN ${r.sn}`]
  if (r.tsError) out.push(fields([['TS analysis error', r.tsError]]))
  if (r.streams?.length) {
    out.push(
      table(
        ['PID', 'Stream type', 'Codec', 'Sample rate', 'Channels', 'PTS start (s)', 'PTS end (s)', 'PES', 'Duration (s)'],
        r.streams.map((s) => [
          formatPid(s.pid),
          `${streamTypeName(s.streamType)} (0x${s.streamType.toString(16).padStart(2, '0')})`,
          s.codec ?? s.family,
          s.sampleRate,
          s.channels,
          round(s.minPts, 3),
          round(s.maxPts, 3),
          s.pesCount,
          round(s.duration, 3),
        ]),
      ),
    )
  }
  if (r.pids?.length) {
    const streamType = (pid: number) => r.streams?.find((s) => s.pid === pid)?.streamType
    out.push(table(['PID', 'Type', 'Packets', 'CC errors'], r.pids.map((p) => [formatPid(p.pid), pidLabel(p.pid, streamType(p.pid), p.kind), p.packets, p.ccErrors])))
  }
  if (r.headers?.length) out.push(table(['Response header', 'Value'], r.headers))
  return out.join('\n\n')
}

function segmentDetailsAppendix({ segments }: MonitorSnapshot): string {
  const detailed = segments.filter((r) => r.tsError || r.streams?.length || r.pids?.length || r.headers?.length)
  return [
    '## Appendix C: Segment details',
    'Elementary streams, PIDs and response headers per segment. Browsers only expose CORS-safelisted headers plus `Access-Control-Expose-Headers` on cross-origin responses.',
    ...(detailed.length ? detailed.map(segmentDetails) : ['_No data._']),
  ].join('\n\n')
}
