import type {
  FragmentLoaderContext,
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
  PlaylistLoaderContext,
} from 'hls.js'
import type { NetworkShaper, ShapeLimits, Shaped } from './network-shaper'
import { looksLikeTs } from './ts/parse-ts'

export type LoaderConstructor = new (config: HlsConfig) => Loader<LoaderContext>

export type RequestKind = 'manifest' | 'level' | 'audioTrack' | 'subtitleTrack' | 'fragment' | 'key' | 'other'
export type RequestOutcome = 'success' | 'error' | 'timeout' | 'abort'

/** One network attempt as seen by the loader. All times are `performance.now()` values. */
export interface RequestRecord {
  kind: RequestKind
  url: string
  outcome: RequestOutcome
  /** HTTP status; 0 when the browser got no response (CORS, network). */
  status?: number
  start: number
  /** First byte (headers received). */
  first?: number
  end: number
  bytes: number
  /** Fragment only. Undefined for fMP4 init segments. */
  sn?: number
  level?: number
  /** `main`, `audio` or `subtitle`. Fragment only. */
  track?: string
  /** EXTINF duration in seconds (of the parent segment for parts). Fragment only. */
  duration?: number
  /** LL-HLS part index inside segment `sn`, when this request loaded a part. */
  part?: number
  /** Part DURATION in seconds. Part only. */
  partDuration?: number
  /** Part INDEPENDENT=YES. Part only. */
  independent?: boolean
  /** Playlist only: LL-HLS delivery directives in the request URL (blocking playlist reload). */
  blocking?: DeliveryDirectives
  /**
   * Response headers visible to page JS, lower-cased names. Fragment only. CORS limits them to
   * the safelisted ones plus whatever `Access-Control-Expose-Headers` lists.
   */
  headers?: [string, string][]
}

export interface DeliveryDirectives {
  /** `_HLS_msn`: a blocking reload until this media sequence number is available. */
  msn?: number
  part?: number
  /** `_HLS_skip`: `YES` or `v2`. */
  skip?: string
}

/** `_HLS_msn` / `_HLS_part` / `_HLS_skip` query parameters of a playlist URL, if present. */
export function parseDeliveryDirectives(url: string): DeliveryDirectives | undefined {
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return undefined
  }
  const num = (name: string) => {
    const v = params.get(name)
    return v === null || !/^\d+$/.test(v) ? undefined : Number(v)
  }
  const directives: DeliveryDirectives = { msn: num('_HLS_msn'), part: num('_HLS_part'), skip: params.get('_HLS_skip') ?? undefined }
  return directives.msn !== undefined || directives.skip !== undefined ? directives : undefined
}

/**
 * `url` without `_HLS_*` delivery directives. Blocking reloads change the query on every refresh,
 * so this is the stable identity used in finding keys.
 */
export function stripDeliveryDirectives(url: string): string {
  try {
    const u = new URL(url)
    for (const name of [...u.searchParams.keys()]) if (name.startsWith('_HLS_')) u.searchParams.delete(name)
    return u.href
  } catch {
    return url
  }
}

export interface LoaderSink {
  /** Every attempt: success, error, timeout or abort. */
  onRequest(record: RequestRecord): void
  /** Raw text of a successfully loaded playlist (manifest, level or track), after `onRequest`. */
  onPlaylist(record: RequestRecord, text: string, context: PlaylistLoaderContext): void
  /**
   * Called for MPEG-TS fragments only. `copy()` returns a private copy of the bytes; the sink
   * decides whether it wants one (e.g. skips when the analyzer is busy), so nothing is copied
   * otherwise.
   */
  onTsSegment(record: RequestRecord, copy: () => ArrayBuffer): void
}

const KIND_BY_CONTEXT: Record<string, RequestKind> = {
  manifest: 'manifest',
  level: 'level',
  audioTrack: 'audioTrack',
  subtitleTrack: 'subtitleTrack',
  'media-fragment': 'fragment',
  key: 'key',
}

function isFragmentContext(context: LoaderContext): context is FragmentLoaderContext {
  return 'frag' in context
}

function buildRecord(context: LoaderContext, stats: LoaderStats, outcome: RequestOutcome, status?: number): RequestRecord {
  const { start, first, end } = stats.loading
  const record: RequestRecord = {
    kind: KIND_BY_CONTEXT[context.type] ?? 'other',
    url: context.url,
    outcome,
    status,
    start,
    first: first > 0 ? first : undefined,
    // Failed requests may not have an end mark yet.
    end: end > 0 ? end : performance.now(),
    bytes: stats.loaded,
  }
  if (isFragmentContext(context)) {
    const { frag } = context
    record.sn = typeof frag.sn === 'number' ? frag.sn : undefined
    record.level = frag.level
    record.track = frag.type
    record.duration = frag.duration
    if (context.part) {
      record.part = context.part.index
      record.partDuration = context.part.duration
      record.independent = context.part.independent
    }
  } else if (record.kind !== 'key' && record.kind !== 'other') {
    record.blocking = parseDeliveryDirectives(context.url)
  }
  return record
}

/**
 * Response headers from the `networkDetails` hls.js passes to loader callbacks: the
 * `XMLHttpRequest` for the default XHR loader, or the `Response` for the fetch loader.
 */
export function extractHeaders(networkDetails: unknown): [string, string][] | undefined {
  if (!networkDetails || typeof networkDetails !== 'object') return undefined
  if ('getAllResponseHeaders' in networkDetails && typeof networkDetails.getAllResponseHeaders === 'function') {
    const raw = (networkDetails as XMLHttpRequest).getAllResponseHeaders()
    if (!raw) return undefined
    return raw
      .trim()
      .split(/[\r\n]+/)
      .map((line): [string, string] => {
        const i = line.indexOf(':')
        return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]
      })
      .filter(([name]) => name)
  }
  if ('headers' in networkDetails && networkDetails.headers instanceof Headers) {
    return [...networkDetails.headers.entries()]
  }
  return undefined
}

/** Sink errors must never break playback. */
function safely(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error('[hls-monitor] loader sink failed', err)
  }
}

/** How often the stats of a held response are advanced to the simulated progress. */
const PROGRESS_INTERVAL_MS = 100

/** hls.js load-policy limits, ignoring missing or infinite values. */
function limitsOf(config: LoaderConfiguration): ShapeLimits {
  const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined)
  return { ttfbMs: finite(config.loadPolicy?.maxTimeToFirstByteMs), totalMs: finite(config.loadPolicy?.maxLoadTimeMs) }
}

/**
 * Returns an hls.js loader class that delegates every request to `Base` (normally
 * `Hls.DefaultConfig.loader`) and reports each attempt to `sink` before handing the result back to
 * hls.js. hls.js keeps full control of retries and timeouts, and nothing is downloaded twice: the
 * monitor only observes what hls.js already fetched.
 *
 * Segment bytes are copied synchronously inside `onSuccess`, before hls.js gets the response,
 * because hls.js may transfer (detach) the original buffer to its transmuxer worker.
 *
 * With an active `shaper`, each response is held until its simulated arrival time and its
 * `LoaderStats` are rewritten in place: hls.js keeps a reference to them (`frag.stats`,
 * `part.stats`) and its ABR abandon rules read `loaded` and `loading.first` while a fragment is
 * in flight, so they are advanced to the simulated progress during the hold. If ABR abandons the
 * load, `abort()` drops the held response. A transfer that would exceed the hls.js load policy is
 * reported as a timeout instead.
 */
export function createMonitoringLoader(Base: LoaderConstructor, sink: LoaderSink, shaper?: NetworkShaper): LoaderConstructor {
  return class MonitoringLoader implements Loader<LoaderContext> {
    private readonly inner: Loader<LoaderContext>
    /** A response held back by the shaper. */
    private held:
      | { timer: ReturnType<typeof setTimeout>; progress?: ReturnType<typeof setInterval>; shaped?: Shaped }
      | undefined

    constructor(config: HlsConfig) {
      this.inner = new Base(config)
    }

    get context(): LoaderContext | null {
      return this.inner.context
    }
    set context(value: LoaderContext | null) {
      this.inner.context = value
    }
    get stats(): LoaderStats {
      return this.inner.stats
    }
    set stats(value: LoaderStats) {
      this.inner.stats = value
    }

    getCacheAge = (): number | null => this.inner.getCacheAge?.() ?? null
    getResponseHeader = (name: string): string | null => this.inner.getResponseHeader?.(name) ?? null

    destroy(): void {
      this.cancelPending()
      this.inner.destroy()
    }

    abort(): void {
      this.cancelPending()
      this.inner.abort()
    }

    private cancelPending(): void {
      const held = this.held
      if (!held) return
      clearTimeout(held.timer)
      clearInterval(held.progress)
      this.held = undefined
      if (held.shaped) shaper?.release(held.shaped, performance.now())
    }

    /**
     * Holds a response until `at`, advancing `stats` to the simulated progress meanwhile, then
     * runs `fn`. Runs `fn` right away if `at` is not in the future.
     */
    private hold(shaped: Shaped, at: number, stats: LoaderStats, fn: () => void): void {
      const bytes = stats.loaded
      const advance = () => {
        const now = performance.now()
        stats.loading.first = now >= shaped.first ? shaped.first : 0
        stats.loaded = shaper!.progress(shaped, bytes, now)
      }
      const delay = at - performance.now()
      if (delay <= 0) return fn()
      stats.loading.end = 0
      advance()
      const progress = setInterval(advance, PROGRESS_INTERVAL_MS)
      const timer = setTimeout(() => {
        clearInterval(progress)
        this.held = undefined
        fn()
      }, delay)
      this.held = { timer, progress, shaped }
    }

    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      const { onAbort } = callbacks
      const throttled = () => !!shaper?.profile
      const wrapped: LoaderCallbacks<LoaderContext> = {
        ...callbacks,
        onSuccess: (response, stats, ctx, networkDetails) => {
          const deliver = () => {
            safely(() => {
              const record = buildRecord(ctx, stats, 'success', response.code)
              if (record.kind === 'fragment') record.headers = extractHeaders(networkDetails)
              const data = response.data
              sink.onRequest(record)
              if (typeof data === 'string' && record.kind !== 'fragment' && record.kind !== 'key') {
                sink.onPlaylist(record, data, ctx as PlaylistLoaderContext)
              }
              // Parts rarely start with PAT/PMT, so they are not analyzed.
              if (record.kind === 'fragment' && record.part === undefined && data instanceof ArrayBuffer) {
                if (looksLikeTs(new Uint8Array(data, 0, Math.min(data.byteLength, 3 * 188)))) {
                  sink.onTsSegment(record, () => data.slice(0))
                }
              }
            })
            callbacks.onSuccess(response, stats, ctx, networkDetails)
          }
          if (!shaper || !throttled()) return deliver()

          const bytes = stats.loaded
          const shaped = shaper.shapeSuccess({ ...stats.loading }, bytes, limitsOf(config))
          const timeoutAt = shaped.timeoutAt
          if (timeoutAt !== undefined) {
            this.hold(shaped, timeoutAt, stats, () => {
              stats.loading.end = timeoutAt
              safely(() => sink.onRequest(buildRecord(ctx, stats, 'timeout')))
              callbacks.onTimeout(stats, ctx, networkDetails)
            })
            return
          }
          this.hold(shaped, shaped.end, stats, () => {
            stats.loaded = bytes
            stats.loading.first = shaped.first
            stats.loading.end = shaped.end
            if (shaped.end > shaped.first) stats.bwEstimate = (bytes * 8000) / (shaped.end - shaped.first)
            deliver()
          })
        },
        onError: (error, ctx, networkDetails, stats) => {
          const deliver = () => {
            safely(() => {
              const record = buildRecord(ctx, stats, 'error', error.code)
              if (record.kind === 'fragment') record.headers = extractHeaders(networkDetails)
              sink.onRequest(record)
            })
            callbacks.onError(error, ctx, networkDetails, stats)
          }
          if (!shaper || !throttled()) return deliver()
          const at = shaper.shapeError({ start: stats.loading.start, end: stats.loading.end || performance.now() })
          const delay = at - performance.now()
          if (delay <= 0) return deliver()
          // Errors carry no body: there is no progress to simulate, only the latency to wait for.
          const timer = setTimeout(() => {
            this.held = undefined
            deliver()
          }, delay)
          this.held = { timer }
        },
        onTimeout: (stats, ctx, networkDetails) => {
          safely(() => sink.onRequest(buildRecord(ctx, stats, 'timeout')))
          callbacks.onTimeout(stats, ctx, networkDetails)
        },
        onAbort: onAbort
          ? (stats, ctx, networkDetails) => {
              // hls.js loaders still call onAbort after a success; drop a held response.
              this.cancelPending()
              safely(() => sink.onRequest(buildRecord(ctx, stats, 'abort')))
              onAbort(stats, ctx, networkDetails)
            }
          : undefined,
      }
      this.inner.load(context, config, wrapped)
    }
  }
}
