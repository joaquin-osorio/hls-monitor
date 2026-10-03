import { describe, expect, it } from 'vitest'
import { droppedFrameSeries, framesByLevel } from './frames'
import type { Sample } from './types'

const s = (t: number, droppedFrames: number, totalFrames: number, level = 0): Sample => ({
  t,
  bufferAhead: 0,
  droppedFrames,
  totalFrames,
  level,
})

describe('droppedFrameSeries', () => {
  it('turns cumulative counters into a per-second rate', () => {
    const series = droppedFrameSeries([s(0, 0, 0), s(500, 2, 15), s(1000, 2, 30)])
    expect(series).toEqual([
      { t: 500, droppedPerSec: 4 },
      { t: 1000, droppedPerSec: 0 },
    ])
  })

  it('treats a counter going backwards as a reset, not a negative delta', () => {
    const series = droppedFrameSeries([s(0, 10, 300), s(500, 0, 5), s(1000, 1, 20)])
    expect(series).toEqual([{ t: 1000, droppedPerSec: 2 }])
  })

  it('skips samples without counters', () => {
    expect(droppedFrameSeries([{ t: 0, bufferAhead: 0 }, s(500, 1, 10)])).toEqual([])
  })
})

describe('framesByLevel', () => {
  it('attributes each delta to the level playing at that sample', () => {
    const levels = framesByLevel([s(0, 0, 0, 1), s(500, 1, 15, 1), s(1000, 4, 30, 2), s(1500, 4, 45, 2)])
    expect(levels).toEqual([
      { level: 1, total: 15, dropped: 1 },
      { level: 2, total: 30, dropped: 3 },
    ])
  })
})
