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
  /** EXTINF duration in seconds. Fragment only. */
  duration?: number
  /**
   * Response headers visible to page JS, lower-cased names. Fragment only. CORS limits them to
   * the safelisted ones plus whatever `Access-Control-Expose-Headers` lists.
   */
  headers?: [string, string][]
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

/**
 * Returns an hls.js loader class that delegates every request to `Base` (normally
 * `Hls.DefaultConfig.loader`) and reports each attempt to `sink` before handing the result back to
 * hls.js. hls.js keeps full control of retries and timeouts, and nothing is downloaded twice: the
 * monitor only observes what hls.js already fetched.
 *
 * Segment bytes are copied synchronously inside `onSuccess`, before hls.js gets the response,
 * because hls.js may transfer (detach) the original buffer to its transmuxer worker.
 */
export function createMonitoringLoader(Base: LoaderConstructor, sink: LoaderSink): LoaderConstructor {
  return class MonitoringLoader implements Loader<LoaderContext> {
    private readonly inner: Loader<LoaderContext>

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
      this.inner.destroy()
    }

    abort(): void {
      this.inner.abort()
    }

    load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      const { onAbort } = callbacks
      const wrapped: LoaderCallbacks<LoaderContext> = {
        ...callbacks,
        onSuccess: (response, stats, ctx, networkDetails) => {
          safely(() => {
            const record = buildRecord(ctx, stats, 'success', response.code)
            if (record.kind === 'fragment') record.headers = extractHeaders(networkDetails)
            const data = response.data
            sink.onRequest(record)
            if (typeof data === 'string' && record.kind !== 'fragment' && record.kind !== 'key') {
              sink.onPlaylist(record, data, ctx as PlaylistLoaderContext)
            }
            if (record.kind === 'fragment' && data instanceof ArrayBuffer) {
              if (looksLikeTs(new Uint8Array(data, 0, Math.min(data.byteLength, 3 * 188)))) {
                sink.onTsSegment(record, () => data.slice(0))
              }
            }
          })
          callbacks.onSuccess(response, stats, ctx, networkDetails)
        },
        onError: (error, ctx, networkDetails, stats) => {
          safely(() => {
            const record = buildRecord(ctx, stats, 'error', error.code)
            if (record.kind === 'fragment') record.headers = extractHeaders(networkDetails)
            sink.onRequest(record)
          })
          callbacks.onError(error, ctx, networkDetails, stats)
        },
        onTimeout: (stats, ctx, networkDetails) => {
          safely(() => sink.onRequest(buildRecord(ctx, stats, 'timeout')))
          callbacks.onTimeout(stats, ctx, networkDetails)
        },
        onAbort: onAbort
          ? (stats, ctx, networkDetails) => {
              safely(() => sink.onRequest(buildRecord(ctx, stats, 'abort')))
              onAbort(stats, ctx, networkDetails)
            }
          : undefined,
      }
      this.inner.load(context, config, wrapped)
    }
  }
}
