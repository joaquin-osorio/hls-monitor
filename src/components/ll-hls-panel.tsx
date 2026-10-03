import { memo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatBytes, formatClock, formatMs } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { PartRecord } from '@/monitor/parts'
import type { PlaylistRefresh } from '@/monitor/playlist/health'

const MAX_ROWS = 100

function Stat({ label, value, alert, hint }: { label: string; value: string; alert?: boolean; hint?: string }) {
  return (
    <div className="flex flex-col" title={hint}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn('font-mono tabular-nums', alert && 'text-status-error')}>{value}</span>
    </div>
  )
}

const seconds = (v: number | undefined) => (v === undefined ? '—' : `${v} s`)

interface LlHlsPanelProps {
  playlists: PlaylistRefresh[]
  parts: PartRecord[]
}

/** LL-HLS server control, blocking reloads, preload hints and part delivery. Renders nothing for regular HLS. */
export const LlHlsPanel = memo(function LlHlsPanel({ playlists, parts }: LlHlsPanelProps) {
  const withLl = playlists.filter((r) => r.ll)
  const last = withLl.findLast((r) => r.key.startsWith('main:')) ?? withLl.at(-1)
  if (!last?.ll && parts.length === 0) return null

  const ll = last?.ll
  const sc = ll?.serverControl
  const blocking = withLl.filter((r) => r.ll?.blocking?.msn !== undefined)
  const holds = blocking.flatMap((r) => (r.ll?.blocking?.holdMs !== undefined ? [r.ll.blocking.holdMs] : []))
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : undefined
  const unsatisfied = blocking.filter((r) => r.ll?.blocking?.satisfied === false).length
  const partTarget = ll?.partTarget
  const rows = parts.slice(-MAX_ROWS).reverse()
  const hint = ll?.preloadHints.find((h) => h.type === 'PART')

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>LL-HLS</CardTitle>
        <CardDescription>
          Low-latency delivery. Blocking reload and preload-hint part requests are held by the server until the content
          exists, so their TTFB is hold time, not network latency.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {ll && (
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <Stat label="PART-TARGET" value={seconds(partTarget)} alert={partTarget === undefined} />
            <Stat label="PART-HOLD-BACK" value={seconds(sc?.partHoldBack)} alert={sc?.partHoldBack === undefined} />
            <Stat label="HOLD-BACK" value={seconds(sc?.holdBack)} />
            <Stat label="CAN-BLOCK-RELOAD" value={sc?.canBlockReload ? 'YES' : 'no'} alert={!sc?.canBlockReload} />
            <Stat label="CAN-SKIP-UNTIL" value={seconds(sc?.canSkipUntil)} />
            <Stat label="Parts listed" value={`${ll.partCount} (${ll.pendingParts} pending)`} />
            <Stat label="Rendition reports" value={String(ll.renditionReports)} />
            <Stat
              label="Blocking reloads"
              value={`${blocking.length} · avg hold ${formatMs(avgHold)}`}
              hint="Playlist requests with _HLS_msn; hold = TTFB"
            />
            <Stat
              label="Unsatisfied reloads"
              value={String(unsatisfied)}
              alert={unsatisfied > 0}
              hint="Responses that did not contain the requested MSN/part"
            />
            <Stat
              label="Preload hints"
              value={`${ll.hintsFulfilled} ok · ${ll.hintsUnfulfilled} unfulfilled`}
              alert={ll.hintsUnfulfilled > 0}
              hint={hint ? `Current hint: ${hint.uri}` : undefined}
            />
          </div>
        )}
        {rows.length === 0 ? (
          <p className="text-muted-foreground">No part requests yet (hls.js loads parts only near the live edge).</p>
        ) : (
          <div className="max-h-72 overflow-auto">
            <Table className="text-xs tabular-nums">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>MSN.part</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Indep.</TableHead>
                  <TableHead className="text-right" title="TTFB: mostly server hold time for hinted parts">
                    Hold
                  </TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.key}>
                    <TableCell className="font-mono">{formatClock(p.t)}</TableCell>
                    <TableCell className="font-mono" title={p.url}>
                      {p.sn}.{p.part}
                    </TableCell>
                    <TableCell>{p.track === 'main' ? p.level : `${p.track} ${p.level}`}</TableCell>
                    <TableCell className={cn('text-right', partTarget !== undefined && p.duration > partTarget + 0.001 && 'text-status-error')}>
                      {p.duration.toFixed(3)} s
                    </TableCell>
                    <TableCell>{p.independent ? 'yes' : ''}</TableCell>
                    <TableCell className="text-right">{formatMs(p.ttfbMs)}</TableCell>
                    <TableCell className="text-right">{formatMs(p.totalMs)}</TableCell>
                    <TableCell className="text-right">{formatBytes(p.bytes)}</TableCell>
                    <TableCell className={cn(p.status === 'error' && 'text-status-error')}>
                      {p.status}
                      {p.httpStatus && p.httpStatus >= 400 ? ` ${p.httpStatus}` : ''}
                      {p.attempts > 1 ? ` ×${p.attempts}` : ''}
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
