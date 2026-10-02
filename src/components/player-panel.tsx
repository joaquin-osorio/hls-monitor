import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { SourceInfo } from '@/monitor/types'

interface PlayerPanelProps {
  videoRef: (video: HTMLVideoElement | null) => void
  source: SourceInfo | null
}

const PHASE_LABEL: Record<SourceInfo['phase'], string> = {
  loading: 'Loading',
  ready: 'Playing',
  fatal: 'Stopped (fatal error)',
  unsupported: 'MSE not supported',
}

export function PlayerPanel({ videoRef, source }: PlayerPanelProps) {
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
        </CardTitle>
      </CardHeader>
      <CardContent>
        <video ref={videoRef} className="aspect-video w-full rounded-md bg-black" controls muted autoPlay playsInline />
      </CardContent>
    </Card>
  )
}
