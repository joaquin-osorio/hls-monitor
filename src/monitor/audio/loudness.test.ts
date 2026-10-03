import { describe, expect, it } from 'vitest'
import { channelWeights, kWeighting, linearToDb, LoudnessAnalyzer, LoudnessProcessor } from './loudness'

/** `seconds` of a sine per channel, as 128-sample render quanta like an AudioWorklet gets. */
function* sine(sampleRate: number, seconds: number, freq: number, amplitude: number, channels = 2, phase = 0) {
  const total = Math.round(sampleRate * seconds)
  for (let start = 0; start < total; start += 128) {
    const n = Math.min(128, total - start)
    const quantum = Array.from({ length: channels }, () => new Float32Array(n))
    for (let i = 0; i < n; i++) {
      const v = amplitude * Math.sin((2 * Math.PI * freq * (start + i)) / sampleRate + phase)
      for (const ch of quantum) ch[i] = v
    }
    yield quantum
  }
}

function* silence(sampleRate: number, seconds: number, channels = 2) {
  const total = Math.round(sampleRate * seconds)
  for (let start = 0; start < total; start += 128) {
    yield Array.from({ length: channels }, () => new Float32Array(Math.min(128, total - start)))
  }
}

function measure(sampleRate: number, ...signals: Iterable<Float32Array[]>[]) {
  const processor = new LoudnessProcessor(sampleRate)
  const analyzer = new LoudnessAnalyzer()
  for (const signal of signals) for (const quantum of signal) for (const block of processor.process(quantum)) analyzer.push(block)
  return analyzer.values()
}

const dbfs = (db: number) => 10 ** (db / 20)

/** EBU Tech 3341 accepts ±0.1 LU. */
function expectLufs(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.1)
}

describe('kWeighting', () => {
  it('matches the BS.1770-4 coefficients at 48 kHz', () => {
    const [shelf, highPass] = kWeighting(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10)
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 10)
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 10)
  })
})

describe('loudness', () => {
  it.each([48000, 44100])('reads a stereo 1 kHz sine at -23 dBFS as -23 LUFS at %i Hz (EBU Tech 3341 case 1)', (rate) => {
    const v = measure(rate, sine(rate, 20, 1000, dbfs(-23)))
    expectLufs(v.integrated, -23)
    expectLufs(v.momentary, -23)
    expectLufs(v.shortTerm, -23)
  })

  it('gates out silence from the integrated loudness', () => {
    const v = measure(48000, sine(48000, 10, 1000, dbfs(-23)), silence(48000, 20))
    // The 400 ms blocks straddling the tone/silence edge are partly loud and still count.
    expectLufs(v.integrated, -23)
    expect(v.momentary).toBe(Number.NEGATIVE_INFINITY)
  })

  it('applies the relative gate to quiet passages (EBU Tech 3341 case 3 style)', () => {
    // 10 s at -36 dBFS, 60 s at -23 dBFS, 10 s at -36 dBFS: the quiet parts fall below -10 LU.
    const rate = 48000
    const v = measure(rate, sine(rate, 10, 1000, dbfs(-36)), sine(rate, 60, 1000, dbfs(-23)), sine(rate, 10, 1000, dbfs(-36)))
    expectLufs(v.integrated, -23)
  })

  it('reports nothing before enough audio was measured', () => {
    expect(measure(48000)).toEqual({
      momentary: Number.NEGATIVE_INFINITY,
      shortTerm: Number.NEGATIVE_INFINITY,
      integrated: Number.NEGATIVE_INFINITY,
      truePeakMax: Number.NEGATIVE_INFINITY,
    })
  })
})

describe('true peak', () => {
  it('finds inter-sample peaks the sample values miss', () => {
    // fs/4 sine at 45°: samples only reach 0.707 of the amplitude.
    const amplitude = dbfs(-6)
    const v = measure(48000, sine(48000, 1, 12000, amplitude, 1, Math.PI / 4))
    expect(v.truePeakMax).toBeGreaterThan(linearToDb(amplitude) - 0.5)
    expect(v.truePeakMax).toBeLessThan(linearToDb(amplitude) + 0.5)
  })
})

describe('channelWeights', () => {
  it('excludes the LFE and boosts surrounds in 5.1', () => {
    expect(channelWeights(6)).toEqual([1, 1, 1, 0, 1.41, 1.41])
    expect(channelWeights(2)).toEqual([1, 1])
  })
})
