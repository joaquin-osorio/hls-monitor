import { describe, expect, it } from 'vitest'
import { alignmentObservations, buildAlignmentReport, compareVariants } from './alignment'
import { type MediaPlaylist, parsePlaylist } from './playlist/parse'

interface Seg {
  d?: number
  disc?: boolean
  pdt?: string
}

function media(msn: number, segs: Seg[], endList = true): MediaPlaylist {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${msn}`]
  segs.forEach((s, i) => {
    if (s.disc) lines.push('#EXT-X-DISCONTINUITY')
    if (s.pdt) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${s.pdt}`)
    lines.push(`#EXTINF:${s.d ?? 6},`, `s${msn + i}.ts`)
  })
  if (endList) lines.push('#EXT-X-ENDLIST')
  const p = parsePlaylist(lines.join('\n'))
  if (p.kind !== 'media') throw new Error('expected media playlist')
  return p
}

const noPts = new Map<number, Map<number, number>>()
const three = (): Seg[] => [{}, {}, {}]

describe('compareVariants', () => {
  it('finds nothing when variants are aligned', () => {
    const byLevel = new Map([
      [0, media(0, three())],
      [1, media(0, three())],
    ])
    expect(compareVariants(byLevel, noPts, false)).toEqual({ issues: [], comparedSns: 3 })
  })

  it('flags EXTINF and discontinuity differences per SN, against the lowest level', () => {
    const byLevel = new Map([
      [0, media(0, three())],
      [1, media(0, [{}, { d: 5.5 }, {}])],
      [2, media(0, [{}, {}, { disc: true }])],
    ])
    const { issues } = compareVariants(byLevel, noPts, false)
    // Level 1 lasts 17.5 s instead of 18 s: within the 1 s window tolerance, so no window issue.
    expect(issues.map((i) => [i.kind, i.sn, i.levels])).toEqual([
      ['extinf', 1, [1]],
      ['discontinuity', 2, [2]],
    ])
  })

  it('flags PDT drift and start-PTS differences from analyzed segments', () => {
    const byLevel = new Map([
      [0, media(10, [{ pdt: '2026-01-01T00:00:00.000Z' }, {}], false)],
      [1, media(10, [{ pdt: '2026-01-01T00:00:00.500Z' }, {}], false)],
    ])
    const pts = new Map([[10, new Map([[0, 100], [1, 100.04]])], [11, new Map([[0, 106], [1, 106.3]])]])
    const { issues } = compareVariants(byLevel, pts, true)
    expect(issues.map((i) => [i.kind, i.sn, i.levels])).toEqual([
      ['pdt', 10, [1]],
      ['pdt', 11, [1]],
      ['pts', 11, [1]],
    ])
  })

  it('only compares SNs every live variant lists', () => {
    const byLevel = new Map([
      [0, media(10, three(), false)],
      [1, media(11, three(), false)],
    ])
    expect(compareVariants(byLevel, noPts, true)).toEqual({ issues: [], comparedSns: 2 })
  })

  it('flags VOD variants with different SN ranges or total duration', () => {
    const byLevel = new Map([
      [0, media(0, three())],
      [1, media(0, [{}, {}])],
    ])
    expect(compareVariants(byLevel, noPts, false).issues.map((i) => [i.kind, i.levels])).toEqual([
      ['window', [1]],
      ['window', [1]],
    ])
  })

  it('flags live variants that share no SN at all', () => {
    const byLevel = new Map([
      [0, media(0, three(), false)],
      [1, media(500, three(), false)],
    ])
    expect(compareVariants(byLevel, noPts, true).issues).toEqual([expect.objectContaining({ kind: 'window', levels: [1] })])
  })
})

describe('buildAlignmentReport', () => {
  it('summarizes each variant, reports fetch errors and derives findings', () => {
    const text = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n#EXT-X-ENDLIST\n'
    const report = buildAlignmentReport(
      [
        { level: 0, uri: 'https://cdn/0.m3u8', text },
        { level: 1, uri: 'https://cdn/1.m3u8', text: text.replace('#EXTINF:6,\nb.ts', '#EXTINF:4,\nb.ts') },
        { level: 2, uri: 'https://cdn/2.m3u8', error: 'HTTP 403' },
      ],
      noPts,
      1234,
      3,
    )
    expect(report).toMatchObject({ t: 1234, live: false, requests: 3, comparedSns: 2 })
    expect(report.variants.map((v) => [v.level, v.segments, v.durationS, v.error])).toEqual([
      [0, 2, 12, undefined],
      [1, 2, 10, undefined],
      [2, 0, 0, 'HTTP 403'],
    ])
    expect(alignmentObservations(report).map((o) => [o.key, o.severity, o.occurrence])).toEqual([
      ['variant-alignment|window', 'error', undefined],
      ['variant-alignment|extinf', 'error', 1],
      ['variant-alignment|fetch|https://cdn/2.m3u8', 'info', undefined],
    ])
  })
})
