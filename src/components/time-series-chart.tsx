import { CartesianGrid, Line, LineChart, ReferenceArea, XAxis, YAxis } from 'recharts'
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { downsample } from '@/lib/downsample'
import { formatClock } from '@/lib/format'

export interface Band {
  from: number
  to: number
}

interface TimeSeriesChartProps<T extends { t: number }> {
  data: T[]
  config: ChartConfig
  /** Keys of `data` to plot, one line each (same unit: one y-axis). */
  series: (keyof T & string)[]
  unit: string
  /** Shaded time ranges (e.g. stalls), in the same `performance.now()` clock as `t`. */
  bands?: Band[]
  className?: string
}

/** Line chart over `performance.now()` time with a wall-clock axis. No animation: data updates every 500 ms. Long series are thinned with `downsample` to keep renders cheap. */
export function TimeSeriesChart<T extends { t: number }>({ data, config, series, unit, bands = [], className }: TimeSeriesChartProps<T>) {
  return (
    <ChartContainer config={config} className={className ?? 'aspect-auto h-48 w-full'}>
      <LineChart data={downsample(data, series)} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={formatClock}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
        />
        <YAxis width={44} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}${unit}`} />
        {bands.map((b) => (
          <ReferenceArea key={b.from} x1={b.from} x2={b.to} fill="var(--status-error)" fillOpacity={0.18} ifOverflow="hidden" />
        ))}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const t = payload?.[0]?.payload?.t
                return typeof t === 'number' ? formatClock(t) : ''
              }}
              formatter={(value, name) => (
                <span className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">{config[String(name)]?.label ?? name}</span>
                  <span className="font-mono tabular-nums">
                    {typeof value === 'number' ? value.toFixed(2) : value}
                    {unit}
                  </span>
                </span>
              )}
            />
          }
        />
        {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {series.map((key) => (
          <Line
            key={key}
            dataKey={key}
            type="linear"
            stroke={`var(--color-${key})`}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  )
}
