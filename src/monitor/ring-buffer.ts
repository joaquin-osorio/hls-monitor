/**
 * Default retention window for every metric series: the last 120 minutes, long enough for a full
 * sports event. Buffer capacities are sized so this window, not the capacity, usually binds first.
 */
export const RETENTION_MS = 120 * 60 * 1000

/**
 * Fixed-capacity circular buffer that also evicts entries older than a time window.
 *
 * Items carry their own timestamp `t` (a `performance.now()` value). Eviction happens on
 * `push`, relative to the pushed item's timestamp, so the buffer never holds more than
 * `windowMs` of history nor more than `capacity` items — whichever bound is hit first.
 */
export class TimeWindowBuffer<T extends { t: number }> {
  private readonly items: (T | undefined)[]
  private head = 0 // index of the oldest item
  private size = 0
  private readonly capacity: number
  private readonly windowMs: number

  constructor(capacity: number, windowMs: number = RETENTION_MS) {
    if (capacity < 1) throw new RangeError('capacity must be >= 1')
    this.capacity = capacity
    this.windowMs = windowMs
    this.items = new Array<T | undefined>(capacity)
  }

  get length(): number {
    return this.size
  }

  push(item: T): void {
    this.evictOlderThan(item.t - this.windowMs)
    if (this.size === this.capacity) {
      // Full: overwrite the oldest slot.
      this.items[this.head] = item
      this.head = (this.head + 1) % this.capacity
      return
    }
    this.items[(this.head + this.size) % this.capacity] = item
    this.size++
  }

  /** Drops every item with `t < cutoff`. Items are assumed to be pushed in time order. */
  evictOlderThan(cutoff: number): void {
    while (this.size > 0) {
      const oldest = this.items[this.head]!
      if (oldest.t >= cutoff) break
      this.items[this.head] = undefined
      this.head = (this.head + 1) % this.capacity
      this.size--
    }
  }

  /**
   * Replaces the newest item matching `predicate` with `update(item)`. Searches from newest to
   * oldest, since updates almost always target recent entries. Returns whether an item was found.
   */
  update(predicate: (item: T) => boolean, update: (item: T) => T): boolean {
    for (let i = this.size - 1; i >= 0; i--) {
      const idx = (this.head + i) % this.capacity
      const item = this.items[idx]!
      if (predicate(item)) {
        this.items[idx] = update(item)
        return true
      }
    }
    return false
  }

  /** Newest item matching `predicate`, if any. */
  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let i = this.size - 1; i >= 0; i--) {
      const item = this.items[(this.head + i) % this.capacity]!
      if (predicate(item)) return item
    }
    return undefined
  }

  last(): T | undefined {
    return this.size === 0 ? undefined : this.items[(this.head + this.size - 1) % this.capacity]
  }

  /** Items from oldest to newest, as a new array. */
  toArray(): T[] {
    const out = new Array<T>(this.size)
    for (let i = 0; i < this.size; i++) out[i] = this.items[(this.head + i) % this.capacity]!
    return out
  }

  clear(): void {
    this.items.fill(undefined)
    this.head = 0
    this.size = 0
  }
}
