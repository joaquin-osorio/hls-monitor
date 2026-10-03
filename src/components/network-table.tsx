import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatBitrate, formatBytes, formatClock, formatMs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { SLOW_RATIO, type SegmentRecord } from '@/monitor/segments'

const MAX_ROWS = 150

const STATUS_TEXT: Record<SegmentRecord['status'], string> = {
  ok: 'text-status-ok',
  slow: 'text-status-slow',
  error: 'text-status-error',
  gap: 'text-status-gap',
}

/** Per-segment network metrics, newest first. Gaps have no request and are left out. */
interface NetworkTableProps {
  segments: SegmentRecord[]
  /** Opens the segment inspector. */
  onInspect: (key: string) => void
}

export const NetworkTable = memo(function NetworkTable({ segments, onInspect }: NetworkTableProps) {
  const rows = segments.filter((r) => r.status !== 'gap').slice(-MAX_ROWS).reverse()
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Network per segment <span className="text-muted-foreground font-normal">(last {MAX_ROWS})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground">No segment requests yet.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table className="text-xs tabular-nums">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>SN</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">TTFB</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Throughput</TableHead>
                  <TableHead className="text-right" title="Download time / segment duration">
                    Ratio
                  </TableHead>
                  <TableHead className="text-right">Tries</TableHead>
                  <TableHead>TS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-mono">{formatClock(r.t)}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="underline decoration-dotted underline-offset-2"
                        onClick={() => onInspect(r.key)}
                        title="Inspect segment"
                      >
                        {r.sn}
                      </button>
                    </TableCell>
                    <TableCell>
                      {r.track === 'main' ? r.level : `${r.track} ${r.level}`}
                    </TableCell>
                    <TableCell className={STATUS_TEXT[r.status]}>
                      {r.status}
                      {r.httpStatus && r.httpStatus >= 400 ? ` ${r.httpStatus}` : ''}
                    </TableCell>
                    <TableCell className="text-right">{formatMs(r.ttfbMs)}</TableCell>
                    <TableCell className="text-right">{formatMs(r.totalMs)}</TableCell>
                    <TableCell className="text-right">{formatBytes(r.bytes)}</TableCell>
                    <TableCell className="text-right">{formatBitrate(r.throughputBps)}</TableCell>
                    <TableCell className={cn('text-right', r.ratio !== undefined && r.ratio >= SLOW_RATIO && 'text-status-slow')}>
                      {r.ratio?.toFixed(2) ?? '—'}
                    </TableCell>
                    <TableCell className={cn('text-right', (r.attempts > 1 || !!r.partErrors) && 'text-status-slow')}>
                      {r.attempts > 0 ? r.attempts : <span title="Delivered as LL-HLS parts">{r.partsLoaded}p</span>}
                    </TableCell>
                    <TableCell className="font-mono">
                      {r.tsError ? (
                        <Badge variant="destructive" title={r.tsError}>
                          parse error
                        </Badge>
                      ) : (
                        <span title={r.ptsStart !== undefined ? `PTS ${r.ptsStart.toFixed(3)} → ${r.ptsEnd?.toFixed(3)}` : undefined}>
                          {r.codecs?.join(', ') ?? '—'}
                          {r.ccErrors ? <span className="text-status-error"> · CC×{r.ccErrors}</span> : null}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
})
