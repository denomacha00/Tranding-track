import { describe, it, expect } from 'vitest'
import { tradesToMarkers } from './chartMarkers'
import type { Trade } from './types'

// Minimal Trade factory — only the fields markers care about; the rest get
// harmless defaults.
function trade(over: Partial<Trade>): Trade {
  return {
    id: 1,
    symbol: 'BTC/USDT',
    side: 'buy',
    amount: 0.01,
    entry_price: 100,
    exit_price: null,
    stop_loss: null,
    take_profit: null,
    status: 'open',
    pnl: 0,
    mode: 'paper',
    source: 'manual',
    note: null,
    opened_at: '2026-01-01T00:30:00Z',
    closed_at: null,
    ...over,
  }
}

const H = 3600 // 1h bars

describe('tradesToMarkers', () => {
  it('marks a closed BUY with an entry arrow and a P&L-coloured exit arrow', () => {
    const m = tradesToMarkers(
      [trade({ status: 'closed', side: 'buy', pnl: 12.34, opened_at: '2026-01-01T00:30:00Z', closed_at: '2026-01-01T02:45:00Z' })],
      'BTC/USDT',
      H,
    )
    expect(m).toHaveLength(2)
    const [entry, exit] = m
    expect(entry).toMatchObject({ position: 'belowBar', shape: 'arrowUp', color: '#16c784' })
    expect(entry.text).toBe('BUY 0.010000')
    expect(exit).toMatchObject({ position: 'aboveBar', shape: 'arrowDown', color: '#16c784' })
    expect(exit.text).toBe('Close +12.34')
  })

  it('colours a losing close red', () => {
    const m = tradesToMarkers(
      [trade({ status: 'closed', pnl: -5, closed_at: '2026-01-01T01:00:00Z' })],
      'BTC/USDT',
      H,
    )
    expect(m[1].color).toBe('#ea3943')
    expect(m[1].text).toBe('Close -5.00')
  })

  it('marks an open SELL with a single down arrow and no exit', () => {
    const m = tradesToMarkers([trade({ status: 'open', side: 'sell', amount: 2 })], 'BTC/USDT', H)
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ position: 'aboveBar', shape: 'arrowDown', color: '#ea3943' })
    expect(m[0].text).toBe('SELL 2.000')
  })

  it('never marks a pending/unfilled order (no fake fill)', () => {
    expect(tradesToMarkers([trade({ status: 'pending' })], 'BTC/USDT', H)).toEqual([])
  })

  it('ignores trades for other symbols', () => {
    expect(tradesToMarkers([trade({ symbol: 'ETH/USDT' })], 'BTC/USDT', H)).toEqual([])
  })

  it('snaps marker times to the candle open and returns them ascending', () => {
    const m = tradesToMarkers(
      [
        trade({ id: 2, status: 'open', opened_at: '2026-01-01T05:59:59Z' }),
        trade({ id: 3, status: 'open', opened_at: '2026-01-01T00:30:00Z' }),
      ],
      'BTC/USDT',
      H,
    )
    // Every marker sits exactly on an hour boundary...
    for (const mk of m) expect(mk.time % H).toBe(0)
    // ...and they come out sorted ascending regardless of input order.
    expect(m[0].time).toBeLessThan(m[1].time)
  })
})
