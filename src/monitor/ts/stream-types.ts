/** Human-readable names for ISO/IEC 13818-1 stream_type values commonly found in HLS. */
const STREAM_TYPE_NAMES: Record<number, string> = {
  0x02: 'MPEG-2 video',
  0x03: 'MPEG-1 audio',
  0x04: 'MPEG-2 audio',
  0x06: 'PES private data',
  0x0f: 'AAC (ADTS)',
  0x11: 'AAC (LATM)',
  0x15: 'ID3 metadata',
  0x1b: 'H.264',
  0x24: 'H.265',
  0x81: 'AC-3',
  0x86: 'SCTE-35',
  0x87: 'E-AC-3',
  0xcf: 'AAC (SAMPLE-AES)',
  0xc1: 'AC-3 (SAMPLE-AES)',
  0xc2: 'E-AC-3 (SAMPLE-AES)',
  0xdb: 'H.264 (SAMPLE-AES)',
}

export function streamTypeName(streamType: number): string {
  return STREAM_TYPE_NAMES[streamType] ?? 'unknown'
}

/** `0x0100`-style PID label. */
export function formatPid(pid: number): string {
  return `0x${pid.toString(16).padStart(4, '0')}`
}

/** Role of a PID inside one segment: program tables, an elementary stream, or something else. */
export function pidLabel(pid: number, streamType: number | undefined): string {
  if (pid === 0) return 'PAT'
  if (streamType === undefined) return pid === 0x11 ? 'SDT' : 'PMT / other'
  return streamTypeName(streamType)
}
