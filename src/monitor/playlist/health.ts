import type { MediaPlaylist } from './parse'

/** Cap on how many missed sequence numbers a single refresh reports (e.g. after a sequence reset). */
const MAX_MISSED_REPORTED = 1000

export interface PlaylistRefresh {
  /** `performance.now()` when the playlist finished loading. */
  t: number
  /** Tracking key, e.g. `main:2` (level 2) or `audio:0`. */
  key: string
  url: string
  mediaSequence: number
  /** SN of the last segment, or `mediaSequence - 1` for an empty playlist. */
  lastSn: number
  segmentCount: number
  targetDuration?: number
  endList: boolean
  /** Time since the previous refresh of the same playlist; undefined on the first load. */
  intervalMs?: number
  /** How far MEDIA-SEQUENCE moved since the previous refresh (negative = sequence went backwards). */
  mediaSequenceAdvance?: number
  /** New segments appended since the previous refresh. */
  newSegments?: number
  /** False when the playlist came back identical (no new segments, same sequence). */
  changed: boolean
  /**
   * SNs that were published and already removed between two refreshes, so the client could never
   * have seen them: the refresh interval is too long for the playlist window.
   */
  missedSns: number[]
  /** ENDLIST appeared on a playlist that had been refreshing without it (a live stream ended). */
  endListAppeared: boolean
}

interface PlaylistState {
  t: number
  mediaSequence: number
  lastSn: number
  endList: boolean
}

/**
 * Tracks consecutive refreshes of each media playlist and derives health signals from them.
 *
 * hls.js only refreshes the playlist of the active level, so a level coming back after a switch
 * would look like it skipped minutes of segments. Callers must `forget(key)` a playlist when it
 * stops being refreshed (e.g. on level switch) so its next load starts a fresh baseline.
 * Playlists are keyed by role (`main:<level>`) rather than URL, because LL-HLS delivery
 * directives and token rotation can change the URL of the same playlist between refreshes.
 */
export class PlaylistHealthTracker {
  private readonly states = new Map<string, PlaylistState>()

  track(key: string, url: string, playlist: MediaPlaylist, t: number): PlaylistRefresh {
    // Delta updates (EXT-X-SKIP) omit the oldest segments but still count them.
    const segmentCount = playlist.skippedSegments + playlist.segments.length
    const lastSn = playlist.mediaSequence + segmentCount - 1
    const prev = this.states.get(key)
    this.states.set(key, { t, mediaSequence: playlist.mediaSequence, lastSn, endList: playlist.endList })

    const refresh: PlaylistRefresh = {
      t,
      key,
      url,
      mediaSequence: playlist.mediaSequence,
      lastSn,
      segmentCount,
      targetDuration: playlist.targetDuration,
      endList: playlist.endList,
      changed: true,
      missedSns: [],
      endListAppeared: false,
    }
    if (!prev) return refresh

    refresh.intervalMs = t - prev.t
    refresh.mediaSequenceAdvance = playlist.mediaSequence - prev.mediaSequence
    refresh.newSegments = Math.max(0, lastSn - prev.lastSn)
    refresh.changed = lastSn !== prev.lastSn || playlist.mediaSequence !== prev.mediaSequence
    refresh.endListAppeared = playlist.endList && !prev.endList

    // Everything between the last SN we saw and the first SN still listed was never visible.
    const firstUnseen = prev.lastSn + 1
    const missedCount = Math.min(playlist.mediaSequence - firstUnseen, MAX_MISSED_REPORTED)
    for (let i = 0; i < missedCount; i++) refresh.missedSns.push(firstUnseen + i)

    return refresh
  }

  forget(key: string): void {
    this.states.delete(key)
  }

  clear(): void {
    this.states.clear()
  }
}
