import type { VariantFetch } from './alignment'

/** How often live variant playlists are fetched for the alignment check. */
export const ALIGNMENT_INTERVAL_MS = 30_000

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Fetches the media playlist of every variant at the same moment so they can be compared. This is
 * the monitor's only own GET traffic besides the CORS probe: playlists only, never segments, and
 * not routed through hls.js (so not throttled and not shown in the network table).
 *
 * Runs once for VOD; for live, `onResult` returns true and the prober repeats every `intervalMs`.
 */
export class AlignmentProber {
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private requests = 0
  private readonly variants: readonly { level: number; uri: string }[]
  private readonly onResult: (fetches: VariantFetch[], requests: number) => boolean
  private readonly fetchFn: FetchFn
  private readonly intervalMs: number

  constructor(
    variants: readonly { level: number; uri: string }[],
    onResult: (fetches: VariantFetch[], requests: number) => boolean,
    fetchFn: FetchFn = (input, init) => fetch(input, init),
    intervalMs = ALIGNMENT_INTERVAL_MS,
  ) {
    this.variants = variants
    this.onResult = onResult
    this.fetchFn = fetchFn
    this.intervalMs = intervalMs
    void this.run()
  }

  destroy(): void {
    clearTimeout(this.timer)
    this.controller.abort()
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal
    const fetches = await Promise.all(
      this.variants.map(async ({ level, uri }): Promise<VariantFetch> => {
        this.requests++
        try {
          const res = await this.fetchFn(uri, { signal, cache: 'no-store' })
          if (!res.ok) return { level, uri, error: `HTTP ${res.status}` }
          return { level, uri, text: await res.text() }
        } catch (err) {
          return { level, uri, error: err instanceof Error ? err.message : String(err) }
        }
      }),
    )
    if (signal.aborted) return
    if (this.onResult(fetches, this.requests)) this.timer = setTimeout(() => void this.run(), this.intervalMs)
  }
}
