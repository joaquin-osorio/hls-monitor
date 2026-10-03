import type { LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MonitorSession } from './session'

const mocks = vi.hoisted(() => {
  /** Responses served by the fake base loader, by URL. */
  const responses = new Map<string, string | ArrayBuffer>()

  class FakeBaseLoader {
    context: unknown = null
    stats = {}
    load(context: { url: string }, _config: unknown, callbacks: { onSuccess: (...args: unknown[]) => void }) {
      this.context = context
      const data = responses.get(context.url)
      const bytes = typeof data === 'string' ? data.length : (data?.byteLength ?? 0)
      const stats = {
        loaded: bytes,
        loading: { start: 100, first: 150, end: 300 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      }
      callbacks.onSuccess({ url: context.url, data, code: 200 }, stats, context, null)
    }
    abort() {}
    destroy() {}
  }

  class FakeHls {
    static instance: FakeHls
    static isSupported = () => true
    static DefaultConfig = { loader: FakeBaseLoader }
    handlers = new Map<string, (event: string, data: unknown) => void>()
    levels: { uri: string; width: number; height: number; attrs: Record<string, string> }[] = []
    currentLevel = -1
    loadLevel = -1
    autoLevelEnabled = true
    latency = 0
    playingDate: Date | null = null
    config: { loader: new (config: unknown) => { load: (...args: unknown[]) => void } }
    constructor(config: FakeHls['config']) {
      this.config = config
      FakeHls.instance = this
    }
    on(event: string, fn: (event: string, data: unknown) => void) {
      this.handlers.set(event, fn)
    }
    emit(event: string, data: unknown = {}) {
      this.handlers.get(event)?.(event, data)
    }
    loadSource() {}
    attachMedia() {}
    destroy() {}
  }

  const analysis = {
    packets: 3,
    syncErrors: 0,
    ccErrors: 0,
    pids: [{ pid: 256, packets: 3, ccErrors: 0 }],
    families: ['avc', 'aac'],
    streams: [{ pid: 256, streamType: 0x1b, family: 'avc', minPts: 10, maxPts: 13.9, duration: 4 }],
  }

  return { responses, FakeHls, analysis }
})

vi.mock('hls.js', () => ({
  default: mocks.FakeHls,
  Events: {
    MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_SWITCHING: 'hlsLevelSwitching',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    ERROR: 'hlsError',
  },
}))

vi.mock('./ts/ts-client', () => ({
  TsAnalyzer: class {
    isBusy = () => false
    analyze = () => Promise.resolve(mocks.analysis)
    destroy() {}
  },
}))

vi.mock('./cors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cors')>()),
  probeCors: () => Promise.resolve(true),
}))

const MASTER_URL = 'https://cdn.test/master.m3u8'
const LEVEL_URL = 'https://cdn.test/v0/index.m3u8'

function fakeVideo() {
  const video = new EventTarget() as EventTarget & Record<string, unknown>
  Object.assign(video, { seeking: false, currentTime: 0, error: null, buffered: { length: 0 } })
  return video as unknown as HTMLVideoElement
}

/** Loads `url` through the monitoring loader hls.js was configured with. */
function load(url: string, context: { type: string } & Record<string, unknown>) {
  const Loader = mocks.FakeHls.instance.config.loader
  const loader = new Loader({})
  const callbacks = { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() } as unknown as LoaderCallbacks<LoaderContext>
  loader.load({ url, responseType: 'text', ...context } as unknown as LoaderContext, {} as LoaderConfiguration, callbacks)
}

function tsSegment(): ArrayBuffer {
  const data = new Uint8Array(188 * 3)
  for (let i = 0; i < 3; i++) data[i * 188] = 0x47
  return data.buffer
}

describe('MonitorSession', () => {
  let session: MonitorSession
  let video: HTMLVideoElement

  const snapshot = () => {
    vi.advanceTimersByTime(1000)
    return session.store.getSnapshot()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
    mocks.responses.clear()
    video = fakeVideo()
  })

  afterEach(() => {
    session.destroy()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('tracks master and live media playlists from loader traffic', () => {
    session = new MonitorSession(MASTER_URL, video)
    mocks.responses.set(MASTER_URL, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nv0/index.m3u8\n')
    mocks.responses.set(
      LEVEL_URL,
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:20\n#EXTINF:4,\na.ts\n#EXT-X-GAP\n#EXTINF:4,\nb.ts\n',
    )
    load(MASTER_URL, { type: 'manifest' })
    load(LEVEL_URL, { type: 'level', level: 0 })

    const snap = snapshot()
    expect(snap.source).toMatchObject({ kind: 'master', live: true })
    expect(snap.findings.map((f) => f.checkId)).toEqual(['codecs-missing'])
    expect(snap.playlists).toEqual([expect.objectContaining({ key: 'main:0', url: LEVEL_URL, mediaSequence: 20, lastSn: 21 })])
    expect(snap.segments).toEqual([expect.objectContaining({ sn: 21, status: 'gap', gapReason: 'tag' })])
  })

  it('records segment metrics and flags codecs found in TS but not declared', async () => {
    session = new MonitorSession(MASTER_URL, video)
    mocks.FakeHls.instance.levels = [{ uri: LEVEL_URL, width: 640, height: 360, attrs: { BANDWIDTH: '800000', CODECS: 'avc1.4d401e' } }]
    mocks.FakeHls.instance.emit('hlsManifestParsed')
    mocks.responses.set('https://cdn.test/v0/a.ts', tsSegment())
    load('https://cdn.test/v0/a.ts', {
      type: 'media-fragment',
      responseType: 'arraybuffer',
      frag: { sn: 20, level: 0, type: 'main', duration: 4 },
    })
    await vi.waitFor(() => expect(snapshot().segments[0]?.codecs).toEqual(['avc', 'aac']))

    const snap = snapshot()
    expect(snap.segments[0]).toMatchObject({ status: 'ok', ttfbMs: 50, totalMs: 200, ratio: 0.05 })
    expect(snap.variants[0]).toMatchObject({ index: 0, width: 640, bandwidth: 800000, detectedCodecs: ['avc', 'aac'] })
    expect(snap.variants[0].measuredBitrate).toBeCloseTo((188 * 3 * 8) / 4)
    expect(snap.findings).toEqual([expect.objectContaining({ checkId: 'codecs-undeclared' })])
  })

  it('logs typed errors, marks fatal ones and confirms CORS with a probe', async () => {
    session = new MonitorSession(MASTER_URL, video)
    mocks.FakeHls.instance.emit('hlsError', {
      type: 'networkError',
      details: 'manifestLoadError',
      fatal: true,
      url: MASTER_URL,
      response: { code: 0 },
      errorAction: { retryCount: 2 },
      error: new Error('Network error'),
    })
    mocks.FakeHls.instance.emit('hlsError', { type: 'mediaError', details: 'bufferStalledError', fatal: false })

    await vi.waitFor(() => expect(snapshot().errors[0]?.corsConfirmed).toBe(true))
    const snap = snapshot()
    expect(snap.errors).toEqual([expect.objectContaining({ type: 'cors', fatal: true, retries: 2, url: MASTER_URL })])
    expect(snap.source).toMatchObject({ phase: 'fatal', fatal: expect.objectContaining({ corsConfirmed: true }) })
  })

  it('measures stalls after playback started, ignoring startup and seeks', () => {
    session = new MonitorSession(MASTER_URL, video)
    video.dispatchEvent(new Event('waiting')) // startup: ignored
    video.dispatchEvent(new Event('playing'))
    video.dispatchEvent(new Event('waiting'))
    vi.advanceTimersByTime(1500)
    video.dispatchEvent(new Event('playing'))
    ;(video as unknown as { seeking: boolean }).seeking = true
    video.dispatchEvent(new Event('waiting')) // seek: ignored

    const stalls = snapshot().stalls
    expect(stalls).toHaveLength(1)
    expect(stalls[0].durationMs).toBeCloseTo(1500, -1)
  })

  it('samples live latency only once playback has started', () => {
    session = new MonitorSession(MASTER_URL, video)
    const hls = mocks.FakeHls.instance
    hls.latency = 600 // bogus value hls.js reports while currentTime is still 0
    mocks.responses.set(LEVEL_URL, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n')
    load(LEVEL_URL, { type: 'level', level: 0 })
    vi.advanceTimersByTime(600)
    expect(snapshot().samples.at(-1)?.liveEdgeDistance).toBeUndefined()

    hls.latency = 8
    video.dispatchEvent(new Event('playing'))
    expect(snapshot().samples.at(-1)?.liveEdgeDistance).toBe(8)
  })

  it('tracks LL-HLS parts and keys findings by the playlist URL without delivery directives', () => {
    session = new MonitorSession(MASTER_URL, video)
    const ll = (msn: number) =>
      `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PART-INF:PART-TARGET=1\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES\n#EXT-X-MEDIA-SEQUENCE:${msn}\n#EXTINF:4,\ns${msn}.ts\n#EXT-X-PART:DURATION=1,URI="p.ts"\n`
    for (const msn of [10, 11]) {
      const url = `${LEVEL_URL}?_HLS_msn=${msn + 1}&_HLS_part=0`
      mocks.responses.set(url, ll(msn))
      load(url, { type: 'level', level: 0 })
    }
    mocks.responses.set('https://cdn.test/v0/s12.0.ts', tsSegment())
    load('https://cdn.test/v0/s12.0.ts', {
      type: 'media-fragment',
      responseType: 'arraybuffer',
      frag: { sn: 12, level: 0, type: 'main', duration: 1 },
      part: { index: 0, duration: 1, independent: true },
    })

    const snap = snapshot()
    expect(snap.findings.filter((f) => f.checkId === 'll-server-control')).toEqual([
      expect.objectContaining({ key: `ll-server-control|part-hold-back-missing|${LEVEL_URL}`, count: 1 }),
    ])
    expect(snap.playlists.at(-1)?.ll).toMatchObject({ partTarget: 1, blocking: { msn: 12, part: 0, satisfied: true } })
    expect(snap.parts).toEqual([expect.objectContaining({ key: 'main:0:12.0', independent: true })])
    expect(snap.segments).toEqual([expect.objectContaining({ sn: 12, attempts: 0, partsLoaded: 1 })])
  })

  it('samples frame counters and the playing level', () => {
    session = new MonitorSession(MASTER_URL, video)
    mocks.FakeHls.instance.currentLevel = 2
    Object.assign(video, { getVideoPlaybackQuality: () => ({ droppedVideoFrames: 3, totalVideoFrames: 120 }) })
    vi.advanceTimersByTime(600)
    expect(snapshot().samples.at(-1)).toMatchObject({ droppedFrames: 3, totalFrames: 120, level: 2 })
  })

  it('applies the requested variant once levels are known and rejects invalid ones', () => {
    const onVariantRejected = vi.fn()
    session = new MonitorSession(MASTER_URL, video, { variant: 5, onVariantRejected })
    const hls = mocks.FakeHls.instance
    hls.levels = [
      { uri: 'a', width: 0, height: 0, attrs: {} },
      { uri: 'b', width: 0, height: 0, attrs: {} },
    ]
    hls.emit('hlsManifestParsed')
    expect(onVariantRejected).toHaveBeenCalledOnce()
    expect(hls.loadLevel).toBe(-1)

    session.setVariant(1)
    expect(hls.currentLevel).toBe(1)
  })
})
