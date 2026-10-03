import { describe, expect, it } from 'vitest'
import { PlaylistHealthTracker } from './health'
import type { MediaPlaylist } from './parse'

/** Live window of `count` 4 s segments starting at `mediaSequence`. */
function live(mediaSequence: number, count: number, endList = false): MediaPlaylist {
  return {
    kind: 'media',
    targetDuration: 4,
    mediaSequence,
    discontinuitySequence: 0,
    endList,
    skippedSegments: 0,
    pendingParts: [],
    preloadHints: [],
    renditionReports: [],
    segments: Array.from({ length: count }, (_, i) => ({
      sn: mediaSequence + i,
      uri: `s${mediaSequence + i}.ts`,
      duration: 4,
      discontinuity: false,
      cc: 0,
      gap: false,
    })),
  }
}

const URL = 'https://cdn/live.m3u8'

describe('PlaylistHealthTracker', () => {
  it('has no interval or advance on the first load', () => {
    const r = new PlaylistHealthTracker().track('main:0', URL, live(10, 5), 1000)
    expect(r).toMatchObject({ mediaSequence: 10, lastSn: 14, missedSns: [] })
    expect(r.intervalMs).toBeUndefined()
  })

  it('measures interval and sequence advance on a healthy sliding window', () => {
    const tracker = new PlaylistHealthTracker()
    tracker.track('main:0', URL, live(10, 5), 1000)
    const r = tracker.track('main:0', URL, live(11, 5), 5000)
    expect(r).toMatchObject({
      intervalMs: 4000,
      mediaSequenceAdvance: 1,
      newSegments: 1,
      changed: true,
      missedSns: [],
    })
  })

  it('flags an unchanged playlist', () => {
    const tracker = new PlaylistHealthTracker()
    tracker.track('main:0', URL, live(10, 5), 1000)
    expect(tracker.track('main:0', URL, live(10, 5), 5000).changed).toBe(false)
  })

  it('reports segments that slid out of the window between refreshes', () => {
    const tracker = new PlaylistHealthTracker()
    tracker.track('main:0', URL, live(10, 3), 0) // last seen: 12
    const r = tracker.track('main:0', URL, live(16, 3), 30_000) // first listed: 16
    expect(r.missedSns).toEqual([13, 14, 15])
  })

  it('detects ENDLIST appearing on a live playlist', () => {
    const tracker = new PlaylistHealthTracker()
    tracker.track('main:0', URL, live(10, 5), 0)
    expect(tracker.track('main:0', URL, live(10, 6, true), 4000).endListAppeared).toBe(true)
  })

  it('does not flag ENDLIST on a playlist that always had it', () => {
    const tracker = new PlaylistHealthTracker()
    expect(tracker.track('main:0', URL, live(0, 5, true), 0).endListAppeared).toBe(false)
  })

  it('starts a fresh baseline after forget', () => {
    const tracker = new PlaylistHealthTracker()
    tracker.track('main:0', URL, live(10, 3), 0)
    tracker.forget('main:0')
    const r = tracker.track('main:0', URL, live(500, 3), 60_000)
    expect(r.intervalMs).toBeUndefined()
    expect(r.missedSns).toEqual([])
  })

  it('counts skipped segments of a delta update, so they are not reported as missed', () => {
    const tracker = new PlaylistHealthTracker()
    tracker.track('main:0', URL, live(10, 10), 1000)
    // Delta update: MSN 11, the first 6 segments skipped, 4 listed (17..20) + 1 new.
    const delta = { ...live(17, 4), mediaSequence: 11, skippedSegments: 6 }
    const r = tracker.track('main:0', URL, delta, 2000)
    expect(r).toMatchObject({ lastSn: 20, segmentCount: 10, newSegments: 1, missedSns: [] })
  })

  it('counts a refresh that only adds LL-HLS parts as changed', () => {
    const tracker = new PlaylistHealthTracker()
    const withParts = (n: number) => ({
      ...live(10, 5),
      pendingParts: Array.from({ length: n }, (_, i) => ({ uri: `p${i}.mp4`, duration: 1, independent: false, gap: false })),
    })
    tracker.track('main:0', URL, withParts(1), 1000)
    expect(tracker.track('main:0', URL, withParts(2), 2000).changed).toBe(true)
    expect(tracker.track('main:0', URL, withParts(2), 3000).changed).toBe(false)
  })
})
