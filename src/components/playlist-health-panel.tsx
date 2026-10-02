import { memo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatClock, formatMs } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { PlaylistRefresh } from '@/monitor/playlist/health'

const MAX_ROWS = 50

/** A refresh interval this many target durations long is flagged. */
const LATE_FACTOR = 1.5

function isLate(r: PlaylistRefresh): boolean {
  return r.intervalMs !== undefined && r.targetDuration !== undefined && r.intervalMs > r.targetDuration * 1000 * LATE_FACTOR
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn('font-mono tabular-nums', alert && 'text-status-error')}>{value}</span>
    </div>
  )
}

export const PlaylistHealthPanel = memo(function PlaylistHealthPanel({ playlists }: { playlists: PlaylistRefresh[] }) {
  const refreshes = playlists.filter((r) => r.intervalMs !== undefined)
  const intervals = refreshes.map((r) => r.intervalMs!)
  const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : undefined
  const last = playlists.at(-1)
  const stale = refreshes.filter((r) => !r.changed).length
  const missed = playlists.reduce((n, r) => n + r.missedSns.length, 0)
  const rows = playlists.slice(-MAX_ROWS).reverse()

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Playlist health</CardTitle>
        <CardDescription>Media playlist loads. Live playlists should refresh about once per target duration.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!last ? (
          <p className="text-muted-foreground">No media playlist loaded yet.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-8 gap-y-2">
              <Stat label="TARGETDURATION" value={last.targetDuration !== undefined ? `${last.targetDuration} s` : 'missing'} alert={last.targetDuration === undefined} />
              <Stat label="Avg refresh" value={formatMs(avgInterval)} />
              <Stat label="MEDIA-SEQUENCE" value={String(last.mediaSequence)} />
              <Stat label="Unchanged refreshes" value={String(stale)} alert={stale > 0} />
              <Stat label="Missed segments" value={String(missed)} alert={missed > 0} />
              <Stat label="ENDLIST" value={last.endList ? 'yes' : 'no'} />
            </div>
            <div className="max-h-72 overflow-auto">
              <Table className="text-xs tabular-nums">
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Playlist</TableHead>
                    <TableHead className="text-right">Interval</TableHead>
                    <TableHead className="text-right">MSN</TableHead>
                    <TableHead className="text-right">+MSN</TableHead>
                    <TableHead className="text-right">New</TableHead>
                    <TableHead className="text-right">Segs</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const notes = [
                      !r.changed && 'unchanged',
                      isLate(r) && 'late',
                      r.missedSns.length > 0 && `missed ${r.missedSns.length}`,
                      r.mediaSequenceAdvance !== undefined && r.mediaSequenceAdvance < 0 && 'MSN went back',
                      r.endListAppeared && 'ENDLIST appeared',
                    ].filter(Boolean)
                    return (
                      <TableRow key={`${r.key}-${r.t}`}>
                        <TableCell className="font-mono">{formatClock(r.t)}</TableCell>
                        <TableCell className="font-mono" title={r.url}>
                          {r.key}
                        </TableCell>
                        <TableCell className={cn('text-right', isLate(r) && 'text-status-slow')}>{formatMs(r.intervalMs)}</TableCell>
                        <TableCell className="text-right">{r.mediaSequence}</TableCell>
                        <TableCell className="text-right">{r.mediaSequenceAdvance ?? '—'}</TableCell>
                        <TableCell className="text-right">{r.newSegments ?? '—'}</TableCell>
                        <TableCell className="text-right">{r.segmentCount}</TableCell>
                        <TableCell className={cn(notes.length > 0 && 'text-status-error')}>{notes.join(', ') || '—'}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
})
