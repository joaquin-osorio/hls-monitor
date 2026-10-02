import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatBitrate } from '@/lib/format'
import type { VariantSelection } from '@/lib/query-state'
import { cn } from '@/lib/utils'
import type { SelectionInfo, VariantInfo } from '@/monitor/types'

interface VariantsPanelProps {
  variants: VariantInfo[]
  selection: SelectionInfo
  /** Variant requested in the URL (`?variant=`). */
  requested: VariantSelection
  onSelect: (variant: VariantSelection) => void
}

/**
 * Measured vs declared: compared to AVERAGE-BANDWIDTH when present (same meaning), else to
 * BANDWIDTH (a peak, so measured should stay below it).
 */
function MeasuredCell({ variant }: { variant: VariantInfo }) {
  const { measuredBitrate, averageBandwidth, bandwidth } = variant
  if (measuredBitrate === undefined) return <span className="text-muted-foreground">—</span>
  const reference = averageBandwidth ?? bandwidth
  const pct = reference ? Math.round((measuredBitrate / reference) * 100) : undefined
  const overPeak = bandwidth !== undefined && measuredBitrate > bandwidth
  return (
    <span className={cn(overPeak && 'text-destructive')} title={overPeak ? 'Measured average exceeds declared BANDWIDTH (peak)' : undefined}>
      {formatBitrate(measuredBitrate)}
      {pct !== undefined && <span className="text-muted-foreground"> ({pct}%)</span>}
    </span>
  )
}

export const VariantsPanel = memo(function VariantsPanel({ variants, selection, requested, onSelect }: VariantsPanelProps) {
  const forced = requested !== 'auto'
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Variants</CardTitle>
        <CardAction>
          <Button size="sm" variant={forced ? 'outline' : 'secondary'} onClick={() => onSelect('auto')} disabled={!forced}>
            {forced ? 'Back to ABR' : 'ABR on'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {variants.length === 0 ? (
          <p className="text-muted-foreground">Waiting for the playlist…</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Resolution</TableHead>
                  <TableHead>CODECS</TableHead>
                  <TableHead>Detected</TableHead>
                  <TableHead className="text-right">BANDWIDTH</TableHead>
                  <TableHead className="text-right">AVG</TableHead>
                  <TableHead className="text-right">Measured</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {variants.map((v) => {
                  const playing = selection.currentLevel === v.index
                  const isForced = requested === v.index
                  return (
                    <TableRow key={v.index} data-state={playing ? 'selected' : undefined}>
                      <TableCell className="tabular-nums">
                        {v.index}
                        {playing && (
                          <Badge variant="secondary" className="ml-1">
                            playing
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{v.width && v.height ? `${v.width}×${v.height}` : '—'}</TableCell>
                      <TableCell className="font-mono">
                        {v.codecs ? v.codecs.join(', ') : <span className="text-destructive">missing</span>}
                      </TableCell>
                      <TableCell className="font-mono">{v.detectedCodecs.length ? v.detectedCodecs.join(', ') : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBitrate(v.bandwidth)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBitrate(v.averageBandwidth)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <MeasuredCell variant={v} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="xs"
                          variant={isForced ? 'default' : 'ghost'}
                          onClick={() => onSelect(v.index)}
                          aria-pressed={isForced}
                        >
                          {isForced ? 'Forced' : 'Force'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-muted-foreground mt-2 text-xs">
          {selection.auto ? 'ABR picks the variant.' : 'ABR off: the variant is forced.'} Measured = Σ bytes × 8 / Σ EXTINF of
          loaded segments; % is against AVG, or BANDWIDTH when AVG is missing. Detected codecs come from MPEG-TS segments (not
          available for fMP4).
        </p>
      </CardContent>
    </Card>
  )
})
