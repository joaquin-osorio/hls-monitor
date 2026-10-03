import { describe, expect, it } from 'vitest'
import { downsample } from './downsample'

interface Point {
  t: number
  a?: number
  b?: number
}

const series = (n: number, f: (i: number) => Partial<Point> = (i) => ({ a: Math.sin(i / 50) })): Point[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 500, ...f(i) }))

describe('downsample', () => {
  it('returns the same array when it is already small enough', () => {
    const data = series(1000)
    expect(downsample(data, ['a'], 1000)).toBe(data)
  })

  it('caps the number of points and keeps them in time order', () => {
    const data = series(14_400, (i) => ({ a: Math.sin(i / 50), b: Math.cos(i / 70) }))
    const out = downsample(data, ['a', 'b'], 1000)
    expect(out.length).toBeLessThanOrEqual(1000)
    expect(out.length).toBeGreaterThan(500)
    for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t)
  })

  it('keeps the first and last points', () => {
    const data = series(5000)
    const out = downsample(data, ['a'], 200)
    expect(out[0]).toBe(data[0])
    expect(out.at(-1)).toBe(data.at(-1))
  })

  it('keeps single-sample spikes in either direction', () => {
    const data = series(14_400, (i) => ({ a: i === 7001 ? 99 : i === 9002 ? -99 : 1 }))
    const out = downsample(data, ['a'], 300)
    expect(out).toContain(data[7001])
    expect(out).toContain(data[9002])
  })

  it('keeps extremes of every key, not just the first', () => {
    const data = series(10_000, (i) => ({ a: 1, b: i === 4321 ? 50 : 0 }))
    expect(downsample(data, ['a', 'b'], 300)).toContain(data[4321])
  })

  it('keeps a missing-value point so line gaps stay visible', () => {
    const data = series(10_000, (i) => (i >= 5000 && i < 5004 ? {} : { a: 1 }))
    const out = downsample(data, ['a'], 300)
    expect(out.some((p) => p.a === undefined)).toBe(true)
  })
})
