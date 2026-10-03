import { memo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { ChartConfig } from '@/components/ui/chart'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { droppedFrameSeries, framesByLevel } from '@/monitor/frames'
import type { Sample } from '@/monitor/types'
import { TimeSeriesChart } from './time-series-chart'

const config = {
  droppedPerSec: { label: 'Dropped', color: 'var(--chart-1)' },
} satisfies ChartConfig

/** Above this share of dropped frames a level is highlighted. */
const ALERT_RATIO = 0.01

function percent(dropped: number, total: number): string {
  return total > 0 ? `${((dropped / total) * 100).toFixed(2)}%` : '—'
}

export const DroppedFramesPanel = memo(function DroppedFramesPanel({ samples }: { samples: Sample[] }) {
  const series = droppedFrameSeries(samples)
  const levels = framesByLevel(samples)
  const total = levels.reduce((n, l) => n + l.total, 0)
  const dropped = levels.reduce((n, l) => n + l.dropped, 0)
  const supported = samples.some((s) => s.totalFrames !== undefined)

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Dropped frames · {dropped} <span className="text-muted-foreground font-normal">({percent(dropped, total)})</span>
        </CardTitle>
        <CardDescription>From getVideoPlaybackQuality(), attributed to the level playing at each sample.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!supported ? (
          <p className="text-muted-foreground">No frame counters yet (or not supported by this browser).</p>
        ) : (
          <>
            <TimeSeriesChart data={series} config={config} series={['droppedPerSec']} unit="/s" />
            {levels.length > 0 && (
              <Table className="text-xs tabular-nums">
                <TableHeader>
                  <TableRow>
                    <TableHead>Level</TableHead>
                    <TableHead className="text-right">Frames</TableHead>
                    <TableHead className="text-right">Dropped</TableHead>
                    <TableHead className="text-right">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {levels.map((l) => (
                    <TableRow key={l.level}>
                      <TableCell>{l.level === -1 ? '—' : l.level}</TableCell>
                      <TableCell className="text-right">{l.total}</TableCell>
                      <TableCell className="text-right">{l.dropped}</TableCell>
                      <TableCell className={cn('text-right', l.total > 0 && l.dropped / l.total > ALERT_RATIO && 'text-status-error')}>
                        {percent(l.dropped, l.total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
})
