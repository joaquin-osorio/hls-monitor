import { describe, expect, it } from 'vitest'
import { escapeCell, formatDuration, isoTime, round, table } from './markdown'

describe('table', () => {
  it('escapes pipes and collapses line breaks so a cell cannot break the row', () => {
    const out = table(['Message'], [['a | b\nnext line']])
    expect(out.split('\n')).toEqual(['| Message |', '| --- |', '| a \\| b next line |'])
  })

  it('renders missing, non-finite and boolean values readably', () => {
    expect(table(['a', 'b', 'c', 'd'], [[undefined, Number.NEGATIVE_INFINITY, true, 0]]).split('\n')[2]).toBe('| — | — | yes | 0 |')
  })

  it('says there is no data instead of emitting a header-only table', () => {
    expect(table(['a'], [])).toBe('_No data._')
  })
})

describe('escapeCell', () => {
  it('keeps backslashes from escaping the cell separator', () => {
    expect(escapeCell('C:\\|x')).toBe('C:\\\\\\|x')
  })
})

describe('helpers', () => {
  it('converts performance.now() timestamps to ISO UTC using the time origin', () => {
    expect(isoTime(1500, Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02T03:04:06.500Z')
  })

  it('rounds and drops non-finite values', () => {
    expect(round(1.23456, 2)).toBe(1.23)
    expect(round(Number.NaN)).toBeUndefined()
  })

  it('formats durations', () => {
    expect(formatDuration(3400)).toBe('3.4 s')
    expect(formatDuration(123_000)).toBe('2m 03s')
    expect(formatDuration(3_723_000)).toBe('1h 02m 03s')
  })
})
