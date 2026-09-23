import { useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import type { Candle } from './types'

// Candlestick price chart powered by TradingView's lightweight-charts library.
export function PriceChart({ candles }: { candles: Candle[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#151a21' },
        textColor: '#8b98a9',
      },
      grid: {
        vertLines: { color: '#232c38' },
        horzLines: { color: '#232c38' },
      },
      timeScale: { borderColor: '#232c38', timeVisible: true },
      rightPriceScale: { borderColor: '#232c38' },
      autoSize: true,
    })
    const series = chart.addCandlestickSeries({
      upColor: '#16c784',
      downColor: '#ea3943',
      borderVisible: false,
      wickUpColor: '#16c784',
      wickDownColor: '#ea3943',
    })
    chartRef.current = chart
    seriesRef.current = series
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return
    seriesRef.current.setData(
      candles.map((c) => ({
        time: c.time as never,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    )
    chartRef.current?.timeScale().fitContent()
  }, [candles])

  return <div className="chart" ref={containerRef} />
}
