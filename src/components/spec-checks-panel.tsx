import { CircleAlert, CircleCheck, Info, Minus, TriangleAlert } from 'lucide-react'
import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { CheckId, Finding, Severity } from '@/monitor/checks'

/** `ll`: only meaningful for LL-HLS streams; shown as n/a otherwise (unless it has findings). */
const CHECKS: { id: CheckId; label: string; ll?: true }[] = [
  { id: 'target-exceeded', label: 'EXTINF within TARGETDURATION' },
  { id: 'discontinuity', label: 'Discontinuities' },
  { id: 'endlist-in-live', label: 'ENDLIST on a live playlist' },
  { id: 'codecs-missing', label: 'CODECS declared on every variant' },
  { id: 'codecs-undeclared', label: 'Segment codecs match CODECS' },
  { id: 'ts-continuity', label: 'MPEG-TS continuity counters' },
  { id: 'extinf-mismatch', label: 'EXTINF matches media duration' },
  { id: 'variant-alignment', label: 'Variants aligned' },
  { id: 'll-part-target', label: 'LL-HLS parts within PART-TARGET', ll: true },
  { id: 'll-server-control', label: 'LL-HLS server control and hold-back', ll: true },
  { id: 'll-blocking-reload', label: 'LL-HLS blocking reloads honored', ll: true },
  { id: 'll-preload-hint', label: 'LL-HLS preload hints fulfilled', ll: true },
]

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

function SeverityIcon({ severity }: { severity: Severity | 'pass' | 'na' }) {
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
            const worst = list.length > 0 ? list[0].severity : undefined
            const status = worst ?? (check.ll && !lowLatency ? 'na' : 'pass')
            return (
              <li key={check.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <SeverityIcon severity={status} />
                  <span className={cn('font-medium', !worst && 'text-muted-foreground')}>{check.label}</span>
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
