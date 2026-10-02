import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatClock } from '@/lib/format'
import type { MonitorError } from '@/monitor/errors'

const MAX_ROWS = 200

function corsHint(error: MonitorError): string {
  if (error.type !== 'cors') return ''
  if (error.corsConfirmed === true) return ' (confirmed)'
  if (error.corsConfirmed === false) return ' or network'
  return ''
}

export const ErrorLog = memo(function ErrorLog({ errors }: { errors: MonitorError[] }) {
  const rows = errors.slice(-MAX_ROWS).reverse()
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Errors <span className="text-muted-foreground font-normal">({errors.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground">No errors.</p>
        ) : (
          <div className="max-h-80 overflow-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Fatal</TableHead>
                  <TableHead className="text-right">Retries</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>URL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono tabular-nums">{formatClock(e.t)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono">
                        {e.type}
                        {e.status ? ` ${e.status}` : ''}
                        {corsHint(e)}
                      </Badge>
                    </TableCell>
                    <TableCell>{e.fatal ? <Badge variant="destructive">fatal</Badge> : 'no'}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.retries}</TableCell>
                    <TableCell className="font-mono" title={e.message}>
                      {e.details}
                    </TableCell>
                    <TableCell className="max-w-64 truncate font-mono" title={e.url}>
                      {e.url ?? '—'}
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
