import type { CheckObservation } from './checks'
import { type MediaPlaylist, parsePlaylist } from './playlist/parse'

/** Max per-segment difference (EXTINF, PDT, start PTS) between variants, in seconds. */
export const ALIGNMENT_TOLERANCE_S = 0.1
/** Max difference in total playlist duration between VOD variants, in seconds. */
const WINDOW_TOLERANCE_S = 1
/** Issues kept per report (the first ones by SN). */
const MAX_ISSUES = 200

export type AlignmentIssueKind = 'extinf' | 'discontinuity' | 'pdt' | 'pts' | 'window'

export interface AlignmentIssue {
  kind: AlignmentIssueKind
  /** Media sequence number, when the issue is about one segment. */
  sn?: number
  /** Variants (hls.js level indexes) that disagree with the reference (lowest level). */
  levels: number[]
  detail: string
}

/** Result of fetching one variant's media playlist. */
export interface VariantFetch {
  level: number
  uri: string
  text?: string
  error?: string
}

export interface VariantSummary {
  level: number
  uri: string
  firstSn?: number
  lastSn?: number
  segments: number
  /** Σ EXTINF of the listed segments, seconds. */
  durationS: number
  discontinuities: number
  /** PROGRAM-DATE-TIME of the first listed segment, epoch ms. */
  firstPdt?: number
  error?: string
}

export interface AlignmentReport {
  /** `performance.now()` of the probe. */
  t: number
  live: boolean
  variants: VariantSummary[]
  issues: AlignmentIssue[]
  /** SNs listed by every variant (the only ones compared segment by segment). */
  comparedSns: number
  /** Playlist requests made by the prober so far. */
  requests: number
}

/** Start PTS of analyzed segments: SN → level → seconds. */
export type PtsBySn = ReadonlyMap<number, ReadonlyMap<number, number>>

function summarize(level: number, uri: string, playlist: MediaPlaylist): VariantSummary {
  const segs = playlist.segments
  return {
    level,
    uri,
    firstSn: segs[0]?.sn,
    lastSn: segs.at(-1)?.sn,
    segments: segs.length,
    durationS: segs.reduce((sum, s) => sum + s.duration, 0),
    discontinuities: segs.filter((s) => s.discontinuity).length,
    firstPdt: segs[0]?.programDateTime,
  }
}

/** Levels whose value differs from the reference by more than `tolerance`. */
function outliers(values: [number, number | undefined][], tolerance: number): { ref: number; levels: number[] } | undefined {
  const known = values.filter((v): v is [number, number] => v[1] !== undefined)
  if (known.length < 2) return undefined
  const ref = known[0][1]
  const levels = known.filter(([, v]) => Math.abs(v - ref) > tolerance).map(([l]) => l)
  return levels.length ? { ref, levels } : undefined
}

/**
 * Compares the media playlists of several variants of one master playlist. Segment-level
 * checks only use SNs listed by every variant, so live windows fetched a moment apart still
 * compare. The reference is the lowest level; `levels` in an issue are the ones that differ.
 */
export function compareVariants(byLevel: ReadonlyMap<number, MediaPlaylist>, ptsBySn: PtsBySn, live: boolean): { issues: AlignmentIssue[]; comparedSns: number } {
  const issues: AlignmentIssue[] = []
  const levels = [...byLevel.keys()].sort((a, b) => a - b)
  if (levels.length < 2) return { issues, comparedSns: 0 }
  const bySn = levels.map((l) => new Map(byLevel.get(l)!.segments.map((s) => [s.sn, s])))
  const common = [...bySn[0].keys()].filter((sn) => bySn.every((m) => m.has(sn))).sort((a, b) => a - b)

  if (common.length === 0) {
    issues.push({ kind: 'window', levels: levels.slice(1), detail: 'Variants share no media sequence numbers' })
  }
  if (!live) {
    const summaries = levels.map((l) => summarize(l, '', byLevel.get(l)!))
    const ref = summaries[0]
    const rangeOff = summaries.filter((s) => s.firstSn !== ref.firstSn || s.lastSn !== ref.lastSn).map((s) => s.level)
    if (rangeOff.length) {
      issues.push({ kind: 'window', levels: rangeOff, detail: `SN range differs from level ${ref.level} (${ref.firstSn}–${ref.lastSn})` })
    }
    const durationOff = summaries.filter((s) => Math.abs(s.durationS - ref.durationS) > WINDOW_TOLERANCE_S).map((s) => s.level)
    if (durationOff.length) {
      issues.push({ kind: 'window', levels: durationOff, detail: `Total duration differs from level ${ref.level} (${ref.durationS.toFixed(3)} s)` })
    }
  }

  for (const sn of common) {
    if (issues.length >= MAX_ISSUES) break
    const segs = bySn.map((m) => m.get(sn)!)
    const extinf = outliers(segs.map((s, i) => [levels[i], s.duration]), ALIGNMENT_TOLERANCE_S)
    if (extinf) issues.push({ kind: 'extinf', sn, levels: extinf.levels, detail: `EXTINF differs from ${extinf.ref}s` })
    const ccOff = levels.filter((_, i) => segs[i].cc !== segs[0].cc)
    if (ccOff.length) issues.push({ kind: 'discontinuity', sn, levels: ccOff, detail: `Discontinuity sequence differs from ${segs[0].cc}` })
    const pdt = outliers(
      segs.map((s, i) => [levels[i], s.programDateTime === undefined ? undefined : s.programDateTime / 1000]),
      ALIGNMENT_TOLERANCE_S,
    )
    if (pdt) issues.push({ kind: 'pdt', sn, levels: pdt.levels, detail: `PROGRAM-DATE-TIME differs from ${new Date(pdt.ref * 1000).toISOString()}` })
  }

  // Start PTS of segments hls.js already downloaded on several levels (ABR switches).
  for (const [sn, ptsByLevel] of [...ptsBySn].sort((a, b) => a[0] - b[0])) {
    if (issues.length >= MAX_ISSUES) break
    const pts = outliers([...ptsByLevel].sort((a, b) => a[0] - b[0]), ALIGNMENT_TOLERANCE_S)
    if (pts) issues.push({ kind: 'pts', sn, levels: pts.levels, detail: `Start PTS differs from ${pts.ref.toFixed(3)} s` })
  }
  return { issues: issues.slice(0, MAX_ISSUES), comparedSns: common.length }
}

/** Parses the fetched playlists and compares them. */
export function buildAlignmentReport(fetches: readonly VariantFetch[], ptsBySn: PtsBySn, t: number, requests: number): AlignmentReport {
  const byLevel = new Map<number, MediaPlaylist>()
  const variants: VariantSummary[] = []
  for (const f of fetches) {
    let error = f.error
    if (f.text !== undefined) {
      try {
        const p = parsePlaylist(f.text, f.uri)
        if (p.kind === 'media') {
          byLevel.set(f.level, p)
          variants.push(summarize(f.level, f.uri, p))
          continue
        }
        error = 'Not a media playlist'
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }
    variants.push({ level: f.level, uri: f.uri, segments: 0, durationS: 0, discontinuities: 0, error })
  }
  const live = [...byLevel.values()].some((p) => !p.endList && p.playlistType !== 'VOD')
  return { t, live, variants, requests, ...compareVariants(byLevel, ptsBySn, live) }
}

/** `variant-alignment` findings: one key per issue kind, counted per SN. */
export function alignmentObservations(report: AlignmentReport): CheckObservation[] {
  const out: CheckObservation[] = report.issues.map((issue) => ({
    checkId: 'variant-alignment',
    key: `variant-alignment|${issue.kind}`,
    severity: 'error',
    message: `${issue.sn !== undefined ? `Segment ${issue.sn}: ` : ''}${issue.detail} on level${issue.levels.length > 1 ? 's' : ''} ${issue.levels.join(', ')}`,
    occurrence: issue.sn,
  }))
  for (const v of report.variants) {
    if (!v.error) continue
    out.push({
      checkId: 'variant-alignment',
      key: `variant-alignment|fetch|${v.uri}`,
      severity: 'info',
      message: `Could not compare level ${v.level}: ${v.error}`,
      url: v.uri,
    })
  }
  return out
}
