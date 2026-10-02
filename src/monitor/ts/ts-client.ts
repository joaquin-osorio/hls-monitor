import type { TsAnalysis } from './parse-ts'
import type { TsJob, TsJobResult } from './protocol'

/** Max segments queued in the worker. Beyond this, new segments are skipped, not buffered. */
const MAX_IN_FLIGHT = 4

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((event: MessageEvent<TsJobResult>) => void) | null
}

/**
 * Runs `parseTs` in a dedicated Web Worker.
 *
 * `analyze` takes ownership of the buffer and transfers it, so the caller must pass a copy it no
 * longer needs. If the worker falls behind, segments are dropped (`analyze` returns null) instead
 * of piling up copies in memory.
 */
export class TsAnalyzer {
  private readonly worker: WorkerLike
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (a: TsAnalysis) => void; reject: (e: Error) => void }>()

  constructor(
    createWorker: () => WorkerLike = () =>
      new Worker(new URL('./ts.worker.ts', import.meta.url), { type: 'module' }) as WorkerLike,
  ) {
    this.worker = createWorker()
    this.worker.onmessage = (event) => {
      const result = event.data
      const job = this.pending.get(result.id)
      if (!job) return
      this.pending.delete(result.id)
      if (result.ok) job.resolve(result.analysis)
      else job.reject(new Error(result.error))
    }
  }

  analyze(buffer: ArrayBuffer): Promise<TsAnalysis> | null {
    if (this.pending.size >= MAX_IN_FLIGHT) return null
    const id = this.nextId++
    const promise = new Promise<TsAnalysis>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    const job: TsJob = { id, buffer }
    this.worker.postMessage(job, [buffer])
    return promise
  }

  destroy(): void {
    this.worker.terminate()
    for (const job of this.pending.values()) job.reject(new Error('TsAnalyzer destroyed'))
    this.pending.clear()
  }
}
