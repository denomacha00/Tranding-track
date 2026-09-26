import { describe, it, expect } from 'vitest'
import { volumeProfile } from './volumeProfile'
import type { Candle } from './types'

// Build candles; OHLC default to the close, volume defaults to 1. Pass highs/
// lows/vols to shape the price range and the traded volume per bar.
function candles(
  closes: number[],
  opts?: { highs?: number[]; lows?: number[]; vols?: number[] },
): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 60,
    open: c,
    high: opts?.highs?.[i] ?? c,
    low: opts?.lows?.[i] ?? c,
    close: c,
    volume: opts?.vols?.[i] ?? 1,
  }))
}

const sumRows = (vols: number[]) => vols.reduce((a, b) => a + b, 0)

describe('volumeProfile', () => {
  it('returns empty for no candles', () => {
    const vp = volumeProfile([])
    expect(vp.rows).toEqual([])
    expect(vp.poc).toBeNull()
    expect(vp.maxVolume).toBe(0)
  })

  it('collapses a flat price range into one bucket holding all the volume', () => {
    const vp = volumeProfile(candles([100, 100, 100], { vols: [2, 3, 5] }), 24)
    expect(vp.rows).toHaveLength(1)
    expect(vp.rows[0].volume).toBe(10)
    expect(vp.poc).toBe(100)
  })

  it('conserves total volume across the buckets (nothing invented or lost)', () => {
    const c = candles([101, 103, 107, 104, 109], {
      lows: [100, 102, 105, 103, 108],
      highs: [102, 105, 108, 106, 110],
      vols: [4, 9, 2, 6, 3],
    })
    const vp = volumeProfile(c, 8)
    expect(sumRows(vp.rows.map((r) => r.volume))).toBeCloseTo(4 + 9 + 2 + 6 + 3, 6)
  })

  it('spreads one wide bar evenly across the buckets it spans', () => {
    // A single bar low=100 high=104 sets the range; across 4 buckets its volume
    // splits equally (overlap 1 of 4 each).
    const vp = volumeProfile(candles([102], { lows: [100], highs: [104], vols: [8] }), 4)
    expect(vp.rows).toHaveLength(4)
    for (const r of vp.rows) expect(r.volume).toBeCloseTo(2, 6)
  })

  it('puts the POC at the price band where the most volume traded', () => {
    // Heavy volume clustered at 100, light at 105/110.
    const vp = volumeProfile(candles([100, 100, 105, 110], { vols: [5, 5, 1, 1] }), 10)
    expect(vp.maxVolume).toBe(10)
    expect(vp.poc).not.toBeNull()
    expect(vp.poc as number).toBeGreaterThanOrEqual(100)
    expect(vp.poc as number).toBeLessThanOrEqual(101)
  })

  it('clamps a non-positive bin count to a single bucket', () => {
    const vp = volumeProfile(candles([100, 101, 102], { vols: [1, 1, 1] }), 0)
    expect(vp.rows).toHaveLength(1)
    expect(vp.rows[0].volume).toBe(3)
  })

  it('ignores non-finite / negative volumes without throwing', () => {
    const c = candles([100, 101, 102], { vols: [Number.NaN, -5, 4] })
    const vp = volumeProfile(c, 4)
    expect(sumRows(vp.rows.map((r) => r.volume))).toBeCloseTo(4, 6)
  })
})
