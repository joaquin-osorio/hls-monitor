import { describe, expect, it } from 'vitest'
import { parseAttributes, parsePlaylist, PlaylistParseError } from './parse'

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=29.970
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720
https://other.cdn/high/index.m3u8
`

describe('parseAttributes', () => {
  it('handles quoted values containing commas', () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.4d401e,mp4a.40.2",NAME="a b"')).toEqual({
      BANDWIDTH: '1',
      CODECS: 'avc1.4d401e,mp4a.40.2',
      NAME: 'a b',
    })
  })
})

describe('parsePlaylist (master)', () => {
  it('parses variants and resolves relative URIs', () => {
    const p = parsePlaylist(MASTER, 'https://cdn.example/stream/master.m3u8')
    expect(p.kind).toBe('master')
    if (p.kind !== 'master') return
    expect(p.variants).toEqual([
      {
        uri: 'https://cdn.example/stream/low/index.m3u8',
        bandwidth: 1280000,
        averageBandwidth: 1000000,
        resolution: { width: 640, height: 360 },
        codecs: ['avc1.4d401e', 'mp4a.40.2'],
        frameRate: 29.97,
      },
      {
        uri: 'https://other.cdn/high/index.m3u8',
        bandwidth: 2560000,
        averageBandwidth: undefined,
        resolution: { width: 1280, height: 720 },
        codecs: undefined,
        frameRate: undefined,
      },
    ])
  })
})

describe('parsePlaylist (media)', () => {
  it('parses a VOD playlist', () => {
    const p = parsePlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6.0,
seg0.ts
#EXTINF:5.5,title
seg1.ts
#EXT-X-ENDLIST
`,
      'https://cdn/v/index.m3u8',
    )
    expect(p).toMatchObject({
      kind: 'media',
      targetDuration: 6,
      mediaSequence: 0,
      playlistType: 'VOD',
      endList: true,
    })
    if (p.kind !== 'media') return
    expect(p.segments.map((s) => [s.sn, s.uri, s.duration])).toEqual([
      [0, 'https://cdn/v/seg0.ts', 6],
      [1, 'https://cdn/v/seg1.ts', 5.5],
    ])
  })

  it('numbers segments from MEDIA-SEQUENCE and tracks discontinuities, gaps and dates', () => {
    const p = parsePlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-DISCONTINUITY-SEQUENCE:3
#EXT-X-PROGRAM-DATE-TIME:2026-10-02T12:00:00.000Z
#EXTINF:4,
a.ts
#EXTINF:4,
b.ts
#EXT-X-DISCONTINUITY
#EXTINF:4,
c.ts
#EXT-X-GAP
#EXTINF:4,
d.ts
`)
    if (p.kind !== 'media') throw new Error('expected media')
    const t0 = Date.parse('2026-10-02T12:00:00.000Z')
    expect(p.endList).toBe(false)
    expect(p.segments.map((s) => ({ sn: s.sn, cc: s.cc, disc: s.discontinuity, gap: s.gap, pdt: s.programDateTime }))).toEqual([
      { sn: 100, cc: 3, disc: false, gap: false, pdt: t0 },
      { sn: 101, cc: 3, disc: false, gap: false, pdt: t0 + 4000 },
      // A discontinuity breaks date extrapolation.
      { sn: 102, cc: 4, disc: true, gap: false, pdt: undefined },
      { sn: 103, cc: 4, disc: false, gap: true, pdt: undefined },
    ])
  })

  it('rejects input without the #EXTM3U header', () => {
    expect(() => parsePlaylist('<html>404</html>')).toThrow(PlaylistParseError)
  })

  it('rejects a segment without EXTINF', () => {
    expect(() => parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\nseg.ts\n')).toThrow(PlaylistParseError)
  })
})

const LL_HLS = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-VERSION:9
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=24,PART-HOLD-BACK=3.012
#EXT-X-PART-INF:PART-TARGET=1.004
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:4.0,
s100.ts
#EXT-X-PART:DURATION=1.0,URI="s101.0.ts",INDEPENDENT=YES
#EXT-X-PART:DURATION=1.0,URI="s101.1.ts"
#EXT-X-PART:DURATION=1.0,URI="s101.2.ts"
#EXT-X-PART:DURATION=1.0,URI="s101.3.ts"
#EXTINF:4.0,
s101.ts
#EXT-X-PART:DURATION=1.0,URI="s102.0.ts",INDEPENDENT=YES
#EXT-X-PART:DURATION=1.0,URI="s102.1.ts",GAP=YES
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s102.2.ts"
#EXT-X-RENDITION-REPORT:URI="../v1/index.m3u8",LAST-MSN=101,LAST-PART=1
`

describe('parsePlaylist (LL-HLS)', () => {
  const p = parsePlaylist(LL_HLS, 'https://cdn/v0/index.m3u8')
  if (p.kind !== 'media') throw new Error('expected media playlist')

  it('reads server control and the part target', () => {
    expect(p.partTarget).toBe(1.004)
    expect(p.serverControl).toEqual({
      canBlockReload: true,
      canSkipUntil: 24,
      canSkipDateRanges: false,
      holdBack: undefined,
      partHoldBack: 3.012,
    })
  })

  it('attaches parts to their segment and keeps trailing parts as pending', () => {
    expect(p.segments.map((s) => [s.sn, s.parts?.length])).toEqual([
      [100, undefined],
      [101, 4],
    ])
    expect(p.segments[1].parts?.[0]).toEqual({
      uri: 'https://cdn/v0/s101.0.ts',
      duration: 1,
      independent: true,
      gap: false,
      byteRange: undefined,
    })
    expect(p.pendingParts.map((x) => [x.uri.split('/').pop(), x.independent, x.gap])).toEqual([
      ['s102.0.ts', true, false],
      ['s102.1.ts', false, true],
    ])
  })

  it('reads preload hints and rendition reports', () => {
    expect(p.preloadHints).toEqual([{ type: 'PART', uri: 'https://cdn/v0/s102.2.ts', byteRangeStart: undefined, byteRangeLength: undefined }])
    expect(p.renditionReports).toEqual([{ uri: 'https://cdn/v1/index.m3u8', lastMsn: 101, lastPart: 1 }])
  })

  it('numbers segments after EXT-X-SKIP from MEDIA-SEQUENCE + SKIPPED-SEGMENTS', () => {
    const delta = parsePlaylist(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-SKIP:SKIPPED-SEGMENTS=6
#EXTINF:4.0,
s106.ts`)
    if (delta.kind !== 'media') throw new Error('expected media playlist')
    expect(delta.skippedSegments).toBe(6)
    expect(delta.segments[0].sn).toBe(106)
  })
})
