import { memo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { continuityByPid } from '@/monitor/continuity'
import type { SegmentRecord } from '@/monitor/segments'
import { formatPid, pidLabel } from '@/monitor/ts/stream-types'

/** Continuity counter errors per PID, aggregated over analyzed MPEG-TS segments. */
export const ContinuityPanel = memo(function ContinuityPanel({ segments }: { segments: SegmentRecord[] }) {
  const rows = continuityByPid(segments)
  const errors = rows.reduce((n, r) => n + r.ccErrors, 0)

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          TS continuity · <span className={cn(errors > 0 && 'text-status-error')}>{errors} CC errors</span>
        </CardTitle>
        <CardDescription>
          Continuity counter jumps per PID inside each analyzed segment (duplicates and signalled discontinuities excluded).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground">No MPEG-TS segments analyzed yet (fMP4 and encrypted segments are not analyzed).</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <Table className="text-xs tabular-nums">
              <TableHeader>
                <TableRow>
                  <TableHead>Playlist</TableHead>
                  <TableHead>PID</TableHead>
                  <TableHead>Stream</TableHead>
                  <TableHead className="text-right">Packets</TableHead>
                  <TableHead className="text-right">CC errors</TableHead>
                  <TableHead className="text-right">Segments</TableHead>
                  <TableHead className="text-right">Last error SN</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell>{r.track === 'main' ? `level ${r.level}` : `${r.track} ${r.level}`}</TableCell>
                    <TableCell className="font-mono">{formatPid(r.pid)}</TableCell>
                    <TableCell>{pidLabel(r.pid, r.streamType)}</TableCell>
                    <TableCell className="text-right">{r.packets}</TableCell>
                    <TableCell className={cn('text-right', r.ccErrors > 0 && 'text-status-error')}>{r.ccErrors}</TableCell>
                    <TableCell className="text-right" title="Affected / analyzed">
                      {r.affectedSegments} / {r.segments}
                    </TableCell>
                    <TableCell className="text-right">{r.lastErrorSn ?? '—'}</TableCell>
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
