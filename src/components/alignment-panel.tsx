import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { AlignmentReport } from '@/monitor/alignment'
import type { SourceInfo } from '@/monitor/types'

const MAX_ISSUES_SHOWN = 50

interface AlignmentPanelProps {
  report: AlignmentReport | null
  source: SourceInfo
}

/** Segment alignment between the variants of a master playlist. */
export const AlignmentPanel = memo(function AlignmentPanel({ report, source }: AlignmentPanelProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Variant alignment{' '}
          {report && (
            <span className={cn('font-normal', report.issues.length > 0 ? 'text-status-error' : 'text-status-ok')}>
              · {report.issues.length > 0 ? `${report.issues.length} issues` : 'aligned'}
            </span>
          )}
        </CardTitle>
        <CardDescription>
          The monitor fetches every variant's media playlist (once for VOD, every 30 s for live; never segments) and compares
          EXTINF, discontinuities and PDT per media sequence number, plus the start PTS of segments loaded on several levels.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {source.kind === 'media' ? (
          <p className="text-muted-foreground">Not applicable: the source is a single media playlist.</p>
        ) : !report ? (
          <p className="text-muted-foreground">Waiting for the first probe…</p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              Last probe {formatClock(report.t)} · {report.requests} playlist requests so far · {report.comparedSns} SNs listed by
              every variant
            </p>
            <div className="overflow-x-auto">
              <Table className="text-xs tabular-nums">
                <TableHeader>
                  <TableRow>
                    <TableHead>Level</TableHead>
                    <TableHead>SN range</TableHead>
                    <TableHead className="text-right">Segments</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">Disc.</TableHead>
                    <TableHead>First PDT</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.variants.map((v) => (
                    <TableRow key={v.level}>
                      <TableCell title={v.uri}>{v.level}</TableCell>
                      {v.error ? (
                        <TableCell colSpan={5} className="text-status-error">
                          {v.error}
                        </TableCell>
                      ) : (
                        <>
                          <TableCell>
                            {v.firstSn ?? '—'}–{v.lastSn ?? '—'}
                          </TableCell>
                          <TableCell className="text-right">{v.segments}</TableCell>
                          <TableCell className="text-right">{v.durationS.toFixed(3)} s</TableCell>
                          <TableCell className="text-right">{v.discontinuities}</TableCell>
                          <TableCell className="font-mono">{v.firstPdt !== undefined ? new Date(v.firstPdt).toISOString() : '—'}</TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {report.issues.length > 0 && (
              <ul className="flex max-h-60 flex-col gap-1 overflow-auto text-xs">
                {report.issues.slice(0, MAX_ISSUES_SHOWN).map((issue, i) => (
                  <li key={`${issue.kind}-${issue.sn}-${i}`} className="flex items-baseline gap-2">
                    <Badge variant="destructive">{issue.kind}</Badge>
                    <span className="tabular-nums">
                      {issue.sn !== undefined && <span className="font-mono">SN {issue.sn} · </span>}
                      {issue.detail} on level{issue.levels.length > 1 ? 's' : ''} {issue.levels.join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
})
