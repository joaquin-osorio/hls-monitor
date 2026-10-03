import type { VariantSelection } from '@/lib/query-state'
import type { AlignmentReport } from './alignment'
import type { LoudnessInfo } from './audio/loudness-meter'
import type { Finding } from './checks'
import type { CodecFamily } from './codecs'
import type { MonitorError } from './errors'
import type { PartRecord } from './parts'
import type { PlaylistRefresh } from './playlist/health'
import type { SegmentRecord } from './segments'

export type SessionPhase = 'loading' | 'ready' | 'fatal' | 'unsupported'

export interface SourceInfo {
  url: string
  /** `performance.now()` when the session was created. */
  startedAt: number
  phase: SessionPhase
  /** Known once the first playlist is parsed. */
  kind?: 'master' | 'media'
  /** True while the media playlist has no ENDLIST. */
  live?: boolean
  /** http:// stream on an https:// page: the browser blocks it before any request. */
  mixedContent: boolean
  /** Latest fatal error, if playback stopped. */
  fatal?: MonitorError
}

export interface VariantInfo {
  /** Index in `hls.levels` (what `?variant=` refers to). */
  index: number
  url: string
  width?: number
  height?: number
  /** CODECS attribute as sent by the server; undefined when missing. */
  codecs?: string[]
  bandwidth?: number
  averageBandwidth?: number
  /** Σ bytes × 8 / Σ EXTINF of loaded segments, bits/s. */
  measuredBitrate?: number
  /** Codec families found in segments by the TS worker (empty for fMP4/encrypted). */
  detectedCodecs: CodecFamily[]
}

export interface SelectionInfo {
  auto: boolean
  /** Level being played, -1 before the first switch. */
  currentLevel: number
  /** Level being downloaded. */
  loadLevel: number
}

export interface Sample {
  /** `performance.now()` */
  t: number
  /** Seconds buffered ahead of the playhead. */
  bufferAhead: number
  /** Live only: seconds behind the live edge (`hls.latency`). */
  liveEdgeDistance?: number
  /** Seconds between wall clock and the PROGRAM-DATE-TIME of the playhead. Client-clock dependent. */
  pdtLatency?: number
  /** Cumulative `getVideoPlaybackQuality().droppedVideoFrames`; reset by the browser on media attach. */
  droppedFrames?: number
  /** Cumulative `getVideoPlaybackQuality().totalVideoFrames`. */
  totalFrames?: number
  /** `hls.currentLevel` at sample time (-1 before the first switch). */
  level?: number
}

export interface Stall {
  /** `performance.now()` when the player started waiting. */
  t: number
  /** Undefined while the stall is ongoing. */
  durationMs?: number
}

export interface MonitorSnapshot {
  source: SourceInfo
  variants: VariantInfo[]
  selection: SelectionInfo
  segments: SegmentRecord[]
  /** LL-HLS part requests. */
  parts: PartRecord[]
  playlists: PlaylistRefresh[]
  samples: Sample[]
  stalls: Stall[]
  errors: MonitorError[]
  findings: Finding[]
  /** Latest variant alignment probe; null for media-playlist sources or before the first probe. */
  alignment: AlignmentReport | null
  /** Loudness meter state; null while the meter is off. */
  loudness: LoudnessInfo | null
}

export type SnapshotKey = keyof MonitorSnapshot

export type { VariantSelection }
