// Live public market data streamed straight from Binance in the browser.
//
// The REST endpoints (/api/ticker, /api/ohlcv, /api/orderbook) are honest but
// POLLED — a few seconds between updates — so a fast market visibly lags a
// TradingView chart. When the account is on REAL (non-testnet) Binance.com,
// this hook opens Binance's PUBLIC combined WebSocket stream directly from the
// user's browser and pushes:
//   - price  : last trade price (aggTrade), sub-second
//   - candle : the forming / just-closed kline for `timeframe`
//   - book   : top-of-book depth (bids/asks) at 100ms
// so the chart, price and order book move the SAME as an exchange chart.
//
// It is PUBLIC data only: no API key, no secrets, read-only. It connects from
// the BROWSER (not the server), so it also sidesteps a server-side region
// block. REST stays the seed (history) and the fallback whenever the stream
// isn't available (testnet, a non-Binance venue, or the socket being down):
// nothing here is ever fabricated — if the socket isn't live, `streaming` is
// false and the caller shows the polled data instead.
import { useEffect, useState } from 'react'
import type { Candle, OrderBook } from './types'

// App timeframe -> Binance kline interval (they line up 1:1 for the frames the
// app offers). An unmapped frame simply skips the kline stream; price + depth
// still stream and the forming bar is driven by the trade price.
const KLINE_INTERVALS = new Set([
  '1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w',
])

// 'BTC/USDT' -> 'btcusdt' (Binance stream names are lowercase, no slash).
function streamSymbol(symbol: string): string {
  return symbol.replace('/', '').toLowerCase()
}

export type LiveCandle = Candle & { closed: boolean }

export type StreamState = {
  price: number | null
  candle: LiveCandle | null
  book: OrderBook | null
  streaming: boolean
}

export function useBinanceStream(
  symbol: string,
  timeframe: string,
  enabled: boolean,
): StreamState {
  const [price, setPrice] = useState<number | null>(null)
  const [candle, setCandle] = useState<LiveCandle | null>(null)
  const [book, setBook] = useState<OrderBook | null>(null)
  const [streaming, setStreaming] = useState(false)

  useEffect(() => {
    // Reset on every (symbol/timeframe/enabled) change so a previous market's
    // ticks never bleed into the new one.
    setPrice(null)
    setCandle(null)
    setBook(null)
    setStreaming(false)
    if (!enabled || !symbol.includes('/')) return

    const s = streamSymbol(symbol)
    const streams = [`${s}@aggTrade`, `${s}@depth20@100ms`]
    if (KLINE_INTERVALS.has(timeframe)) streams.push(`${s}@kline_${timeframe}`)
    const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`

    let alive = true
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let backoff = 1000
    // Coalesce high-frequency ticks into ~5 renders/sec: trades can arrive
    // dozens of times a second, but the eye (and the chart) only needs a smooth
    // cadence. The newest value in each window wins.
    let pendingPrice: number | null = null
    let pendingBook: OrderBook | null = null
    let pendingCandle: LiveCandle | null = null
    const flush = setInterval(() => {
      if (!alive) return
      if (pendingPrice != null) { setPrice(pendingPrice); pendingPrice = null }
      if (pendingBook) { setBook(pendingBook); pendingBook = null }
      if (pendingCandle) { setCandle(pendingCandle); pendingCandle = null }
    }, 200)

    const toLevels = (rows: [string, string][] | undefined) =>
      (rows || [])
        .map((r) => ({ price: Number(r[0]), amount: Number(r[1]) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.amount))

    const connect = () => {
      if (!alive) return
      ws = new WebSocket(url)
      ws.onopen = () => {
        if (alive) { setStreaming(true); backoff = 1000 }
      }
      ws.onmessage = (ev) => {
        if (!alive) return
        let msg: { stream?: string; data?: Record<string, unknown> }
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        } catch {
          return
        }
        const stream = msg?.stream || ''
        const data = msg?.data as Record<string, unknown> | undefined
        if (!data) return
        if (stream.endsWith('@aggTrade')) {
          const p = Number(data.p)
          if (Number.isFinite(p) && p > 0) pendingPrice = p
        } else if (stream.includes('@kline_')) {
          const k = data.k as Record<string, unknown> | undefined
          if (k) {
            const close = Number(k.c)
            pendingCandle = {
              time: Math.floor(Number(k.t) / 1000),
              open: Number(k.o),
              high: Number(k.h),
              low: Number(k.l),
              close,
              volume: Number(k.v),
              closed: Boolean(k.x),
            }
            if (Number.isFinite(close) && close > 0) pendingPrice = close
          }
        } else if (stream.includes('@depth')) {
          pendingBook = {
            symbol,
            bids: toLevels(data.bids as [string, string][] | undefined),
            asks: toLevels(data.asks as [string, string][] | undefined),
            source: 'binance',
          }
        }
      }
      const scheduleReconnect = () => {
        if (!alive) return
        setStreaming(false)
        if (retry) clearTimeout(retry)
        retry = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 15000)
      }
      ws.onerror = () => {
        try { ws?.close() } catch { /* ignore */ }
      }
      ws.onclose = scheduleReconnect
    }
    connect()

    return () => {
      alive = false
      clearInterval(flush)
      if (retry) clearTimeout(retry)
      if (ws) {
        ws.onclose = null // don't reconnect on an intentional teardown
        try { ws.close() } catch { /* ignore */ }
      }
    }
  }, [symbol, timeframe, enabled])

  return { price, candle, book, streaming }
}
