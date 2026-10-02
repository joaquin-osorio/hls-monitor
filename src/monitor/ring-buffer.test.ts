import { describe, expect, it } from 'vitest'
import { TimeWindowBuffer } from './ring-buffer'

const item = (t: number, v = t) => ({ t, v })

describe('TimeWindowBuffer', () => {
  it('keeps items in insertion order', () => {
    const buf = new TimeWindowBuffer<{ t: number; v: number }>(10, 1000)
    buf.push(item(1))
    buf.push(item(2))
    buf.push(item(3))
    expect(buf.toArray().map((i) => i.t)).toEqual([1, 2, 3])
    expect(buf.last()?.t).toBe(3)
  })

  it('overwrites the oldest item when capacity is reached', () => {
    const buf = new TimeWindowBuffer<{ t: number; v: number }>(3, 1_000_000)
    for (let t = 1; t <= 5; t++) buf.push(item(t))
    expect(buf.length).toBe(3)
    expect(buf.toArray().map((i) => i.t)).toEqual([3, 4, 5])
  })

  it('evicts items that fall outside the time window', () => {
    const windowMs = 30 * 60 * 1000
    const buf = new TimeWindowBuffer<{ t: number; v: number }>(10_000, windowMs)
    buf.push(item(0))
    buf.push(item(10 * 60 * 1000))
    buf.push(item(31 * 60 * 1000)) // pushes t=0 out of the 30 min window
    expect(buf.toArray().map((i) => i.t)).toEqual([10 * 60 * 1000, 31 * 60 * 1000])
  })

  it('keeps an item exactly at the window edge', () => {
    const buf = new TimeWindowBuffer<{ t: number; v: number }>(10, 100)
    buf.push(item(0))
    buf.push(item(100))
    expect(buf.length).toBe(2)
  })

  it('updates the newest matching item in place', () => {
    const buf = new TimeWindowBuffer<{ t: number; v: number }>(3, 1_000_000)
    for (let t = 1; t <= 4; t++) buf.push(item(t, t % 2)) // wraps around
    const found = buf.update(
      (i) => i.v === 1,
      (i) => ({ ...i, v: 99 }),
    )
    expect(found).toBe(true)
    expect(buf.toArray().map((i) => i.v)).toEqual([0, 99, 0])
    expect(buf.update(() => false, (i) => i)).toBe(false)
  })

  it('finds the newest matching item', () => {
    const buf = new TimeWindowBuffer<{ t: number; v: number }>(5, 1_000_000)
    buf.push(item(1, 7))
    buf.push(item(2, 7))
    buf.push(item(3, 8))
    expect(buf.findLast((i) => i.v === 7)?.t).toBe(2)
  })
})
