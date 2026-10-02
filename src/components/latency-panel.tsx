import { memo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { ChartConfig } from '@/components/ui/chart'
import { formatSeconds } from '@/lib/format'
import type { Sample } from '@/monitor/types'
import { TimeSeriesChart } from './time-series-chart'

const config = {
  liveEdgeDistance: { label: 'Behind live edge', color: 'var(--chart-1)' },
  pdtLatency: { label: 'Latency vs PDT', color: 'var(--chart-2)' },
} satisfies ChartConfig

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-lg tabular-nums" title={hint}>
        {value}
      </span>
    </div>
  )
}

export const LatencyPanel = memo(function LatencyPanel({ samples, live }: { samples: Sample[]; live: boolean | undefined }) {
  const last = samples.at(-1)
  const hasPdt = samples.some((s) => s.pdtLatency !== undefined)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Live latency</CardTitle>
        <CardDescription>
          PDT latency = wall clock − PROGRAM-DATE-TIME at the playhead. It depends on this computer's clock being in sync.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!live ? (
          <p className="text-muted-foreground">Only available for live streams.</p>
        ) : (
          <>
            <div className="flex gap-8">
              <Stat label="Behind live edge" value={formatSeconds(last?.liveEdgeDistance)} />
              <Stat
                label="Latency vs PDT"
                value={hasPdt ? formatSeconds(last?.pdtLatency) : 'no PDT'}
                hint={hasPdt ? undefined : 'The playlist has no EXT-X-PROGRAM-DATE-TIME'}
              />
            </div>
            <TimeSeriesChart
              data={samples}
              config={config}
              series={hasPdt ? ['liveEdgeDistance', 'pdtLatency'] : ['liveEdgeDistance']}
              unit="s"
            />
          </>
        )}
      </CardContent>
    </Card>
  )
})
