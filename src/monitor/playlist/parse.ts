/**
 * Minimal M3U8 parser for monitoring.
 *
 * It reports what the server actually sent, without the normalization hls.js applies, so spec
 * checks can flag things hls.js tolerates. Only the tags the monitor uses are parsed; everything
 * else is ignored. LL-HLS tags (parts, preload hints, server control, delta updates) are parsed;
 * alternate renditions (EXT-X-MEDIA) are not.
 */

export interface Resolution {
  width: number
  height: number
}

export interface VariantStream {
  /** Absolute URI (resolved against the playlist URL when one is given). */
  uri: string
  bandwidth?: number
  averageBandwidth?: number
  resolution?: Resolution
  /** Entries of the CODECS attribute, or undefined when the attribute is missing. */
  codecs?: string[]
  frameRate?: number
}

export interface MasterPlaylist {
  kind: 'master'
  variants: VariantStream[]
}

/** An LL-HLS partial segment (EXT-X-PART). */
export interface MediaPart {
  uri: string
  /** DURATION in seconds. */
  duration: number
  independent: boolean
  gap: boolean
  byteRange?: string
}

export interface PreloadHint {
  type: 'PART' | 'MAP'
  uri: string
  byteRangeStart?: number
  byteRangeLength?: number
}

export interface RenditionReport {
  uri: string
  lastMsn?: number
  lastPart?: number
}

/** EXT-X-SERVER-CONTROL */
export interface ServerControl {
  canBlockReload: boolean
  /** CAN-SKIP-UNTIL in seconds. */
  canSkipUntil?: number
  canSkipDateRanges: boolean
  holdBack?: number
  partHoldBack?: number
}

export interface MediaSegment {
  /** Media sequence number. */
  sn: number
  uri: string
  /** EXTINF duration in seconds. */
  duration: number
  /** Preceded by EXT-X-DISCONTINUITY. */
  discontinuity: boolean
  /** Discontinuity sequence number (EXT-X-DISCONTINUITY-SEQUENCE + discontinuities seen so far). */
  cc: number
  /** Tagged with EXT-X-GAP. */
  gap: boolean
  /**
   * Wall-clock start in epoch ms: from EXT-X-PROGRAM-DATE-TIME, or extrapolated from the previous
   * segment's date + duration when there is no discontinuity in between.
   */
  programDateTime?: number
  /** EXT-X-PART tags preceding the segment URI (LL-HLS). */
  parts?: MediaPart[]
}

export interface MediaPlaylist {
  kind: 'media'
  targetDuration?: number
  mediaSequence: number
  discontinuitySequence: number
  playlistType?: string
  endList: boolean
  /**
   * EXT-X-SKIP SKIPPED-SEGMENTS of a delta update (`_HLS_skip`): that many segments after
   * MEDIA-SEQUENCE were omitted, so the first listed segment is `mediaSequence + skippedSegments`.
   */
  skippedSegments: number
  segments: MediaSegment[]
  /** EXT-X-PART-INF PART-TARGET in seconds. */
  partTarget?: number
  serverControl?: ServerControl
  /** Parts listed after the last complete segment: the segment being produced (SN = last + 1). */
  pendingParts: MediaPart[]
  preloadHints: PreloadHint[]
  renditionReports: RenditionReport[]
}

export type Playlist = MasterPlaylist | MediaPlaylist

export class PlaylistParseError extends Error {
  name = 'PlaylistParseError'
}

/** Parses an HLS attribute list (`KEY=value,KEY="quoted,value"`). Keys are kept as written. */
export function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  for (const match of input.matchAll(re)) {
    const raw = match[2]
    attrs[match[1]] = raw.startsWith('"') ? raw.slice(1, -1) : raw
  }
  return attrs
}

function resolveUri(uri: string, baseUrl?: string): string {
  if (!baseUrl) return uri
  try {
    return new URL(uri, baseUrl).href
  } catch {
    return uri
  }
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function parseResolution(value: string | undefined): Resolution | undefined {
  const m = value?.match(/^(\d+)x(\d+)$/)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined
}

export function parsePlaylist(text: string, baseUrl?: string): Playlist {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  if (lines[0]?.replace(/^\uFEFF/, '') !== '#EXTM3U') {
    throw new PlaylistParseError('Missing #EXTM3U header')
  }
  return lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'))
    ? parseMaster(lines, baseUrl)
    : parseMedia(lines, baseUrl)
}

function parseMaster(lines: string[], baseUrl?: string): MasterPlaylist {
  const variants: VariantStream[] = []
  let pending: Record<string, string> | null = null
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length))
    } else if (pending && line && !line.startsWith('#')) {
      variants.push({
        uri: resolveUri(line, baseUrl),
        bandwidth: toNumber(pending['BANDWIDTH']),
        averageBandwidth: toNumber(pending['AVERAGE-BANDWIDTH']),
        resolution: parseResolution(pending['RESOLUTION']),
        codecs: pending['CODECS']
          ?.split(',')
          .map((c) => c.trim())
          .filter(Boolean),
        frameRate: toNumber(pending['FRAME-RATE']),
      })
      pending = null
    }
  }
  return { kind: 'master', variants }
}

function parsePart(value: string, baseUrl?: string): MediaPart | undefined {
  const a = parseAttributes(value)
  const duration = toNumber(a['DURATION'])
  if (!a['URI'] || duration === undefined) return undefined
  return {
    uri: resolveUri(a['URI'], baseUrl),
    duration,
    independent: a['INDEPENDENT'] === 'YES',
    gap: a['GAP'] === 'YES',
    byteRange: a['BYTERANGE'],
  }
}

function parseMedia(lines: string[], baseUrl?: string): MediaPlaylist {
  const playlist: MediaPlaylist = {
    kind: 'media',
    mediaSequence: 0,
    discontinuitySequence: 0,
    endList: false,
    skippedSegments: 0,
    segments: [],
    pendingParts: [],
    preloadHints: [],
    renditionReports: [],
  }
  let parts: MediaPart[] = []
  let duration: number | undefined
  let discontinuity = false
  let gap = false
  let pdt: number | undefined
  let cc: number | undefined

  for (const line of lines) {
    if (!line) continue
    if (!line.startsWith('#')) {
      if (duration === undefined) throw new PlaylistParseError(`Segment without #EXTINF: ${line}`)
      cc ??= playlist.discontinuitySequence
      if (discontinuity && playlist.segments.length > 0) cc++
      const prev = playlist.segments.at(-1)
      const programDateTime =
        pdt ?? (prev?.programDateTime !== undefined && !discontinuity ? prev.programDateTime + prev.duration * 1000 : undefined)
      playlist.segments.push({
        sn: playlist.mediaSequence + playlist.skippedSegments + playlist.segments.length,
        uri: resolveUri(line, baseUrl),
        duration,
        discontinuity,
        cc,
        gap,
        programDateTime,
        ...(parts.length > 0 && { parts }),
      })
      parts = []
      duration = undefined
      discontinuity = false
      gap = false
      pdt = undefined
      continue
    }
    const colon = line.indexOf(':')
    const tag = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1)
    switch (tag) {
      case '#EXTINF': {
        const d = Number(value.split(',')[0])
        if (!Number.isFinite(d)) throw new PlaylistParseError(`Invalid #EXTINF: ${line}`)
        duration = d
        break
      }
      case '#EXT-X-TARGETDURATION':
        playlist.targetDuration = toNumber(value)
        break
      case '#EXT-X-MEDIA-SEQUENCE':
        playlist.mediaSequence = toNumber(value) ?? 0
        break
      case '#EXT-X-DISCONTINUITY-SEQUENCE':
        playlist.discontinuitySequence = toNumber(value) ?? 0
        break
      case '#EXT-X-PLAYLIST-TYPE':
        playlist.playlistType = value
        break
      case '#EXT-X-ENDLIST':
        playlist.endList = true
        break
      case '#EXT-X-DISCONTINUITY':
        discontinuity = true
        break
      case '#EXT-X-GAP':
        gap = true
        break
      case '#EXT-X-PROGRAM-DATE-TIME': {
        const ms = Date.parse(value)
        pdt = Number.isNaN(ms) ? undefined : ms
        break
      }
      case '#EXT-X-PART-INF':
        playlist.partTarget = toNumber(parseAttributes(value)['PART-TARGET'])
        break
      case '#EXT-X-SERVER-CONTROL': {
        const a = parseAttributes(value)
        playlist.serverControl = {
          canBlockReload: a['CAN-BLOCK-RELOAD'] === 'YES',
          canSkipUntil: toNumber(a['CAN-SKIP-UNTIL']),
          canSkipDateRanges: a['CAN-SKIP-DATERANGES'] === 'YES',
          holdBack: toNumber(a['HOLD-BACK']),
          partHoldBack: toNumber(a['PART-HOLD-BACK']),
        }
        break
      }
      case '#EXT-X-SKIP':
        playlist.skippedSegments = toNumber(parseAttributes(value)['SKIPPED-SEGMENTS']) ?? 0
        break
      case '#EXT-X-PART': {
        const part = parsePart(value, baseUrl)
        if (part) parts.push(part)
        break
      }
      case '#EXT-X-PRELOAD-HINT': {
        const a = parseAttributes(value)
        if ((a['TYPE'] === 'PART' || a['TYPE'] === 'MAP') && a['URI']) {
          playlist.preloadHints.push({
            type: a['TYPE'],
            uri: resolveUri(a['URI'], baseUrl),
            byteRangeStart: toNumber(a['BYTERANGE-START']),
            byteRangeLength: toNumber(a['BYTERANGE-LENGTH']),
          })
        }
        break
      }
      case '#EXT-X-RENDITION-REPORT': {
        const a = parseAttributes(value)
        if (a['URI']) {
          playlist.renditionReports.push({
            uri: resolveUri(a['URI'], baseUrl),
            lastMsn: toNumber(a['LAST-MSN']),
            lastPart: toNumber(a['LAST-PART']),
          })
        }
        break
      }
    }
  }
  playlist.pendingParts = parts
  return playlist
}
