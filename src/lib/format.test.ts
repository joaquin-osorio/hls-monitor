import { describe, expect, it } from 'vitest'
import { formatBitrate, formatBytes, formatMs, formatSeconds } from './format'

describe('format', () => {
  it('formats bitrates', () => {
    expect(formatBitrate(850_000)).toBe('850 kbps')
    expect(formatBitrate(4_200_000)).toBe('4.20 Mbps')
    expect(formatBitrate(undefined)).toBe('—')
  })

  it('formats durations and sizes', () => {
    expect(formatMs(123.4)).toBe('123 ms')
    expect(formatMs(12_345)).toBe('12.3 s')
    expect(formatSeconds(3.456)).toBe('3.5 s')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1_048_576)).toBe('3.00 MB')
  })
})
