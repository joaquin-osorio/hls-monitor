import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlignmentProber } from './alignment-prober'

const VARIANTS = [
  { level: 0, uri: 'https://cdn/0.m3u8' },
  { level: 1, uri: 'https://cdn/1.m3u8' },
]

describe('AlignmentProber', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fetches every variant once and repeats only while onResult asks for it', async () => {
    const fetchFn = vi.fn(async (uri: string) => (uri.includes('1') ? new Response('', { status: 404 }) : new Response('#EXTM3U')))
    const onResult = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const prober = new AlignmentProber(VARIANTS, onResult, fetchFn, 1000)

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce())
    expect(onResult).toHaveBeenLastCalledWith(
      [
        { level: 0, uri: 'https://cdn/0.m3u8', text: '#EXTM3U' },
        { level: 1, uri: 'https://cdn/1.m3u8', error: 'HTTP 404' },
      ],
      2,
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(onResult).toHaveBeenCalledTimes(2)
    expect(onResult.mock.calls[1][1]).toBe(4)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onResult).toHaveBeenCalledTimes(2)
    prober.destroy()
  })

  it('reports network failures and stops after destroy', async () => {
    let reject!: (e: Error) => void
    const fetchFn = vi.fn(() => new Promise<Response>((_, r) => (reject = r)))
    const onResult = vi.fn(() => true)
    const prober = new AlignmentProber(VARIANTS.slice(0, 1), onResult, fetchFn, 1000)
    prober.destroy()
    reject(new Error('aborted'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(onResult).not.toHaveBeenCalled()
    expect(fetchFn).toHaveBeenCalledWith('https://cdn/0.m3u8', expect.objectContaining({ cache: 'no-store' }))
  })
})
