import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThrottledStore } from './store'

type Snap = { a: number; b: number; aObj: { n: number }; bObj: { n: number } }

function setup() {
  const counts = { a: 0, b: 0 }
  const builds: string[][] = []
  const initial: Snap = { a: 0, b: 0, aObj: { n: 0 }, bObj: { n: 0 } }
  const store = new ThrottledStore<Snap, 'a' | 'b'>(
    initial,
    (dirty, prev) => {
      builds.push([...dirty].sort())
      return {
        a: counts.a,
        b: counts.b,
        aObj: dirty.has('a') ? { n: counts.a } : prev.aObj,
        bObj: dirty.has('b') ? { n: counts.b } : prev.bObj,
      }
    },
    {
      intervalMs: 500,
      now: () => Date.now(),
      raf: (cb) => setTimeout(cb, 16),
    },
  )
  const listener = vi.fn()
  store.subscribe(listener)
  return { store, counts, builds, listener }
}

describe('ThrottledStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes the first change right away, inside a frame', () => {
    const { store, counts, listener } = setup()
    counts.a = 1
    store.markDirty('a')
    expect(listener).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().a).toBe(1)
  })

  it('coalesces bursts into at most one flush per interval', () => {
    const { store, counts, listener } = setup()
    // 100 changes spread over 2 seconds.
    for (let i = 0; i < 100; i++) {
      counts.a++
      store.markDirty('a')
      vi.advanceTimersByTime(20)
    }
    vi.advanceTimersByTime(1000)
    // 2 s of activity at 500 ms per flush → ~5 flushes (leading edge + one per interval).
    expect(listener.mock.calls.length).toBeLessThanOrEqual(6)
    expect(store.getSnapshot().a).toBe(100)
  })

  it('rebuilds only dirty slices and keeps the others referentially equal', () => {
    const { store, counts, builds } = setup()
    counts.a = 1
    store.markDirty('a')
    vi.advanceTimersByTime(16)
    const first = store.getSnapshot()

    vi.advanceTimersByTime(1000)
    counts.b = 1
    store.markDirty('b')
    vi.advanceTimersByTime(16)
    const second = store.getSnapshot()

    expect(builds).toEqual([['a'], ['b']])
    expect(second.aObj).toBe(first.aObj)
    expect(second.bObj).not.toBe(first.bObj)
  })

  it('stops notifying after destroy', () => {
    const { store, listener } = setup()
    store.markDirty('a')
    store.destroy()
    vi.advanceTimersByTime(1000)
    expect(listener).not.toHaveBeenCalled()
  })
})
