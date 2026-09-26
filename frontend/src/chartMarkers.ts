// Real trade markers for the bot chart: arrows drawn on the exact bars where a
// trade actually opened and closed, straight from the user's OWN trade history.
// Nothing is invented — an entry arrow appears only for a trade that genuinely
// filled (status open/closed), and an exit arrow only once it really closed. A
// pending/resting order (no fill yet) gets no arrow. This is the honest answer to
// "let me SEE on the chart where I got in, and whether I came out ahead."
import type { Trade } from './types'

// One marker in the shape lightweight-charts' series.setMarkers() consumes. Kept
// as a plain local type (no charting import) so this stays a pure, unit-testable
// function; PriceChart casts it to the library's SeriesMarker.
export type ChartMarker = {
  time: number
  position: 'aboveBar' | 'belowBar'
  color: string
  shape: 'arrowUp' | 'arrowDown'
  text: string
}

// Colours mirror the app theme's --green / --red so markers read the same as the
// rest of the UI. Literals (not read from the DOM) keep this function pure.
const GREEN = '#16c784'
const RED = '#ea3943'

// Snap a unix time to the open of its candle so the marker lands exactly on a
// real bar (a trade filled mid-candle still marks that candle).
function bucket(tsSeconds: number, tfSeconds: number): number {
  if (!tfSeconds || tfSeconds <= 0) return tsSeconds
  return Math.floor(tsSeconds / tfSeconds) * tfSeconds
}

// ISO timestamp -> unix seconds, or null if absent/unparseable (then no marker).
function parseSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

function isBuy(side: string): boolean {
  const s = side.toLowerCase()
  return s.includes('buy') || s.includes('long')
}

// Compact base-amount label (0.012 BTC etc.) — enough precision to be honest
// without overflowing the little marker tag.
function fmtAmt(n: number): string {
  if (!Number.isFinite(n)) return ''
  const a = Math.abs(n)
  if (a >= 1000) return n.toFixed(0)
  if (a >= 1) return n.toFixed(3)
  return n.toFixed(6)
}

// Map the user's trades for ONE symbol to entry/exit markers, sorted ascending by
// time (lightweight-charts requires that order). `tfSeconds` is the chart's
// timeframe so fills snap onto their bar.
export function tradesToMarkers(trades: Trade[], symbol: string, tfSeconds: number): ChartMarker[] {
  const sym = symbol.toUpperCase()
  const markers: ChartMarker[] = []
  for (const t of trades) {
    if (t.symbol.toUpperCase() !== sym) continue
    // Only trades that actually filled get an entry arrow — never a resting/
    // pending order that hasn't executed (that would be a fake fill).
    if (t.status !== 'open' && t.status !== 'closed') continue
    const buy = isBuy(t.side)
    const entryT = parseSeconds(t.opened_at)
    if (entryT != null) {
      markers.push({
        time: bucket(entryT, tfSeconds),
        position: buy ? 'belowBar' : 'aboveBar',
        color: buy ? GREEN : RED,
        shape: buy ? 'arrowUp' : 'arrowDown',
        text: `${buy ? 'BUY' : 'SELL'} ${fmtAmt(t.amount)}`,
      })
    }
    if (t.status === 'closed') {
      const exitT = parseSeconds(t.closed_at)
      if (exitT != null) {
        const win = t.pnl >= 0
        markers.push({
          // The exit is the opposite action (closing a long is a sell, a short a
          // buy); colour it by realised P&L so a glance shows win vs loss.
          time: bucket(exitT, tfSeconds),
          position: buy ? 'aboveBar' : 'belowBar',
          color: win ? GREEN : RED,
          shape: buy ? 'arrowDown' : 'arrowUp',
          text: `Close ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}`,
        })
      }
    }
  }
  markers.sort((a, b) => a.time - b.time)
  return markers
}
