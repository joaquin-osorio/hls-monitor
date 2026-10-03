import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
import type { VariantSelection } from '@/lib/query-state'
import type { ThrottleProfile } from '@/monitor/network-shaper'
import { MonitorSession } from '@/monitor/session'
import type { MonitorSnapshot } from '@/monitor/types'

/** Tiny external store holding the current session, so effects don't need React setState. */
function createSessionHolder() {
  let current: MonitorSession | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(session: MonitorSession | null) {
      current = session
      for (const l of listeners) l()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const noSubscribe = () => () => {}
const noSnapshot = () => null

interface UseMonitorOptions {
  url: string | null
  video: HTMLVideoElement | null
  variant: VariantSelection
  onVariantRejected: () => void
  throttle: ThrottleProfile | null
  /** Loudness meter on/off. Turn it on from a user gesture (it unmutes the video). */
  loudness: boolean
}

/**
 * Runs one `MonitorSession` per (url, video element) pair and returns its throttled snapshot.
 * The variant, network throttle and loudness meter are synced into the live session without
 * recreating it.
 */
export function useMonitor({ url, video, variant, onVariantRejected, throttle, loudness }: UseMonitorOptions): {
  session: MonitorSession | null
  snapshot: MonitorSnapshot | null
} {
  const [holder] = useState(createSessionHolder)
  const session = useSyncExternalStore(holder.subscribe, holder.get)
  const rejectVariant = useEffectEvent(onVariantRejected)

  useEffect(() => {
    if (!url || !video) return
    const created = new MonitorSession(url, video, { onVariantRejected: () => rejectVariant() })
    holder.set(created)
    return () => {
      created.destroy()
      holder.set(null)
    }
  }, [url, video, holder])

  useEffect(() => {
    session?.setVariant(variant)
  }, [session, variant])

  useEffect(() => {
    session?.setThrottle(throttle)
  }, [session, throttle])

  useEffect(() => {
    session?.setLoudness(loudness)
  }, [session, loudness])

  const snapshot = useSyncExternalStore(
    session ? session.store.subscribe : noSubscribe,
    session ? session.store.getSnapshot : noSnapshot,
  )
  return { session, snapshot }
}
