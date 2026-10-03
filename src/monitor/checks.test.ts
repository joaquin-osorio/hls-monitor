import { describe, expect, it } from 'vitest'
import { checkDetectedCodecs, checkMasterPlaylist, checkMediaPlaylist, checkSegmentDuration, checkTsContinuity, FindingsLog } from './checks'
import { familyOfCodecString } from './codecs'
import { PlaylistHealthTracker } from './playlist/health'
import { type MediaPlaylist, parsePlaylist } from './playlist/parse'

const URL = 'https://cdn/live.m3u8'

function media(text: string): MediaPlaylist {
  const p = parsePlaylist(text)
  if (p.kind !== 'media') throw new Error('expected media playlist')
  return p
}

describe('checkMediaPlaylist', () => {
  it('flags EXTINF that rounds above TARGETDURATION, but not one that rounds down to it', () => {
    const p = media(`#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.4,
ok.ts
#EXTINF:6.6,
bad.ts
#EXT-X-ENDLIST`)
    const obs = checkMediaPlaylist(p, URL)
    expect(obs).toHaveLength(1)
    expect(obs[0]).toMatchObject({ checkId: 'target-exceeded', severity: 'error', occurrence: 1 })
  })

  it('reports each discontinuity as info', () => {
    const p = media(`#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4,
a.ts
#EXT-X-DISCONTINUITY
#EXTINF:4,
b.ts`)
    expect(checkMediaPlaylist(p, URL)).toEqual([
      expect.objectContaining({ checkId: 'discontinuity', severity: 'info', occurrence: 1 }),
    ])
  })

  it('reports ENDLIST appearing on a live playlist', () => {
    const tracker = new PlaylistHealthTracker()
    const before = media('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts')
    const after = media('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST')
    tracker.track('main:0', URL, before, 0)
    const refresh = tracker.track('main:0', URL, after, 4000)
    expect(checkMediaPlaylist(after, URL, refresh).map((o) => o.checkId)).toEqual(['endlist-in-live'])
  })
})

describe('checkMasterPlaylist', () => {
  it('flags variants without CODECS', () => {
    const p = parsePlaylist(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d401e"
a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2
b.m3u8`)
    if (p.kind !== 'master') throw new Error('expected master')
    expect(checkMasterPlaylist(p, URL)).toEqual([
      expect.objectContaining({ checkId: 'codecs-missing', message: '1 of 2 variants have no CODECS attribute' }),
    ])
  })
})

describe('checkDetectedCodecs', () => {
  it('flags families present in segments but missing from CODECS', () => {
    expect(checkDetectedCodecs('v.m3u8', ['avc1.64001f'], ['avc', 'aac'])).toEqual([
      expect.objectContaining({ checkId: 'codecs-undeclared', severity: 'error' }),
    ])
  })

  it('accepts declared families regardless of profile, and skips variants without CODECS', () => {
    expect(checkDetectedCodecs('v.m3u8', ['avc3.4d401e', 'mp4a.40.5'], ['avc', 'aac'])).toEqual([])
    expect(checkDetectedCodecs('v.m3u8', undefined, ['avc'])).toEqual([])
  })
})

describe('familyOfCodecString', () => {
  it.each([
    ['avc1.640028', 'avc'],
    ['hev1.1.6.L93.B0', 'hevc'],
    ['mp4a.40.2', 'aac'],
    ['mp4a.40.34', 'mp3'],
    ['ac-3', 'ac3'],
    ['ec-3', 'eac3'],
    ['wvtt', undefined],
  ])('%s → %s', (codec, family) => {
    expect(familyOfCodecString(codec)).toBe(family)
  })
})

describe('FindingsLog', () => {
  it('counts distinct occurrences and ignores repeats from later refreshes', () => {
    const log = new FindingsLog()
    const obs = (sn: number) => ({
      checkId: 'target-exceeded' as const,
      key: 'k',
      severity: 'error' as const,
      message: `seg ${sn}`,
      occurrence: sn,
    })
    expect(log.recordAll([obs(5), obs(7)], 100)).toBe(true)
    expect(log.recordAll([obs(5), obs(7)], 200)).toBe(false) // same segments on the next refresh
    expect(log.record(obs(9), 300)).toBe(true)
    expect(log.list()).toEqual([
      expect.objectContaining({ count: 3, firstSeen: 100, lastSeen: 300, message: 'seg 9' }),
    ])
  })

  it('records a non-occurrence finding once', () => {
    const log = new FindingsLog()
    const obs = { checkId: 'codecs-missing' as const, key: 'm', severity: 'warn' as const, message: 'x' }
    expect(log.record(obs, 1)).toBe(true)
    expect(log.record(obs, 2)).toBe(false)
    expect(log.list()[0].count).toBe(1)
  })
})

describe('checkTsContinuity', () => {
  it('reports one observation per PID with continuity errors, keyed per level and PID', () => {
    const analysis = {
      pids: [
        { pid: 0, packets: 1, ccErrors: 0 },
        { pid: 256, packets: 900, ccErrors: 2 },
      ],
      streams: [{ pid: 256, streamType: 0x1b }],
    }
    expect(checkTsContinuity('main', 1, 42, 'https://cdn/s42.ts', analysis)).toEqual([
      {
        checkId: 'ts-continuity',
        key: 'ts-continuity|main:1|256',
        severity: 'error',
        message: 'main 1 · PID 0x0100 (H.264): 2 continuity errors in segment 42',
        occurrence: 42,
        url: 'https://cdn/s42.ts',
      },
    ])
  })
})

describe('checkSegmentDuration', () => {
  it('warns only when the measured duration is off by more than 100 ms', () => {
    expect(checkSegmentDuration('main', 0, 7, 'u', 6.006, 6.0)).toEqual([])
    expect(checkSegmentDuration('main', 0, 7, 'u', 6, undefined)).toEqual([])
    expect(checkSegmentDuration('main', 0, 7, 'u', 6, 5.5)).toEqual([
      expect.objectContaining({ checkId: 'extinf-mismatch', key: 'extinf-mismatch|main:0', severity: 'warn', occurrence: 7 }),
    ])
  })
})
