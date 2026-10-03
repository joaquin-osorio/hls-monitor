import workletUrl from './loudness.worklet.ts?worker&url'

export interface AudioGraph {
  context: AudioContext
  /** Receives `LoudnessBlock[]` messages on its port. */
  meter: AudioWorkletNode
}

/**
 * One graph per media element, for the page's lifetime: `createMediaElementSource` can only be
 * called once per element, and the `<video>` outlives monitoring sessions. Once created, the
 * element's audio is routed through the context, so it keeps playing via `source → destination`.
 */
const graphs = new WeakMap<HTMLMediaElement, Promise<AudioGraph>>()

export function audioGraphFor(media: HTMLMediaElement): Promise<AudioGraph> {
  let graph = graphs.get(media)
  if (!graph) {
    graph = createGraph(media)
    graphs.set(media, graph)
    // Allow a retry if setup failed before the element was captured.
    graph.catch(() => graphs.delete(media))
  }
  return graph
}

async function createGraph(media: HTMLMediaElement): Promise<AudioGraph> {
  const context = new AudioContext({ latencyHint: 'playback' })
  await context.audioWorklet.addModule(workletUrl)
  const source = context.createMediaElementSource(media)
  source.connect(context.destination)
  const meter = new AudioWorkletNode(context, 'loudness-meter', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCountMode: 'max',
    channelInterpretation: 'discrete', // no up/down-mixing: BS.1770 weighs channels itself
  })
  // A silent path to the destination keeps the worklet pulled by the render graph.
  const mute = context.createGain()
  mute.gain.value = 0
  source.connect(meter).connect(mute).connect(context.destination)
  return { context, meter }
}
