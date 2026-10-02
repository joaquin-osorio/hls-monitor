import type { ErrorData } from 'hls.js'
import { describe, expect, it } from 'vitest'
import { classifyHlsError } from './errors'

function err(type: string, details: string, extra: Partial<Record<string, unknown>> = {}): ErrorData {
  return { type, details, fatal: false, error: new Error(details), ...extra } as unknown as ErrorData
}

describe('classifyHlsError', () => {
  it.each([
    [404, 'http4xx'],
    [403, 'http4xx'],
    [500, 'http5xx'],
    [503, 'http5xx'],
    [0, 'cors'],
  ])('classifies a network error with status %i as %s', (code, expected) => {
    const result = classifyHlsError(
      err('networkError', 'fragLoadError', { response: { url: 'https://cdn/seg.ts', code } }),
    )
    expect(result).toEqual({ type: expected, url: 'https://cdn/seg.ts', status: code })
  })

  it('treats a network error without a response as cors', () => {
    expect(classifyHlsError(err('networkError', 'manifestLoadError', { url: 'https://x/m.m3u8' }))).toEqual({
      type: 'cors',
      url: 'https://x/m.m3u8',
      status: undefined,
    })
  })

  it.each(['manifestLoadTimeOut', 'levelLoadTimeOut', 'fragLoadTimeOut'])('classifies %s as timeout', (details) => {
    expect(classifyHlsError(err('networkError', details))?.type).toBe('timeout')
  })

  it.each(['manifestParsingError', 'levelParsingError', 'levelEmptyError'])('classifies %s as parse', (details) => {
    expect(classifyHlsError(err('networkError', details))?.type).toBe('parse')
  })

  it('classifies demux failures as parse and buffer failures as decode', () => {
    expect(classifyHlsError(err('mediaError', 'fragParsingError'))?.type).toBe('parse')
    expect(classifyHlsError(err('mediaError', 'bufferAppendError'))?.type).toBe('decode')
    expect(classifyHlsError(err('mediaError', 'manifestIncompatibleCodecsError'))?.type).toBe('decode')
    expect(classifyHlsError(err('keySystemError', 'keySystemNoKeys'))?.type).toBe('decode')
    expect(classifyHlsError(err('muxError', 'remuxAllocError'))?.type).toBe('parse')
  })

  it.each(['bufferStalledError', 'bufferNudgeOnStall', 'fragGap', 'playlistUnchangedError'])(
    'does not log %s as an error',
    (details) => {
      expect(classifyHlsError(err('mediaError', details))).toBeNull()
    },
  )

  it('takes the url from the fragment when the event has none', () => {
    const result = classifyHlsError(
      err('networkError', 'fragLoadError', { frag: { url: 'https://cdn/7.ts' }, response: { code: 404 } }),
    )
    expect(result?.url).toBe('https://cdn/7.ts')
  })
})
