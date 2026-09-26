import { useEffect, useRef } from 'react'
import type { Theme } from './theme'

// Full TradingView chart, embedded as their real, free "Advanced Chart" widget.
// This is the genuine TradingView graph — every drawing tool (trend lines, the
// long/short position tool, the measure ruler, fib, rectangles), every built-in
// indicator, symbol search and multi-timeframe — served from TradingView's own
// data feed. It is a sealed widget, so it shows the live MARKET, not this bot's
// own trades/stops (the "Bot chart" view keeps those, marked on real data). We
// point it at the SAME venue the bot uses (BINANCE:<PAIR>) so the two agree.
//
// Nothing about the user's account, keys or balances is sent here — the widget
// only requests a public chart for a symbol. Drawings you make are saved by
// TradingView itself when you're signed in to a TradingView account in it.

// tv.js is loaded once and reused across mounts.
let tvScriptPromise: Promise<void> | null = null
function loadTv(): Promise<void> {
  if (tvScriptPromise) return tvScriptPromise
  tvScriptPromise = new Promise<void>((resolve, reject) => {
    if ((window as unknown as { TradingView?: unknown }).TradingView) {
      resolve()
      return
    }
    const s = document.createElement('script')
    s.src = 'https://s3.tradingview.com/tv.js'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Could not load TradingView'))
    document.head.appendChild(s)
  })
  return tvScriptPromise
}

// "BTC/USDT" -> "BINANCE:BTCUSDT" so the embedded chart shows the same Binance
// market the bot trades. Falls back to a raw uppercased symbol if it's odd.
function toTvSymbol(symbol: string): string {
  const parts = symbol.split('/')
  if (parts.length === 2) return `BINANCE:${parts[0].toUpperCase()}${parts[1].toUpperCase()}`
  return symbol.replace('/', '').toUpperCase()
}

// App timeframe -> TradingView interval code.
const TF_TO_INTERVAL: Record<string, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': 'D',
  '1w': 'W',
}

export function TradingViewChart({
  symbol,
  timeframe,
  theme,
}: {
  symbol: string
  timeframe: string
  theme: Theme
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const errRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    // A fresh inner container each (re)build; TradingView fills it by id.
    const id = `tv_${Math.random().toString(36).slice(2)}`
    host.innerHTML = ''
    const inner = document.createElement('div')
    inner.id = id
    inner.style.height = '100%'
    inner.style.width = '100%'
    host.appendChild(inner)

    loadTv()
      .then(() => {
        if (cancelled) return
        const TV = (window as unknown as { TradingView?: { widget: new (o: unknown) => unknown } })
          .TradingView
        if (!TV) throw new Error('TradingView unavailable')
        new TV.widget({
          container_id: id,
          symbol: toTvSymbol(symbol),
          interval: TF_TO_INTERVAL[timeframe] ?? '60',
          autosize: true,
          theme: theme === 'light' ? 'light' : 'dark',
          style: '1', // candles
          timezone: 'Etc/UTC',
          locale: 'en',
          hide_side_toolbar: false, // show the full drawing-tools rail
          allow_symbol_change: true,
          withdateranges: true,
          details: false,
          calendar: false,
        })
      })
      .catch(() => {
        if (cancelled || !errRef.current) return
        errRef.current.textContent =
          'TradingView chart could not load (network blocked?). Your Bot chart still works.'
      })

    return () => {
      cancelled = true
      host.innerHTML = ''
    }
  }, [symbol, timeframe, theme])

  return (
    <div className="chart-wrap tv-wrap">
      <div className="tv-host" ref={hostRef} />
      <div className="empty tv-err" ref={errRef} />
    </div>
  )
}
