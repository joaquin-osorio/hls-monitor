import { describe, expect, it } from 'vitest'
import type { CheckObservation } from '../checks'
import type { RequestRecord } from '../loader'
import { blockingSatisfied, checkLlHls, LlHlsTracker, summarizeLl } from './ll-hls'
import { type MediaPlaylist, parsePlaylist } from './parse'

const URL = 'https://cdn/v0/index.m3u8'

interface Options {
  msn?: number
  /** Complete segments listed, each with 4 parts of `partDuration`. */
  segments?: number
  pending?: number
  hint?: boolean
  partDuration?: number
  serverControl?: string
}

/** LL-HLS playlist: segments `msn..msn+segments-1` with parts, then `pending` parts of the next one. */
function ll({ msn = 100, segments = 2, pending = 2, hint = true, partDuration = 1, serverControl = 'CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=3' }: Options = {}): MediaPlaylist {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', `#EXT-X-SERVER-CONTROL:${serverControl}`, '#EXT-X-PART-INF:PART-TARGET=1', `#EXT-X-MEDIA-SEQUENCE:${msn}`]
  for (let s = msn; s < msn + segments; s++) {
    for (let p = 0; p < 4; p++) lines.push(`#EXT-X-PART:DURATION=${partDuration},URI="s${s}.${p}.ts"`)
    lines.push('#EXTINF:4,', `s${s}.ts`)
  }
  const next = msn + segments
  for (let p = 0; p < pending; p++) lines.push(`#EXT-X-PART:DURATION=${partDuration},URI="s${next}.${p}.ts"`)
  if (hint) lines.push(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="s${next}.${pending}.ts"`)
  const p = parsePlaylist(lines.join('\n'), URL)
  if (p.kind !== 'media') throw new Error('expected media playlist')
  return p
}

function playlistRecord(url: string, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return { kind: 'level', url, outcome: 'success', status: 200, start: 0, first: 700, end: 720, bytes: 1000, ...overrides }
}

describe('blockingSatisfied', () => {
  const p = ll({ msn: 100, segments: 2, pending: 2 }) // complete 100-101, parts 0-1 of 102
  it('accepts a response containing the requested segment or part', () => {
    expect(blockingSatisfied(p, 101, undefined)).toBe(true)
    expect(blockingSatisfied(p, 102, 1)).toBe(true)
  })
  it('rejects a response that stops before the requested part', () => {
    expect(blockingSatisfied(p, 102, 2)).toBe(false)
    expect(blockingSatisfied(p, 102, undefined)).toBe(false)
  })
})

describe('summarizeLl', () => {
  it('summarizes parts and measures the hold time of a blocking reload', () => {
    const p = ll()
    const summary = summarizeLl(p, playlistRecord(URL, { blocking: { msn: 102, part: 1 } }), { fulfilled: 3, unfulfilled: 0 })
    expect(summary).toMatchObject({
      partTarget: 1,
      partCount: 10,
      pendingParts: 2,
      blocking: { msn: 102, part: 1, holdMs: 700, satisfied: true },
      hintsFulfilled: 3,
    })
  })

  it('returns undefined for a regular playlist', () => {
    const p = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n')
    if (p.kind !== 'media') throw new Error()
    expect(summarizeLl(p, playlistRecord(URL), { fulfilled: 0, unfulfilled: 0 })).toBeUndefined()
  })
})

describe('LlHlsTracker', () => {
  it('counts a hint as fulfilled once it is published as a part', () => {
    const tracker = new LlHlsTracker()
    tracker.observe('main:0', ll({ pending: 2 })) // hints s102.2
    expect(tracker.observe('main:0', ll({ pending: 3 }))).toMatchObject({ fulfilled: 1, unfulfilled: 0 })
  })

  it('counts a hint as unfulfilled when its segment is published without it', () => {
    const tracker = new LlHlsTracker()
    tracker.observe('main:0', ll({ pending: 2 })) // hints s102.2
    const next = ll({ pending: 3 })
    next.pendingParts[2] = { ...next.pendingParts[2], uri: 'https://cdn/v0/other.ts' }
    const result = tracker.observe('main:0', next)
    expect(result).toMatchObject({ fulfilled: 0, unfulfilled: 1 })
    expect(result.newlyUnfulfilled).toEqual([{ uri: 'https://cdn/v0/s102.2.ts', sn: 102 }])
  })

  it('gives no verdict when the hinted segment no longer lists parts', () => {
    const tracker = new LlHlsTracker()
    tracker.observe('main:0', ll({ msn: 100, pending: 2 }))
    const later = ll({ msn: 110, pending: 1 })
    expect(tracker.observe('main:0', later)).toMatchObject({ fulfilled: 0, unfulfilled: 0 })
  })
})

describe('checkLlHls', () => {
  /** `checkId|issue` of each observation. */
  const ids = (obs: CheckObservation[]) => obs.map((o) => o.key.split('|').slice(0, 2).join('|'))

  it('passes a well-formed LL-HLS playlist', () => {
    expect(checkLlHls(ll(), URL, undefined)).toEqual([])
  })

  it('flags parts longer than PART-TARGET', () => {
    const obs = checkLlHls(ll({ partDuration: 1.2, segments: 1, pending: 0 }), URL, undefined)
    expect(obs.map((o) => [o.checkId, o.occurrence])).toEqual([
      ['ll-part-target', 100_000],
      ['ll-part-target', 100_001],
      ['ll-part-target', 100_002],
      ['ll-part-target', 100_003],
    ])
  })

  it('flags server control problems', () => {
    expect(ids(checkLlHls(ll({ serverControl: 'PART-HOLD-BACK=1.5,HOLD-BACK=6' }), URL, undefined))).toEqual([
      'll-server-control|hold-back',
      'll-server-control|block-reload',
      'll-server-control|part-hold-back',
    ])
    expect(ids(checkLlHls(ll({ serverControl: 'CAN-BLOCK-RELOAD=YES' }), URL, undefined))).toEqual([
      'll-server-control|part-hold-back-missing',
    ])
  })

  it('flags unsatisfied blocking reloads and unfulfilled hints', () => {
    const p = ll()
    const summary = summarizeLl(p, playlistRecord(URL, { blocking: { msn: 103 } }), { fulfilled: 0, unfulfilled: 1 })
    expect(ids(checkLlHls(p, URL, summary, [{ uri: 'x', sn: 102 }]))).toEqual([
      'll-blocking-reload|https://cdn/v0/index.m3u8',
      'll-preload-hint|https://cdn/v0/index.m3u8',
    ])
  })
})
