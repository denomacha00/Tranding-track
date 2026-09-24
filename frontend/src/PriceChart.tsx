import { useEffect, useRef } from 'react'
import {
  createChart,
  ColorType,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import type { Candle } from './types'
import type { Theme } from './theme'

// Candlestick price chart powered by TradingView's lightweight-charts library.
//
// Live like an exchange chart: `candles` seeds the history, and `last` (a live
// ticker price polled every few seconds) moves the newest bar in real time via
// series.update() — the forming candle's close/high/low track the market
// without waiting for the next full OHLCV reload. Colours are read from the
// active theme's CSS variables so it re-themes with the rest of the app.
type Palette = {
  bg: string
  text: string
  grid: string
  up: string
  down: string
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--chart-bg', '#151b24'),
    text: v('--muted', '#8b98a9'),
    grid: v('--border', '#263241'),
    up: v('--green', '#16c784'),
    down: v('--red', '#ea3943'),
  }
}

export function PriceChart({
  candles,
  theme,
  last,
  fitKey,
}: {
  candles: Candle[]
  theme: Theme
  last?: number | null
  // Changes when the symbol/timeframe changes. The chart re-fits the view only
  // when this changes (or on first data) so periodic reloads don't yank the
  // user's pan/zoom back — an exchange chart stays where you left it.
  fitKey?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  // The newest bar, kept current so live ticks extend it rather than reset it.
  const lastBarRef = useRef<CandlestickData | null>(null)
  // Tracks whether we've fitted the view, and for which symbol/timeframe.
  const didFitRef = useRef(false)
  const fitKeyRef = useRef<string | undefined>(undefined)

  // Create the chart once on mount.
  useEffect(() => {
    if (!containerRef.current) return
    const p = readPalette()
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: p.bg }, textColor: p.text },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      timeScale: { borderColor: p.grid, timeVisible: true },
      rightPriceScale: { borderColor: p.grid },
      autoSize: true,
    })
    const series = chart.addCandlestickSeries({
      upColor: p.up,
      downColor: p.down,
      borderVisible: false,
      wickUpColor: p.up,
      wickDownColor: p.down,
    })
    chartRef.current = chart
    seriesRef.current = series
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  // Re-colour in place when the theme flips (no teardown, keeps the live bar).
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return
    const p = readPalette()
    chartRef.current.applyOptions({
      layout: { background: { type: ColorType.Solid, color: p.bg }, textColor: p.text },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      timeScale: { borderColor: p.grid },
      rightPriceScale: { borderColor: p.grid },
    })
    seriesRef.current.applyOptions({
      upColor: p.up,
      downColor: p.down,
      wickUpColor: p.up,
      wickDownColor: p.down,
    })
  }, [theme])

  // Seed / replace the full history when the candle set changes.
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    const data: CandlestickData[] = candles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))
    seriesRef.current.setData(data)
    lastBarRef.current = { ...data[data.length - 1] }
    // Fit the view on the first load and whenever the symbol/timeframe changes
    // (fitKey), but NOT on the periodic reloads of the same series — otherwise
    // every 10s refresh would snap the user's pan/zoom back to the full range.
    if (!didFitRef.current || fitKeyRef.current !== fitKey) {
      chartRef.current?.timeScale().fitContent()
      didFitRef.current = true
      fitKeyRef.current = fitKey
    }
  }, [candles, fitKey])

  // Move the newest bar live as the ticker price updates.
  useEffect(() => {
    if (!seriesRef.current || last == null || !Number.isFinite(last) || last <= 0) return
    const bar = lastBarRef.current
    if (!bar) return
    const updated: CandlestickData = {
      time: bar.time,
      open: bar.open,
      high: Math.max(bar.high, last),
      low: Math.min(bar.low, last),
      close: last,
    }
    lastBarRef.current = updated
    seriesRef.current.update(updated)
  }, [last])

  return <div className="chart" ref={containerRef} />
}
