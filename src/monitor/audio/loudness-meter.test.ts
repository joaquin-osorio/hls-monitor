import { describe, expect, it, vi } from 'vitest'
import type { AudioGraph } from './audio-graph'
import { LoudnessMeter } from './loudness-meter'

function fakeGraph() {
  const port = { onmessage: null as ((e: MessageEvent) => void) | null }
  const graph = { context: { resume: vi.fn(async () => {}) }, meter: { port } } as unknown as AudioGraph
  const send = (energy: number, count = 1) =>
    port.onmessage?.({ data: Array.from({ length: count }, () => ({ energy, peak: 0.5 })) } as MessageEvent)
  return { graph, port, send }
}

/** Energy that reads as `lufs`. */
const energy = (lufs: number) => 10 ** ((lufs + 0.691) / 10)

describe('LoudnessMeter', () => {
  it('unmutes the element, resumes the context and measures blocks', async () => {
    const media = { muted: true, volume: 0.5, paused: false }
    const { graph, send } = fakeGraph()
    const meter = new LoudnessMeter(media, Promise.resolve(graph), () => {})
    expect(media).toMatchObject({ muted: false, volume: 1 })
    await vi.waitFor(() => expect(meter.info().status).toBe('measuring'))
    expect(graph.context.resume).toHaveBeenCalled()

    send(energy(-20), 30)
    meter.sample(1000)
    const info = meter.info()
    expect(info.values.momentary).toBeCloseTo(-20)
    expect(info.values.integrated).toBeCloseTo(-20)
    expect(info.values.truePeakMax).toBeCloseTo(-6.02, 1)
    expect(info.series).toEqual([{ t: 1000, momentary: expect.closeTo(-20), shortTerm: expect.closeTo(-20) }])
  })

  it('ignores blocks while the element is muted, turned down or paused', async () => {
    const media = { muted: false, volume: 1, paused: false }
    const { graph, send } = fakeGraph()
    const meter = new LoudnessMeter(media, Promise.resolve(graph), () => {})
    await vi.waitFor(() => expect(meter.info().status).toBe('measuring'))

    media.muted = true
    send(energy(-10), 30)
    expect(meter.info()).toMatchObject({ status: 'paused', pausedReason: 'muted' })
    expect(meter.info().values.integrated).toBe(Number.NEGATIVE_INFINITY)

    media.muted = false
    media.volume = 0.3
    meter.sample(500)
    expect(meter.info()).toMatchObject({ status: 'paused', pausedReason: 'volume', series: [{ t: 500 }] })
  })

  it('reports setup failures and detaches from the graph on destroy', async () => {
    const failing = new LoudnessMeter({ muted: false, volume: 1, paused: false }, Promise.reject(new Error('no worklet')), () => {})
    await vi.waitFor(() => expect(failing.info()).toMatchObject({ status: 'error', error: 'no worklet' }))

    const { graph, port } = fakeGraph()
    const meter = new LoudnessMeter({ muted: false, volume: 1, paused: false }, Promise.resolve(graph), () => {})
    await vi.waitFor(() => expect(port.onmessage).not.toBeNull())
    meter.destroy()
    expect(port.onmessage).toBeNull()
  })
})
