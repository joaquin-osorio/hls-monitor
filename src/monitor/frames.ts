import type { Sample } from './types'

export interface DroppedFramePoint {
  t: number
  /** Frames dropped per second since the previous sample with frame counters. */
  droppedPerSec: number
}

export interface LevelFrames {
  level: number
  total: number
  dropped: number
}

interface Delta {
  t: number
  dtMs: number
  dropped: number
  total: number
  level: number
}

/**
 * Per-interval deltas of the cumulative `getVideoPlaybackQuality()` counters. A counter going
 * backwards means the element reset them (new media attach): that sample becomes the new
 * baseline instead of producing a negative delta.
 */
function frameDeltas(samples: readonly Sample[]): Delta[] {
  const out: Delta[] = []
  let prev: Sample | undefined
  for (const s of samples) {
    if (s.droppedFrames === undefined || s.totalFrames === undefined) continue
    if (prev && s.droppedFrames >= prev.droppedFrames! && s.totalFrames >= prev.totalFrames!) {
      out.push({
        t: s.t,
        dtMs: s.t - prev.t,
        dropped: s.droppedFrames - prev.droppedFrames!,
        total: s.totalFrames - prev.totalFrames!,
        level: s.level ?? -1,
      })
    }
    prev = s
  }
  return out
}

export function droppedFrameSeries(samples: readonly Sample[]): DroppedFramePoint[] {
  return frameDeltas(samples).map((d) => ({ t: d.t, droppedPerSec: d.dtMs > 0 ? (d.dropped * 1000) / d.dtMs : 0 }))
}

/** Rendered and dropped frames attributed to the level that was playing at each sample. */
export function framesByLevel(samples: readonly Sample[]): LevelFrames[] {
  const byLevel = new Map<number, LevelFrames>()
  for (const d of frameDeltas(samples)) {
    const entry = byLevel.get(d.level) ?? { level: d.level, total: 0, dropped: 0 }
    entry.total += d.total
    entry.dropped += d.dropped
    byLevel.set(d.level, entry)
  }
  return [...byLevel.values()].sort((a, b) => a.level - b.level)
}
