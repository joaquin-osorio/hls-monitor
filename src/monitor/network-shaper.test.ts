import { describe, expect, it } from 'vitest'
import { NetworkShaper } from './network-shaper'

const loading = (start: number, first: number, end: number) => ({ start, first, end })

describe('NetworkShaper', () => {
  it('leaves timings untouched when off', () => {
    const shaper = new NetworkShaper()
    expect(shaper.shapeSuccess(loading(0, 10, 20), 1_000_000)).toEqual({ first: 10, transferStart: 10, end: 20 })
  })

  it('adds latency before the first byte and caps the transfer rate', () => {
    const shaper = new NetworkShaper()
    shaper.set({ downKbps: 1000, latencyMs: 200 })
    // 125 000 bytes = 1 000 000 bits at 1000 bit/ms = 1000 ms
    expect(shaper.shapeSuccess(loading(0, 10, 20), 125_000)).toEqual({ first: 200, transferStart: 200, end: 1200 })
  })

  it('never makes a response faster than it really was', () => {
    const shaper = new NetworkShaper()
    shaper.set({ downKbps: 100_000, latencyMs: 10 })
    expect(shaper.shapeSuccess(loading(0, 300, 900), 1000)).toEqual({ first: 300, transferStart: 300, end: 900 })
  })

  it('shares the link: a concurrent response waits for the previous transfer', () => {
    const shaper = new NetworkShaper()
    shaper.set({ downKbps: 1000, latencyMs: 0 })
    expect(shaper.shapeSuccess(loading(0, 5, 10), 125_000)).toEqual({ first: 5, transferStart: 5, end: 1005 })
    expect(shaper.shapeSuccess(loading(0, 5, 10), 125_000)).toEqual({ first: 5, transferStart: 1005, end: 2005 })
  })

  it('reports a timeout at the hls.js limit when the transfer would exceed it', () => {
    const shaper = new NetworkShaper()
    shaper.set({ downKbps: 100, latencyMs: 50 })
    expect(shaper.shapeSuccess(loading(1000, 1010, 1020), 125_000, { ttfbMs: 10_000, totalMs: 5000 })).toMatchObject({ timeoutAt: 6000 })
    // The abandoned transfer kept the link busy until the timeout.
    expect(shaper.shapeSuccess(loading(1000, 1010, 1020), 100)).toMatchObject({ transferStart: 6000 })
  })

  it('delays errors by the latency only', () => {
    const shaper = new NetworkShaper()
    shaper.set({ downKbps: 100, latencyMs: 300 })
    expect(shaper.shapeError(loading(0, 0, 20))).toBe(300)
  })

  it('reports in-flight progress at the simulated rate', () => {
    const shaper = new NetworkShaper()
    shaper.set({ downKbps: 1000, latencyMs: 100 })
    const shaped = shaper.shapeSuccess(loading(0, 5, 10), 125_000) // body from 100 to 1100
    expect([50, 600, 1100].map((t) => shaper.progress(shaped, 125_000, t))).toEqual([0, 62_500, 125_000])
  })

  it('frees the link when a held response is aborted', () => {
    const shaper = new NetworkShaper()
    shaper.set({ downKbps: 1000, latencyMs: 0 })
    const first = shaper.shapeSuccess(loading(0, 5, 10), 125_000)
    shaper.release(first, 300)
    expect(shaper.shapeSuccess(loading(300, 305, 310), 125_000)).toMatchObject({ transferStart: 305, end: 1305 })
  })
})
