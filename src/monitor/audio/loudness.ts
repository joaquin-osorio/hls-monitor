/**
 * ITU-R BS.1770-4 / EBU R128 loudness and true-peak measurement.
 *
 * `LoudnessProcessor` runs on raw samples (inside the AudioWorklet) and emits one `LoudnessBlock`
 * per 100 ms. `LoudnessAnalyzer` runs on the main thread and turns those blocks into momentary,
 * short-term and integrated loudness. Plain TypeScript, no DOM: unit-tested in Node.
 */

/** Sub-block length: gating blocks are 4 of them (400 ms, 75 % overlap); short-term is 30. */
export const BLOCK_MS = 100
const MOMENTARY_BLOCKS = 4
const SHORT_TERM_BLOCKS = 30
const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_LU = -10

/** Histogram used for gating: 0.1 LU bins from the absolute gate up to +5 LUFS. */
const HIST_MIN = ABSOLUTE_GATE_LUFS
const HIST_STEP = 0.1
const HIST_BINS = 750

/** Weighted channel energy and true peak of one 100 ms sub-block. */
export interface LoudnessBlock {
  /** Σ Gᵢ · mean(xᵢ²) over the K-weighted channels. */
  energy: number
  /** Highest absolute value of the 4× oversampled signal across channels (linear). */
  peak: number
}

export function energyToLufs(energy: number): number {
  return energy > 0 ? -0.691 + 10 * Math.log10(energy) : Number.NEGATIVE_INFINITY
}

export function linearToDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY
}

/**
 * BS.1770 channel weights for Web Audio's discrete channel order. 5.1 is L, R, C, LFE, SL, SR:
 * the LFE is excluded and the surrounds get +1.5 dB (1.41). Other layouts weigh every channel 1.
 */
export function channelWeights(channels: number): number[] {
  if (channels === 6) return [1, 1, 1, 0, 1.41, 1.41]
  return Array.from({ length: channels }, () => 1)
}

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * The two K-weighting stages (high-shelf "pre-filter" and RLB high-pass) for any sample rate,
 * derived from their analog prototypes as in libebur128. At 48 kHz they match the coefficients
 * tabulated in BS.1770-4.
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = 10 ** (G / 20)
  const Vb = Vh ** 0.4996667741545416
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / sampleRate)
  a0 = 1 + K / Q + K * K
  const highPass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }
  return [shelf, highPass]
}

/** 4× oversampling interpolation filter from BS.1770-4 Annex 2 (48 taps as 4 phases of 12). */
const TRUE_PEAK_PHASES = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
]
const TAPS = 12

class ChannelState {
  // Direct form II transposed state of the two biquads.
  private s1 = [0, 0]
  private s2 = [0, 0]
  /** Last TAPS input samples (ring buffer) for the true-peak interpolator. */
  private readonly history = new Float64Array(TAPS)
  private pos = 0
  sumSquares = 0
  peak = 0
  private readonly stages: [Biquad, Biquad]

  constructor(stages: [Biquad, Biquad]) {
    this.stages = stages
  }

  push(x: number): void {
    // True peak on the unfiltered signal.
    this.history[this.pos] = x
    this.pos = (this.pos + 1) % TAPS
    let peak = Math.abs(x)
    for (const phase of TRUE_PEAK_PHASES) {
      let y = 0
      for (let j = 0; j < TAPS; j++) y += phase[j] * this.history[(this.pos - 1 - j + 2 * TAPS) % TAPS]
      peak = Math.max(peak, Math.abs(y))
    }
    if (peak > this.peak) this.peak = peak

    // K-weighting, then mean square.
    let v = x
    for (let i = 0; i < 2; i++) {
      const f = this.stages[i]
      const y = f.b0 * v + this.s1[i]
      this.s1[i] = f.b1 * v - f.a1 * y + this.s2[i]
      this.s2[i] = f.b2 * v - f.a2 * y
      v = y
    }
    this.sumSquares += v * v
  }
}

/** Sample-level part of the meter: feed it audio, get one block per 100 ms. */
export class LoudnessProcessor {
  private readonly blockSize: number
  private readonly stages: [Biquad, Biquad]
  private channels: ChannelState[] = []
  private weights: number[] = []
  private filled = 0

  constructor(sampleRate: number) {
    this.blockSize = Math.round((sampleRate * BLOCK_MS) / 1000)
    this.stages = kWeighting(sampleRate)
  }

  /** Processes one chunk (one Float32Array per channel, equal lengths). */
  process(input: readonly Float32Array[]): LoudnessBlock[] {
    if (input.length === 0) return []
    if (input.length !== this.channels.length) {
      // Layout changed (or first call): restart filters and the current block.
      this.channels = input.map(() => new ChannelState(this.stages))
      this.weights = channelWeights(input.length)
      this.filled = 0
    }
    const out: LoudnessBlock[] = []
    const length = input[0].length
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < input.length; c++) this.channels[c].push(input[c][i])
      if (++this.filled === this.blockSize) {
        let energy = 0
        let peak = 0
        this.channels.forEach((ch, c) => {
          energy += (this.weights[c] * ch.sumSquares) / this.blockSize
          peak = Math.max(peak, ch.peak)
          ch.sumSquares = 0
          ch.peak = 0
        })
        out.push({ energy, peak })
        this.filled = 0
      }
    }
    return out
  }
}

export interface LoudnessValues {
  /** 400 ms window, LUFS. */
  momentary: number
  /** 3 s window, LUFS. */
  shortTerm: number
  /** Gated over everything measured, LUFS. */
  integrated: number
  /** Max true peak since the start, dBTP. */
  truePeakMax: number
}

/**
 * Block-level part of the meter. Integrated loudness uses a histogram of gating-block loudness
 * (0.1 LU bins holding block counts and exact energy sums), so memory stays constant no matter how
 * long the measurement runs. Bins only quantize the relative-gate threshold, by at most 0.1 LU.
 */
export class LoudnessAnalyzer {
  private readonly recent: number[] = []
  private readonly counts = new Uint32Array(HIST_BINS)
  private readonly energies = new Float64Array(HIST_BINS)
  private peak = 0

  push(block: LoudnessBlock): void {
    this.recent.push(block.energy)
    if (this.recent.length > SHORT_TERM_BLOCKS) this.recent.shift()
    if (block.peak > this.peak) this.peak = block.peak
    if (this.recent.length >= MOMENTARY_BLOCKS) {
      // Every 100 ms completes a new 400 ms gating block (75 % overlap).
      const energy = this.mean(MOMENTARY_BLOCKS)
      const lufs = energyToLufs(energy)
      if (lufs > ABSOLUTE_GATE_LUFS) {
        const bin = Math.min(HIST_BINS - 1, Math.floor((lufs - HIST_MIN) / HIST_STEP))
        this.counts[bin]++
        this.energies[bin] += energy
      }
    }
  }

  values(): LoudnessValues {
    return {
      momentary: this.recent.length >= MOMENTARY_BLOCKS ? energyToLufs(this.mean(MOMENTARY_BLOCKS)) : Number.NEGATIVE_INFINITY,
      shortTerm: this.recent.length >= SHORT_TERM_BLOCKS ? energyToLufs(this.mean(SHORT_TERM_BLOCKS)) : Number.NEGATIVE_INFINITY,
      integrated: this.integrated(),
      truePeakMax: linearToDb(this.peak),
    }
  }

  private mean(n: number): number {
    let sum = 0
    for (let i = this.recent.length - n; i < this.recent.length; i++) sum += this.recent[i]
    return sum / n
  }

  private integrated(): number {
    const gatedMean = (fromBin: number) => {
      let count = 0
      let energy = 0
      for (let b = fromBin; b < HIST_BINS; b++) {
        count += this.counts[b]
        energy += this.energies[b]
      }
      return count ? energy / count : 0
    }
    const absolute = gatedMean(0)
    if (absolute === 0) return Number.NEGATIVE_INFINITY
    const threshold = energyToLufs(absolute) + RELATIVE_GATE_LU
    const fromBin = Math.max(0, Math.floor((threshold - HIST_MIN) / HIST_STEP))
    return energyToLufs(gatedMean(fromBin))
  }
}
