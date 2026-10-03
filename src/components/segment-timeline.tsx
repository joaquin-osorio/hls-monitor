import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatBitrate, formatMs } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { SegmentRecord, SegmentStatus } from '@/monitor/segments'

const STATUS_CLASS: Record<SegmentStatus, string> = {
  ok: 'bg-status-ok',
  slow: 'bg-status-slow',
  error: 'bg-status-error',
  // Hatched so gaps stay distinguishable without relying on color.
  gap: 'bg-[repeating-linear-gradient(135deg,var(--status-gap)_0_2px,transparent_2px_4px)] ring-1 ring-status-gap ring-inset',
}

const STATUS_LABEL: Record<SegmentStatus, string> = {
  ok: 'ok',
  slow: 'slow',
  error: 'error',
  gap: 'gap',
}

function describe(r: SegmentRecord): string {
  const lines = [`SN ${r.sn} · level ${r.level} · ${r.track} · ${STATUS_LABEL[r.status]}`, `EXTINF ${r.duration}s`]
  if (r.status === 'gap') lines.push(r.gapReason === 'tag' ? 'EXT-X-GAP' : 'Left the playlist before it was seen')
  else if (r.attempts === 0 && r.partsLoaded !== undefined) lines.push(`delivered as ${r.partsLoaded} LL-HLS parts`)
  else {
    lines.push(`total ${formatMs(r.totalMs)} · TTFB ${formatMs(r.ttfbMs)} · ratio ${r.ratio?.toFixed(2) ?? '—'}`)
    lines.push(`throughput ${formatBitrate(r.throughputBps)} · attempts ${r.attempts}`)
    if (r.httpStatus && r.httpStatus >= 400) lines.push(`HTTP ${r.httpStatus}`)
  }
  return lines.join('\n')
}

function TrackRow({ track, records, onInspect }: { track: string; records: SegmentRecord[]; onInspect: (key: string) => void }) {
  const sorted = [...records].sort((a, b) => a.sn - b.sn || a.t - b.t)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{track}</span>
      <div className="flex flex-wrap gap-0.5" role="list" aria-label={`${track} segments`}>
        {sorted.map((r) => (
          <button
            key={r.key}
            type="button"
            role="listitem"
            title={describe(r)}
            aria-label={`Inspect segment ${r.sn}`}
            onClick={() => onInspect(r.key)}
            className={cn('h-4 w-2 rounded-[2px] hover:ring-2 hover:ring-foreground/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', STATUS_CLASS[r.status])}
          />
        ))}
      </div>
    </div>
  )
}

interface SegmentTimelineProps {
  segments: SegmentRecord[]
  /** Opens the segment inspector. */
  onInspect: (key: string) => void
}

export const SegmentTimeline = memo(function SegmentTimeline({ segments, onInspect }: SegmentTimelineProps) {
  const counts: Record<SegmentStatus, number> = { ok: 0, slow: 0, error: 0, gap: 0 }
  const byTrack = new Map<string, SegmentRecord[]>()
  for (const r of segments) {
    counts[r.status]++
    const list = byTrack.get(r.track)
    if (list) list.push(r)
    else byTrack.set(r.track, [r])
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-x-4 gap-y-1">
          Segment timeline
          <span className="flex flex-wrap gap-3 text-xs font-normal">
            {(Object.keys(counts) as SegmentStatus[]).map((s) => (
              <span key={s} className="flex items-center gap-1">
                <span className={cn('inline-block size-3 rounded-[2px]', STATUS_CLASS[s])} />
                {STATUS_LABEL[s]} <span className="text-muted-foreground tabular-nums">{counts[s]}</span>
              </span>
            ))}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {segments.length === 0 ? (
          <p className="text-muted-foreground">No segments yet.</p>
        ) : (
          [...byTrack].map(([track, records]) => <TrackRow key={track} track={track} records={records} onInspect={onInspect} />)
        )}
      </CardContent>
    </Card>
  )
})
