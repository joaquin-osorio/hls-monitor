import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { CheckId, Finding, Severity } from '@/monitor/checks'

const CHECKS: { id: CheckId; label: string }[] = [
  { id: 'target-exceeded', label: 'EXTINF within TARGETDURATION' },
  { id: 'discontinuity', label: 'Discontinuities' },
  { id: 'endlist-in-live', label: 'ENDLIST on a live playlist' },
  { id: 'codecs-missing', label: 'CODECS declared on every variant' },
  { id: 'codecs-undeclared', label: 'Segment codecs match CODECS' },
]

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

function SeverityIcon({ severity }: { severity: Severity | 'pass' }) {
  switch (severity) {
    case 'error':
      return <CircleAlert className="text-status-error size-4 shrink-0" aria-label="error" />
    case 'warn':
      return <TriangleAlert className="text-status-slow size-4 shrink-0" aria-label="warning" />
    case 'info':
      return <Info className="text-muted-foreground size-4 shrink-0" aria-label="info" />
    case 'pass':
      return <CircleCheck className="text-status-ok size-4 shrink-0" aria-label="pass" />
  }
}

export const SpecChecksPanel = memo(function SpecChecksPanel({ findings }: { findings: Finding[] }) {
  const byCheck = new Map<CheckId, Finding[]>()
  for (const f of findings) byCheck.set(f.checkId, [...(byCheck.get(f.checkId) ?? []), f])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Spec checks</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {CHECKS.map((check) => {
            const list = (byCheck.get(check.id) ?? []).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
            const worst = list[0]?.severity
            return (
              <li key={check.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <SeverityIcon severity={worst ?? 'pass'} />
                  <span className={cn('font-medium', !worst && 'text-muted-foreground')}>{check.label}</span>
                  <span className="text-muted-foreground text-xs">{worst ? `${worst}` : 'ok'}</span>
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
