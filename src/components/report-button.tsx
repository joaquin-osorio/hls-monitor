import { FileDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadText } from '@/lib/download'
import type { VariantSelection } from '@/lib/query-state'
import type { ThrottleProfile } from '@/monitor/network-shaper'
import { buildMarkdownReport, reportFilename } from '@/monitor/report/build-report'
import type { MonitorSnapshot } from '@/monitor/types'

interface ReportButtonProps {
  snapshot: MonitorSnapshot
  throttle: ThrottleProfile | null
  requestedVariant: VariantSelection
  loudnessEnabled: boolean
}

/** Downloads everything collected in the current session as a Markdown report. */
export function ReportButton({ snapshot, throttle, requestedVariant, loudnessEnabled }: ReportButtonProps) {
  const download = () => {
    // Built on click only: a long session produces a large document.
    const now = performance.now()
    const report = buildMarkdownReport(snapshot, { timeOrigin: performance.timeOrigin, now, throttle, requestedVariant, loudnessEnabled })
    downloadText(reportFilename(snapshot.source.url, performance.timeOrigin + now), report, 'text/markdown')
  }
  return (
    <Button type="button" variant="outline" onClick={download}>
      <FileDown data-icon="inline-start" />
      Download report
    </Button>
  )
}
