import { memo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { ChartConfig } from '@/components/ui/chart'
import { formatClock, formatMs, formatSeconds } from '@/lib/format'
import type { Sample, Stall } from '@/monitor/types'
import { type Band, TimeSeriesChart } from './time-series-chart'

const config = {
  bufferAhead: { label: 'Buffer ahead', color: 'var(--chart-1)' },
} satisfies ChartConfig

interface BufferPanelProps {
  samples: Sample[]
  stalls: Stall[]
}

export const BufferPanel = memo(function BufferPanel({ samples, stalls }: BufferPanelProps) {
  const lastT = samples.at(-1)?.t ?? 0
  // Ongoing stalls extend to the latest sample.
  const bands: Band[] = stalls.map((s) => ({ from: s.t, to: s.durationMs !== undefined ? s.t + s.durationMs : lastT }))
  const finished = stalls.filter((s) => s.durationMs !== undefined)
  const totalStallMs = finished.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
  const ongoing = stalls.at(-1)?.durationMs === undefined && stalls.length > 0

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Buffer ahead · {formatSeconds(samples.at(-1)?.bufferAhead)}
        </CardTitle>
        <CardDescription>
          Shaded ranges are stalls (playback waiting for data after it had started; seeks excluded).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <TimeSeriesChart data={samples} config={config} series={['bufferAhead']} unit="s" bands={bands} />
        <div className="text-xs">
          <p>
            <span className="font-medium">{stalls.length} stalls</span>
            {ongoing && <span className="text-status-error"> · stalled now</span>}
            <span className="text-muted-foreground"> · total {formatMs(totalStallMs)}</span>
          </p>
          {stalls.length > 0 && (
            <ul className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 font-mono tabular-nums">
              {stalls
                .slice(-8)
                .reverse()
                .map((s) => (
                  <li key={s.t}>
                    {formatClock(s.t)} {s.durationMs !== undefined ? formatMs(s.durationMs) : 'ongoing'}
                  </li>
                ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
})
