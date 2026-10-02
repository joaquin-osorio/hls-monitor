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
