import { useEffect, useRef } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts'
import type { Candle } from './types'
import type { Theme } from './theme'

// Candlestick price chart powered by TradingView's lightweight-charts library.
//
// Live like an exchange chart: `candles` seeds the history, and `last` (a live
// ticker price polled every few seconds) moves the newest bar in real time via
// series.update() — the forming candle's close/high/low track the market
// without waiting for the next full OHLCV reload. Under the price sits a volume
// histogram; an OHLC + volume legend follows the crosshair (defaulting to the
// latest bar), and a countdown shows the time left on the forming candle — the
// same read-outs a TradingView chart gives you. Colours come from the active
// theme's CSS variables so it re-themes with the rest of the app.
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

// Translucent bar colours for the volume histogram — a secondary layer that
// reads clearly under the candles on either theme.
const VOL_UP = 'rgba(38, 166, 154, 0.45)'
const VOL_DOWN = 'rgba(239, 83, 80, 0.45)'

// Seconds per candle — used only to count down to the forming bar's close (the
// "time left" read-out, like TradingView). Frames we don't map show no timer.
const TF_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '12h': 43200,
  '1d': 86400,
  '1w': 604800,
}

function fmtPrice(v: number): string {
  const dp = Math.abs(v) < 10 ? 4 : 2
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

// Compact volume (1.23K / 4.56M / 7.89B) so a busy bar doesn't overflow.
function fmtVol(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K'
  return v.toFixed(a < 1 ? 4 : 2)
}

// mm:ss, or h:mm:ss once an hour or more remains.
function fmtDur(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p2(m)}:${p2(ss)}` : `${p2(m)}:${p2(ss)}`
}

export function PriceChart({
  candles,
  theme,
  last,
  liveBar,
  fitKey,
  symbol,
  timeframe,
  priceLines,
}: {
  candles: Candle[]
  theme: Theme
  last?: number | null
  // A full OHLCV frame for the forming/just-closed candle, straight from a
  // real-time kline WebSocket. When present it drives the newest bar (including
  // rolling over to a brand-new candle the instant the market opens one) and the
  // scalar `last` path is skipped — this is the exchange-grade live update. When
  // null (no stream) the chart falls back to moving the last bar by `last`.
  liveBar?: (Candle & { closed?: boolean }) | null
  // Changes when the symbol/timeframe changes. The chart re-fits the view only
  // when this changes (or on first data) so periodic reloads don't yank the
  // user's pan/zoom back — an exchange chart stays where you left it.
  fitKey?: string
  symbol?: string
  timeframe?: string
  // Horizontal reference levels drawn on the price axis (real "marking"): armed
  // price alerts and open-position entry / stop-loss / take-profit levels. Each
  // is a genuine number from the user's OWN data — nothing decorative or faked.
  priceLines?: { price: number; color?: string; title?: string }[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  // The newest bar, kept current so live ticks extend it rather than reset it.
  const lastBarRef = useRef<CandlestickData | null>(null)
  const lastVolRef = useRef<number | undefined>(undefined)
  // True while the pointer is over the chart, so live updates don't fight the
  // crosshair read-out for the bar the user is inspecting.
  const hoveringRef = useRef(false)
  const paletteRef = useRef<Palette | null>(null)
  const legendRef = useRef<HTMLSpanElement>(null)
  const countdownRef = useRef<HTMLDivElement>(null)
  // Tracks whether we've fitted the view, and for which symbol/timeframe.
  const didFitRef = useRef(false)
  const fitKeyRef = useRef<string | undefined>(undefined)
  // Horizontal price lines we've drawn (alert / SL / TP / entry markers), kept so
  // we can clear and redraw them when the set changes.
  const priceLineObjsRef = useRef<IPriceLine[]>([])

  // Paint the OHLC + volume legend for one bar. Values are all numeric, so
  // writing them via innerHTML is safe; the symbol/timeframe label is rendered
  // by React below (never interpolated here) to stay XSS-safe for typed pairs.
  const renderLegend = (bar: CandlestickData, vol: number | undefined) => {
    const el = legendRef.current
    const p = paletteRef.current
    if (!el || !p) return
    const chg = bar.close - bar.open
    const chgPct = bar.open ? (chg / bar.open) * 100 : 0
    const col = chg >= 0 ? p.up : p.down
    const sign = chg >= 0 ? '+' : ''
    el.innerHTML =
      `<span class="cl-k">O</span><span class="cl-v">${fmtPrice(bar.open)}</span>` +
      `<span class="cl-k">H</span><span class="cl-v">${fmtPrice(bar.high)}</span>` +
      `<span class="cl-k">L</span><span class="cl-v">${fmtPrice(bar.low)}</span>` +
      `<span class="cl-k">C</span><span class="cl-v">${fmtPrice(bar.close)}</span>` +
      `<span class="cl-chg" style="color:${col}">${sign}${fmtPrice(chg)} (${sign}${chgPct.toFixed(2)}%)</span>` +
      `<span class="cl-k">Vol</span><span class="cl-v" style="color:${col}">${fmtVol(vol)}</span>`
  }

  // Create the chart once on mount.
  useEffect(() => {
    if (!containerRef.current) return
    const p = readPalette()
    paletteRef.current = p
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: p.bg }, textColor: p.text },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      timeScale: { borderColor: p.grid, timeVisible: true },
      rightPriceScale: { borderColor: p.grid },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    })
    const series = chart.addCandlestickSeries({
      upColor: p.up,
      downColor: p.down,
      borderVisible: false,
      wickUpColor: p.up,
      wickDownColor: p.down,
    })
    // Leave room at the bottom for the volume histogram (its own overlay scale).
    series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } })
    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } })
    chartRef.current = chart
    seriesRef.current = series
    volumeRef.current = volume

    // Follow the crosshair: show the hovered bar, or fall back to the latest.
    const onMove = (param: MouseEventParams<Time>) => {
      const s = seriesRef.current
      if (!s) return
      if (param.time && param.seriesData.size) {
        const cd = param.seriesData.get(s) as CandlestickData | undefined
        const vd = volumeRef.current
          ? (param.seriesData.get(volumeRef.current) as HistogramData | undefined)
          : undefined
        if (cd) {
          hoveringRef.current = true
          renderLegend(cd, vd?.value)
          return
        }
      }
      hoveringRef.current = false
      if (lastBarRef.current) renderLegend(lastBarRef.current, lastVolRef.current)
    }
    chart.subscribeCrosshairMove(onMove)

    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      volumeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-colour in place when the theme flips (no teardown, keeps the live bar).
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return
    const p = readPalette()
    paletteRef.current = p
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
    if (lastBarRef.current && !hoveringRef.current) {
      renderLegend(lastBarRef.current, lastVolRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (volumeRef.current) {
      const vol: HistogramData[] = candles.map((c) => ({
        time: c.time as Time,
        value: c.volume,
        color: c.close >= c.open ? VOL_UP : VOL_DOWN,
      }))
      volumeRef.current.setData(vol)
    }
    lastBarRef.current = { ...data[data.length - 1] }
    lastVolRef.current = candles[candles.length - 1]?.volume
    if (!hoveringRef.current) renderLegend(lastBarRef.current, lastVolRef.current)
    // Fit the view on the first load and whenever the symbol/timeframe changes
    // (fitKey), but NOT on the periodic reloads of the same series — otherwise
    // every 10s refresh would snap the user's pan/zoom back to the full range.
    if (!didFitRef.current || fitKeyRef.current !== fitKey) {
      chartRef.current?.timeScale().fitContent()
      didFitRef.current = true
      fitKeyRef.current = fitKey
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, fitKey])

  // Move the newest bar live as the ticker price updates. Skipped entirely when
  // a real-time kline stream is feeding `liveBar` — that path is richer (true
  // OHLC + volume + rollover) and the two must not fight over the same bar.
  useEffect(() => {
    if (liveBar) return
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
    if (!hoveringRef.current) renderLegend(updated, lastVolRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, liveBar])

  // Real-time kline stream: move (and roll over) the newest bar from full OHLCV
  // frames — the same data an exchange chart draws — so a fresh candle appears
  // the instant the market opens it, not on the next REST reload. Out-of-order
  // frames older than the bar on screen are ignored.
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !liveBar) return
    if (!Number.isFinite(liveBar.close) || liveBar.close <= 0) return
    const prev = lastBarRef.current
    if (prev && (liveBar.time as number) < (prev.time as number)) return
    const bar: CandlestickData = {
      time: liveBar.time as Time,
      open: liveBar.open,
      high: liveBar.high,
      low: liveBar.low,
      close: liveBar.close,
    }
    series.update(bar)
    lastBarRef.current = bar
    if (volumeRef.current && Number.isFinite(liveBar.volume)) {
      volumeRef.current.update({
        time: liveBar.time as Time,
        value: liveBar.volume,
        color: liveBar.close >= liveBar.open ? VOL_UP : VOL_DOWN,
      })
      lastVolRef.current = liveBar.volume
    }
    if (!hoveringRef.current) renderLegend(bar, lastVolRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBar])

  // Count down to the forming candle's close (open time + one frame), ticking
  // every second. Frames without a known length simply show no timer.
  useEffect(() => {
    const el = countdownRef.current
    if (!el) return
    const secs = TF_SECONDS[timeframe ?? '']
    const lastBar = candles[candles.length - 1]
    if (!secs || !lastBar) {
      el.textContent = ''
      return
    }
    const tick = () => {
      // Prefer the live forming bar's open time (kept current by the live/stream
      // effects) so the timer rolls over the instant a new candle opens, not on
      // the next REST reload; fall back to the seeded last bar.
      const openT = (lastBarRef.current?.time as number) ?? (lastBar.time as number)
      el.textContent = '⏱ ' + fmtDur(openT + secs - Math.floor(Date.now() / 1000))
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [candles, timeframe])

  // Draw horizontal reference levels (real "marking"): armed price alerts and
  // open-position entry/SL/TP. Cleared and redrawn only when the set actually
  // changes (via a stable key) so live ticks never churn them. Every level is a
  // real number from the user's own data — the chart never invents a line.
  const priceLinesKey = JSON.stringify(
    (priceLines ?? []).map((l) => [l.price, l.color, l.title]),
  )
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const ln of priceLineObjsRef.current) {
      try {
        series.removePriceLine(ln)
      } catch {
        /* series already torn down */
      }
    }
    priceLineObjsRef.current = []
    for (const pl of priceLines ?? []) {
      if (!Number.isFinite(pl.price) || pl.price <= 0) continue
      priceLineObjsRef.current.push(
        series.createPriceLine({
          price: pl.price,
          color: pl.color || '#8b98a9',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: pl.title || '',
        }),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceLinesKey])

  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        <span className="cl-sym">
          {symbol || ''}
          {timeframe ? ` · ${timeframe}` : ''}
        </span>
        <span className="cl-ohlc" ref={legendRef} />
      </div>
      <div className="chart-countdown" ref={countdownRef} title="Time left until this candle closes" />
      <div className="chart" ref={containerRef} />
    </div>
  )
}
