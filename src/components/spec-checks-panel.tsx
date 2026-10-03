import { CircleAlert, CircleCheck, Info, Minus, TriangleAlert } from 'lucide-react'
import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'
import { summarizeChecks, type CheckStatus, type Finding } from '@/monitor/checks'

function SeverityIcon({ severity }: { severity: CheckStatus }) {
  switch (severity) {
    case 'error':
      return <CircleAlert className="text-status-error size-4 shrink-0" aria-label="error" />
    case 'warn':
      return <TriangleAlert className="text-status-slow size-4 shrink-0" aria-label="warning" />
    case 'info':
      return <Info className="text-muted-foreground size-4 shrink-0" aria-label="info" />
    case 'pass':
      return <CircleCheck className="text-status-ok size-4 shrink-0" aria-label="pass" />
    case 'na':
      return <Minus className="text-muted-foreground size-4 shrink-0" aria-label="not applicable" />
  }
}

interface SpecChecksPanelProps {
  findings: Finding[]
  /** The stream uses LL-HLS (parts); otherwise LL checks are not applicable. */
  lowLatency: boolean
}

export const SpecChecksPanel = memo(function SpecChecksPanel({ findings, lowLatency }: SpecChecksPanelProps) {

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Spec checks</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {summarizeChecks(findings, lowLatency).map(({ id, label, status, findings: list }) => {
            return (
              <li key={id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <SeverityIcon severity={status} />
                  <span className={cn('font-medium', list.length === 0 && 'text-muted-foreground')}>{label}</span>
                  <span className="text-muted-foreground text-xs">{status === 'pass' ? 'ok' : status === 'na' ? 'n/a' : status}</span>
                </div>
                {list.map((f) => (
                  <div key={f.key} className="text-muted-foreground ml-6 text-xs">
                    <p className="text-foreground">{f.message}</p>
                    <p className="font-mono tabular-nums">
                      ×{f.count} · first {formatClock(f.firstSeen)} · last {formatClock(f.lastSeen)}
                      {f.url && (
                        <span className="block truncate" title={f.url}>
                          {f.url}
                        </span>
                      )}
                    </p>
                  </div>
                ))}
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
})
