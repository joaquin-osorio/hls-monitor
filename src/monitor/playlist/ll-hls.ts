import type { CheckObservation } from '../checks'
import type { DeliveryDirectives, RequestRecord } from '../loader'
import type { MediaPart, MediaPlaylist, PreloadHint, ServerControl } from './parse'

/** Part durations may exceed PART-TARGET by this much (float noise in the playlist). */
const PART_TARGET_EPSILON_S = 0.001

/** LL-HLS view of one media playlist load. */
export interface LlSummary {
  partTarget?: number
  serverControl?: ServerControl
  /** Parts listed in the playlist, including `pendingParts`. */
  partCount: number
  pendingParts: number
  preloadHints: PreloadHint[]
  renditionReports: number
  /** Present when this load was a blocking reload (`_HLS_msn` in the URL). */
  blocking?: DeliveryDirectives & {
    /** Server hold time: TTFB of the playlist request. */
    holdMs?: number
    /** The response contains the requested MSN (and part), as the spec requires. */
    satisfied?: boolean
  }
  /** Cumulative preload-hint outcomes for this playlist (see `LlHlsTracker`). */
  hintsFulfilled: number
  hintsUnfulfilled: number
}

function allParts(playlist: MediaPlaylist): MediaPart[] {
  return [...playlist.segments.flatMap((s) => s.parts ?? []), ...playlist.pendingParts]
}

/** True when the playlist uses any LL-HLS feature. */
export function isLowLatency(playlist: MediaPlaylist): boolean {
  return playlist.partTarget !== undefined || playlist.pendingParts.length > 0 || playlist.segments.some((s) => s.parts?.length)
}

/**
 * Whether a blocking reload response contains what was asked for: segment `msn` complete, or
 * (with `_HLS_part`) part `part` of segment `msn`, or anything later.
 */
export function blockingSatisfied(playlist: MediaPlaylist, msn: number, part: number | undefined): boolean {
  const lastSn = playlist.mediaSequence + playlist.skippedSegments + playlist.segments.length - 1
  if (lastSn >= msn) return true
  return part !== undefined && lastSn + 1 === msn && playlist.pendingParts.length > part
}

interface PendingHint {
  uri: string
  /** SN of the segment the hinted part belongs to (the one being produced when hinted). */
  sn: number
}

/**
 * Tracks EXT-X-PRELOAD-HINT (TYPE=PART) per playlist. A hint is **fulfilled** when its URI shows
 * up as an EXT-X-PART of the expected segment in a later load, and **unfulfilled** when that
 * segment is listed with parts but without the hinted URI. If the segment's parts have already
 * scrolled out of the playlist (a slow refresh), the hint is dropped without a verdict.
 */
export class LlHlsTracker {
  private readonly pending = new Map<string, PendingHint[]>()
  private readonly totals = new Map<string, { fulfilled: number; unfulfilled: number }>()

  observe(key: string, playlist: MediaPlaylist): { fulfilled: number; unfulfilled: number; newlyUnfulfilled: PendingHint[] } {
    const totals = this.totals.get(key) ?? { fulfilled: 0, unfulfilled: 0 }
    const newlyUnfulfilled: PendingHint[] = []
    const listedUris = new Set(allParts(playlist).map((p) => p.uri))
    const nextSn = playlist.mediaSequence + playlist.skippedSegments + playlist.segments.length
    const hinted = new Set(playlist.preloadHints.filter((h) => h.type === 'PART').map((h) => h.uri))

    const stillPending: PendingHint[] = []
    for (const hint of this.pending.get(key) ?? []) {
      if (listedUris.has(hint.uri)) {
        totals.fulfilled++
        continue
      }
      if (hinted.has(hint.uri)) {
        stillPending.push(hint) // still announced, not published yet
        continue
      }
      const segment = playlist.segments.find((s) => s.sn === hint.sn)
      const segmentListsParts = hint.sn === nextSn ? playlist.pendingParts.length > 0 : !!segment?.parts?.length
      if (segmentListsParts) {
        totals.unfulfilled++
        newlyUnfulfilled.push(hint)
      }
    }
    for (const uri of hinted) {
      if (!stillPending.some((h) => h.uri === uri)) stillPending.push({ uri, sn: nextSn })
    }
    this.pending.set(key, stillPending)
    this.totals.set(key, totals)
    return { ...totals, newlyUnfulfilled }
  }

  forget(key: string): void {
    this.pending.delete(key)
  }
}

export function summarizeLl(
  playlist: MediaPlaylist,
  record: RequestRecord,
  hints: { fulfilled: number; unfulfilled: number },
): LlSummary | undefined {
  const blocking = record.blocking
  if (!isLowLatency(playlist) && !blocking?.msn) return undefined
  return {
    partTarget: playlist.partTarget,
    serverControl: playlist.serverControl,
    partCount: allParts(playlist).length,
    pendingParts: playlist.pendingParts.length,
    preloadHints: playlist.preloadHints,
    renditionReports: playlist.renditionReports.length,
    blocking: blocking && {
      ...blocking,
      holdMs: record.first !== undefined ? record.first - record.start : undefined,
      satisfied: blocking.msn !== undefined ? blockingSatisfied(playlist, blocking.msn, blocking.part) : undefined,
    },
    hintsFulfilled: hints.fulfilled,
    hintsUnfulfilled: hints.unfulfilled,
  }
}

/**
 * LL-HLS spec checks (RFC 8216bis §4.4.3.7, §4.4.3.8, §4.4.4.9, §6.2.5.2) for one playlist
 * load. `url` must be stable across refreshes (delivery directives stripped), since it is part
 * of the dedup keys. `newlyUnfulfilled` comes from `LlHlsTracker.observe`.
 */
export function checkLlHls(
  playlist: MediaPlaylist,
  url: string,
  summary: LlSummary | undefined,
  newlyUnfulfilled: readonly PendingHint[] = [],
): CheckObservation[] {
  const out: CheckObservation[] = []
  const sc = playlist.serverControl
  const target = playlist.targetDuration
  if (sc?.holdBack !== undefined && target !== undefined && sc.holdBack < 3 * target) {
    out.push({
      checkId: 'll-server-control',
      key: `ll-server-control|hold-back|${url}`,
      severity: 'error',
      message: `HOLD-BACK ${sc.holdBack}s is below 3 × TARGETDURATION (${3 * target}s)`,
      url,
    })
  }
  if (!isLowLatency(playlist)) return out

  const partTarget = playlist.partTarget
  if (partTarget === undefined) {
    out.push({
      checkId: 'll-part-target',
      key: `ll-part-target|missing|${url}`,
      severity: 'error',
      message: 'EXT-X-PART present without EXT-X-PART-INF',
      url,
    })
  } else {
    const firstPendingSn = playlist.mediaSequence + playlist.skippedSegments + playlist.segments.length
    const withSn = [
      ...playlist.segments.flatMap((s) => (s.parts ?? []).map((p, i) => ({ p, i, sn: s.sn }))),
      ...playlist.pendingParts.map((p, i) => ({ p, i, sn: firstPendingSn })),
    ]
    for (const { p, i, sn } of withSn) {
      if (p.duration <= partTarget + PART_TARGET_EPSILON_S) continue
      out.push({
        checkId: 'll-part-target',
        key: `ll-part-target|exceeded|${url}`,
        severity: 'error',
        message: `Part ${i} of segment ${sn} lasts ${p.duration}s, above PART-TARGET ${partTarget}s`,
        occurrence: sn * 1000 + i,
        url,
      })
    }
  }

  if (!sc?.canBlockReload) {
    out.push({
      checkId: 'll-server-control',
      key: `ll-server-control|block-reload|${url}`,
      severity: 'warn',
      message: 'Parts are published but EXT-X-SERVER-CONTROL lacks CAN-BLOCK-RELOAD=YES',
      url,
    })
  }
  if (sc?.partHoldBack === undefined) {
    out.push({
      checkId: 'll-server-control',
      key: `ll-server-control|part-hold-back-missing|${url}`,
      severity: 'error',
      message: 'PART-HOLD-BACK is required when the playlist has EXT-X-PART-INF',
      url,
    })
  } else if (partTarget !== undefined && sc.partHoldBack < 2 * partTarget) {
    out.push({
      checkId: 'll-server-control',
      key: `ll-server-control|part-hold-back|${url}`,
      severity: 'error',
      message: `PART-HOLD-BACK ${sc.partHoldBack}s is below 2 × PART-TARGET (${2 * partTarget}s)`,
      url,
    })
  }

  const blocking = summary?.blocking
  if (blocking?.msn !== undefined && blocking.satisfied === false) {
    out.push({
      checkId: 'll-blocking-reload',
      key: `ll-blocking-reload|${url}`,
      severity: 'error',
      message: `Blocking reload for MSN ${blocking.msn}${blocking.part !== undefined ? ` part ${blocking.part}` : ''} returned a playlist without it`,
      occurrence: blocking.msn * 1000 + (blocking.part ?? 0),
      url,
    })
  }

  // Occurrences number unfulfilled hints in order, so each one counts once.
  const base = (summary?.hintsUnfulfilled ?? newlyUnfulfilled.length) - newlyUnfulfilled.length
  newlyUnfulfilled.forEach((hint, i) => {
    out.push({
      checkId: 'll-preload-hint',
      key: `ll-preload-hint|${url}`,
      severity: 'warn',
      message: `Preload hint ${hint.uri.split('/').pop()} was never published as a part of segment ${hint.sn}`,
      occurrence: base + i + 1,
      url,
    })
  })
  return out
}
