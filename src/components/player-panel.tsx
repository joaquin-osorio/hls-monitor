import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatBitrate } from '@/lib/format'
import type { ThrottleProfile } from '@/monitor/network-shaper'
import type { SourceInfo } from '@/monitor/types'

interface PlayerPanelProps {
  videoRef: (video: HTMLVideoElement | null) => void
  source: SourceInfo | null
  /** Active network simulation, shown as a badge so readings are not mistaken for the real network. */
  throttle: ThrottleProfile | null
}

const PHASE_LABEL: Record<SourceInfo['phase'], string> = {
  loading: 'Loading',
  ready: 'Playing',
  fatal: 'Stopped (fatal error)',
  unsupported: 'MSE not supported',
}

export function PlayerPanel({ videoRef, source, throttle }: PlayerPanelProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Player
          {source && (
            <>
              <Badge variant={source.phase === 'fatal' || source.phase === 'unsupported' ? 'destructive' : 'secondary'}>
                {PHASE_LABEL[source.phase]}
              </Badge>
              {source.kind && <Badge variant="outline">{source.kind} playlist</Badge>}
              {source.live !== undefined && <Badge variant="outline">{source.live ? 'LIVE' : 'VOD'}</Badge>}
            </>
          )}
          {throttle && (
            <Badge variant="destructive" title="Network simulation is on: timings and ABR reflect the simulated link">
              Throttled · {formatBitrate(throttle.downKbps * 1000)} · {throttle.latencyMs} ms
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <video ref={videoRef} className="aspect-video w-full rounded-md bg-black" controls muted autoPlay playsInline />
      </CardContent>
    </Card>
  )
}
