/// <reference lib="webworker" />
import { parseTs } from './parse-ts'
import type { TsJob, TsJobResult } from './protocol'

// The segment copy is only referenced inside this handler, so it is garbage-collected as soon
// as the analysis has been posted back: no segment bytes outlive a job.
self.onmessage = (event: MessageEvent<TsJob>) => {
  const { id, buffer } = event.data
  let result: TsJobResult
  try {
    result = { id, ok: true, analysis: parseTs(new Uint8Array(buffer)) }
  } catch (err) {
    result = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(result)
}
