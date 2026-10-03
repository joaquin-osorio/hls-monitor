import { memo } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { ChartConfig } from '@/components/ui/chart'
import { cn } from '@/lib/utils'
import type { LoudnessInfo, LoudnessPause } from '@/monitor/audio/loudness-meter'
import { TimeSeriesChart } from './time-series-chart'

const config = {
  momentary: { label: 'Momentary', color: 'var(--chart-1)' },
  shortTerm: { label: 'Short-term', color: 'var(--chart-2)' },
} satisfies ChartConfig

/** EBU R128 maximum true peak. */
const TRUE_PEAK_LIMIT_DBTP = -1

const PAUSE_TEXT: Record<LoudnessPause, string> = {
  muted: 'Paused: the video is muted.',
  volume: 'Paused: volume is below 100 %, which would skew the reading.',
  paused: 'Paused: playback is paused.',
}

function Reading({ label, value, unit, alert, hint }: { label: string; value: number | undefined; unit: string; alert?: boolean; hint?: string }) {
  const shown = value !== undefined && Number.isFinite(value) ? value.toFixed(1) : '—'
  return (
    <div className="flex flex-col" title={hint}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn('font-mono text-lg tabular-nums', alert && 'text-status-error')}>
        {shown}
        <span className="text-muted-foreground ml-1 text-xs">{unit}</span>
      </span>
    </div>
  )
}

interface LoudnessPanelProps {
  info: LoudnessInfo | null
  enabled: boolean
  onToggle: (enabled: boolean) => void
}

/** BS.1770 / EBU R128 loudness of the audio being played. */
export const LoudnessPanel = memo(function LoudnessPanel({ info, enabled, onToggle }: LoudnessPanelProps) {
  const v = info?.values
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Loudness</CardTitle>
        <CardDescription>
          ITU-R BS.1770 measured on the decoded audio as it plays. Reference: EBU R128 targets −23 LUFS integrated and at
          most −1 dBTP true peak. Integrated loudness restarts for every stream.
        </CardDescription>
        <CardAction>
          <Button size="sm" variant={enabled ? 'outline' : 'default'} onClick={() => onToggle(!enabled)}>
            {enabled ? 'Stop' : 'Measure loudness'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!enabled || !info ? (
          <p className="text-muted-foreground">
            Off. Starting the meter unmutes the video: it measures the element's output, so it needs sound at 100 % volume.
          </p>
        ) : info.status === 'error' ? (
          <p className="text-status-error">Could not start the audio meter: {info.error}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-8 gap-y-2">
              <Reading label="Momentary (400 ms)" value={v?.momentary} unit="LUFS" />
              <Reading label="Short-term (3 s)" value={v?.shortTerm} unit="LUFS" />
              <Reading label="Integrated" value={v?.integrated} unit="LUFS" hint="Gated: −70 LUFS absolute, −10 LU relative" />
              <Reading
                label="True peak (max)"
                value={v?.truePeakMax}
                unit="dBTP"
                alert={v !== undefined && v.truePeakMax > TRUE_PEAK_LIMIT_DBTP}
                hint="4× oversampled; above −1 dBTP is highlighted"
              />
            </div>
            {info.status === 'paused' && info.pausedReason && <p className="text-status-slow text-xs">{PAUSE_TEXT[info.pausedReason]}</p>}
            {info.status === 'starting' && <p className="text-muted-foreground text-xs">Starting the audio meter…</p>}
            <TimeSeriesChart data={info.series} config={config} series={['momentary', 'shortTerm']} unit="" />
          </>
        )}
      </CardContent>
    </Card>
  )
})
