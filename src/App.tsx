import { useState } from 'react'
import { BufferPanel } from '@/components/buffer-panel'
import { CorsBanner } from '@/components/cors-banner'
import { DroppedFramesPanel } from '@/components/dropped-frames-panel'
import { ErrorLog } from '@/components/error-log'
import { LatencyPanel } from '@/components/latency-panel'
import { NetworkTable } from '@/components/network-table'
import { PlayerPanel } from '@/components/player-panel'
import { PlaylistHealthPanel } from '@/components/playlist-health-panel'
import { SegmentTimeline } from '@/components/segment-timeline'
import { SpecChecksPanel } from '@/components/spec-checks-panel'
import { UrlForm } from '@/components/url-form'
import { VariantsPanel } from '@/components/variants-panel'
import { useMonitor } from '@/hooks/use-monitor'
import { useQueryState } from '@/hooks/use-query-state'

const SAMPLE_STREAMS = [
  { label: 'VOD · TS · multi-variant (Mux)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  {
    label: 'VOD · TS · Apple advanced',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
  },
  { label: 'LIVE · Unified Streaming', url: 'https://demo.unified-streaming.com/k8s/live/scte35.isml/.m3u8' },
]

function App() {
  const [query, setQuery] = useQueryState()
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const { snapshot } = useMonitor(query.url, video, query.variant, () => setQuery({ variant: 'auto' }))

  const load = (url: string) => setQuery({ url, variant: 'auto' }, 'push')

  return (
    <div className="mx-auto flex max-w-screen-2xl flex-col gap-4 p-4">
      <header className="flex flex-col gap-3 md:flex-row md:items-center">
        <h1 className="shrink-0 font-heading text-lg font-semibold">HLS Monitor</h1>
        <UrlForm key={query.url ?? ''} initialUrl={query.url ?? ''} onSubmit={load} />
      </header>

      {!query.url && (
        <section className="text-muted-foreground text-sm">
          <p>Paste a master or media playlist URL, or try one of these:</p>
          <ul className="mt-2 flex flex-col gap-1">
            {SAMPLE_STREAMS.map((s) => (
              <li key={s.url}>
                <button type="button" className="text-foreground underline underline-offset-4" onClick={() => load(s.url)}>
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snapshot && <CorsBanner source={snapshot.source} />}

      {/* Always mounted so the <video> element survives URL changes. */}
      <div className={query.url ? 'flex flex-col gap-4' : 'hidden'}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <PlayerPanel videoRef={setVideo} source={snapshot?.source ?? null} />
          {snapshot && (
            <div className="flex flex-col gap-4">
              <BufferPanel samples={snapshot.samples} stalls={snapshot.stalls} />
              <LatencyPanel samples={snapshot.samples} live={snapshot.source.live} />
              <DroppedFramesPanel samples={snapshot.samples} />
            </div>
          )}
        </div>
        {snapshot && (
          <>
            <VariantsPanel
              variants={snapshot.variants}
              selection={snapshot.selection}
              requested={query.variant}
              onSelect={(variant) => setQuery({ variant })}
            />
            <SegmentTimeline segments={snapshot.segments} />
            <div className="grid gap-4 xl:grid-cols-2">
              <NetworkTable segments={snapshot.segments} />
              <PlaylistHealthPanel playlists={snapshot.playlists} />
            </div>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <SpecChecksPanel findings={snapshot.findings} />
              <ErrorLog errors={snapshot.errors} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default App
