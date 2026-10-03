import Hls, { Events, type ErrorData, type LevelSwitchingData, type PlaylistLoaderContext } from 'hls.js'
import type { VariantSelection } from '@/lib/query-state'
import { alignmentObservations, buildAlignmentReport, type AlignmentReport, type VariantFetch } from './alignment'
import { AlignmentProber } from './alignment-prober'
import { audioGraphFor } from './audio/audio-graph'
import { LoudnessMeter } from './audio/loudness-meter'
import {
  checkDetectedCodecs,
  checkMasterPlaylist,
  checkMediaPlaylist,
  checkSegmentDuration,
  checkTsContinuity,
  FindingsLog,
  type CheckObservation,
} from './checks'
import type { CodecFamily } from './codecs'
import { isMixedContent, probeCors } from './cors'
import { classifyHlsError, type MonitorError } from './errors'
import { createMonitoringLoader, stripDeliveryDirectives, type LoaderSink, type RequestRecord } from './loader'
import { NetworkShaper, type ThrottleProfile } from './network-shaper'
import { PartLog } from './parts'
import { PlaylistHealthTracker, type PlaylistRefresh } from './playlist/health'
import { checkLlHls, LlHlsTracker, summarizeLl } from './playlist/ll-hls'
import { parsePlaylist, PlaylistParseError, type MediaPlaylist } from './playlist/parse'
import { RETENTION_MS, TimeWindowBuffer } from './ring-buffer'
import { measuredBitrates, SegmentLog, segmentKey } from './segments'
import { ThrottledStore } from './store'
import { TsAnalyzer } from './ts/ts-client'
import type { MonitorSnapshot, Sample, SnapshotKey, SourceInfo, Stall, VariantInfo } from './types'

/** How often buffer and latency are sampled. */
export const SAMPLE_INTERVAL_MS = 500

/** Room for one sample per tick over the whole retention window, plus a margin for timer drift. */
const SAMPLE_CAPACITY = Math.ceil(RETENTION_MS / SAMPLE_INTERVAL_MS) + 600

export interface MonitorSessionOptions {
  /** Initial variant from `?variant=`. Applied once levels are known. */
  variant?: VariantSelection
  /** Called when the requested variant index does not exist; the session falls back to auto. */
  onVariantRejected?: () => void
}

/**
 * One monitoring session for one stream URL: owns the hls.js instance, wires its loader and
 * events to the collectors, samples the media element, and publishes a throttled snapshot.
 *
 * Framework-agnostic: React only subscribes to `store`. Create a new session per URL and call
 * `destroy()` when done.
 */
export class MonitorSession {
  readonly store: ThrottledStore<MonitorSnapshot, SnapshotKey>

  private readonly video: HTMLVideoElement
  private readonly options: MonitorSessionOptions
  private hls: Hls | null = null
  private analyzer: TsAnalyzer | null = null
  private prober: AlignmentProber | null = null
  private loudness: LoudnessMeter | null = null
  private alignment: AlignmentReport | null = null
  private sampler: ReturnType<typeof setInterval> | undefined
  private destroyed = false

  private source: SourceInfo
  private readonly shaper = new NetworkShaper()
  private readonly segments = new SegmentLog()
  private readonly parts = new PartLog()
  private readonly playlists = new TimeWindowBuffer<PlaylistRefresh>(15_000)
  private readonly samples = new TimeWindowBuffer<Sample>(SAMPLE_CAPACITY)
  private readonly stalls = new TimeWindowBuffer<Stall>(1000)
  private readonly errors = new TimeWindowBuffer<MonitorError>(1000)
  private readonly findings = new FindingsLog()
  private readonly health = new PlaylistHealthTracker()
  private readonly llHls = new LlHlsTracker()
  private readonly detectedCodecs = new Map<number, Set<CodecFamily>>()
  private readonly corsProbes = new Map<string, Promise<boolean>>()
  private nextErrorId = 0
  private hasPlayed = false
  private activeLevel = -1

  constructor(url: string, video: HTMLVideoElement, options: MonitorSessionOptions = {}) {
    this.video = video
    this.options = options
    this.source = { url, startedAt: performance.now(), phase: 'loading', mixedContent: isMixedContent(url, globalThis.location?.protocol ?? '') }
    this.store = new ThrottledStore<MonitorSnapshot, SnapshotKey>(this.emptySnapshot(), (dirty, prev) =>
      this.buildSnapshot(dirty, prev),
    )

    if (!Hls.isSupported()) {
      this.source = { ...this.source, phase: 'unsupported' }
      this.store.markDirty('source')
      return
    }

    this.analyzer = new TsAnalyzer()
    this.hls = new Hls({
      loader: createMonitoringLoader(Hls.DefaultConfig.loader, this.sink, this.shaper),
    })
    this.hls.on(Events.MANIFEST_PARSED, this.onManifestParsed)
    this.hls.on(Events.LEVEL_SWITCHING, this.onLevelSwitching)
    this.hls.on(Events.LEVEL_SWITCHED, this.onLevelSwitched)
    this.hls.on(Events.ERROR, this.onHlsError)

    video.addEventListener('waiting', this.onWaiting)
    video.addEventListener('playing', this.onPlaying)
    video.addEventListener('seeking', this.onSeeking)
    video.addEventListener('error', this.onMediaError)

    this.hls.loadSource(url)
    this.hls.attachMedia(video)
    this.sampler = setInterval(this.sample, SAMPLE_INTERVAL_MS)
  }

  /** Forces a variant (disables ABR) or returns to automatic selection. */
  setVariant(variant: VariantSelection): void {
    const hls = this.hls
    if (!hls || hls.levels.length === 0) {
      this.options.variant = variant
      return
    }
    if (variant === 'auto') {
      hls.loadLevel = -1 // back to ABR without flushing the buffer
    } else if (variant >= 0 && variant < hls.levels.length) {
      hls.currentLevel = variant // immediate switch, ABR off
    } else {
      hls.loadLevel = -1
      this.options.onVariantRejected?.()
    }
    this.store.markDirty('selection')
  }

  /** Simulates a slower network for every hls.js request (null turns it off). */
  setThrottle(profile: ThrottleProfile | null): void {
    this.shaper.set(profile)
  }

  /**
   * Starts or stops loudness measurement. Starting unmutes the element (the meter taps its
   * output) and should follow a user gesture, so the browser lets the AudioContext run.
   */
  setLoudness(enabled: boolean): void {
    if (enabled === !!this.loudness || this.destroyed) return
    if (enabled) {
      this.loudness = new LoudnessMeter(this.video, audioGraphFor(this.video), () => this.store.markDirty('loudness'))
    } else {
      this.loudness?.destroy()
      this.loudness = null
    }
    this.store.markDirty('loudness')
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    clearInterval(this.sampler)
    this.video.removeEventListener('waiting', this.onWaiting)
    this.video.removeEventListener('playing', this.onPlaying)
    this.video.removeEventListener('seeking', this.onSeeking)
    this.video.removeEventListener('error', this.onMediaError)
    this.prober?.destroy()
    this.prober = null
    this.loudness?.destroy()
    this.loudness = null
    this.hls?.destroy()
    this.hls = null
    this.analyzer?.destroy()
    this.analyzer = null
    this.store.destroy()
  }

  // ---------------------------------------------------------------- loader sink

  private readonly sink: LoaderSink = {
    onRequest: (record) => {
      if (this.destroyed) return
      if (this.segments.recordAttempt(record)) {
        this.store.markDirty('segments')
        this.store.markDirty('variants')
      }
      if (this.parts.recordAttempt(record)) this.store.markDirty('parts')
    },
    onPlaylist: (record, text, context) => {
      if (!this.destroyed) this.handlePlaylist(record, text, context)
    },
    onTsSegment: (record, copy) => {
      const analyzer = this.analyzer
      if (this.destroyed || !analyzer || analyzer.isBusy() || record.sn === undefined || record.level === undefined) return
      const { level, sn } = record
      const track = record.track ?? 'main'
      const key = segmentKey(track, level, sn)
      analyzer.analyze(copy())?.then(
        (analysis) => {
          if (this.destroyed) return
          this.segments.attachAnalysis(key, analysis)
          if (track === 'main') this.recordDetectedCodecs(level, analysis.families)
          const measured = this.segments.get(key)?.measuredDuration
          this.recordFindings(
            [
              ...checkTsContinuity(track, level, sn, record.url, analysis),
              ...checkSegmentDuration(track, level, sn, record.url, record.duration ?? 0, measured),
            ],
            performance.now(),
          )
          this.store.markDirty('segments')
        },
        (err: Error) => {
          if (this.destroyed) return
          this.segments.attachAnalysis(key, { error: err.message })
          this.pushError({ type: 'parse', fatal: false, retries: 0, details: 'tsParseError', message: err.message, url: record.url })
          this.store.markDirty('segments')
        },
      )
    },
  }

  private handlePlaylist(record: RequestRecord, text: string, context: PlaylistLoaderContext): void {
    const t = record.end
    // Blocking reloads change the query on every refresh; findings need a stable URL.
    const url = stripDeliveryDirectives(record.url)
    let playlist
    try {
      playlist = parsePlaylist(text, record.url)
    } catch (err) {
      // hls.js reports its own parse failure through ERROR; only log what hls.js tolerated.
      if (!(err instanceof PlaylistParseError)) throw err
      return
    }

    if (playlist.kind === 'master') {
      this.source = { ...this.source, kind: 'master' }
      this.store.markDirty('source')
      this.recordFindings(checkMasterPlaylist(playlist, url), t)
      return
    }

    if (record.kind === 'manifest') {
      this.source = { ...this.source, kind: 'media' }
    }
    // A media playlist given directly as the source is hls.js level 0.
    const isMain = record.kind === 'manifest' || record.kind === 'level'
    const level = isMain ? (context.level ?? 0) : (context.id ?? 0)
    const track = isMain ? 'main' : record.kind === 'audioTrack' ? 'audio' : 'subtitle'
    const live = !playlist.endList && playlist.playlistType !== 'VOD'
    if (isMain && this.source.live !== live) this.source = { ...this.source, live }
    this.store.markDirty('source')

    const key = `${track}:${level}`
    const hints = this.llHls.observe(key, playlist)
    const ll = summarizeLl(playlist, record, hints)
    const refresh: PlaylistRefresh = { ...this.health.track(key, record.url, playlist, t), ll }
    this.playlists.push(refresh)
    this.store.markDirty('playlists')

    this.markGaps(playlist, refresh, track, level, t)
    this.recordFindings([...checkMediaPlaylist(playlist, url, refresh), ...checkLlHls(playlist, url, ll, hints.newlyUnfulfilled)], t)
  }

  private markGaps(playlist: MediaPlaylist, refresh: PlaylistRefresh, track: string, level: number, t: number): void {
    let changed = false
    for (const seg of playlist.segments) {
      if (seg.gap) changed = this.segments.markGap(track, level, seg.sn, seg.duration, 'tag', t) || changed
    }
    const missedDuration = playlist.targetDuration ?? 0
    for (const sn of refresh.missedSns) {
      changed = this.segments.markGap(track, level, sn, missedDuration, 'missed', t) || changed
    }
    if (changed) this.store.markDirty('segments')
  }

  private recordDetectedCodecs(level: number, families: readonly CodecFamily[]): void {
    let set = this.detectedCodecs.get(level)
    if (!set) this.detectedCodecs.set(level, (set = new Set()))
    const before = set.size
    for (const f of families) set.add(f)
    if (set.size === before) return
    this.store.markDirty('variants')
    const levelObj = this.hls?.levels[level]
    if (levelObj) {
      const declared = levelObj.attrs.CODECS?.split(',').map((c) => c.trim())
      this.recordFindings(checkDetectedCodecs(levelObj.uri, declared, [...set]), performance.now())
    }
  }

  private recordFindings(observations: CheckObservation[], t: number): void {
    if (this.findings.recordAll(observations, t)) this.store.markDirty('findings')
  }

  // ---------------------------------------------------------------- hls.js events

  private readonly onManifestParsed = (): void => {
    this.source = { ...this.source, phase: 'ready' }
    this.store.markDirty('source')
    this.store.markDirty('variants')
    const requested = this.options.variant
    if (requested !== undefined && requested !== 'auto') this.setVariant(requested)
    const levels = this.hls?.levels ?? []
    if (this.source.kind === 'master' && levels.length > 1 && !this.prober) {
      this.prober = new AlignmentProber(
        levels.map((l, level) => ({ level, uri: l.uri })),
        this.onAlignmentProbe,
      )
    }
  }

  /** Returns whether to probe again (live streams). */
  private readonly onAlignmentProbe = (fetches: VariantFetch[], requests: number): boolean => {
    if (this.destroyed) return false
    const ptsBySn = new Map<number, Map<number, number>>()
    for (const r of this.segments.toArray()) {
      if (r.track !== 'main' || r.ptsStart === undefined) continue
      let byLevel = ptsBySn.get(r.sn)
      if (!byLevel) ptsBySn.set(r.sn, (byLevel = new Map()))
      byLevel.set(r.level, r.ptsStart)
    }
    const report = buildAlignmentReport(fetches, ptsBySn, performance.now(), requests)
    this.alignment = report
    this.store.markDirty('alignment')
    this.recordFindings(alignmentObservations(report), report.t)
    return report.live
  }

  private readonly onLevelSwitching = (_event: Events.LEVEL_SWITCHING, data: LevelSwitchingData): void => {
    // hls.js stops refreshing the previous level's playlist; reset its baseline so coming back
    // later is not mistaken for missed segments.
    if (this.activeLevel !== -1 && this.activeLevel !== data.level) {
      this.health.forget(`main:${this.activeLevel}`)
      this.llHls.forget(`main:${this.activeLevel}`)
    }
    this.activeLevel = data.level
    this.store.markDirty('selection')
  }

  private readonly onLevelSwitched = (): void => {
    this.store.markDirty('selection')
  }

  private readonly onHlsError = (_event: Events.ERROR, data: ErrorData): void => {
    const classification = classifyHlsError(data)
    if (!classification) return
    const error = this.pushError({
      ...classification,
      fatal: data.fatal,
      retries: data.errorAction?.retryCount ?? 0,
      details: data.details,
      message: data.error?.message ?? data.reason ?? data.details,
    })
    if (error.fatal) {
      this.source = { ...this.source, phase: 'fatal', fatal: error }
      this.store.markDirty('source')
    }
    if (error.type === 'cors' && error.url) this.confirmCors(error.id, error.url)
  }

  private confirmCors(errorId: number, url: string): void {
    let probe = this.corsProbes.get(url)
    if (!probe) this.corsProbes.set(url, (probe = probeCors(url)))
    probe.then((reachable) => {
      if (this.destroyed) return
      const update = (e: MonitorError) => ({ ...e, corsConfirmed: reachable })
      this.errors.update((e) => e.id === errorId, update)
      if (this.source.fatal?.id === errorId) this.source = { ...this.source, fatal: update(this.source.fatal) }
      this.store.markDirty('errors')
      this.store.markDirty('source')
    })
  }

  private pushError(fields: Omit<MonitorError, 'id' | 't'>): MonitorError {
    const error: MonitorError = { id: this.nextErrorId++, t: performance.now(), ...fields }
    this.errors.push(error)
    this.store.markDirty('errors')
    return error
  }

  // ---------------------------------------------------------------- media element

  private readonly onPlaying = (): void => {
    this.hasPlayed = true
    this.endStall()
  }

  private readonly onWaiting = (): void => {
    // Startup buffering and seeks are not stalls.
    if (!this.hasPlayed || this.video.seeking) return
    const last = this.stalls.last()
    if (last && last.durationMs === undefined) return // already stalled
    this.stalls.push({ t: performance.now() })
    this.store.markDirty('stalls')
  }

  private readonly onSeeking = (): void => {
    this.endStall()
  }

  private endStall(): void {
    const last = this.stalls.last()
    if (!last || last.durationMs !== undefined) return
    const end = performance.now()
    this.stalls.update(
      (s) => s === last,
      (s) => ({ ...s, durationMs: end - s.t }),
    )
    this.store.markDirty('stalls')
  }

  private readonly onMediaError = (): void => {
    const mediaError = this.video.error
    if (!mediaError) return
    // MEDIA_ERR_DECODE / MEDIA_ERR_SRC_NOT_SUPPORTED; hls.js usually reports its own error too.
    this.pushError({
      type: 'decode',
      fatal: true,
      retries: 0,
      details: `mediaElementError:${mediaError.code}`,
      message: mediaError.message || `HTMLMediaElement error ${mediaError.code}`,
    })
  }

  private readonly sample = (): void => {
    const hls = this.hls
    if (!hls) return
    const video = this.video
    const now = performance.now()
    let bufferAhead = 0
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 0.1 && video.currentTime < video.buffered.end(i)) {
        bufferAhead = video.buffered.end(i) - video.currentTime
        break
      }
    }
    const sample: Sample = { t: now, bufferAhead, level: hls.currentLevel }
    const quality = video.getVideoPlaybackQuality?.()
    if (quality) {
      sample.droppedFrames = quality.droppedVideoFrames
      sample.totalFrames = quality.totalVideoFrames
    }
    // Before the first frame plays, currentTime is 0 and hls.latency is meaningless.
    if (this.source.live && this.hasPlayed) {
      sample.liveEdgeDistance = hls.latency
      const playingDate = hls.playingDate
      if (playingDate) sample.pdtLatency = (Date.now() - playingDate.getTime()) / 1000
    }
    this.samples.push(sample)
    this.store.markDirty('samples')
    this.loudness?.sample(now)
  }

  // ---------------------------------------------------------------- snapshot

  private emptySnapshot(): MonitorSnapshot {
    return {
      source: this.source,
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

  private buildSnapshot(dirty: ReadonlySet<SnapshotKey>, prev: MonitorSnapshot): MonitorSnapshot {
    const next = { ...prev }
    if (dirty.has('source')) next.source = this.source
    if (dirty.has('segments')) next.segments = this.segments.toArray()
    if (dirty.has('variants')) next.variants = this.buildVariants(next.segments)
    if (dirty.has('selection') && this.hls) {
      next.selection = {
        auto: this.hls.autoLevelEnabled,
        currentLevel: this.hls.currentLevel,
        loadLevel: this.hls.loadLevel,
      }
    }
    if (dirty.has('parts')) next.parts = this.parts.toArray()
    if (dirty.has('playlists')) next.playlists = this.playlists.toArray()
    if (dirty.has('samples')) next.samples = this.samples.toArray()
    if (dirty.has('stalls')) next.stalls = this.stalls.toArray()
    if (dirty.has('errors')) next.errors = this.errors.toArray()
    if (dirty.has('findings')) next.findings = this.findings.list()
    if (dirty.has('alignment')) next.alignment = this.alignment
    if (dirty.has('loudness')) next.loudness = this.loudness?.info() ?? null
    return next
  }

  private buildVariants(segments: MonitorSnapshot['segments']): VariantInfo[] {
    const levels = this.hls?.levels ?? []
    const measured = measuredBitrates(segments)
    return levels.map((level, index) => {
      const attrs = level.attrs
      const toNum = (v: string | undefined) => (v === undefined ? undefined : Number(v))
      return {
        index,
        url: level.uri,
        width: level.width || undefined,
        height: level.height || undefined,
        codecs: attrs.CODECS?.split(',').map((c) => c.trim()),
        bandwidth: toNum(attrs.BANDWIDTH),
        averageBandwidth: toNum(attrs['AVERAGE-BANDWIDTH']),
        measuredBitrate: measured.get(index),
        detectedCodecs: [...(this.detectedCodecs.get(index) ?? [])],
      }
    })
  }
}
