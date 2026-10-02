/** Minimum time between two UI flushes. */
export const RENDER_INTERVAL_MS = 500

export interface ThrottledStoreOptions {
  intervalMs?: number
  now?: () => number
  /** Frame scheduler. Defaults to `requestAnimationFrame`; injectable for tests. */
  raf?: (cb: () => void) => void
}

/**
 * External store for `useSyncExternalStore` that rebuilds its snapshot at most once every
 * `intervalMs`, inside an animation frame.
 *
 * Producers call `markDirty(key)` as often as they like; the store coalesces those calls into one
 * flush. `build` receives the set of dirty keys and the previous snapshot so it can rebuild only
 * the slices that changed and keep the others referentially equal (cheap `React.memo` bailouts).
 *
 * While the tab is hidden, animation frames don't run, so flushes pause; data collection keeps
 * going and the next visible frame catches up in one flush.
 */
export class ThrottledStore<Snapshot, Key extends string = string> {
  private snapshot: Snapshot
  private readonly listeners = new Set<() => void>()
  private readonly dirty = new Set<Key>()
  private pending = false
  private destroyed = false
  private lastFlush = Number.NEGATIVE_INFINITY
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly build: (dirty: ReadonlySet<Key>, prev: Snapshot) => Snapshot
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly raf: (cb: () => void) => void

  constructor(
    initial: Snapshot,
    build: (dirty: ReadonlySet<Key>, prev: Snapshot) => Snapshot,
    options: ThrottledStoreOptions = {},
  ) {
    this.snapshot = initial
    this.build = build
    this.intervalMs = options.intervalMs ?? RENDER_INTERVAL_MS
    this.now = options.now ?? (() => performance.now())
    this.raf = options.raf ?? ((cb) => requestAnimationFrame(cb))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): Snapshot => this.snapshot

  markDirty(key: Key): void {
    if (this.destroyed) return
    this.dirty.add(key)
    if (this.pending) return
    this.pending = true
    const wait = Math.max(0, this.lastFlush + this.intervalMs - this.now())
    this.timer = setTimeout(() => this.raf(() => this.flush()), wait)
  }

  /** Stops scheduling flushes and drops listeners. The last snapshot stays readable. */
  destroy(): void {
    this.destroyed = true
    clearTimeout(this.timer)
    this.listeners.clear()
    this.dirty.clear()
  }

  private flush(): void {
    this.pending = false
    if (this.destroyed || this.dirty.size === 0) return
    this.lastFlush = this.now()
    const dirty = new Set(this.dirty)
    this.dirty.clear()
    this.snapshot = this.build(dirty, this.snapshot)
    for (const listener of this.listeners) listener()
  }
}
