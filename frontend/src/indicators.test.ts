import { describe, it, expect } from 'vitest'
import { sma, ema, rsi, vwap, bollinger, macd } from './indicators'
import type { Candle } from './types'

// Build candles from a list of closes. time is a simple 60s grid; OHLC default
// to the close, volume defaults to 1 unless a parallel volumes array is given.
function candles(closes: number[], opts?: { highs?: number[]; lows?: number[]; vols?: number[] }): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 60,
    open: c,
    high: opts?.highs?.[i] ?? c,
    low: opts?.lows?.[i] ?? c,
    close: c,
    volume: opts?.vols?.[i] ?? 1,
  }))
}

describe('sma', () => {
  it('averages the close over the window and starts at the (period-1)th bar', () => {
    const out = sma(candles([1, 2, 3, 4, 5]), 3)
    expect(out.map((p) => p.value)).toEqual([2, 3, 4])
    // First point aligns to the 3rd candle's time (index 2).
    expect(out[0].time).toBe(1_700_000_000 + 2 * 60)
  })
  it('returns nothing for a period longer than the data', () => {
    expect(sma(candles([1, 2]), 5)).toEqual([])
  })
})

describe('ema', () => {
  it('is SMA-seeded then rolled with k=2/(p+1)', () => {
    // closes [1,2,3,10,10], period 3: seed=(1+2+3)/3=2, k=0.5
    // idx3 = 10*.5 + 2*.5 = 6 ; idx4 = 10*.5 + 6*.5 = 8
    const out = ema(candles([1, 2, 3, 10, 10]), 3)
    expect(out.map((p) => p.value)).toEqual([2, 6, 8])
  })
})

describe('rsi', () => {
  it('is 100 when every bar closes higher (no losses)', () => {
    const out = rsi(candles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 14)
    expect(out[out.length - 1].value).toBe(100)
  })
  it('stays within 0..100', () => {
    const out = rsi(candles([5, 4, 6, 3, 7, 2, 8, 1, 9, 4, 6, 3, 7, 5, 8, 2, 9]), 14)
    for (const p of out) {
      expect(p.value).toBeGreaterThanOrEqual(0)
      expect(p.value).toBeLessThanOrEqual(100)
    }
  })
})

describe('vwap', () => {
  it('equals the typical price when every bar shares it', () => {
    const out = vwap(candles([10, 10, 10], { highs: [10, 10, 10], lows: [10, 10, 10], vols: [5, 2, 3] }))
    expect(out.every((p) => p.value === 10)).toBe(true)
  })
})

describe('bollinger', () => {
  it('has upper >= basis >= lower and basis equal to the SMA', () => {
    const c = candles([1, 3, 2, 5, 4, 6, 5, 8, 7, 9, 8, 10, 9, 12, 11, 13, 12, 15, 14, 16, 15])
    const bb = bollinger(c, 20, 2)
    const basis = sma(c, 20)
    expect(bb.basis[0].value).toBeCloseTo(basis[0].value, 10)
    for (let i = 0; i < bb.basis.length; i++) {
      expect(bb.upper[i].value).toBeGreaterThanOrEqual(bb.basis[i].value)
      expect(bb.basis[i].value).toBeGreaterThanOrEqual(bb.lower[i].value)
    }
  })
})

describe('macd', () => {
  it('line = EMA(fast) - EMA(slow) and histogram = line - signal, all time-aligned', () => {
    // A ramp then a drop, long enough for slow EMA(26) + signal(9) to exist.
    const closes = Array.from({ length: 60 }, (_, i) => (i < 40 ? 100 + i : 140 - (i - 40) * 2))
    const c = candles(closes)
    const m = macd(c, 12, 26, 9)
    expect(m.macd.length).toBeGreaterThan(0)
    expect(m.signal.length).toBeGreaterThan(0)
    expect(m.histogram.length).toBe(m.signal.length)
    // Histogram is exactly line - signal on the signal's own timestamps.
    const lineAt = new Map(m.macd.map((p) => [p.time, p.value]))
    for (const h of m.histogram) {
      const sig = m.signal.find((s) => s.time === h.time)!
      expect(h.value).toBeCloseTo((lineAt.get(h.time) as number) - sig.value, 10)
    }
  })
})
