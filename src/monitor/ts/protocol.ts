import type { TsAnalysis } from './parse-ts'

export interface TsJob {
  id: number
  /** A private copy of the segment bytes, transferred (not cloned) to the worker. */
  buffer: ArrayBuffer
}

export type TsJobResult = { id: number; ok: true; analysis: TsAnalysis } | { id: number; ok: false; error: string }
