import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { ThrottleProfile } from '@/monitor/network-shaper'

const PRESETS: { label: string; profile: ThrottleProfile }[] = [
  { label: 'Slow 3G', profile: { downKbps: 500, latencyMs: 400 } },
  { label: 'Fast 3G', profile: { downKbps: 1600, latencyMs: 150 } },
  { label: '4G', profile: { downKbps: 9000, latencyMs: 60 } },
]

const same = (a: ThrottleProfile | null, b: ThrottleProfile | null) =>
  a?.downKbps === b?.downKbps && a?.latencyMs === b?.latencyMs

interface ThrottleControlProps {
  value: ThrottleProfile | null
  onChange: (profile: ThrottleProfile | null) => void
}

/** Network simulation presets plus a custom bandwidth/latency form. */
export function ThrottleControl({ value, onChange }: ThrottleControlProps) {
  const [kbps, setKbps] = useState('2000')
  const [latency, setLatency] = useState('100')
  const custom = value !== null && !PRESETS.some((p) => same(p.profile, value))

  const applyCustom = (e: FormEvent) => {
    e.preventDefault()
    const downKbps = Number(kbps)
    const latencyMs = Number(latency)
    if (downKbps > 0 && latencyMs >= 0) onChange({ downKbps, latencyMs })
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Network simulation</CardTitle>
        <CardDescription>
          Holds every hls.js response to emulate a slower link shared by all requests. ABR and every timing in this page then
          reflect the simulated network. The real download still happens at full speed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Network presets">
          <Button size="sm" variant={value === null ? 'default' : 'outline'} aria-pressed={value === null} onClick={() => onChange(null)}>
            Off
          </Button>
          {PRESETS.map((p) => {
            const active = same(p.profile, value)
            return (
              <Button
                key={p.label}
                size="sm"
                variant={active ? 'default' : 'outline'}
                aria-pressed={active}
                onClick={() => onChange(p.profile)}
                title={`${p.profile.downKbps} kbps · ${p.profile.latencyMs} ms`}
              >
                {p.label}
              </Button>
            )
          })}
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={applyCustom}>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Downlink (kbps)</span>
            <Input className="w-28" type="number" min={1} value={kbps} onChange={(e) => setKbps(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Latency (ms)</span>
            <Input className="w-24" type="number" min={0} value={latency} onChange={(e) => setLatency(e.target.value)} />
          </label>
          <Button size="sm" type="submit" variant={custom ? 'default' : 'outline'} aria-pressed={custom}>
            Apply custom
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
