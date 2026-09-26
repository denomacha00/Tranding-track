// Real technical indicators, computed straight from the market's OWN candles —
// the same math TradingView draws. Every value here is derived from real OHLCV
// the chart already loaded; nothing is invented or back-filled. Each function
// returns points aligned to candle open times, and only for bars where the
// indicator is actually defined (e.g. an SMA(50) starts at the 50th bar), so
// lightweight-charts draws a clean line that begins where the math is valid.
import type { Candle } from './types'

// One plotted point. `time` is the candle's unix open time (seconds), matching
// the price series so overlays sit exactly on their bar.
export type LinePoint = { time: number; value: number }

// Which price-overlay indicators the user has switched on. Persisted so the
// choice sticks between visits (see App: loaded from / saved to localStorage).
export type IndicatorPrefs = {
  ema9: boolean
  ema21: boolean
  sma50: boolean
  sma200: boolean
  bb: boolean
  vwap: boolean
}

export const DEFAULT_INDICATORS: IndicatorPrefs = {
  ema9: false,
  ema21: false,
  sma50: false,
  sma200: false,
  bb: false,
  vwap: false,
}

// Simple moving average of the close over `period` bars.
export function sma(candles: Candle[], period: number): LinePoint[] {
  if (period <= 0) return []
  const out: LinePoint[] = []
  let sum = 0
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close
    if (i >= period) sum -= candles[i - period].close
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period })
  }
  return out
}

// Exponential moving average of the close. Seeded with the SMA of the first
// `period` closes (the standard warm-up), then rolled forward with k=2/(p+1).
export function ema(candles: Candle[], period: number): LinePoint[] {
  if (period <= 0 || candles.length < period) return []
  const k = 2 / (period + 1)
  const out: LinePoint[] = []
  let seed = 0
  for (let i = 0; i < period; i++) seed += candles[i].close
  let prev = seed / period
  out.push({ time: candles[period - 1].time, value: prev })
  for (let i = period; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k)
    out.push({ time: candles[i].time, value: prev })
  }
  return out
}

// Bollinger Bands: an SMA basis with an upper/lower envelope at `mult` standard
// deviations (population stddev over the same window). Returns three aligned
// lines. Classic defaults are period 20, mult 2.
export function bollinger(
  candles: Candle[],
  period = 20,
  mult = 2,
): { basis: LinePoint[]; upper: LinePoint[]; lower: LinePoint[] } {
  const basis: LinePoint[] = []
  const upper: LinePoint[] = []
  const lower: LinePoint[] = []
  if (period <= 0) return { basis, upper, lower }
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close
    const mean = sum / period
    let variance = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = candles[j].close - mean
      variance += d * d
    }
    const sd = Math.sqrt(variance / period)
    const t = candles[i].time
    basis.push({ time: t, value: mean })
    upper.push({ time: t, value: mean + mult * sd })
    lower.push({ time: t, value: mean - mult * sd })
  }
  return { basis, upper, lower }
}

// Volume-Weighted Average Price, accumulated from the first loaded bar using the
// typical price (H+L+C)/3 weighted by real volume. Anchored to the start of the
// loaded range (labelled as such in the UI), so it's honest about its window.
export function vwap(candles: Candle[]): LinePoint[] {
  const out: LinePoint[] = []
  let cumPV = 0
  let cumV = 0
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3
    const v = Number.isFinite(c.volume) ? c.volume : 0
    cumPV += typical * v
    cumV += v
    if (cumV > 0) out.push({ time: c.time, value: cumPV / cumV })
  }
  return out
}

// Relative Strength Index (Wilder's smoothing) over `period` bars. Returns 0–100
// points aligned to their bar, starting once the first averages are available.
export function rsi(candles: Candle[], period = 14): LinePoint[] {
  const out: LinePoint[] = []
  if (candles.length <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const ch = candles[i].close - candles[i - 1].close
    if (ch >= 0) gain += ch
    else loss -= ch
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  const rsiAt = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  out.push({ time: candles[period].time, value: rsiAt() })
  for (let i = period + 1; i < candles.length; i++) {
    const ch = candles[i].close - candles[i - 1].close
    const g = ch >= 0 ? ch : 0
    const l = ch < 0 ? -ch : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    out.push({ time: candles[i].time, value: rsiAt() })
  }
  return out
}
