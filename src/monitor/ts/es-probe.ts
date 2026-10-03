import type { CodecFamily } from '../codecs'

export interface EsCodecInfo {
  /** RFC 6381 codec string, comparable to a CODECS entry. */
  codec?: string
  sampleRate?: number
  channels?: number
}

const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
const AC3_SAMPLE_RATES = [48000, 44100, 32000]

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/**
 * `avc1.PPCCLL` from the first SPS in an Annex-B byte stream. The three bytes after the NAL
 * header can't contain an emulation-prevention sequence (profile_idc is never 0), so no
 * unescaping is needed.
 */
function probeAvc(es: Uint8Array): EsCodecInfo {
  for (let i = 0; i + 6 < es.length; i++) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue
    if ((es[i + 3] & 0x1f) === 7) return { codec: `avc1.${hex2(es[i + 4])}${hex2(es[i + 5])}${hex2(es[i + 6])}` }
  }
  return {}
}

/**
 * Codec from the ADTS header of the first AAC frame. ADTS carries the base object type, so
 * HE-AAC with implicit SBR signalling reads as `mp4a.40.2`.
 */
function probeAac(es: Uint8Array): EsCodecInfo {
  for (let i = 0; i + 4 < es.length; i++) {
    if (es[i] !== 0xff || (es[i + 1] & 0xf6) !== 0xf0) continue // syncword + layer 00
    const aot = ((es[i + 2] >> 6) & 0x3) + 1
    const sampleRate = ADTS_SAMPLE_RATES[(es[i + 2] >> 2) & 0xf]
    if (!sampleRate) continue
    const channels = ((es[i + 2] & 0x1) << 2) | (es[i + 3] >> 6)
    return { codec: `mp4a.40.${aot}`, sampleRate, channels: channels || undefined }
  }
  return {}
}

function probeAc3(es: Uint8Array): EsCodecInfo {
  for (let i = 0; i + 4 < es.length; i++) {
    if (es[i] === 0x0b && es[i + 1] === 0x77) return { codec: 'ac-3', sampleRate: AC3_SAMPLE_RATES[es[i + 4] >> 6] }
  }
  return { codec: 'ac-3' }
}

/** Codec details from the start of an elementary stream (the first PES payload). */
export function probeEs(family: CodecFamily | undefined, es: Uint8Array): EsCodecInfo {
  switch (family) {
    case 'avc':
      return probeAvc(es)
    case 'aac':
      return probeAac(es)
    case 'ac3':
      return probeAc3(es)
    case 'eac3':
      return { codec: 'ec-3' }
    case 'mp3':
      return { codec: 'mp4a.40.34' }
    default:
      return {}
  }
}
