import { describe, expect, it, vi } from 'vitest'
import { isMixedContent, probeCors } from './cors'

describe('probeCors', () => {
  it('reports reachable when the no-cors HEAD resolves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null))
    await expect(probeCors('https://cdn/x.m3u8', fetchImpl)).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn/x.m3u8',
      expect.objectContaining({ method: 'HEAD', mode: 'no-cors' }),
    )
  })

  it('reports unreachable when the probe rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(probeCors('https://down/x.m3u8', fetchImpl)).resolves.toBe(false)
  })
})

describe('isMixedContent', () => {
  it('flags http streams on https pages only', () => {
    expect(isMixedContent('http://cdn/x.m3u8', 'https:')).toBe(true)
    expect(isMixedContent('https://cdn/x.m3u8', 'https:')).toBe(false)
    expect(isMixedContent('http://cdn/x.m3u8', 'http:')).toBe(false)
    expect(isMixedContent('not a url', 'https:')).toBe(false)
  })
})
