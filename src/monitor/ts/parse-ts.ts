import type { CodecFamily } from '../codecs'

const PACKET_SIZE = 188
const SYNC_BYTE = 0x47
const PTS_CLOCK = 90_000

export interface TsStream {
  pid: number
  /** ISO/IEC 13818-1 stream_type from the PMT. */
  streamType: number
  /** Undefined for streams that are not audio/video (ID3 metadata, unknown private data). */
  family?: CodecFamily
  /** First and last PES PTS in seconds, in packet order. */
  firstPts?: number
  lastPts?: number
}

export interface TsAnalysis {
  packets: number
  /** Packets that did not start with the 0x47 sync byte (skipped). */
  syncErrors: number
  /** Continuity counter jumps on PIDs with payload, excluding signalled discontinuities. */
  ccErrors: number
  streams: TsStream[]
  /** Distinct codec families across `streams`. */
  families: CodecFamily[]
}

export class TsParseError extends Error {
  name = 'TsParseError'
}

/** Quick content sniff: sync bytes at the start of the first two (or three) packets. */
export function looksLikeTs(data: Uint8Array): boolean {
  if (data.length < PACKET_SIZE || data[0] !== SYNC_BYTE) return false
  if (data.length >= 2 * PACKET_SIZE && data[PACKET_SIZE] !== SYNC_BYTE) return false
  if (data.length >= 3 * PACKET_SIZE && data[2 * PACKET_SIZE] !== SYNC_BYTE) return false
  return true
}

function familyOf(streamType: number, descriptorTags: number[]): CodecFamily | undefined {
  switch (streamType) {
    case 0x1b: // H.264
    case 0xdb: // H.264, SAMPLE-AES
      return 'avc'
    case 0x24:
      return 'hevc'
    case 0x0f: // AAC ADTS
    case 0x11: // AAC LATM
    case 0xcf: // AAC, SAMPLE-AES
      return 'aac'
    case 0x03:
    case 0x04:
      return 'mp3'
    case 0x81:
    case 0xc1: // AC-3, SAMPLE-AES
      return 'ac3'
    case 0x87:
    case 0xc2: // E-AC-3, SAMPLE-AES
      return 'eac3'
    case 0x06: // PES private data: DVB signals AC-3 / E-AC-3 through descriptors
      if (descriptorTags.includes(0x6a)) return 'ac3'
      if (descriptorTags.includes(0x7a)) return 'eac3'
      return undefined
    default:
      return undefined
  }
}

/** Offset of the payload inside the packet at `p`, or -1 if it has none. */
function payloadOffset(data: Uint8Array, p: number): number {
  const afc = (data[p + 3] >> 4) & 0x3
  if (afc === 0x1) return p + 4
  if (afc === 0x3) return p + 5 + data[p + 4]
  return -1
}

/** Start of a PSI section: skips the pointer_field present on payload-unit-start packets. */
function sectionStart(data: Uint8Array, payload: number): number {
  return payload + 1 + data[payload]
}

function parsePat(data: Uint8Array, s: number, end: number): number | undefined {
  if (data[s] !== 0x00) return undefined
  const sectionLength = ((data[s + 1] & 0x0f) << 8) | data[s + 2]
  const loopEnd = Math.min(s + 3 + sectionLength - 4, end) // minus CRC32
  for (let i = s + 8; i + 4 <= loopEnd; i += 4) {
    const program = (data[i] << 8) | data[i + 1]
    if (program !== 0) return ((data[i + 2] & 0x1f) << 8) | data[i + 3]
  }
  return undefined
}

function parsePmt(data: Uint8Array, s: number, end: number): TsStream[] | undefined {
  if (data[s] !== 0x02) return undefined
  const sectionLength = ((data[s + 1] & 0x0f) << 8) | data[s + 2]
  const loopEnd = Math.min(s + 3 + sectionLength - 4, end)
  const programInfoLength = ((data[s + 10] & 0x0f) << 8) | data[s + 11]
  const streams: TsStream[] = []
  for (let i = s + 12 + programInfoLength; i + 5 <= loopEnd; ) {
    const streamType = data[i]
    const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2]
    const esInfoLength = ((data[i + 3] & 0x0f) << 8) | data[i + 4]
    const tags: number[] = []
    for (let d = i + 5; d + 2 <= i + 5 + esInfoLength; d += 2 + data[d + 1]) tags.push(data[d])
    streams.push({ pid, streamType, family: familyOf(streamType, tags) })
    i += 5 + esInfoLength
  }
  return streams
}

/** PTS in seconds from a PES header starting at `o`, if present. */
function readPts(data: Uint8Array, o: number, end: number): number | undefined {
  if (o + 14 > end || data[o] !== 0 || data[o + 1] !== 0 || data[o + 2] !== 1) return undefined
  if ((data[o + 7] & 0x80) === 0) return undefined
  const b = o + 9
  // 33-bit value: use arithmetic, not bitwise ops, to stay above 32 bits.
  const pts =
    (data[b] & 0x0e) * 536870912 + // << 29
    data[b + 1] * 4194304 + // << 22
    (data[b + 2] & 0xfe) * 16384 + // << 14
    data[b + 3] * 128 + // << 7
    (data[b + 4] >> 1)
  return pts / PTS_CLOCK
}

/**
 * Parses an MPEG-TS segment: program tables, elementary streams with codec family, PTS range and
 * continuity errors. Assumes PAT and PMT sections each fit in a single packet, which holds for
 * practically every HLS packager.
 *
 * @throws TsParseError when the data has no usable PAT/PMT.
 */
export function parseTs(data: Uint8Array): TsAnalysis {
  let pmtPid: number | undefined
  let streams: TsStream[] | undefined
  let syncErrors = 0
  let ccErrors = 0
  let packets = 0
  const lastCc = new Map<number, number>()
  const ptsByPid = new Map<number, { first: number; last: number }>()

  for (let p = 0; p + PACKET_SIZE <= data.length; p += PACKET_SIZE) {
    packets++
    if (data[p] !== SYNC_BYTE) {
      syncErrors++
      continue
    }
    const pusi = (data[p + 1] & 0x40) !== 0
    const pid = ((data[p + 1] & 0x1f) << 8) | data[p + 2]
    const end = p + PACKET_SIZE
    const payload = payloadOffset(data, p)
    if (pid === 0x1fff) continue // null packets

    if (payload !== -1) {
      const cc = data[p + 3] & 0x0f
      const discontinuity = (data[p + 3] & 0x20) !== 0 && data[p + 4] > 0 && (data[p + 5] & 0x80) !== 0
      const prev = lastCc.get(pid)
      // A repeated CC is a legal duplicate packet; anything else but +1 is a loss.
      if (prev !== undefined && !discontinuity && cc !== prev && cc !== ((prev + 1) & 0x0f)) ccErrors++
      lastCc.set(pid, cc)
    }
    if (payload === -1 || payload >= end || !pusi) continue

    if (pid === 0) {
      pmtPid ??= parsePat(data, sectionStart(data, payload), end)
    } else if (pid === pmtPid) {
      streams ??= parsePmt(data, sectionStart(data, payload), end)
    } else {
      const pts = readPts(data, payload, end)
      if (pts === undefined) continue
      const range = ptsByPid.get(pid)
      if (range) range.last = pts
      else ptsByPid.set(pid, { first: pts, last: pts })
    }
  }

  if (pmtPid === undefined) throw new TsParseError('No PAT found')
  if (!streams) throw new TsParseError('No PMT found')

  for (const s of streams) {
    const range = ptsByPid.get(s.pid)
    s.firstPts = range?.first
    s.lastPts = range?.last
  }
  const families = [...new Set(streams.flatMap((s) => (s.family ? [s.family] : [])))]
  return { packets, syncErrors, ccErrors, streams, families }
}
