export interface ThrottleProfile {
  /** Downlink capacity in kbit/s, shared by all requests. */
  downKbps: number
  /** Added to every request before the first byte, in ms. */
  latencyMs: number
}

export interface ShapeLimits {
  /** hls.js `loadPolicy.maxTimeToFirstByteMs`. */
  ttfbMs?: number
  /** hls.js `loadPolicy.maxLoadTimeMs`. */
  totalMs?: number
}

/** Simulated timing of one response; all values are `performance.now()` times. */
export interface Shaped {
  first: number
  /** When the body starts flowing (after `first`, or later if the link is busy). */
  transferStart: number
  end: number
  /** Set when hls.js would have timed out before `end`; the response is then never delivered. */
  timeoutAt?: number
}

/**
 * Simulates a slower network for responses that already arrived. The model is one virtual
 * downlink shared by every request: a response's body can only start once the previous one has
 * finished (`busyUntil`), which is how concurrent audio/video/playlist loads compete for
 * bandwidth on a real connection.
 *
 * Simulated times never go below the real ones: the shaper can only slow the network down.
 */
export class NetworkShaper {
  private current: ThrottleProfile | null = null
  private busyUntil = 0

  get profile(): ThrottleProfile | null {
    return this.current
  }

  set(profile: ThrottleProfile | null): void {
    this.current = profile && profile.downKbps > 0 ? profile : null
    this.busyUntil = 0
  }

  /**
   * Simulated first-byte and end times for a successful response of `bytes`, or the time hls.js
   * would have timed out if the simulated transfer exceeds its limits.
   */
  shapeSuccess(loading: { start: number; first: number; end: number }, bytes: number, limits: ShapeLimits = {}): Shaped {
    const p = this.current
    if (!p) return { first: loading.first, transferStart: loading.first, end: loading.end }
    const first = Math.max(loading.first, loading.start + p.latencyMs)
    const transferStart = Math.max(first, this.busyUntil)
    const end = Math.max(loading.end, transferStart + (bytes * 8) / p.downKbps) // kbit/s = bit/ms
    const shaped: Shaped = { first, transferStart, end }
    if (limits.ttfbMs && first - loading.start > limits.ttfbMs) shaped.timeoutAt = loading.start + limits.ttfbMs
    else if (limits.totalMs && end - loading.start > limits.totalMs) shaped.timeoutAt = loading.start + limits.totalMs
    // An abandoned transfer only occupies the link until hls.js gives up.
    this.busyUntil = Math.max(this.busyUntil, shaped.timeoutAt ?? end)
    return shaped
  }

  /**
   * Bytes of a held response that would have arrived by `now`, so hls.js's in-flight ABR checks
   * (which read `stats.loaded` while a fragment is loading) see the simulated progress.
   */
  progress(shaped: Shaped, bytes: number, now: number): number {
    if (now <= shaped.transferStart) return 0
    if (now >= shaped.end || shaped.end <= shaped.transferStart) return bytes
    return Math.floor((bytes * (now - shaped.transferStart)) / (shaped.end - shaped.transferStart))
  }

  /** Frees the link when a held response is aborted at `now` (e.g. ABR abandoned it). */
  release(shaped: Shaped, now: number): void {
    if (this.busyUntil === (shaped.timeoutAt ?? shaped.end)) this.busyUntil = Math.max(now, shaped.transferStart)
  }

  /** When a failed response would arrive: errors only pay the added latency. */
  shapeError(loading: { start: number; end: number }): number {
    return this.current ? Math.max(loading.end, loading.start + this.current.latencyMs) : loading.end
  }
}
