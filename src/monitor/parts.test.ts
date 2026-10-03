import { describe, expect, it } from 'vitest'
import type { RequestRecord } from './loader'
import { PartLog } from './parts'

function part(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    kind: 'fragment',
    url: 'https://cdn/s10.2.ts',
    outcome: 'success',
    status: 200,
    start: 1000,
    first: 1800,
    end: 1850,
    bytes: 50_000,
    sn: 10,
    level: 0,
    track: 'main',
    duration: 4,
    part: 2,
    partDuration: 1,
    independent: true,
    ...overrides,
  }
}

describe('PartLog', () => {
  it('keeps one record per part with hold time and retries', () => {
    const log = new PartLog()
    expect(log.recordAttempt(part({ outcome: 'error', status: 404, bytes: 0 }))).toBe(true)
    log.recordAttempt(part())
    expect(log.toArray()).toEqual([
      expect.objectContaining({ key: 'main:0:10.2', sn: 10, part: 2, duration: 1, independent: true, status: 'ok', attempts: 2, ttfbMs: 800, totalMs: 850, bytes: 50_000 }),
    ])
  })

  it('ignores full segments and aborts', () => {
    const log = new PartLog()
    expect(log.recordAttempt(part({ part: undefined }))).toBe(false)
    expect(log.recordAttempt(part({ outcome: 'abort' }))).toBe(false)
    expect(log.toArray()).toEqual([])
  })
})
