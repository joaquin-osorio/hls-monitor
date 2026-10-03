import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatBitrate, formatBytes, formatClock, formatMs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EXTINF_TOLERANCE_S } from '@/monitor/checks'
import { RETENTION_MS } from '@/monitor/ring-buffer'
import type { SegmentRecord } from '@/monitor/segments'
import { formatPid, pidLabel, streamTypeName } from '@/monitor/ts/stream-types'
import type { VariantInfo } from '@/monitor/types'

interface SegmentInspectorProps {
  /** Key of the inspected segment; null when closed. */
  segmentKey: string | null
  /** Live record for `segmentKey`; undefined once it left the retention window. */
  record: SegmentRecord | undefined
  variants: VariantInfo[]
  onClose: () => void
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Field({ label, children, alert }: { label: string; children: ReactNode; alert?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn('font-mono tabular-nums', alert && 'text-status-error')}>{children}</dd>
    </div>
  )
}

const pts = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(3))

function DurationSection({ record }: { record: SegmentRecord }) {
  const { duration, measuredDuration } = record
  const delta = measuredDuration !== undefined ? measuredDuration - duration : undefined
  const deltaMs = delta !== undefined ? Math.round(delta * 1000) : undefined
  return (
    <Section title="Duration">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="EXTINF">{duration} s</Field>
        <Field label="Measured (PTS)">{measuredDuration !== undefined ? `${measuredDuration.toFixed(3)} s` : '—'}</Field>
        <Field label="Δ" alert={delta !== undefined && Math.abs(delta) > EXTINF_TOLERANCE_S}>
          {deltaMs !== undefined ? `${deltaMs > 0 ? '+' : ''}${deltaMs} ms` : '—'}
        </Field>
        <Field label="PTS range">
          {pts(record.ptsStart)} → {pts(record.ptsEnd)}
        </Field>
      </dl>
    </Section>
  )
}

function StreamsSection({ record }: { record: SegmentRecord }) {
  if (record.tsError) return <p className="text-status-error">TS parse error: {record.tsError}</p>
  if (!record.pids) {
    return <p className="text-muted-foreground">Not analyzed (fMP4, encrypted, or skipped because the worker was busy).</p>
  }
  const streamByPid = new Map(record.streams?.map((s) => [s.pid, s]))
  return (
    <Section title="PIDs">
      <div className="overflow-x-auto">
        <Table className="text-xs tabular-nums">
          <TableHeader>
            <TableRow>
              <TableHead>PID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Codec</TableHead>
              <TableHead className="text-right">Packets</TableHead>
              <TableHead className="text-right">CC err</TableHead>
              <TableHead className="text-right">PTS</TableHead>
              <TableHead className="text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {record.pids.map((p) => {
              const s = streamByPid.get(p.pid)
              const audio = s?.sampleRate ? ` · ${s.sampleRate / 1000} kHz${s.channels ? ` · ${s.channels} ch` : ''}` : ''
              return (
                <TableRow key={p.pid}>
                  <TableCell className="font-mono">{formatPid(p.pid)}</TableCell>
                  <TableCell title={s ? `stream_type 0x${s.streamType.toString(16)} (${streamTypeName(s.streamType)})` : undefined}>
                    {pidLabel(p.pid, s?.streamType, p.kind)}
                    {s && <span className="text-muted-foreground"> 0x{s.streamType.toString(16).padStart(2, '0')}</span>}
                  </TableCell>
                  <TableCell className="font-mono">
                    {s?.codec ?? s?.family ?? '—'}
                    <span className="text-muted-foreground">{audio}</span>
                  </TableCell>
                  <TableCell className="text-right">{p.packets}</TableCell>
                  <TableCell className={cn('text-right', p.ccErrors > 0 && 'text-status-error')}>{p.ccErrors}</TableCell>
                  <TableCell className="text-right">
                    {s?.minPts !== undefined ? `${pts(s.minPts)} → ${pts(s.maxPts)}` : '—'}
                  </TableCell>
                  <TableCell className="text-right">{s?.duration !== undefined ? `${s.duration.toFixed(3)} s` : '—'}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </Section>
  )
}

function CodecsSection({ record, variant }: { record: SegmentRecord; variant: VariantInfo | undefined }) {
  const detected = record.streams?.flatMap((s) => (s.codec ? [s.codec] : [])) ?? []
  if (record.track !== 'main' || (!variant?.codecs && detected.length === 0)) return null
  const declared = variant?.codecs ?? []
  const lower = new Set(declared.map((c) => c.toLowerCase()))
  return (
    <Section title="Codecs: declared vs detected">
      <dl className="grid grid-cols-2 gap-3">
        <Field label={`CODECS (variant ${record.level})`}>{declared.length ? declared.join(', ') : 'missing'}</Field>
        <Field label="In this segment">
          {detected.length === 0
            ? '—'
            : detected.map((c, i) => (
                <span key={c} className={cn(!lower.has(c.toLowerCase()) && 'text-status-slow')} title={lower.has(c.toLowerCase()) ? undefined : 'Not declared verbatim in CODECS'}>
                  {i > 0 && ', '}
                  {c}
                </span>
              ))}
        </Field>
      </dl>
    </Section>
  )
}

function HeadersSection({ headers }: { headers: [string, string][] | undefined }) {
  return (
    <Section title="Response headers">
      {headers?.length ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs">
          {headers.map(([name, value], i) => (
            <div key={`${name}-${i}`} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">No headers captured.</p>
      )}
      <p className="text-muted-foreground text-xs">
        Cross-origin responses only expose CORS-safelisted headers (Cache-Control, Content-Language, Content-Length,
        Content-Type, Expires, Last-Modified, Pragma) plus those listed in Access-Control-Expose-Headers.
      </p>
    </Section>
  )
}

/** Side sheet with everything known about one segment: request, timing, duration, PIDs and headers. */
export function SegmentInspector({ segmentKey, record, variants, onClose }: SegmentInspectorProps) {
  return (
    <Sheet open={segmentKey !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{record ? `Segment ${record.sn}` : 'Segment'}</SheetTitle>
          <SheetDescription>
            {record ? (
              <>
                {record.track} · level {record.level} · {formatClock(record.t)}
              </>
            ) : (
              `This segment left the ${RETENTION_MS / 60_000}-minute retention window.`
            )}
          </SheetDescription>
        </SheetHeader>
        {record && (
          <div className="flex flex-col gap-5 px-4 pb-6">
            <Section title="Request">
              {record.attempts === 0 && record.partsLoaded !== undefined ? (
                <p className="text-xs">
                  Delivered as {record.partsLoaded} LL-HLS parts
                  {record.partErrors ? <span className="text-status-slow"> ({record.partErrors} failed attempts)</span> : null}. Part
                  timings are in the LL-HLS panel.
                </p>
              ) : (
                <p className="font-mono text-xs break-all">{record.url ?? '—'}</p>
              )}
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Status">
                  <Badge variant={record.status === 'error' ? 'destructive' : 'secondary'}>{record.status}</Badge>{' '}
                  {record.httpStatus ?? ''}
                </Field>
                <Field label="Attempts" alert={record.attempts > 1}>
                  {record.attempts}
                </Field>
                <Field label="TTFB">{formatMs(record.ttfbMs)}</Field>
                <Field label="Total">{formatMs(record.totalMs)}</Field>
                <Field label="Size">{formatBytes(record.bytes)}</Field>
                <Field label="Throughput">{formatBitrate(record.throughputBps)}</Field>
                <Field label="Ratio">{record.ratio?.toFixed(2) ?? '—'}</Field>
              </dl>
            </Section>
            {record.status !== 'gap' && (
              <>
                <DurationSection record={record} />
                <StreamsSection record={record} />
                <CodecsSection record={record} variant={variants[record.level]} />
                <HeadersSection headers={record.headers} />
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
