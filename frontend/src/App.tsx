import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, setToken, getToken, setAuthFailureHandler } from './api'
import { PriceChart } from './PriceChart'
import { Login, LicenseGate } from './Login'
import { Admin } from './Admin'
import { useSocket } from './useSocket'
import { useTheme, type Theme } from './theme'
import { ThemeToggle } from './ThemeToggle'
import type { BotStatus, BacktestResult, Candle, ExchangeAccess, MarketAnalysis, Me, Settings, SignalRow, StrategyInfo, Ticker, Trade, TrainingReport } from './types'

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT']
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d']

// WS events that mean the trades table on screen is now stale and must be
// refetched: a position opened/closed, a resting order placed/cancelled, the
// exchange reconciled a position (closed or resized it out from under us), or a
// trailing stop moved. Missing any of these would leave the UI showing a trade
// that no longer matches reality — unacceptable for a live-money view.
const TRADE_EVENTS: ReadonlySet<string> = new Set([
  'trade_opened',
  'trade_closed',
  'order_pending',
  'order_canceled',
  'reconcile_closed',
  'reconcile_adjusted',
  'stop_trailed',
])

function fmt(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

type Toast = { kind: 'ok' | 'error'; text: string } | null

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [checking, setChecking] = useState(true)
  const [theme, toggleTheme] = useTheme()

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setMe(null)
      setChecking(false)
      return
    }
    try {
      setMe(await api.me())
    } catch {
      setToken(null)
      setMe(null)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    loadMe()
  }, [loadMe])

  const logout = useCallback(() => {
    setToken(null)
    setMe(null)
  }, [])

  // Force a clean logout when any authenticated request (REST or WebSocket)
  // reports the session is dead (401 / ws 4401), instead of leaving the user
  // on a broken dashboard that silently fails every call.
  useEffect(() => {
    setAuthFailureHandler(() => setMe(null))
    return () => setAuthFailureHandler(null)
  }, [])

  if (checking) {
    return <div className="auth-wrap"><div className="auth-card">Loading…</div></div>
  }
  if (!me) {
    return <Login onAuthed={() => { setChecking(true); loadMe() }} theme={theme} onToggleTheme={toggleTheme} />
  }
  if (me.license_status !== 'active') {
    return (
      <LicenseGate
        status={me.license_status as 'pending' | 'revoked'}
        email={me.email}
        onLogout={logout}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    )
  }
  return <Dashboard me={me} onLogout={logout} onMeChanged={setMe} theme={theme} onToggleTheme={toggleTheme} />
}

type TabKey = 'trades' | 'signals' | 'analyze' | 'train' | 'backtest' | 'settings' | 'admin'

// Left-drawer navigation. `admin: true` items only render for admins. The same
// keys drive the in-panel tab strip, so the two stay in sync off one `tab`.
const NAV: { key: TabKey; label: string; icon: string; admin?: boolean }[] = [
  { key: 'trades', label: 'Trades', icon: '📈' },
  { key: 'signals', label: 'Signals', icon: '📡' },
  { key: 'analyze', label: 'Analyze', icon: '🔍' },
  { key: 'train', label: 'Train', icon: '🧠' },
  { key: 'backtest', label: 'Backtest', icon: '↺' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
  { key: 'admin', label: 'Admin', icon: '🛡', admin: true },
]

function Dashboard({
  me,
  onLogout,
  onMeChanged,
  theme,
  onToggleTheme,
}: {
  me: Me
  onLogout: () => void
  onMeChanged: (m: Me) => void
  theme: Theme
  onToggleTheme: () => void
}) {
  const [status, setStatus] = useState<BotStatus | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsError, setSettingsError] = useState(false)
  const [trades, setTrades] = useState<Trade[]>([])
  const [signals, setSignals] = useState<SignalRow[]>([])
  const [candles, setCandles] = useState<Candle[]>([])
  const [ticker, setTicker] = useState<Ticker | null>(null)
  const [tickerStale, setTickerStale] = useState(false)
  const [symbol, setSymbol] = useState(SYMBOLS[0])
  const [timeframe, setTimeframe] = useState('1h')
  const [amount, setAmount] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')
  const [placing, setPlacing] = useState(false)
  const [closing, setClosing] = useState<number | null>(null)
  const [toast, setToast] = useState<Toast>(null)
  const [tab, setTab] = useState<TabKey>('trades')
  const [access, setAccess] = useState<ExchangeAccess | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const showToast = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 4000)
  }, [])

  // Close the nav drawer on Escape so it behaves like a normal modal drawer.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const refreshTrades = useCallback(async () => {
    try {
      setTrades(await api.trades())
    } catch (e) {
      /* ignore */
    }
  }, [])

  const refreshSignals = useCallback(async () => {
    try {
      setSignals(await api.signals())
    } catch (e) {
      /* ignore */
    }
  }, [])

  // Settings load is its own callback so the Settings panel can retry it after
  // a failed fetch instead of being stuck on "Loading…" forever (the fetch
  // failing is distinct from it still being in flight).
  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.settings())
      setSettingsError(false)
    } catch (e) {
      setSettingsError(true)
    }
  }, [])

  const { connected } = useSocket({
    onStatus: setStatus,
    onEvent: (m) => {
      if (TRADE_EVENTS.has(m.event)) {
        refreshTrades()
      }
      if (m.event === 'signal') {
        refreshSignals()
        showToast(m.data.accepted ? 'ok' : 'error', m.data.message)
      }
    },
  })

  // Initial load.
  useEffect(() => {
    api.status().then(setStatus).catch(() => {})
    loadSettings()
    api.exchangeAccess().then(setAccess).catch(() => {})
    refreshTrades()
    refreshSignals()
  }, [loadSettings, refreshTrades, refreshSignals])

  // Poll the trades table on a slow cadence as a safety net. Trade changes are
  // normally pushed over the WebSocket (see onEvent), but if the socket drops
  // and reconnects, any events during the gap are missed; this also keeps an
  // open position's unrealized PnL from going stale between pushes. Cheap GET.
  useEffect(() => {
    const id = setInterval(refreshTrades, 15000)
    return () => clearInterval(id)
  }, [refreshTrades])

  // Load candles when symbol/timeframe changes, and poll periodically. The
  // poll is fairly frequent so a new closed bar shows up quickly; the live
  // ticker (below) keeps the forming bar moving in between reloads.
  useEffect(() => {
    let alive = true
    setCandles([]) // drop the previous market's bars immediately on a switch
    const load = (isInitial: boolean) =>
      api
        .ohlcv(symbol, timeframe, 200)
        .then((c) => alive && setCandles(c))
        .catch(() => {
          // Only blank the chart if the very first fetch for this market
          // fails (genuine "no data"); on background polls keep the last good
          // bars rather than wiping the chart over a transient hiccup.
          if (alive && isInitial) setCandles([])
        })
    load(true)
    const id = setInterval(() => load(false), 10000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [symbol, timeframe])

  // Live price feed: poll the ticker fast so the chart's newest bar and the
  // header last-price move in near-real-time, like an exchange chart. Reset on
  // symbol change so a stale price from the previous market never lingers.
  useEffect(() => {
    let alive = true
    setTicker(null)
    setTickerStale(false)
    let lastOk = Date.now()
    const load = () =>
      api
        .ticker(symbol)
        .then((t) => {
          if (!alive) return
          lastOk = Date.now()
          setTicker(t)
          setTickerStale(false)
        })
        .catch(() => {
          // Keep the last price on screen, but once the feed has been down for
          // several polls flag it stale so a frozen quote is never presented as
          // live — "if it's offline, show it offline".
          if (alive && Date.now() - lastOk > 12000) setTickerStale(true)
        })
    load()
    const id = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [symbol])

  const openTrades = useMemo(
    () => trades.filter((t) => t.status === 'open' || t.status === 'pending'),
    [trades],
  )

  const doOrder = async (action: 'buy' | 'sell') => {
    if (placing) return // guard against double-submit / duplicate orders
    const amt = amount ? Number(amount) : undefined
    const lim = limitPrice ? Number(limitPrice) : undefined
    const sl = stopLoss ? Number(stopLoss) : undefined
    const tp = takeProfit ? Number(takeProfit) : undefined
    // Client-side numeric validation: any provided value must be > 0.
    const fields: [string, number | undefined][] = [
      ['Amount', amt],
      ['Limit price', lim],
      ['Stop loss', sl],
      ['Take profit', tp],
    ]
    for (const [label, v] of fields) {
      if (v !== undefined && (!Number.isFinite(v) || v <= 0)) {
        showToast('error', `${label} must be a positive number.`)
        return
      }
    }
    // Confirm before spending REAL money. Confirm unless we positively KNOW the
    // account is in paper mode: if status hasn't loaded yet (mode unknown) we
    // must not silently wave through what could be a live, real-funds order.
    if (status?.trading_mode !== 'paper') {
      const knownLive = status?.trading_mode === 'live'
      const parts = [
        `${action.toUpperCase()} ${symbol}`,
        amt ? `amount ${amt}` : 'auto-sized by risk',
        lim ? `limit ${lim}` : 'market',
      ]
      if (sl) parts.push(`stop-loss ${sl}`)
      if (tp) parts.push(`take-profit ${tp}`)
      const header = knownLive
        ? 'LIVE ORDER — this uses real funds on your Binance account.'
        : 'Trading mode not confirmed yet — this MAY place a REAL order on your Binance account.'
      const ok = window.confirm(`${header}\n\n${parts.join('  ·  ')}\n\nPlace this order?`)
      if (!ok) return
    }
    setPlacing(true)
    try {
      const res = await api.order({
        action,
        symbol,
        amount: amt,
        limit_price: lim,
        stop_loss: sl,
        take_profit: tp,
      })
      showToast(res.accepted ? 'ok' : 'error', res.message)
      refreshTrades()
    } catch (e) {
      showToast('error', (e as Error).message)
    } finally {
      setPlacing(false)
    }
  }

  const closeTrade = async (id: number) => {
    if (closing !== null) return // one close at a time; avoid double-close
    // Same conservative gate as doOrder: confirm unless we KNOW it's paper.
    if (status?.trading_mode !== 'paper') {
      const msg =
        status?.trading_mode === 'live'
          ? 'Close this LIVE position at market now?'
          : 'Trading mode not confirmed yet — this may close a REAL position at market. Continue?'
      if (!window.confirm(msg)) return
    }
    setClosing(id)
    try {
      const res = await api.closeTrade(id)
      showToast(res.accepted ? 'ok' : 'error', res.message)
      refreshTrades()
    } catch (e) {
      showToast('error', (e as Error).message)
    } finally {
      setClosing(null)
    }
  }

  const toggleBot = async () => {
    if (!status) return
    try {
      const res = await api.setBot(status.running ? 'stop' : 'start')
      // Functional update: a fresh status may have arrived over the WS while
      // the request was in flight, so merge onto the latest, not the closure's
      // snapshot, and only touch `running`.
      setStatus((prev) => (prev ? { ...prev, running: res.running } : prev))
    } catch (e) {
      showToast('error', (e as Error).message)
    }
  }

  const pnlClass = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')

  // Live price for the header readout + the chart's forming bar. Prefer the
  // fast ticker; fall back to the newest candle close until it arrives.
  const livePrice = ticker?.last ?? (candles.length ? candles[candles.length - 1].close : null)
  const chgPct = ticker?.percentage ?? null

  return (
    <div className="app">
      {/* Slide-in navigation drawer + click-away backdrop. The hamburger in the
         topbar toggles `menuOpen`; picking an item sets the tab and closes it. */}
      <div
        className={`drawer-backdrop ${menuOpen ? 'show' : ''}`}
        onClick={() => setMenuOpen(false)}
      />
      <aside className={`drawer ${menuOpen ? 'open' : ''}`} aria-hidden={!menuOpen}>
        <div className="drawer-head">
          <div className="brand" style={{ fontSize: 16 }}>
            <span className="dot" />
            Tranding-track
          </div>
          <button
            className="drawer-close"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
            type="button"
          >
            ✕
          </button>
        </div>
        <nav className="drawer-nav">
          {NAV.filter((n) => !n.admin || me.role === 'admin').map((n) => (
            <button
              key={n.key}
              className={`drawer-item ${tab === n.key ? 'active' : ''}`}
              onClick={() => {
                setTab(n.key)
                setMenuOpen(false)
              }}
              type="button"
            >
              <span className="drawer-ico">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <header className="topbar">
        <button
          className={`hamburger ${menuOpen ? 'open' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
          type="button"
        >
          <span />
          <span />
          <span />
        </button>
        <div className="brand">
          <span className="dot" />
          Tranding-track
        </div>
        {status && (
          <>
            <span className={`badge ${status.trading_mode === 'live' ? 'live' : 'paper'}`}>
              {status.trading_mode}
            </span>
            {status.testnet && <span className="badge">testnet</span>}
            <span className={`badge ${status.running ? 'on' : 'off'}`}>
              {status.running ? 'running' : 'stopped'}
            </span>
          </>
        )}
        <div className="spacer" />
        <span className="hint">{me.email}</span>
        {me.role === 'admin' && <span className="badge">admin</span>}
        <span className="hint">{connected ? 'live' : 'reconnecting…'}</span>
        <span className={`ws-dot ${connected ? 'connected' : ''}`} />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <button className="btn primary" onClick={toggleBot}>
          {status?.running ? 'Stop bot' : 'Start bot'}
        </button>
        <button className="btn" onClick={onLogout}>
          Sign out
        </button>
      </header>

      {access && status?.trading_mode === 'live' && !access.ok && (
        <div className="alert-banner">
          <span className="alert-icon">⚠️</span>
          <div>
            <b>Live trading is not ready.</b> {access.detail}
            {' '}Orders will be rejected until the exchange key can trade. Paper mode is unaffected.
          </div>
        </div>
      )}

      <div className="body">
        <div className="col">
          <StatsRow status={status} />

          <section className="panel">
            <div className="panel-head">
              <div className="price-ticker">
                <span>Price</span>
                {livePrice != null && (
                  <>
                    <span className="last" style={tickerStale ? { opacity: 0.5 } : undefined}>
                      {fmt(livePrice, livePrice < 10 ? 4 : 2)}
                    </span>
                    {chgPct != null && !tickerStale && (
                      <span className={`chg ${pnlClass(chgPct)}`}>
                        {chgPct > 0 ? '+' : ''}
                        {fmt(chgPct, 2)}%
                      </span>
                    )}
                    {tickerStale && (
                      <span
                        className="hint"
                        title="Live price feed interrupted — showing the last known price, not a current quote"
                      >
                        ⚠ stale
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="row" style={{ alignItems: 'center' }}>
                <select className="select" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                  {SYMBOLS.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <select
                  className="select"
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value)}
                >
                  {TIMEFRAMES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="panel-body">
              {candles.length ? (
                <PriceChart candles={candles} theme={theme} last={livePrice} fitKey={`${symbol}:${timeframe}`} />
              ) : (
                <div className="empty">
                  No candle data. Check the backend / Binance connection.
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">Manual order</div>
            <div className="panel-body">
              <div className="row">
                <div className="field">
                  <label>Symbol</label>
                  <input className="input" value={symbol} readOnly />
                </div>
                <div className="field">
                  <label>Amount (blank = auto-size by risk)</label>
                  <input
                    className="input"
                    placeholder="auto"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <div className="field">
                  <label>Limit price (blank = market)</label>
                  <input
                    className="input"
                    placeholder="market"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <div className="field">
                  <label>Stop-loss price (optional)</label>
                  <input
                    className="input"
                    placeholder="auto"
                    value={stopLoss}
                    onChange={(e) => setStopLoss(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <div className="field">
                  <label>Take-profit price (optional)</label>
                  <input
                    className="input"
                    placeholder="auto"
                    value={takeProfit}
                    onChange={(e) => setTakeProfit(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <button className="btn buy" onClick={() => doOrder('buy')} disabled={placing}>
                  {placing ? 'Placing…' : 'Buy'}
                </button>
                <button className="btn sell" onClick={() => doOrder('sell')} disabled={placing}>
                  {placing ? 'Placing…' : 'Sell'}
                </button>
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                Orders respect your risk settings. In <b>paper</b> mode nothing hits the exchange;
                in <b>live</b> mode you'll be asked to confirm before real funds are used. Set a
                <b> limit price</b> to rest the order until the market reaches it (a buy fills at or
                below it, a sell at or above it); leave it blank for an immediate market order. A
                blank <b>stop-loss</b>/<b>take-profit</b> uses your configured default percentages.
              </p>
            </div>
          </section>
        </div>

        <div className="col">
          <section className="panel">
            <div className="panel-head">
              <div className="tabs">
                <span
                  className={`tab ${tab === 'trades' ? 'active' : ''}`}
                  onClick={() => setTab('trades')}
                >
                  Trades
                </span>
                <span
                  className={`tab ${tab === 'signals' ? 'active' : ''}`}
                  onClick={() => setTab('signals')}
                >
                  Signals
                </span>
                <span
                  className={`tab ${tab === 'analyze' ? 'active' : ''}`}
                  onClick={() => setTab('analyze')}
                >
                  Analyze
                </span>
                <span
                  className={`tab ${tab === 'train' ? 'active' : ''}`}
                  onClick={() => setTab('train')}
                >
                  Train
                </span>
                <span
                  className={`tab ${tab === 'backtest' ? 'active' : ''}`}
                  onClick={() => setTab('backtest')}
                >
                  Backtest
                </span>
                <span
                  className={`tab ${tab === 'settings' ? 'active' : ''}`}
                  onClick={() => setTab('settings')}
                >
                  Settings
                </span>
                {me.role === 'admin' && (
                  <span
                    className={`tab ${tab === 'admin' ? 'active' : ''}`}
                    onClick={() => setTab('admin')}
                  >
                    Admin
                  </span>
                )}
              </div>
            </div>
            <div className="panel-body">
              {tab === 'trades' && (
                <TradesTable
                  trades={trades}
                  openTrades={openTrades}
                  onClose={closeTrade}
                  pnlClass={pnlClass}
                  closingId={closing}
                />
              )}
              {tab === 'signals' && <SignalsTable signals={signals} />}
              {tab === 'analyze' && (
                <AnalyzePanel
                  symbol={symbol}
                  timeframe={timeframe}
                  onError={(m) => showToast('error', m)}
                />
              )}
              {tab === 'train' && (
                <TrainPanel symbol={symbol} timeframe={timeframe} onError={(m) => showToast('error', m)} />
              )}
              {tab === 'backtest' && (
                <BacktestPanel symbol={symbol} timeframe={timeframe} onError={(m) => showToast('error', m)} />
              )}
              {tab === 'settings' && (
                <SettingsPanel
                  settings={settings}
                  loadError={settingsError}
                  onReload={loadSettings}
                  access={access}
                  me={me}
                  onSaved={(s) => {
                    setSettings(s)
                    showToast('ok', 'Settings saved')
                  }}
                  onMeChanged={onMeChanged}
                  onError={(msg) => showToast('error', msg)}
                />
              )}
              {tab === 'admin' && me.role === 'admin' && (
                <Admin onError={(msg) => showToast('error', msg)} />
              )}
            </div>
          </section>
        </div>
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}

function StatsRow({ status }: { status: BotStatus | null }) {
  const cls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')
  return (
    <section className="stats">
      <div className="stat">
        <div className="label">Equity</div>
        <div className="value">${fmt(status?.equity)}</div>
      </div>
      <div className="stat">
        <div className="label">Balance</div>
        <div className="value">${fmt(status?.balance)}</div>
      </div>
      <div className="stat">
        <div className="label">Unrealized PnL</div>
        <div className={`value ${cls(status?.unrealized_pnl ?? 0)}`}>
          ${fmt(status?.unrealized_pnl)}
        </div>
      </div>
      <div className="stat">
        <div className="label">Realized PnL</div>
        <div className={`value ${cls(status?.realized_pnl ?? 0)}`}>
          ${fmt(status?.realized_pnl)}
        </div>
      </div>
      <div className="stat">
        <div className="label">Today's PnL</div>
        <div className={`value ${cls(status?.day_pnl ?? 0)}`}>
          ${fmt(status?.day_pnl)}
        </div>
      </div>
      <div className="stat">
        <div className="label">Open / Max</div>
        <div className="value">
          {status?.open_positions ?? 0} / {status?.max_open_positions ?? 0}
        </div>
      </div>
    </section>
  )
}

function TradesTable({
  trades,
  openTrades,
  onClose,
  pnlClass,
  closingId,
}: {
  trades: Trade[]
  openTrades: Trade[]
  onClose: (id: number) => void
  pnlClass: (n: number) => string
  closingId?: number | null
}) {
  if (!trades.length) return <div className="empty">No trades yet.</div>
  const openIds = new Set(openTrades.map((t) => t.id))
  return (
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Side</th>
          <th className="mono">Entry</th>
          <th className="mono">PnL</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id}>
            <td>{t.symbol}</td>
            <td>
              <span className={`tag ${t.side}`}>{t.side}</span>
            </td>
            <td className="mono">
              {t.status === 'pending' && t.limit_price
                ? `${fmt(t.limit_price)} (limit)`
                : fmt(t.entry_price)}
            </td>
            <td className={`mono ${pnlClass(t.pnl)}`}>{fmt(t.pnl)}</td>
            <td>
              <span className={`tag ${t.status}`}>{t.status}</span>
            </td>
            <td>
              {openIds.has(t.id) && (
                <button
                  className="btn"
                  onClick={() => onClose(t.id)}
                  disabled={closingId !== null && closingId !== undefined}
                >
                  {closingId === t.id
                    ? 'Working…'
                    : t.status === 'pending'
                      ? 'Cancel'
                      : 'Close'}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SignalsTable({ signals }: { signals: SignalRow[] }) {
  if (!signals.length)
    return <div className="empty">No signals received yet. Wire up TradingView in Settings.</div>
  return (
    <table>
      <thead>
        <tr>
          <th>Source</th>
          <th>Action</th>
          <th>Symbol</th>
          <th>OK</th>
        </tr>
      </thead>
      <tbody>
        {signals.map((s) => (
          <tr key={s.id}>
            <td>{s.source}</td>
            <td>{s.action ?? '-'}</td>
            <td>{s.symbol ?? '-'}</td>
            <td>{s.accepted ? '✅' : '❌'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function AnalyzePanel({
  symbol,
  timeframe,
  onError,
}: {
  symbol: string
  timeframe: string
  onError: (msg: string) => void
}) {
  const [analysis, setAnalysis] = useState<MarketAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [asking, setAsking] = useState(false)

  // The verdict and AI answer are specific to one market; clear them when the
  // symbol/timeframe changes so stale results aren't shown against a new chart.
  useEffect(() => {
    setAnalysis(null)
    setAnswer('')
  }, [symbol, timeframe])

  const run = async (explain: boolean) => {
    setBusy(true)
    try {
      setAnalysis(await api.analyze(symbol, timeframe, explain))
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const runAssess = async () => {
    setBusy(true)
    try {
      setAnalysis(await api.analyze(symbol, timeframe, false, true))
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const ask = async () => {
    if (!question.trim()) return
    setAsking(true)
    setAnswer('')
    try {
      const res = await api.aiAsk(question, symbol, timeframe)
      setAnswer(res.answer)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setAsking(false)
    }
  }

  const verdictClass =
    analysis?.verdict === 'buy' ? 'pos' : analysis?.verdict === 'sell' ? 'neg' : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="hint">
        The analyzer weighs trend, RSI, MACD, momentum and volatility into one
        confidence-scored verdict for <b>{symbol}</b> <b>{timeframe}</b>. When
        signals are weak or volatility is extreme it says <b>HOLD</b> — protecting
        capital instead of forcing a trade.
      </p>
      <div className="row">
        <button className="btn primary" onClick={() => run(false)} disabled={busy}>
          {busy ? 'Analyzing…' : 'Analyze market'}
        </button>
        <button className="btn" onClick={() => run(true)} disabled={busy}>
          Analyze + explain
        </button>
        <button className="btn" onClick={() => runAssess()} disabled={busy}>
          🧠 Deep assessment
        </button>
      </div>

      {analysis && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span className={`verdict ${verdictClass}`} style={{ fontSize: 22, fontWeight: 700 }}>
              {analysis.verdict.toUpperCase()}
            </span>
            <span className="hint">confidence {Math.round(analysis.confidence * 100)}%</span>
            <span className="mono hint">score {analysis.score.toFixed(2)}</span>
          </div>
          <p style={{ marginTop: 6 }}>{analysis.summary}</p>
          {analysis.narration && analysis.narration !== analysis.summary && (
            <p className="hint" style={{ fontStyle: 'italic' }}>🧠 {analysis.narration}</p>
          )}
          {analysis.assessment && analysis.assessment !== analysis.summary && (
            <div
              className="hint"
              style={{
                marginTop: 8,
                whiteSpace: 'pre-wrap',
                background: 'rgba(127,127,127,0.08)',
                borderRadius: 8,
                padding: 12,
              }}
            >
              {analysis.assessment}
            </div>
          )}
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Factor</th>
                <th>Signal</th>
                <th className="mono">Weight</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {analysis.factors.map((f) => (
                <tr key={f.name}>
                  <td>{f.name}</td>
                  <td className={f.signal === 'buy' ? 'pos' : f.signal === 'sell' ? 'neg' : ''}>
                    {f.signal}
                  </td>
                  <td className="mono">{f.weight.toFixed(2)}</td>
                  <td>{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="field" style={{ marginTop: 8 }}>
        <label>Ask the AI about this market (needs AI_API_KEY configured)</label>
        <div className="row">
          <input
            className="input"
            placeholder="e.g. Is this a good entry, and what's the main risk?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
          />
          <button className="btn" onClick={ask} disabled={asking}>
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
        {answer && <p className="hint" style={{ marginTop: 8 }}>{answer}</p>}
      </div>
    </div>
  )
}

function BacktestPanel({
  symbol,
  timeframe,
  onError,
}: {
  symbol: string
  timeframe: string
  onError: (msg: string) => void
}) {
  const [strategies, setStrategies] = useState<StrategyInfo[]>([])
  const [strategy, setStrategy] = useState('ma_cross')
  const [feePct, setFeePct] = useState('0.1')
  const [slippagePct, setSlippagePct] = useState('0.05')
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .strategies()
      .then((s) => {
        setStrategies(s)
        if (s.length) setStrategy(s[0].name)
      })
      .catch(() => {})
  }, [])

  // Results are tied to the selected market; drop them on a symbol/timeframe
  // switch so the panel never shows a backtest for the wrong chart.
  useEffect(() => {
    setResult(null)
  }, [symbol, timeframe])

  const run = async () => {
    setBusy(true)
    setResult(null)
    try {
      setResult(
        await api.backtest(
          symbol,
          strategy,
          timeframe,
          feePct === '' ? undefined : Number(feePct),
          slippagePct === '' ? undefined : Number(slippagePct),
        ),
      )
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="hint">
        Replay a strategy over real <b>{symbol}</b> <b>{timeframe}</b> candles. Fills happen at the
        next bar's open (no look-ahead), with fees and slippage applied against you, so results are
        conservative rather than optimistic.
      </p>
      <div className="row">
        <div className="field">
          <label>Strategy</label>
          <select className="select" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            {strategies.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Fee % per side</label>
          <input
            className="input"
            value={feePct}
            onChange={(e) => setFeePct(e.target.value)}
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label>Slippage %</label>
          <input
            className="input"
            value={slippagePct}
            onChange={(e) => setSlippagePct(e.target.value)}
            inputMode="decimal"
          />
        </div>
        <button className="btn primary" onClick={run} disabled={busy}>
          {busy ? 'Running…' : 'Run backtest'}
        </button>
      </div>

      {result && (
        <div>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="stat">
              <div className="label">Return</div>
              <div className={`value ${result.total_return_pct >= 0 ? 'pos' : 'neg'}`}>
                {fmt(result.total_return_pct)}%
              </div>
            </div>
            <div className="stat">
              <div className="label">End balance</div>
              <div className="value">{fmt(result.ending_balance)}</div>
            </div>
            <div className="stat">
              <div className="label">Trades</div>
              <div className="value">{result.num_trades}</div>
            </div>
            <div className="stat">
              <div className="label">Win rate</div>
              <div className="value">{fmt(result.win_rate_pct)}%</div>
            </div>
            <div className="stat">
              <div className="label">Max drawdown</div>
              <div className="value neg">{fmt(result.max_drawdown_pct)}%</div>
            </div>
            <div className="stat">
              <div className="label">Fees paid</div>
              <div className="value">{fmt(result.total_fees ?? 0)}</div>
            </div>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            Applied the bot's live exit rules — stop-loss{' '}
            {fmt(result.stop_loss_pct ?? 0)}%, take-profit {fmt(result.take_profit_pct ?? 0)}%,
            trailing {fmt(result.trailing_stop_pct ?? 0)}% — so these numbers reflect how the
            bot would actually trade, not buy-and-hold.
          </p>
          {result.equity_curve.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <EquitySparkline values={result.equity_curve} />
            </div>
          )}
          {result.num_trades === 0 && (
            <div className="empty">
              This strategy generated no trades on this data. Try another symbol, timeframe, or
              strategy.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EquitySparkline({ values }: { values: number[] }) {
  const w = 600
  const h = 120
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w
      const y = h - ((v - min) / range) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const up = values[values.length - 1] >= values[0]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
      <polyline
        points={pts}
        fill="none"
        stroke={up ? 'var(--green, #16a34a)' : 'var(--red, #dc2626)'}
        strokeWidth={2}
      />
    </svg>
  )
}

function TrainPanel({
  symbol,
  timeframe,
  onError,
}: {
  symbol: string
  timeframe: string
  onError: (msg: string) => void
}) {
  const [strategies, setStrategies] = useState<StrategyInfo[]>([])
  const [strategy, setStrategy] = useState('ma_cross')
  const [report, setReport] = useState<TrainingReport | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .strategies()
      .then((s) => {
        setStrategies(s)
        if (s.length) setStrategy(s[0].name)
      })
      .catch(() => {})
  }, [])

  // A training report is for one market only; clear it on a symbol/timeframe
  // switch so a stale leaderboard isn't shown against a different chart.
  useEffect(() => {
    setReport(null)
  }, [symbol, timeframe])

  const run = async () => {
    setBusy(true)
    setReport(null)
    try {
      setReport(await api.train(symbol, strategy, timeframe))
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="hint">
        Teach the bot: it backtests every parameter combination for a strategy on real{' '}
        <b>{symbol}</b> <b>{timeframe}</b> candles and finds the best-performing setup.
      </p>
      <div className="row">
        <div className="field">
          <label>Strategy</label>
          <select className="select" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            {strategies.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn primary" onClick={run} disabled={busy}>
          {busy ? 'Training…' : 'Train'}
        </button>
      </div>

      {report && (
        <div>
          {report.best ? (
            <>
              <p className="hint">
                Tested {report.tested} configs on {report.candles} candles.{' '}
                {report.train_fraction < 1
                  ? `Fitted on the first ${Math.round(report.train_fraction * 100)}% and validated on the untouched remainder (out-of-sample).`
                  : 'Evaluated on the full dataset (no holdout split).'}{' '}
                Best setup:
              </p>
              {report.warning && (
                <p className="hint" style={{ color: 'var(--red)' }}>⚠️ {report.warning}</p>
              )}
              <pre className="code">{JSON.stringify(report.best.params, null, 2)}</pre>
              <table>
                <thead>
                  <tr>
                    <th>Params</th>
                    <th className="mono">Return %</th>
                    <th className="mono">Win %</th>
                    <th className="mono">Max DD %</th>
                    <th className="mono">Trades</th>
                    <th className="mono">Val. return %</th>
                    <th className="mono">Overfit gap</th>
                  </tr>
                </thead>
                <tbody>
                  {report.leaderboard.map((c, i) => (
                    <tr key={i}>
                      <td>{Object.entries(c.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
                      <td className={`mono ${c.total_return_pct >= 0 ? 'pos' : 'neg'}`}>
                        {fmt(c.total_return_pct)}
                      </td>
                      <td className="mono">{fmt(c.win_rate_pct)}</td>
                      <td className="mono">{fmt(c.max_drawdown_pct)}</td>
                      <td className="mono">{c.num_trades}</td>
                      <td
                        className={`mono ${
                          c.validation_return_pct == null
                            ? ''
                            : c.validation_return_pct >= 0
                            ? 'pos'
                            : 'neg'
                        }`}
                      >
                        {c.validation_return_pct == null ? '—' : fmt(c.validation_return_pct)}
                      </td>
                      <td className="mono">
                        {c.overfit_gap_pct == null ? '—' : fmt(c.overfit_gap_pct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="empty">
              No profitable configuration traded on this data. Try a different symbol or timeframe.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SettingsPanel({
  settings,
  loadError,
  onReload,
  access,
  me,
  onSaved,
  onMeChanged,
  onError,
}: {
  settings: Settings | null
  loadError: boolean
  onReload: () => void
  access: ExchangeAccess | null
  me: Me
  onSaved: (s: Settings) => void
  onMeChanged: (m: Me) => void
  onError: (msg: string) => void
}) {
  const [form, setForm] = useState<Settings | null>(settings)
  const [copied, setCopied] = useState(false)
  useEffect(() => setForm(settings), [settings])
  if (!form) {
    // Distinguish a failed fetch from one still in flight so the panel never
    // sits on "Loading…" forever when the request actually errored.
    if (loadError) {
      return (
        <div className="empty">
          Couldn't load your settings.
          <button className="btn" style={{ marginLeft: 10 }} onClick={onReload}>
            Retry
          </button>
        </div>
      )
    }
    return <div className="empty">Loading…</div>
  }

  const webhookUrl = `${location.origin}${form.webhook_path}`
  // Numeric field handler: empty clears to 0; anything that isn't a finite
  // number is ignored (the field keeps its last valid value) so NaN/garbage can
  // never be saved to a risk setting.
  const num = (k: keyof Settings, v: string) => {
    if (v === '') {
      setForm({ ...form, [k]: 0 } as Settings)
      return
    }
    const parsed = Number(v)
    if (!Number.isFinite(parsed)) return
    setForm({ ...form, [k]: parsed } as Settings)
  }

  const save = async () => {
    try {
      const saved = await api.updateSettings({
        trading_mode: form.trading_mode,
        max_open_positions: form.max_open_positions,
        risk_per_trade_pct: form.risk_per_trade_pct,
        daily_loss_limit_pct: form.daily_loss_limit_pct,
        default_stop_loss_pct: form.default_stop_loss_pct,
        default_take_profit_pct: form.default_take_profit_pct,
        trailing_stop_pct: form.trailing_stop_pct,
        max_total_exposure_pct: form.max_total_exposure_pct,
        min_signal_confidence: form.min_signal_confidence,
        auto_trade_enabled: form.auto_trade_enabled,
        auto_symbols: form.auto_symbols,
        auto_timeframe: form.auto_timeframe,
        auto_confirm_timeframe: form.auto_confirm_timeframe,
      })
      onSaved(saved)
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const alertExample = JSON.stringify(
    { action: 'buy', symbol: 'BTC/USDT', amount: 0.001 },
    null,
    2,
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="field">
        <label>Trading mode</label>
        <select
          className="select"
          value={form.trading_mode}
          onChange={(e) => setForm({ ...form, trading_mode: e.target.value })}
        >
          <option value="paper">paper (safe, simulated)</option>
          <option value="live">live (REAL orders)</option>
        </select>
      </div>
      {form.trading_mode === 'live' && (
        <p className="hint" style={{ color: 'var(--red)' }}>
          ⚠️ Live mode places REAL orders on Binance. Make sure your API keys are set in the
          backend .env and you have tested on testnet first.
        </p>
      )}

      {access && (
        <div className={`access-card ${access.ok ? 'ok' : 'bad'}`}>
          <div className="access-head">
            {access.ok ? '✅ Exchange ready to trade' : '⚠️ Exchange cannot trade yet'}
            {access.testnet ? ' (testnet)' : ' (live account)'}
          </div>
          <div className="access-rows">
            <span>Public data: {access.can_read_public ? '✅' : '❌'}</span>
            <span>Account read: {access.can_read_account ? '✅' : '❌'}</span>
            <span>Trading: {access.can_trade ? '✅' : '❌'}</span>
          </div>
          <p className="hint" style={{ marginTop: 6 }}>{access.detail}</p>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label>Max open positions</label>
          <input
            className="input"
            value={form.max_open_positions}
            onChange={(e) => num('max_open_positions', e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div className="field">
          <label>Risk per trade %</label>
          <input
            className="input"
            value={form.risk_per_trade_pct}
            onChange={(e) => num('risk_per_trade_pct', e.target.value)}
            inputMode="decimal"
          />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>Stop-loss %</label>
          <input
            className="input"
            value={form.default_stop_loss_pct}
            onChange={(e) => num('default_stop_loss_pct', e.target.value)}
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label>Take-profit %</label>
          <input
            className="input"
            value={form.default_take_profit_pct}
            onChange={(e) => num('default_take_profit_pct', e.target.value)}
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label>Trailing stop % (0 = off)</label>
          <input
            className="input"
            value={form.trailing_stop_pct}
            onChange={(e) => num('trailing_stop_pct', e.target.value)}
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label>Daily loss limit %</label>
          <input
            className="input"
            value={form.daily_loss_limit_pct}
            onChange={(e) => num('daily_loss_limit_pct', e.target.value)}
            inputMode="decimal"
          />
        </div>
        <div className="field">
          <label>Max total exposure % (0 = off)</label>
          <input
            className="input"
            value={form.max_total_exposure_pct}
            onChange={(e) => num('max_total_exposure_pct', e.target.value)}
            inputMode="decimal"
          />
        </div>
      </div>

      <div className="panel-head" style={{ paddingLeft: 0, borderBottom: 'none' }}>
        Autonomous trading (the bot analyses & trades by itself)
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={form.auto_trade_enabled}
          onChange={(e) => setForm({ ...form, auto_trade_enabled: e.target.checked })}
        />
        Enable autonomous trading{' '}
        {form.trading_mode === 'live' && (
          <span style={{ color: 'var(--red)' }}>(LIVE — real money!)</span>
        )}
      </label>
      <div className="row">
        <div className="field">
          <label>Auto symbols (comma-separated)</label>
          <input
            className="input"
            value={form.auto_symbols}
            onChange={(e) => setForm({ ...form, auto_symbols: e.target.value })}
            placeholder="BTC/USDT, ETH/USDT"
          />
        </div>
        <div className="field">
          <label>Auto timeframe</label>
          <input
            className="input"
            value={form.auto_timeframe}
            onChange={(e) => setForm({ ...form, auto_timeframe: e.target.value })}
            placeholder="1h"
          />
        </div>
        <div className="field">
          <label>Confirm timeframe (higher; blank = off)</label>
          <input
            className="input"
            value={form.auto_confirm_timeframe}
            onChange={(e) => setForm({ ...form, auto_confirm_timeframe: e.target.value })}
            placeholder="4h"
          />
        </div>
        <div className="field">
          <label>Min signal confidence (0–1)</label>
          <input
            className="input"
            value={form.min_signal_confidence}
            onChange={(e) => num('min_signal_confidence', e.target.value)}
            inputMode="decimal"
          />
        </div>
      </div>
      <p className="hint">
        When enabled, on every monitor tick the bot runs its analyzer on each auto
        symbol and only opens a long (or exits one) when confidence clears the
        threshold. Higher confidence = fewer, higher-conviction trades.{' '}
        {form.ai_enabled ? `✅ AI commentary is configured${form.ai_model ? ` (${form.ai_model}${form.ai_style ? `, ${form.ai_style}` : ''})` : ''}.` : 'AI commentary is off (set AI_API_KEY to enable).'}
      </p>
      <p className="hint">
        Trailing stop ratchets an open long's stop-loss upward as price rises to
        lock in gains (never loosened). Binance keys:{' '}
        {form.api_key_set ? '✅ set (live trading available)' : '⚠️ not set — add them below to trade live'}
        . Telegram alerts: {form.notifications_enabled ? '✅ on' : 'off'}.
      </p>

      <button className="btn primary" onClick={save}>
        Save settings
      </button>

      <CredentialsCard me={me} onMeChanged={onMeChanged} onError={onError} />

      <div className="panel" style={{ marginTop: 6 }}>
        <div className="panel-head">Your TradingView webhook</div>
        <div className="panel-body">
          <p className="hint">Point your TradingView alert's webhook URL here (unique to your account — keep it private, it acts as your secret):</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <code className="inline" style={{ flex: 1, minWidth: 240, wordBreak: 'break-all' }}>{webhookUrl}</code>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(webhookUrl)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                } catch {
                  /* clipboard blocked — user can select manually */
                }
              }}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>Alert message (JSON) — no secret needed, the URL token authenticates you:</p>
          <pre className="code">{alertExample}</pre>
          <details className="help" style={{ marginTop: 10 }}>
            <summary>How do I connect TradingView?</summary>
            <div className="help-body">
              <p className="hint">
                TradingView has <b>no API key to paste</b> — the webhook URL above is
                your credential. TradingView just sends alerts to that URL; your bot
                holds the Binance keys and does the actual trading.
              </p>
              <ol className="hint">
                <li>Create a free account at{' '}
                  <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">tradingview.com</a>{' '}
                  (webhook alerts need a paid plan — Essential or higher).</li>
                <li>Open a chart, click the <b>alarm clock (Alerts)</b> icon → <b>Create Alert</b>.</li>
                <li>Set your condition (e.g. a strategy or indicator crossover).</li>
                <li>Under <b>Notifications</b>, tick <b>Webhook URL</b> and paste the URL above.</li>
                <li>In the alert's <b>Message</b> box, paste the JSON shown above (edit side/symbol as needed).</li>
                <li>Save. When the alert fires, TradingView calls your bot and it places the order on Binance.</li>
              </ol>
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}

function CredentialsCard({
  me,
  onMeChanged,
  onError,
}: {
  me: Me
  onMeChanged: (m: Me) => void
  onError: (msg: string) => void
}) {
  const [binKey, setBinKey] = useState('')
  const [binSecret, setBinSecret] = useState('')
  const [testnet, setTestnet] = useState(me.binance_testnet)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState('')

  const disabled = !me.secrets_storage_enabled

  const save = async () => {
    setBusy(true)
    setSaved('')
    try {
      const body: Record<string, unknown> = { binance_testnet: testnet }
      if (binKey.trim()) body.binance_api_key = binKey.trim()
      if (binSecret.trim()) body.binance_api_secret = binSecret.trim()
      const updated = await api.updateCredentials(body)
      onMeChanged(updated)
      setBinKey('')
      setBinSecret('')
      setSaved('Credentials saved (encrypted at rest).')
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel" style={{ marginTop: 6 }}>
      <div className="panel-head">Your Binance API keys</div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {disabled ? (
          <p className="hint" style={{ color: 'var(--red)' }}>
            ⚠️ Key storage is disabled: the operator has not set SECRET_KEY, so keys
            cannot be encrypted. Ask the administrator to configure it.
          </p>
        ) : (
          <p className="hint">
            Use <b>trade-only</b> keys (no withdrawal permission). Keys are encrypted
            at rest and never shown again. Binance keys currently{' '}
            {me.binance_keys_set ? '✅ set' : '❌ not set'}. The AI assistant is{' '}
            <b>built into the app</b> — {me.ai_key_set ? '✅ active for everyone' : 'not configured by the operator yet'}, so you don't enter any AI key.
          </p>
        )}
        <details className="help">
          <summary>How do I get my Binance API key?</summary>
          <div className="help-body">
            <p className="hint">
              <b>Live trading (real funds):</b>
            </p>
            <ol className="hint">
              <li>Log in at binance.com → profile menu → <b>API Management</b>.</li>
              <li>Click <b>Create API</b> → <b>System generated</b>, name it e.g. "trading-bot", pass 2FA.</li>
              <li>Copy the <b>API Key</b> and <b>Secret Key</b> — the secret is shown only once.</li>
              <li>In the key's permissions, turn ON <b>Enable Spot &amp; Margin Trading</b>. Leave <b>Enable Withdrawals</b> OFF.</li>
              <li>Paste both below and save.</li>
            </ol>
            <p className="hint">
              <b>Testnet (fake money, no risk):</b> go to testnet.binance.vision, log in
              with GitHub, <b>Generate HMAC_SHA256 Key</b> with <b>Spot enabled</b>, then
              tick "Use Binance testnet" below. (A testnet key without Spot permission
              causes a -2015 error.)
            </p>
            <p className="hint" style={{ color: 'var(--red)' }}>
              ⚠️ Only ever create <b>trade-only</b> keys (withdrawals disabled), and never
              share your Secret with anyone. Your keys are encrypted and tied to your
              account only — no other user can see or use them.
            </p>
          </div>
        </details>
        <div className="row">
          <div className="field">
            <label>Binance API key</label>
            <input
              className="input"
              type="password"
              value={binKey}
              onChange={(e) => setBinKey(e.target.value)}
              placeholder={me.binance_keys_set ? 'unchanged' : 'paste key'}
              disabled={disabled}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Binance API secret</label>
            <input
              className="input"
              type="password"
              value={binSecret}
              onChange={(e) => setBinSecret(e.target.value)}
              placeholder={me.binance_keys_set ? 'unchanged' : 'paste secret'}
              disabled={disabled}
              autoComplete="off"
            />
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={testnet}
            onChange={(e) => setTestnet(e.target.checked)}
            disabled={disabled}
          />
          Use Binance testnet (recommended until you have verified everything)
        </label>
        {saved && <p className="hint" style={{ color: 'var(--green)' }}>{saved}</p>}
        <button className="btn primary" onClick={save} disabled={disabled || busy}>
          {busy ? 'Saving…' : 'Save API keys'}
        </button>
      </div>
    </div>
  )
}
