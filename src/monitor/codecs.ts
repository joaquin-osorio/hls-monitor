/**
 * Codec families the monitor can compare between a variant's CODECS attribute and what the
 * MPEG-TS parser finds in the segments. Profiles/levels are deliberately ignored: TS stream types
 * only identify the family.
 */
export type CodecFamily = 'avc' | 'hevc' | 'aac' | 'mp3' | 'ac3' | 'eac3'

/** Family of an RFC 6381 codec string as used in CODECS, or undefined if not tracked. */
export function familyOfCodecString(codec: string): CodecFamily | undefined {
  const c = codec.trim().toLowerCase()
  const [fourcc, oti, aot] = c.split('.')
  switch (fourcc) {
    case 'avc1':
    case 'avc3':
      return 'avc'
    case 'hvc1':
    case 'hev1':
      return 'hevc'
    case 'ac-3':
      return 'ac3'
    case 'ec-3':
      return 'eac3'
    case 'mp3':
      return 'mp3'
    case 'mp4a':
      if (oti === '69' || oti === '6b' || (oti === '40' && aot === '34')) return 'mp3'
      if (oti === 'a5') return 'ac3'
      if (oti === 'a6') return 'eac3'
      return 'aac'
    default:
      return undefined
  }
}
