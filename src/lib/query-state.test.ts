import { describe, expect, it } from 'vitest'
import { parseQueryState, serializeQueryState } from './query-state'

describe('parseQueryState', () => {
  it('reads url and a numeric variant', () => {
    expect(parseQueryState('?url=https%3A%2F%2Fcdn%2Fm.m3u8&variant=2')).toEqual({
      url: 'https://cdn/m.m3u8',
      variant: 2,
    })
  })

  it.each(['', '?variant=auto', '?variant=-1', '?variant=1.5', '?variant=abc'])(
    'falls back to auto for %j',
    (search) => {
      expect(parseQueryState(search).variant).toBe('auto')
    },
  )

  it('treats an empty url as missing', () => {
    expect(parseQueryState('?url=%20').url).toBeNull()
  })
})

describe('serializeQueryState', () => {
  it('round-trips through parse', () => {
    const state = { url: 'https://cdn/a b.m3u8?token=1&x=2', variant: 3 }
    expect(parseQueryState(serializeQueryState(state))).toEqual(state)
  })

  it('omits auto variant and null url, keeping unrelated params', () => {
    expect(serializeQueryState({ url: null, variant: 'auto' }, '?url=x&variant=1&debug=1')).toBe('?debug=1')
  })
})
