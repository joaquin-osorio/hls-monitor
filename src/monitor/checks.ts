import { type CodecFamily, familyOfCodecString } from './codecs'
import type { PlaylistRefresh } from './playlist/health'
import type { MasterPlaylist, MediaPlaylist } from './playlist/parse'
import type { TsAnalysis } from './ts/parse-ts'
import { formatPid, pidLabel } from './ts/stream-types'

export type Severity = 'error' | 'warn' | 'info'

/** Max allowed difference between EXTINF and the duration measured from PTS, in seconds. */
export const EXTINF_TOLERANCE_S = 0.1

export type CheckId =
  | 'target-exceeded'
  | 'discontinuity'
  | 'endlist-in-live'
  | 'codecs-missing'
  | 'codecs-undeclared'
  | 'ts-continuity'
  | 'extinf-mismatch'
  | 'll-part-target'
  | 'll-server-control'
  | 'll-blocking-reload'
  | 'll-preload-hint'
  | 'variant-alignment'

/** One raw result of a check. Observations sharing a `key` collapse into one `Finding`. */
export interface CheckObservation {
  checkId: CheckId
  /** Dedup key: one finding per key. */
  key: string
  severity: Severity
  message: string
  /**
   * Monotonic identifier of what was observed, usually a segment SN. Observations with an
   * occurrence at or below the highest one already recorded are repeats (the same segment seen
   * again on the next live refresh) and are not counted.
   */
  occurrence?: number
  url?: string
}

export interface Finding extends CheckObservation {
  count: number
  /** `performance.now()` of the first and latest counted observation. */
  firstSeen: number
  lastSeen: number
}

export interface CheckDefinition {
  id: CheckId
  label: string
  /** Only meaningful for LL-HLS streams; not applicable otherwise (unless it has findings). */
  ll?: true
}

/** Every check, in display order, with its human-readable label. */
export const CHECK_DEFINITIONS: readonly CheckDefinition[] = [
  { id: 'target-exceeded', label: 'EXTINF within TARGETDURATION' },
  { id: 'discontinuity', label: 'Discontinuities' },
  { id: 'endlist-in-live', label: 'ENDLIST on a live playlist' },
  { id: 'codecs-missing', label: 'CODECS declared on every variant' },
  { id: 'codecs-undeclared', label: 'Segment codecs match CODECS' },
  { id: 'ts-continuity', label: 'MPEG-TS continuity counters' },
  { id: 'extinf-mismatch', label: 'EXTINF matches media duration' },
  { id: 'variant-alignment', label: 'Variants aligned' },
  { id: 'll-part-target', label: 'LL-HLS parts within PART-TARGET', ll: true },
  { id: 'll-server-control', label: 'LL-HLS server control and hold-back', ll: true },
  { id: 'll-blocking-reload', label: 'LL-HLS blocking reloads honored', ll: true },
  { id: 'll-preload-hint', label: 'LL-HLS preload hints fulfilled', ll: true },
]

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

export type CheckStatus = Severity | 'pass' | 'na'

export interface CheckSummary extends CheckDefinition {
  /** Worst severity among its findings; `pass` without findings, `na` for LL checks on non-LL streams. */
  status: CheckStatus
  /** Findings of this check, worst first. */
  findings: Finding[]
}

/** One entry per check in `CHECK_DEFINITIONS` order, with its findings and overall status. */
export function summarizeChecks(findings: readonly Finding[], lowLatency: boolean): CheckSummary[] {
  return CHECK_DEFINITIONS.map((check) => {
    const list = findings.filter((f) => f.checkId === check.id).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    const status: CheckStatus = list[0]?.severity ?? (check.ll && !lowLatency ? 'na' : 'pass')
    return { ...check, status, findings: list }
  })
}

export function checkMasterPlaylist(master: MasterPlaylist, url: string): CheckObservation[] {
  const missing = master.variants.filter((v) => !v.codecs?.length)
  if (missing.length === 0) return []
  return [
    {
      checkId: 'codecs-missing',
      key: `codecs-missing|${url}`,
      severity: 'warn',
      message: `${missing.length} of ${master.variants.length} variants have no CODECS attribute`,
      url,
    },
  ]
}

export function checkMediaPlaylist(playlist: MediaPlaylist, url: string, refresh?: PlaylistRefresh): CheckObservation[] {
  const out: CheckObservation[] = []
  const target = playlist.targetDuration
  for (const seg of playlist.segments) {
    // RFC 8216 §4.3.3.1: EXTINF rounded to the nearest integer MUST be <= EXT-X-TARGETDURATION.
    if (target !== undefined && Math.round(seg.duration) > target) {
      out.push({
        checkId: 'target-exceeded',
        key: `target-exceeded|${url}`,
        severity: 'error',
        message: `Segment ${seg.sn} lasts ${seg.duration}s, above TARGETDURATION ${target}s`,
        occurrence: seg.sn,
        url,
      })
    }
    if (seg.discontinuity) {
      out.push({
        checkId: 'discontinuity',
        key: `discontinuity|${url}`,
        severity: 'info',
        message: `EXT-X-DISCONTINUITY before segment ${seg.sn}`,
        occurrence: seg.sn,
        url,
      })
    }
  }
  if (refresh?.endListAppeared) {
    out.push({
      checkId: 'endlist-in-live',
      key: `endlist-in-live|${url}`,
      severity: 'warn',
      message: 'EXT-X-ENDLIST appeared on a live playlist: the stream ended',
      url,
    })
  }
  return out
}

/**
 * Compares codec families found in a variant's segments with its CODECS attribute. Variants
 * without CODECS are already reported by `checkMasterPlaylist`.
 */
export function checkDetectedCodecs(
  variantUri: string,
  declared: string[] | undefined,
  detected: readonly CodecFamily[],
): CheckObservation[] {
  if (!declared?.length) return []
  const declaredFamilies = new Set(declared.map(familyOfCodecString))
  const undeclared = detected.filter((f) => !declaredFamilies.has(f))
  if (undeclared.length === 0) return []
  return [
    {
      checkId: 'codecs-undeclared',
      key: `codecs-undeclared|${variantUri}|${undeclared.join(',')}`,
      severity: 'error',
      message: `Segments contain ${undeclared.join(', ')} but CODECS declares "${declared.join(',')}"`,
      url: variantUri,
    },
  ]
}

/**
 * One finding per (playlist, PID) whose continuity counter jumped inside segment `sn`. The count
 * of a finding is the number of affected segments.
 */
export function checkTsContinuity(
  track: string,
  level: number,
  sn: number,
  url: string,
  analysis: Pick<TsAnalysis, 'pids' | 'streams'>,
): CheckObservation[] {
  return analysis.pids
    .filter((p) => p.ccErrors > 0)
    .map((p) => {
      const label = pidLabel(p.pid, analysis.streams.find((s) => s.pid === p.pid)?.streamType, p.kind)
      return {
        checkId: 'ts-continuity' as const,
        key: `ts-continuity|${track}:${level}|${p.pid}`,
        severity: 'error' as const,
        message: `${track} ${level} · PID ${formatPid(p.pid)} (${label}): ${p.ccErrors} continuity errors in segment ${sn}`,
        occurrence: sn,
        url,
      }
    })
}

/** Flags a segment whose PTS-measured duration differs from its EXTINF by more than the tolerance. */
export function checkSegmentDuration(
  track: string,
  level: number,
  sn: number,
  url: string,
  extinf: number,
  measured: number | undefined,
): CheckObservation[] {
  if (measured === undefined || extinf <= 0 || Math.abs(measured - extinf) <= EXTINF_TOLERANCE_S) return []
  return [
    {
      checkId: 'extinf-mismatch',
      key: `extinf-mismatch|${track}:${level}`,
      severity: 'warn',
      message: `${track} ${level} · segment ${sn}: EXTINF ${extinf}s but media lasts ${measured.toFixed(3)}s`,
      occurrence: sn,
      url,
    },
  ]
}

/** Deduplicated, counted findings. Finding objects are replaced, never mutated. */
export class FindingsLog {
  private readonly findings = new Map<string, Finding>()

  /** Returns true when the log changed. */
  record(obs: CheckObservation, t: number): boolean {
    const existing = this.findings.get(obs.key)
    if (!existing) {
      this.findings.set(obs.key, { ...obs, count: 1, firstSeen: t, lastSeen: t })
      return true
    }
    if (obs.occurrence === undefined || existing.occurrence === undefined || obs.occurrence <= existing.occurrence) {
      return false
    }
    this.findings.set(obs.key, { ...obs, count: existing.count + 1, firstSeen: existing.firstSeen, lastSeen: t })
    return true
  }

  /** Records many observations; returns true if any changed the log. */
  recordAll(observations: readonly CheckObservation[], t: number): boolean {
    let changed = false
    for (const obs of observations) changed = this.record(obs, t) || changed
    return changed
  }

  list(): Finding[] {
    return [...this.findings.values()]
  }

  clear(): void {
    this.findings.clear()
  }
}
