import type { ErrorData } from 'hls.js'

export type MonitorErrorType = 'cors' | 'http4xx' | 'http5xx' | 'timeout' | 'decode' | 'parse'

export interface MonitorError {
  id: number
  /** `performance.now()` when the error was observed. */
  t: number
  type: MonitorErrorType
  fatal: boolean
  /** Retries hls.js had already performed for this request when the error was reported. */
  retries: number
  /** Raw hls.js `ErrorDetails` value, or a monitor-specific detail such as `tsParseError`. */
  details: string
  message: string
  url?: string
  status?: number
  /**
   * Only for `cors`: whether a no-cors probe reached the server. `true` means the server answered,
   * so the failure is a missing CORS header; `false` means it was unreachable (network/DNS/mixed
   * content); `undefined` means the probe has not finished.
   */
  corsConfirmed?: boolean
}

export type ErrorClassification = Pick<MonitorError, 'type' | 'url' | 'status'>

/**
 * hls.js details that are not reported as errors: stalls and gaps are tracked by their own
 * collectors, buffer-full is self-healed by hls.js, unchanged playlists feed playlist health.
 */
const IGNORED = new Set<string>([
  'bufferStalledError',
  'bufferNudgeOnStall',
  'bufferSeekOverHole',
  'bufferFullError',
  'fragGap',
  'playlistUnchangedError',
  'aborted',
])

const TIMEOUTS = new Set<string>([
  'manifestLoadTimeOut',
  'levelLoadTimeOut',
  'audioTrackLoadTimeOut',
  'subtitleTrackLoadTimeOut',
  'fragLoadTimeOut',
  'keyLoadTimeOut',
  'assetListLoadTimeout',
])

const PARSE = new Set<string>([
  'manifestParsingError',
  'levelParsingError',
  'levelEmptyError',
  'fragParsingError',
  'assetListParsingError',
])

/**
 * Maps an hls.js ERROR event to the monitor's error taxonomy, or `null` when it should not be
 * logged as an error (see `IGNORED`).
 *
 * Network failures are split by HTTP status. A status of 0 (or none) means the browser blocked or
 * never got a response, which from page JS is indistinguishable from a CORS rejection; it is
 * classified as `cors` and refined later by a probe (`MonitorError.corsConfirmed`). Non-zero
 * statuses below 400 are bucketed with `http4xx`.
 *
 * Anything not listed explicitly falls back on `data.type`: media and key-system errors are
 * `decode`, mux and other internal errors are `parse`.
 */
export function classifyHlsError(data: ErrorData): ErrorClassification | null {
  const details: string = data.details
  if (IGNORED.has(details)) return null

  const url = data.url ?? data.frag?.url ?? data.context?.url ?? data.response?.url
  const status = data.response?.code

  if (TIMEOUTS.has(details)) return { type: 'timeout', url, status }
  if (PARSE.has(details)) return { type: 'parse', url }

  const type: string = data.type
  if (type === 'networkError') {
    if (status === undefined || status === 0) return { type: 'cors', url, status }
    return { type: status >= 500 ? 'http5xx' : 'http4xx', url, status }
  }
  if (type === 'mediaError' || type === 'keySystemError') return { type: 'decode', url }
  return { type: 'parse', url }
}
