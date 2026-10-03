import { describe, expect, it } from 'vitest'
import { looksLikeTs, parseTs, TsParseError } from './parse-ts'

const PMT_PID = 0x1000
const VIDEO_PID = 0x100
const AUDIO_PID = 0x101

/** Builds one 188-byte packet (payload only), padded with 0xFF stuffing. */
function packet(pid: number, cc: number, payload: number[], pusi = true): number[] {
  const header = [0x47, (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f), pid & 0xff, 0x10 | (cc & 0x0f)]
  const bytes = [...header, ...payload]
  while (bytes.length < 188) bytes.push(0xff)
  return bytes
}

/** PSI section with pointer_field, a fake CRC and the given body after section_length. */
function section(tableId: number, body: number[]): number[] {
  const length = body.length + 4 // + CRC32
  return [0x00, tableId, 0xb0 | ((length >> 8) & 0x0f), length & 0xff, ...body, 0, 0, 0, 0]
}

function pat(): number[] {
  // transport_stream_id, version, section numbers, then program 1 → PMT_PID
  return packet(0, 0, section(0x00, [0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]))
}

function pmt(entries: { type: number; pid: number; descriptors?: number[] }[]): number[] {
  const es = entries.flatMap((e) => {
    const d = e.descriptors ?? []
    return [e.type, 0xe0 | (e.pid >> 8), e.pid & 0xff, 0xf0 | (d.length >> 8), d.length & 0xff, ...d]
  })
  // program_number, version, section numbers, PCR_PID, program_info_length = 0
  const body = [0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00, ...es]
  return packet(PMT_PID, 0, section(0x02, body))
}

function encodePts(seconds: number): number[] {
  const pts = Math.round(seconds * 90_000)
  const hi = Math.floor(pts / 2 ** 30) & 0x07
  const mid = Math.floor(pts / 2 ** 15) & 0x7fff
  const lo = pts & 0x7fff
  return [0x21 | (hi << 1), mid >> 7, ((mid & 0x7f) << 1) | 1, lo >> 7, ((lo & 0x7f) << 1) | 1]
}

function pes(pid: number, cc: number, seconds: number): number[] {
  return packet(pid, cc, [0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x80, 0x05, ...encodePts(seconds)])
}

const AVC_AAC = pmt([
  { type: 0x1b, pid: VIDEO_PID },
  { type: 0x0f, pid: AUDIO_PID },
])

function segment(...packets: number[][]): Uint8Array {
  return new Uint8Array(packets.flat())
}

describe('parseTs', () => {
  it('finds streams, codec families and PTS ranges', () => {
    const data = segment(
      pat(),
      AVC_AAC,
      pes(VIDEO_PID, 0, 10),
      pes(AUDIO_PID, 0, 10.01),
      pes(VIDEO_PID, 1, 12),
      pes(VIDEO_PID, 2, 13.96),
      pes(AUDIO_PID, 1, 13.98),
    )
    const result = parseTs(data)
    expect(result.families).toEqual(['avc', 'aac'])
    expect(result.packets).toBe(7)
    expect(result.ccErrors).toBe(0)
    const video = result.streams.find((s) => s.pid === VIDEO_PID)!
    expect(video.streamType).toBe(0x1b)
    expect(video.firstPts).toBeCloseTo(10)
    expect(video.lastPts).toBeCloseTo(13.96)
  })

  it('reads PTS values above 32 bits', () => {
    const big = 2 ** 32 / 90_000 + 5 // ~47 727 s
    const result = parseTs(segment(pat(), AVC_AAC, pes(VIDEO_PID, 0, big)))
    expect(result.streams[0].firstPts).toBeCloseTo(big, 3)
  })

  it('detects AC-3 signalled through a DVB descriptor on private data', () => {
    const table = pmt([
      { type: 0x1b, pid: VIDEO_PID },
      { type: 0x06, pid: AUDIO_PID, descriptors: [0x6a, 0x01, 0x00] },
    ])
    expect(parseTs(segment(pat(), table)).families).toEqual(['avc', 'ac3'])
  })

  it('counts continuity counter jumps but not duplicates', () => {
    const data = segment(
      pat(),
      AVC_AAC,
      pes(VIDEO_PID, 0, 1),
      pes(VIDEO_PID, 0, 1), // duplicate: allowed
      pes(VIDEO_PID, 3, 2), // jump 0 → 3: lost packets
    )
    expect(parseTs(data).ccErrors).toBe(1)
  })

  it('attributes continuity errors and packet counts to each PID', () => {
    const data = segment(
      pat(),
      AVC_AAC,
      pes(VIDEO_PID, 0, 1),
      pes(AUDIO_PID, 0, 1),
      pes(VIDEO_PID, 1, 2),
      pes(AUDIO_PID, 5, 2), // jump on audio only
    )
    expect(parseTs(data).pids).toEqual([
      { pid: 0, packets: 1, ccErrors: 0 },
      { pid: VIDEO_PID, packets: 2, ccErrors: 0 },
      { pid: AUDIO_PID, packets: 2, ccErrors: 1 },
      { pid: PMT_PID, packets: 1, ccErrors: 0 },
    ])
  })

  it('counts packets without a sync byte', () => {
    const broken = pes(VIDEO_PID, 0, 1)
    broken[0] = 0x00
    expect(parseTs(segment(pat(), AVC_AAC, broken)).syncErrors).toBe(1)
  })

  it('throws when there are no program tables', () => {
    expect(() => parseTs(segment(pes(VIDEO_PID, 0, 1)))).toThrow(TsParseError)
  })
})

describe('looksLikeTs', () => {
  it('accepts TS and rejects fMP4 / text', () => {
    expect(looksLikeTs(segment(pat(), AVC_AAC, pes(VIDEO_PID, 0, 1)))).toBe(true)
    const mp4 = new Uint8Array(400)
    mp4.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]) // ....ftyp
    expect(looksLikeTs(mp4)).toBe(false)
    expect(looksLikeTs(new TextEncoder().encode('#EXTM3U'))).toBe(false)
  })
})
