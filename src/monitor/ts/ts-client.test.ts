import { describe, expect, it, vi } from 'vitest'
import type { TsAnalysis } from './parse-ts'
import type { TsJob, TsJobResult } from './protocol'
import { TsAnalyzer } from './ts-client'

const ANALYSIS: TsAnalysis = { packets: 1, syncErrors: 0, ccErrors: 0, streams: [], families: ['avc'] }

function fakeWorker() {
  const worker = {
    onmessage: null as ((event: MessageEvent<TsJobResult>) => void) | null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
    reply(result: TsJobResult) {
      worker.onmessage?.({ data: result } as MessageEvent<TsJobResult>)
    },
  }
  return worker
}

describe('TsAnalyzer', () => {
  it('transfers the buffer and resolves with the matching result', async () => {
    const worker = fakeWorker()
    const analyzer = new TsAnalyzer(() => worker)
    const buffer = new ArrayBuffer(188)
    const first = analyzer.analyze(buffer)!
    const second = analyzer.analyze(new ArrayBuffer(188))!

    expect(worker.postMessage).toHaveBeenNthCalledWith(1, { id: 0, buffer }, [buffer])
    worker.reply({ id: 1, ok: false, error: 'No PAT found' })
    worker.reply({ id: 0, ok: true, analysis: ANALYSIS })

    await expect(first).resolves.toEqual(ANALYSIS)
    await expect(second).rejects.toThrow('No PAT found')
  })

  it('drops segments instead of queueing when the worker falls behind', () => {
    const worker = fakeWorker()
    const analyzer = new TsAnalyzer(() => worker)
    const results = Array.from({ length: 6 }, () => analyzer.analyze(new ArrayBuffer(188)))
    expect(results.filter((r) => r === null)).toHaveLength(2)
    expect(worker.postMessage).toHaveBeenCalledTimes(4)
    const job = worker.postMessage.mock.calls[0][0] as TsJob
    worker.reply({ id: job.id, ok: true, analysis: ANALYSIS })
    expect(analyzer.analyze(new ArrayBuffer(188))).not.toBeNull()
  })
})
