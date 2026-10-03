import { TimeWindowBuffer } from '../ring-buffer'
import type { AudioGraph } from './audio-graph'
import { type LoudnessBlock, LoudnessAnalyzer, type LoudnessValues } from './loudness'

export interface LoudnessPoint {
  /** `performance.now()` */
  t: number
  /** LUFS; undefined while silent, paused or not yet measured (a gap in the chart). */
  momentary?: number
  shortTerm?: number
}

export type LoudnessPause = 'muted' | 'volume' | 'paused'

export interface LoudnessInfo {
  status: 'starting' | 'measuring' | 'paused' | 'error'
  /** Why blocks are being ignored while `status` is `paused`. */
  pausedReason?: LoudnessPause
  error?: string
  values: LoudnessValues
  series: LoudnessPoint[]
}

type MediaLike = Pick<HTMLMediaElement, 'muted' | 'volume' | 'paused'>

const finite = (v: number) => (Number.isFinite(v) ? v : undefined)

/**
 * Loudness measurement for one monitoring session. Blocks from the shared audio graph are only
 * counted while the element plays unmuted at full volume: the graph taps the element's output,
 * so mute and volume would otherwise skew (or zero) the reading. Integrated loudness starts
 * over with every new meter, i.e. every new URL.
 */
export class LoudnessMeter {
  private readonly analyzer = new LoudnessAnalyzer()
  private readonly series = new TimeWindowBuffer<LoudnessPoint>(4000)
  private status: LoudnessInfo['status'] = 'starting'
  private pausedReason: LoudnessPause | undefined
  private error: string | undefined
  private graph: AudioGraph | null = null
  private destroyed = false
  private readonly media: MediaLike
  private readonly onChange: () => void

  constructor(media: MediaLike, graph: Promise<AudioGraph>, onChange: () => void) {
    this.media = media
    this.onChange = onChange
    // The meter needs to hear the element: unmute it and take volume to 100 %.
    media.muted = false
    media.volume = 1
    graph.then(
      async (g) => {
        if (this.destroyed) return
        this.graph = g
        g.meter.port.onmessage = (event: MessageEvent<LoudnessBlock[]>) => this.onBlocks(event.data)
        await g.context.resume()
        this.updateStatus()
      },
      (err: unknown) => {
        if (this.destroyed) return
        this.status = 'error'
        this.error = err instanceof Error ? err.message : String(err)
        this.onChange()
      },
    )
  }

  /** Called on the session's sampling tick: records a chart point and refreshes the pause state. */
  sample(t: number): void {
    if (this.status === 'error' || this.status === 'starting') return
    this.updateStatus()
    const v = this.analyzer.values()
    this.series.push(this.status === 'measuring' ? { t, momentary: finite(v.momentary), shortTerm: finite(v.shortTerm) } : { t })
    this.onChange()
  }

  info(): LoudnessInfo {
    return {
      status: this.status,
      pausedReason: this.pausedReason,
      error: this.error,
      values: this.analyzer.values(),
      series: this.series.toArray(),
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.graph) this.graph.meter.port.onmessage = null
  }

  private onBlocks(blocks: LoudnessBlock[]): void {
    this.updateStatus()
    if (this.status !== 'measuring') return
    for (const b of blocks) this.analyzer.push(b)
  }

  private updateStatus(): void {
    const m = this.media
    const reason: LoudnessPause | undefined = m.muted ? 'muted' : m.volume < 1 ? 'volume' : m.paused ? 'paused' : undefined
    const status = reason ? 'paused' : 'measuring'
    if (status === this.status && reason === this.pausedReason) return
    this.status = status
    this.pausedReason = reason
    this.onChange()
  }
}
