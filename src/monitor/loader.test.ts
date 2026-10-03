import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from 'hls.js'
import { describe, expect, it, vi } from 'vitest'
import { createMonitoringLoader, extractHeaders, type LoaderSink } from './loader'

function stats(start: number, first: number, end: number, loaded: number): LoaderStats {
  return {
    aborted: false,
    loaded,
    retry: 0,
    total: loaded,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start, first, end },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  }
}

/** Base loader whose `load` hands its callbacks to the test. */
class FakeLoader implements Loader<LoaderContext> {
  static last: FakeLoader
  context: LoaderContext | null = null
  stats = stats(0, 0, 0, 0)
  callbacks!: LoaderCallbacks<LoaderContext>
  constructor() {
    FakeLoader.last = this
  }
  load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    this.context = context
    this.callbacks = callbacks
  }
  abort() {}
  destroy() {}
}

function setup() {
  const sink = {
    onRequest: vi.fn<LoaderSink['onRequest']>(),
    onPlaylist: vi.fn<LoaderSink['onPlaylist']>(),
    onTsSegment: vi.fn<LoaderSink['onTsSegment']>(),
  }
  const Monitoring = createMonitoringLoader(FakeLoader, sink)
  const loader = new Monitoring({} as HlsConfig)
  const hlsCallbacks = { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() }
  return { sink, loader, hlsCallbacks }
}

const fragContext = (url = 'https://cdn/seg7.ts') =>
  ({
    url,
    type: 'media-fragment',
    responseType: 'arraybuffer',
    frag: { sn: 7, level: 2, type: 'main', duration: 4 },
    part: null,
  }) as unknown as LoaderContext

function tsBytes(packets = 4): ArrayBuffer {
  const data = new Uint8Array(188 * packets)
  for (let i = 0; i < packets; i++) data[i * 188] = 0x47
  return data.buffer
}

describe('createMonitoringLoader', () => {
  it('records fragment timings and hands TS bytes to the sink as a private copy', () => {
    const { sink, loader, hlsCallbacks } = setup()
    loader.load(fragContext(), {} as LoaderConfiguration, hlsCallbacks)
    const bytes = tsBytes()
    FakeLoader.last.callbacks.onSuccess({ url: 'https://cdn/seg7.ts', data: bytes, code: 200 }, stats(100, 150, 400, 752), FakeLoader.last.context!, null)

    expect(sink.onRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'fragment',
        outcome: 'success',
        status: 200,
        start: 100,
        first: 150,
        end: 400,
        bytes: 752,
        sn: 7,
        level: 2,
        track: 'main',
        duration: 4,
      }),
    )
    const copy = sink.onTsSegment.mock.calls[0][1]
    const copied = copy()
    expect(copied).not.toBe(bytes)
    expect(new Uint8Array(copied)).toEqual(new Uint8Array(bytes))
    // hls.js still receives the original response.
    expect(hlsCallbacks.onSuccess.mock.calls[0][0].data).toBe(bytes)
  })

  it('does not offer non-TS fragments to the analyzer', () => {
    const { sink, loader, hlsCallbacks } = setup()
    loader.load(fragContext('https://cdn/seg.m4s'), {} as LoaderConfiguration, hlsCallbacks)
    FakeLoader.last.callbacks.onSuccess({ url: '', data: new ArrayBuffer(1000), code: 200 }, stats(0, 1, 2, 1000), FakeLoader.last.context!, null)
    expect(sink.onRequest).toHaveBeenCalledOnce()
    expect(sink.onTsSegment).not.toHaveBeenCalled()
  })

  it('passes playlist text to the sink', () => {
    const { sink, loader, hlsCallbacks } = setup()
    const context = { url: 'https://cdn/m.m3u8', type: 'manifest', responseType: 'text' } as LoaderContext
    loader.load(context, {} as LoaderConfiguration, hlsCallbacks)
    FakeLoader.last.callbacks.onSuccess({ url: context.url, data: '#EXTM3U', code: 200 }, stats(0, 5, 10, 7), context, null)
    expect(sink.onPlaylist).toHaveBeenCalledWith(expect.objectContaining({ kind: 'manifest' }), '#EXTM3U', context)
  })

  it('records failed and timed-out attempts and still notifies hls.js', () => {
    const { sink, loader, hlsCallbacks } = setup()
    loader.load(fragContext(), {} as LoaderConfiguration, hlsCallbacks)
    const ctx = FakeLoader.last.context!
    FakeLoader.last.callbacks.onError({ code: 404, text: 'Not Found' }, ctx, null, stats(10, 20, 30, 0))
    FakeLoader.last.callbacks.onTimeout(stats(40, 0, 0, 0), ctx, null)

    expect(sink.onRequest.mock.calls.map(([r]) => [r.outcome, r.status])).toEqual([
      ['error', 404],
      ['timeout', undefined],
    ])
    expect(hlsCallbacks.onError).toHaveBeenCalledOnce()
    expect(hlsCallbacks.onTimeout).toHaveBeenCalledOnce()
  })

  it('records the response headers of fragments', () => {
    const { sink, loader, hlsCallbacks } = setup()
    loader.load(fragContext(), {} as LoaderConfiguration, hlsCallbacks)
    const xhr = { getAllResponseHeaders: () => 'Content-Type: video/mp2t\r\nCache-Control: max-age=60\r\n' } as unknown as XMLHttpRequest
    FakeLoader.last.callbacks.onSuccess({ url: '', data: tsBytes(), code: 200 }, stats(0, 1, 2, 3), FakeLoader.last.context!, xhr)
    expect(sink.onRequest.mock.calls[0][0].headers).toEqual([
      ['content-type', 'video/mp2t'],
      ['cache-control', 'max-age=60'],
    ])
  })

  it('keeps playback going when the sink throws', () => {
    const { sink, loader, hlsCallbacks } = setup()
    sink.onRequest.mockImplementation(() => {
      throw new Error('boom')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    loader.load(fragContext(), {} as LoaderConfiguration, hlsCallbacks)
    FakeLoader.last.callbacks.onSuccess({ url: '', data: tsBytes(), code: 200 }, stats(0, 1, 2, 3), FakeLoader.last.context!, null)
    expect(hlsCallbacks.onSuccess).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })
})

describe('extractHeaders', () => {
  it('reads headers from an XHR, a fetch Response, or nothing', () => {
    expect(extractHeaders({ getAllResponseHeaders: () => 'Age: 12\r\nX-Cache: HIT' })).toEqual([
      ['age', '12'],
      ['x-cache', 'HIT'],
    ])
    expect(extractHeaders({ headers: new Headers({ 'Content-Length': '10' }) })).toEqual([['content-length', '10']])
    expect(extractHeaders(null)).toBeUndefined()
    expect(extractHeaders({ getAllResponseHeaders: () => '' })).toBeUndefined()
  })
})
