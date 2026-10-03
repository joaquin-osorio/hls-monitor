import { LoudnessProcessor } from './loudness'

// AudioWorkletGlobalScope is not part of TypeScript's DOM lib; declare the bits used here.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

/**
 * Runs the sample-level BS.1770 processing on the audio thread and posts `LoudnessBlock[]` to the
 * main thread every time a 100 ms block completes. Channels arrive in discrete order.
 */
class LoudnessWorklet extends AudioWorkletProcessor {
  private readonly meter = new LoudnessProcessor(sampleRate)

  process(inputs: Float32Array[][]): boolean {
    const blocks = this.meter.process(inputs[0] ?? [])
    if (blocks.length > 0) this.port.postMessage(blocks)
    return true
  }
}

registerProcessor('loudness-meter', LoudnessWorklet)
