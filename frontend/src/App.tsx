import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, setToken, getToken, setAuthFailureHandler } from './api'
import { PriceChart } from './PriceChart'
import { Login, LicenseGate } from './Login'
import { Admin } from './Admin'
import { useSocket } from './useSocket'
import { useTheme, type Theme } from './theme'
import { ThemeToggle } from './ThemeToggle'
import type { AiHealth, BotStatus, BacktestResult, Candle, ChatTurn, ExchangeAccess, MarketAnalysis, Me, NewsItem, OrderBook as OrderBookData, Performance, PerfBucket, SavedStrategy, Settings, SignalRow, StrategyInfo, Ticker, Trade, TrainingReport } from './types'

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
// A persisted copy of a toast, kept in the header's notifications feed so bot
// pings/alerts aren't lost the instant the transient toast auto-dismisses.
type Notif = { id: number; kind: 'ok' | 'error'; text: string; ts: number }

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
  // Gate on EFFECTIVE access (active AND not expired), not status alone, so an
  // expired time-limited licence is stopped at the door just like a pending one.
  if (!me.license_active) {
    const gate: 'pending' | 'revoked' | 'expired' =
      me.license_status === 'revoked'
        ? 'revoked'
        : me.license_status === 'active'
          ? 'expired' // status active but past its expiry
          : 'pending'
    return (
      <LicenseGate
        status={gate}
        email={me.email}
        onLogout={logout}
        onRedeemed={setMe}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    )
  }
  return <Dashboard me={me} onLogout={logout} onMeChanged={setMe} theme={theme} onToggleTheme={toggleTheme} />
}

type TabKey = 'trades' | 'performance' | 'signals' | 'assistant' | 'news' | 'analyze' | 'train' | 'backtest' | 'settings' | 'admin'

// Left-drawer navigation. `admin: true` items only render for admins. The same
// keys drive the in-panel tab strip, so the two stay in sync off one `tab`.
const NAV: { key: TabKey; label: string; icon: string; admin?: boolean }[] = [
  { key: 'trades', label: 'Trades', icon: '📈' },
  { key: 'performance', label: 'Performance', icon: '🏆' },
  { key: 'signals', label: 'Signals', icon: '📡' },
  { key: 'assistant', label: 'AI Assistant', icon: '🤖' },
  { key: 'news', label: 'News', icon: '📰' },
  { key: 'analyze', label: 'Analyze', icon: '🔍' },
  { key: 'train', label: 'Train', icon: '🧠' },
  { key: 'backtest', label: 'Backtest', icon: '↺' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
  { key: 'admin', label: 'Admin', icon: '🛡', admin: true },
]

// Human labels for a nav destination, used when the AI asks to "take me to X".
const NAV_LABEL: Record<TabKey, string> = {
  trades: 'Trades',
  performance: 'Performance',
  signals: 'Signals',
  assistant: 'AI Assistant',
  news: 'News',
  analyze: 'Analyze',
  train: 'Train',
  backtest: 'Backtest',
  settings: 'Settings',
  admin: 'Admin',
}

// Map the words the assistant might emit in [[goto:<dest>]] to a real tab. We
// accept synonyms so "keys", "connect", "credentials" etc. all land on Settings.
const NAV_ALIAS: Record<string, TabKey> = {
  trades: 'trades', trade: 'trades', positions: 'trades', dashboard: 'trades', home: 'trades',
  performance: 'performance', perf: 'performance', stats: 'performance', results: 'performance',
  pnl: 'performance', analytics: 'performance',
  signals: 'signals', signal: 'signals',
  assistant: 'assistant', ai: 'assistant', chat: 'assistant',
  news: 'news', headlines: 'news', feed: 'news', feeds: 'news',
  analyze: 'analyze', analysis: 'analyze', analyse: 'analyze',
  train: 'train', training: 'train',
  backtest: 'backtest', backtesting: 'backtest',
  settings: 'settings', setting: 'settings', credentials: 'settings', keys: 'settings',
  connect: 'settings', connection: 'settings', binance: 'settings', account: 'settings', risk: 'settings',
  admin: 'admin', users: 'admin',
}

// Pull a trailing [[goto:<dest>]] action out of an AI reply: returns the reply
// with the tag stripped (it's machine-only, never shown) plus the resolved tab.
function parseNavAction(text: string): { text: string; dest: TabKey | null } {
  const m = text.match(/\[\[\s*goto\s*:\s*([a-zA-Z]+)\s*\]\]/i)
  if (!m) return { text, dest: null }
  const dest = NAV_ALIAS[m[1].toLowerCase()] ?? null
  return { text: text.replace(m[0], '').trim(), dest }
}

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
  // Free-text draft for the symbol box (committed on Enter/blur) so you can
  // chart ANY pair, not just the presets, without reloading on every keystroke.
  const [symbolDraft, setSymbolDraft] = useState(SYMBOLS[0])
  // Wall-clock of the last status we received (WS push or poll), so the bot
  // activity strip can show an honest "updated Ns ago" heartbeat.
  const [statusTs, setStatusTs] = useState(0)
  const [amount, setAmount] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')
  const [placing, setPlacing] = useState(false)
  // Scaled / DCA entry controls (buy-only; splits one entry into laddered legs).
  const [scaleIn, setScaleIn] = useState(false)
  const [legs, setLegs] = useState('3')
  const [stepPct, setStepPct] = useState('1')
  const [firstAtMarket, setFirstAtMarket] = useState(true)
  const [scaling, setScaling] = useState(false)
  const [closingAll, setClosingAll] = useState(false)
  const [closing, setClosing] = useState<number | null>(null)
  const [toast, setToast] = useState<Toast>(null)
  const [tab, setTab] = useState<TabKey>('trades')
  const [access, setAccess] = useState<ExchangeAccess | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Global connection status (shown in the slim bar under the header on every
  // tab): the built-in AI provider's real reachability + the exchange access.
  const [aiHealth, setAiHealth] = useState<AiHealth | null>(null)
  const [aiHealthLoading, setAiHealthLoading] = useState(false)
  const [testingAccess, setTestingAccess] = useState(false)
  // Header notifications feed: a capped, persistent log of recent alerts/pings
  // behind the 🔔 bell, with an unread count.
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [notifUnread, setNotifUnread] = useState(0)

  const showToast = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text })
    // Mirror every toast into the persistent notifications feed so it survives
    // the 4s auto-dismiss. Newest first; capped so the log can't grow unbounded.
    setNotifs((n) =>
      [{ id: Date.now() + Math.random(), kind, text, ts: Date.now() }, ...n].slice(0, 50),
    )
    setNotifUnread((u) => Math.min(u + 1, 999))
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

  // Apply a fresh status and stamp when it arrived, so the UI can show a
  // truthful "last updated" heartbeat rather than implying constant liveness.
  const applyStatus = useCallback((s: BotStatus) => {
    setStatus(s)
    setStatusTs(Date.now())
  }, [])

  const { connected } = useSocket({
    onStatus: applyStatus,
    onEvent: (m) => {
      if (TRADE_EVENTS.has(m.event)) {
        refreshTrades()
      }
      if (m.event === 'signal') {
        refreshSignals()
        // The built-in analyzer logs its OWN verdict changes here too. A
        // hold/blocked verdict isn't a failure, so don't flash a red error
        // toast for it — only surface a toast when the bot actually acted.
        // External (TradingView) signals keep the ok/error toast so a
        // rejected alert is still visible.
        if (m.data.source === 'analyzer') {
          if (m.data.accepted) showToast('ok', m.data.message)
        } else {
          showToast(m.data.accepted ? 'ok' : 'error', m.data.message)
        }
      }
    },
  })

  // Re-run the real exchange connection probe (used on mount, after saving
  // API keys, and by the "Test connection" button) so the connection status
  // shown is always the true, current result — never a stale/blank guess.
  const refreshAccess = useCallback(async (): Promise<ExchangeAccess | null> => {
    try {
      const a = await api.exchangeAccess()
      setAccess(a)
      return a
    } catch {
      return null
    }
  }, [])

  // Real AI-provider reachability probe (one honest ping, no secrets) so the
  // global status bar can say "connected" or the concrete reason it can't answer.
  const loadAiHealth = useCallback(async () => {
    setAiHealthLoading(true)
    try {
      setAiHealth(await api.aiHealth())
    } catch {
      setAiHealth(null)
    } finally {
      setAiHealthLoading(false)
    }
  }, [])

  // Re-run the exchange probe on demand from the status bar's "Test" button.
  const testAccess = useCallback(async () => {
    setTestingAccess(true)
    try {
      const a = await refreshAccess()
      if (!a) showToast('error', 'Could not reach the connection check.')
    } finally {
      setTestingAccess(false)
    }
  }, [refreshAccess, showToast])

  // Initial load.
  useEffect(() => {
    api.status().then(applyStatus).catch(() => {})
    loadSettings()
    refreshAccess()
    loadAiHealth()
    refreshTrades()
    refreshSignals()
  }, [loadSettings, refreshAccess, loadAiHealth, refreshTrades, refreshSignals, applyStatus])

  // Poll the trades table on a slow cadence as a safety net. Trade changes are
  // normally pushed over the WebSocket (see onEvent), but if the socket drops
  // and reconnects, any events during the gap are missed; this also keeps an
  // open position's unrealized PnL from going stale between pushes. Cheap GET.
  useEffect(() => {
    const id = setInterval(refreshTrades, 15000)
    return () => clearInterval(id)
  }, [refreshTrades])

  // Same safety net for the signal log: verdict changes are pushed over the
  // WebSocket, but poll on a slow cadence so anything missed during a socket
  // gap still appears (and the tab is populated even if a push was dropped).
  useEffect(() => {
    const id = setInterval(refreshSignals, 20000)
    return () => clearInterval(id)
  }, [refreshSignals])

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

  // Keep the symbol box's draft in step when the pair changes elsewhere (e.g.
  // picking a preset), then commit a typed pair: uppercased, and defaulted to a
  // /USDT quote when none is given, so "doge" becomes "DOGE/USDT".
  useEffect(() => {
    setSymbolDraft(symbol)
  }, [symbol])
  const commitSymbol = () => {
    let s = symbolDraft.trim().toUpperCase()
    if (!s) {
      setSymbolDraft(symbol)
      return
    }
    if (!s.includes('/')) s = `${s}/USDT`
    setSymbolDraft(s)
    if (s !== symbol) setSymbol(s)
  }

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

  const doScaledOrder = async () => {
    if (scaling) return // guard against double-submit
    const amt = amount ? Number(amount) : undefined
    const sl = stopLoss ? Number(stopLoss) : undefined
    const tp = takeProfit ? Number(takeProfit) : undefined
    const nLegs = Number(legs)
    const step = Number(stepPct)
    if (!Number.isInteger(nLegs) || nLegs < 2 || nLegs > 20) {
      showToast('error', 'Legs must be a whole number between 2 and 20.')
      return
    }
    if (!Number.isFinite(step) || step <= 0 || step > 50) {
      showToast('error', 'Step % must be greater than 0 and at most 50.')
      return
    }
    const nums: [string, number | undefined][] = [
      ['Amount', amt],
      ['Stop loss', sl],
      ['Take profit', tp],
    ]
    for (const [label, v] of nums) {
      if (v !== undefined && (!Number.isFinite(v) || v <= 0)) {
        showToast('error', `${label} must be a positive number.`)
        return
      }
    }
    // Same real-money confirm gate as doOrder: confirm unless we KNOW it's paper.
    if (status?.trading_mode !== 'paper') {
      const knownLive = status?.trading_mode === 'live'
      const parts = [
        `Scaled BUY ${symbol}`,
        `${nLegs} legs, ${step}% apart`,
        firstAtMarket ? 'first leg at market' : 'all resting limits',
        amt ? `total amount ${amt}` : 'auto-sized by risk',
      ]
      if (sl) parts.push(`stop-loss ${sl}`)
      if (tp) parts.push(`take-profit ${tp}`)
      const header = knownLive
        ? 'LIVE SCALED ORDER — this uses real funds on your Binance account.'
        : 'Trading mode not confirmed yet — this MAY place REAL orders on your Binance account.'
      if (!window.confirm(`${header}\n\n${parts.join('  ·  ')}\n\nPlace this scaled entry?`)) return
    }
    setScaling(true)
    try {
      const res = await api.scaledOrder({
        symbol,
        amount: amt,
        legs: nLegs,
        step_pct: step,
        first_at_market: firstAtMarket,
        stop_loss: sl,
        take_profit: tp,
      })
      showToast(res.accepted ? 'ok' : 'error', res.message)
      refreshTrades()
    } catch (e) {
      showToast('error', (e as Error).message)
    } finally {
      setScaling(false)
    }
  }

  const doCloseAll = async () => {
    if (closingAll) return // one bulk-close at a time
    // Same conservative gate as closeTrade: confirm unless we KNOW it's paper.
    if (status?.trading_mode !== 'paper') {
      const msg =
        status?.trading_mode === 'live'
          ? `Close ALL LIVE ${symbol} positions and cancel any resting orders at market now?`
          : `Trading mode not confirmed yet — this may close REAL ${symbol} positions at market. Continue?`
      if (!window.confirm(msg)) return
    }
    setClosingAll(true)
    try {
      const res = await api.closeAll(symbol)
      showToast(res.closed > 0 ? 'ok' : 'error', res.message)
      refreshTrades()
    } catch (e) {
      showToast('error', (e as Error).message)
    } finally {
      setClosingAll(false)
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
        <NotificationsBell
          items={notifs}
          unread={notifUnread}
          onOpen={() => setNotifUnread(0)}
          onClear={() => {
            setNotifs([])
            setNotifUnread(0)
          }}
        />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <button className="btn primary" onClick={toggleBot}>
          {status?.running ? 'Stop bot' : 'Start bot'}
        </button>
        <button className="btn" onClick={onLogout}>
          Sign out
        </button>
      </header>

      {/* Slim, always-on status bar: the AI provider + exchange connection live
          here so they show on every tab, not buried inside the chat panel. */}
      <ConnectionBar
        aiHealth={aiHealth}
        aiHealthLoading={aiHealthLoading}
        onRecheckAi={loadAiHealth}
        access={access}
        testing={testingAccess}
        onTest={testAccess}
        onFix={() => setTab('settings')}
      />

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

          <BotPulse
            status={status}
            statusTs={statusTs}
            signals={signals}
            settings={settings}
            connected={connected}
          />

          <AutonomyToggle
            settings={settings}
            status={status}
            onSaved={(s) => setSettings(s)}
            onError={(m) => showToast('error', m)}
          />

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
                    {/* Honest source label: when the primary exchange is
                        geo-blocked, market data is served from the configured
                        public fallback venue. Show it so the price is never
                        implied to come from somewhere it didn't. */}
                    {ticker?.source &&
                      access?.exchange &&
                      ticker.source !== access.exchange && (
                        <span
                          className="hint"
                          title={`${access.exchange} market data is unavailable here (e.g. geo-blocked); this price is served from the public fallback ${ticker.source}. Orders and balances still use ${access.exchange}.`}
                        >
                          via {ticker.source}
                        </span>
                      )}
                  </>
                )}
              </div>
              <div className="row" style={{ alignItems: 'center' }}>
                <input
                  className="input sym-input"
                  list="symbol-presets"
                  value={symbolDraft}
                  onChange={(e) => setSymbolDraft(e.target.value)}
                  onBlur={commitSymbol}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitSymbol()
                      ;(e.target as HTMLInputElement).blur()
                    }
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Symbol (any Binance pair, e.g. BTC/USDT)"
                  title="Type any Binance pair (e.g. DOGE/USDT) and press Enter"
                />
                <datalist id="symbol-presets">
                  {SYMBOLS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
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
              <MarketStats ticker={ticker} symbol={symbol} stale={tickerStale} />
              {candles.length ? (
                <PriceChart
                  candles={candles}
                  theme={theme}
                  last={livePrice}
                  fitKey={`${symbol}:${timeframe}`}
                  symbol={symbol}
                  timeframe={timeframe}
                />
              ) : (
                <div className="empty">
                  No candle data. Check the backend / Binance connection.
                </div>
              )}
            </div>
          </section>

          <OrderBook symbol={symbol} exchange={access?.exchange} />

          <section className="panel">
            <div className="panel-head">Manual order</div>
            <div className="panel-body">
              <div className="row">
                <div className="field">
                  <label>Symbol</label>
                  <input className="input" value={symbol} readOnly />
                </div>
                <div className="field">
                  <label>{scaleIn ? 'Total amount across all legs (blank = auto)' : 'Amount (blank = auto-size by risk)'}</label>
                  <input
                    className="input"
                    placeholder="auto"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <div className="field">
                  <label>{scaleIn ? 'Limit price (set by ladder)' : 'Limit price (blank = market)'}</label>
                  <input
                    className="input"
                    placeholder={scaleIn ? 'stepped per leg' : 'market'}
                    value={scaleIn ? '' : limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    inputMode="decimal"
                    disabled={scaleIn}
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
                {scaleIn && (
                  <>
                    <div className="field">
                      <label>Legs (2–20)</label>
                      <input
                        className="input"
                        placeholder="3"
                        value={legs}
                        onChange={(e) => setLegs(e.target.value)}
                        inputMode="numeric"
                      />
                    </div>
                    <div className="field">
                      <label>Step % between legs</label>
                      <input
                        className="input"
                        placeholder="1"
                        value={stepPct}
                        onChange={(e) => setStepPct(e.target.value)}
                        inputMode="decimal"
                      />
                    </div>
                  </>
                )}
                {scaleIn ? (
                  <button className="btn buy" onClick={doScaledOrder} disabled={scaling}>
                    {scaling ? 'Placing…' : 'Scaled buy'}
                  </button>
                ) : (
                  <>
                    <button className="btn buy" onClick={() => doOrder('buy')} disabled={placing}>
                      {placing ? 'Placing…' : 'Buy'}
                    </button>
                    <button className="btn sell" onClick={() => doOrder('sell')} disabled={placing}>
                      {placing ? 'Placing…' : 'Sell'}
                    </button>
                  </>
                )}
                <button className="btn ghost" onClick={doCloseAll} disabled={closingAll}>
                  {closingAll ? 'Closing…' : `Close all ${symbol}`}
                </button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={scaleIn}
                    onChange={(e) => setScaleIn(e.target.checked)}
                  />
                  Scale in (DCA) — split one buy into a ladder of legs
                </label>
                {scaleIn && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={firstAtMarket}
                      onChange={(e) => setFirstAtMarket(e.target.checked)}
                    />
                    First leg at market (rest are resting limits)
                  </label>
                )}
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                Orders respect your risk settings. In <b>paper</b> mode nothing hits the exchange;
                in <b>live</b> mode you'll be asked to confirm before real funds are used. Set a
                <b> limit price</b> to rest the order until the market reaches it (a buy fills at or
                below it, a sell at or above it); leave it blank for an immediate market order. A
                blank <b>stop-loss</b>/<b>take-profit</b> uses your configured default percentages.
                <br />
                <b>Scale in (DCA)</b> splits a single buy into a ladder of legs stepped below the
                current price. The <b>total</b> is sized once by your risk manager, then divided
                equally — so a ladder never risks more than one entry. The first leg can fill at
                market; the rest rest as limit orders and each filled leg gets its own
                stop-loss/take-profit. <b>Close all {symbol}</b> exits every open position and
                cancels every resting leg for the symbol in one click.
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
                  className={`tab ${tab === 'performance' ? 'active' : ''}`}
                  onClick={() => setTab('performance')}
                >
                  Performance
                </span>
                <span
                  className={`tab ${tab === 'signals' ? 'active' : ''}`}
                  onClick={() => setTab('signals')}
                >
                  Signals
                </span>
                <span
                  className={`tab ${tab === 'assistant' ? 'active' : ''}`}
                  onClick={() => setTab('assistant')}
                >
                  AI Assistant
                </span>
                <span
                  className={`tab ${tab === 'news' ? 'active' : ''}`}
                  onClick={() => setTab('news')}
                >
                  News
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
              {/* On phones the tab strip is hidden (the hamburger drawer is the
                 nav); show just the current view's name so context isn't lost. */}
              <div className="tab-current">{NAV_LABEL[tab]}</div>
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
              {tab === 'performance' && (
                <PerformancePanel onError={(m) => showToast('error', m)} />
              )}
              {tab === 'assistant' && (
                <AssistantPanel
                  symbol={symbol}
                  timeframe={timeframe}
                  onNavigate={setTab}
                  onError={(m) => showToast('error', m)}
                />
              )}
              {tab === 'news' && <NewsPanel onError={(m) => showToast('error', m)} />}
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
                  onRefreshAccess={refreshAccess}
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

// Human-friendly "x minutes ago" for the notifications feed. Recomputed on each
// render (no ticking timer) — good enough for a dropdown.
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// Slim, always-visible status strip under the header: the built-in AI provider's
// real reachability and the exchange connection, each with a concrete state and
// a one-click action. Lifted out of the AI chat panel so it shows on every tab.
function ConnectionBar({
  aiHealth,
  aiHealthLoading,
  onRecheckAi,
  access,
  testing,
  onTest,
  onFix,
}: {
  aiHealth: AiHealth | null
  aiHealthLoading: boolean
  onRecheckAi: () => void
  access: ExchangeAccess | null
  testing: boolean
  onTest: () => void
  onFix: () => void
}) {
  return (
    <div className="conn-bar">
      <div
        className={`conn-pill ${aiHealth ? (aiHealth.ok ? 'ok' : 'bad') : 'muted'}`}
        title={aiHealth?.detail || ''}
      >
        <span className="conn-dot" />
        <span className="conn-label">Assistant AI</span>
        <span className="conn-state">
          {aiHealthLoading
            ? 'checking…'
            : aiHealth
              ? aiHealth.ok
                ? `connected (${aiHealth.model || 'model'})`
                : `not working — ${aiHealth.detail}`
              : 'status unknown'}
        </span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={onRecheckAi}
          disabled={aiHealthLoading}
          title="Re-check the AI provider"
        >
          {aiHealthLoading ? '…' : '↻'}
        </button>
      </div>
      <div
        className={`conn-pill ${access ? (access.ok ? 'ok' : 'bad') : 'muted'}`}
        title={access?.detail || ''}
      >
        <span className="conn-dot" />
        <span className="conn-label">Exchange</span>
        <span className="conn-state">
          {access
            ? access.can_trade
              ? `trade-ready on ${access.exchange ?? 'exchange'} (${access.testnet ? 'testnet' : 'live'})`
              : access.can_read_account
                ? 'connected, read-only (can’t trade yet)'
                : access.can_read_public
                  ? 'public data only — not signed in'
                  : 'not connected'
            : 'not tested'}
        </span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={onTest}
          disabled={testing}
          title="Test the exchange connection now"
        >
          {testing ? '…' : 'Test'}
        </button>
        {access && !access.can_trade && (
          <button
            type="button"
            className="btn sm"
            onClick={onFix}
            title="Open Settings to add keys / fix the connection"
          >
            Fix in Settings →
          </button>
        )}
      </div>
    </div>
  )
}

// Header notifications: a 🔔 with an unread badge and a dropdown feed of recent
// alerts/pings (fed from every showToast). Opening it clears the unread count;
// transient toasts still flash for live events.
function NotificationsBell({
  items,
  unread,
  onOpen,
  onClear,
}: {
  items: Notif[]
  unread: number
  onOpen: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Close on outside-click / Escape, like a normal popover menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    setOpen((v) => {
      if (!v) onOpen() // opening marks everything read
      return !v
    })
  }

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className="notif-bell"
        onClick={toggle}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        aria-expanded={open}
        title="Notifications"
      >
        🔔
        {unread > 0 && <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-dropdown" role="menu">
          <div className="notif-head">
            <span>Notifications</span>
            {items.length > 0 && (
              <button type="button" className="btn ghost sm" onClick={onClear}>
                Clear
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="notif-empty">
              No notifications yet. Bot pings and alerts will show up here.
            </div>
          ) : (
            <div className="notif-list">
              {items.map((n) => (
                <div key={n.id} className={`notif-item ${n.kind}`}>
                  <span className="n-dot" />
                  <div className="notif-body">
                    <div>{n.text}</div>
                    <div className="notif-time">{relativeTime(n.ts)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Compact number (1.23K / 4.56M / 7.89B) for volumes and order sizes.
function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K'
  return n.toFixed(a > 0 && a < 1 ? 4 : 2)
}

// Price with a sensible number of decimals for its magnitude.
function fmtPx(v: number): string {
  const dp = v < 1 ? 6 : v < 10 ? 4 : 2
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

// Short "time since" for the activity heartbeat. Truthful, not decorative.
function ago(ts: number): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 3) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// Live bid/ask + 24h volume strip above the chart. Every figure is only shown
// when the venue actually reported it — no fabricated depth or volume.
function MarketStats({
  ticker,
  symbol,
  stale,
}: {
  ticker: Ticker | null
  symbol: string
  stale: boolean
}) {
  const [base, quote] = symbol.split('/')
  const bid = ticker?.bid ?? null
  const ask = ticker?.ask ?? null
  const spread = bid != null && ask != null && ask > 0 ? ask - bid : null
  const spreadPct = spread != null && ask ? (spread / ask) * 100 : null
  return (
    <div className={`market-stats ${stale ? 'stale' : ''}`}>
      <div className="ms-item">
        <span className="ms-k">Bid</span>
        <span className="ms-v buy" title="Highest resting buy order — you sell into this">
          {bid != null ? fmtPx(bid) : '—'}
        </span>
      </div>
      <div className="ms-item">
        <span className="ms-k">Ask</span>
        <span className="ms-v sell" title="Lowest resting sell order — you buy at this">
          {ask != null ? fmtPx(ask) : '—'}
        </span>
      </div>
      <div className="ms-item">
        <span className="ms-k">Spread</span>
        <span className="ms-v">
          {spread != null ? `${fmtPx(spread)}${spreadPct != null ? ` (${spreadPct.toFixed(3)}%)` : ''}` : '—'}
        </span>
      </div>
      <div className="ms-item">
        <span className="ms-k">24h Vol</span>
        <span className="ms-v" title="24h traded volume reported by the venue">
          {ticker?.base_volume != null ? `${compact(ticker.base_volume)} ${base}` : '—'}
          {ticker?.quote_volume != null ? ` · ${compact(ticker.quote_volume)} ${quote}` : ''}
        </span>
      </div>
    </div>
  )
}
// Live order-book depth: the market's REAL resting bids (buy side) and asks
// (sell side), polled every few seconds. Depth bars are scaled to the largest
// order shown. Empty sides mean the venue returned no depth — never invented.
function OrderBook({ symbol, exchange }: { symbol: string; exchange?: string }) {
  const [book, setBook] = useState<OrderBookData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setBook(null)
    setErr(null)
    const load = () =>
      api
        .orderbook(symbol, 20)
        .then((b) => {
          if (alive) {
            setBook(b)
            setErr(null)
          }
        })
        .catch((e) => {
          if (alive) setErr(e?.message || 'unavailable')
        })
    load()
    const id = setInterval(load, 2500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [symbol])

  const LEVELS = 12
  const asks = (book?.asks ?? []).slice(0, LEVELS)
  const bids = (book?.bids ?? []).slice(0, LEVELS)
  const maxAmt = Math.max(1e-9, ...asks.map((a) => a.amount), ...bids.map((b) => b.amount))
  const bestAsk = book?.asks[0]?.price
  const bestBid = book?.bids[0]?.price
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null
  const spreadPct = spread != null && bestAsk ? (spread / bestAsk) * 100 : null
  const viaFallback = Boolean(book?.source && exchange && book.source !== exchange)
  return (
    <section className="panel orderbook">
      <div className="panel-head">
        <span>Order book</span>
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          {viaFallback && (
            <span className="hint" title={`Depth served from the public fallback ${book?.source}, not ${exchange}.`}>
              via {book?.source}
            </span>
          )}
          {spread != null && (
            <span className="hint">
              Spread {fmtPx(spread)}
              {spreadPct != null ? ` (${spreadPct.toFixed(3)}%)` : ''}
            </span>
          )}
        </div>
      </div>
      <div className="panel-body">
        {err ? (
          <div className="empty">Order book unavailable: {err}</div>
        ) : !book ? (
          <div className="empty">Loading order book…</div>
        ) : asks.length === 0 && bids.length === 0 ? (
          <div className="empty">No resting orders returned{book.source ? ` by ${book.source}` : ''}.</div>
        ) : (
          <div className="ob">
            <div className="ob-headrow">
              <span>Price</span>
              <span>Amount</span>
            </div>
            <div className="ob-side">
              {[...asks].reverse().map((lvl, i) => (
                <div className="ob-row ask" key={`a${i}`}>
                  <div className="ob-depth" style={{ width: `${(lvl.amount / maxAmt) * 100}%` }} />
                  <span className="ob-price sell">{fmtPx(lvl.price)}</span>
                  <span className="ob-amt">{compact(lvl.amount)}</span>
                </div>
              ))}
            </div>
            <div className="ob-spread">
              {bestBid != null && bestAsk != null ? `${fmtPx(bestBid)} — ${fmtPx(bestAsk)}` : '—'}
            </div>
            <div className="ob-side">
              {bids.map((lvl, i) => (
                <div className="ob-row bid" key={`b${i}`}>
                  <div className="ob-depth" style={{ width: `${(lvl.amount / maxAmt) * 100}%` }} />
                  <span className="ob-price buy">{fmtPx(lvl.price)}</span>
                  <span className="ob-amt">{compact(lvl.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
// Bot activity heartbeat: an honest, at-a-glance answer to "is the bot actually
// doing anything?". Shows the live monitor pulse, mode, open positions, the
// most recent logged signal, an "updated Ns ago" stamp, and a plain-English
// line on what "running" means right now (watching vs. autonomously trading).
function BotPulse({
  status,
  statusTs,
  signals,
  settings,
  connected,
}: {
  status: BotStatus | null
  statusTs: number
  signals: SignalRow[]
  settings: Settings | null
  connected: boolean
}) {
  // Re-render every second so the "updated Ns ago" heartbeat stays honest.
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const running = Boolean(status?.running)
  const auto = Boolean(settings?.auto_trade_enabled)
  const latest = signals.length
    ? [...signals].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0]
    : null
  const autoSymbols = settings?.auto_symbols?.trim() || 'your auto symbols'

  let explain: string
  if (!running) {
    explain =
      'Monitor stopped — no new signals. Stop-loss / take-profit and resting-order checks still run to protect any open trades.'
  } else if (auto) {
    explain = `Autonomous trading is ON: a confident signal on ${autoSymbols} can place a REAL order. It never invents trades.`
  } else {
    explain = `Watching ${autoSymbols} and logging verdicts to Signals — it does NOT place orders unless you send a manual order or a TradingView alert fires.`
  }
  return (
    <section className="bot-pulse">
      <div className="bp-main">
        <span className={`bp-dot ${running ? 'live' : 'off'}`} />
        <span className="bp-state">{running ? 'Monitoring market' : 'Bot stopped'}</span>
        <span className={`badge ${status?.trading_mode === 'live' ? 'live' : 'paper'}`}>
          {status?.trading_mode ?? '—'}
        </span>
        {status?.testnet && <span className="badge">testnet</span>}
        <span className={`badge ${auto ? 'on' : 'off'}`}>auto {auto ? 'on' : 'off'}</span>
        <span className="bp-sep" />
        <span className="bp-meta">Open positions: {status?.open_positions ?? 0}</span>
        <span className="bp-sep" />
        <span className="bp-meta" title="Time since the last status update from the backend">
          {connected ? 'updated ' : 'stale — reconnecting, last '}
          {ago(statusTs)}
        </span>
      </div>
      <div className="bp-signal">
        {latest ? (
          <>
            <span className="bp-k">Latest signal</span>
            <span className={`badge ${latest.accepted ? 'on' : 'off'}`}>
              {latest.accepted ? 'acted' : 'logged'}
            </span>
            <span className="bp-sig">
              {latest.source}: {latest.action ?? 'hold'} {latest.symbol ?? ''}
              {latest.confidence != null ? ` · ${(latest.confidence * 100).toFixed(0)}%` : ''}
            </span>
            <span className="hint">{ago(+new Date(latest.created_at))}</span>
          </>
        ) : (
          <span className="hint">No signals logged yet — none will appear until the bot is running.</span>
        )}
      </div>
      <div className="bp-explain">{explain}</div>
    </section>
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

// Map a REAL analyzer verdict + confidence to a TradingView-style rating label.
// Never invents a rating: a hold, or a row with no confidence, reads "Neutral".
function ratingFor(
  action: string | null,
  confidence: number | null,
): { label: string; cls: string } {
  if (action === 'buy')
    return confidence != null && confidence >= 0.66
      ? { label: 'Strong Buy', cls: 'rate-strong-buy' }
      : { label: 'Buy', cls: 'rate-buy' }
  if (action === 'sell')
    return confidence != null && confidence >= 0.66
      ? { label: 'Strong Sell', cls: 'rate-strong-sell' }
      : { label: 'Sell', cls: 'rate-sell' }
  return { label: 'Neutral', cls: 'rate-neutral' }
}

type SigSource = 'all' | 'analyzer' | 'tradingview'
type SigAction = 'all' | 'buy' | 'sell' | 'hold'

function SignalsTable({ signals }: { signals: SignalRow[] }) {
  const [srcFilter, setSrcFilter] = useState<SigSource>('all')
  const [actFilter, setActFilter] = useState<SigAction>('all')

  // Per-symbol rating strip from the LATEST analyzer verdict per symbol. Signals
  // arrive newest-first, so the first analyzer row seen for a symbol is current.
  // Built only from real logged verdicts — a symbol with none is never shown.
  const ratings = useMemo(() => {
    const seen = new Map<string, SignalRow>()
    for (const s of signals) {
      if (s.source !== 'analyzer' || !s.symbol) continue
      if (!seen.has(s.symbol)) seen.set(s.symbol, s)
    }
    return Array.from(seen.values())
  }, [signals])

  const filtered = useMemo(
    () =>
      signals.filter((s) => {
        if (srcFilter !== 'all' && s.source !== srcFilter) return false
        if (actFilter !== 'all' && (s.action ?? 'hold') !== actFilter) return false
        return true
      }),
    [signals, srcFilter, actFilter],
  )

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString()
  }
  const actionClass = (a: string | null) =>
    a === 'buy' ? 'sig-buy' : a === 'sell' ? 'sig-sell' : 'sig-hold'

  return (
    <div className="signals-wrap">
      {ratings.length > 0 && (
        <div className="rating-strip">
          {ratings.map((r) => {
            const rt = ratingFor(r.action, r.confidence)
            const pct = r.confidence != null ? Math.round(r.confidence * 100) : null
            return (
              <div key={r.symbol} className="rating-card" title={r.message ?? undefined}>
                <div className="rating-sym">{r.symbol}</div>
                <div className={`rating-badge ${rt.cls}`}>{rt.label}</div>
                <div className="conf-bar">
                  <span
                    className={`conf-fill ${rt.cls}`}
                    style={{ width: pct != null ? `${pct}%` : '0%' }}
                  />
                </div>
                <div className="muted rating-conf">
                  {pct != null ? `confidence ${pct}%` : 'no confidence'}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="sig-filters">
        <div className="seg">
          {(['all', 'analyzer', 'tradingview'] as SigSource[]).map((v) => (
            <button
              key={v}
              type="button"
              className={`seg-btn ${srcFilter === v ? 'active' : ''}`}
              onClick={() => setSrcFilter(v)}
            >
              {v === 'all' ? 'All sources' : v === 'analyzer' ? 'Brain' : 'TradingView'}
            </button>
          ))}
        </div>
        <div className="seg">
          {(['all', 'buy', 'sell', 'hold'] as SigAction[]).map((v) => (
            <button
              key={v}
              type="button"
              className={`seg-btn ${actFilter === v ? 'active' : ''}`}
              onClick={() => setActFilter(v)}
            >
              {v === 'all' ? 'All' : v.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="hint">{filtered.length} shown</span>
      </div>

      {!signals.length ? (
        <div className="empty">
          No signals yet. The built-in analyzer records its own live verdicts here
          every few seconds while the bot is running — even with autonomous trading
          off — alongside any TradingView alerts you wire up in Settings.
        </div>
      ) : !filtered.length ? (
        <div className="empty">No signals match the current filters.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Source</th>
              <th>Action</th>
              <th>Symbol</th>
              <th>Confidence</th>
              <th>Acted</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const pct = s.confidence != null ? Math.round(s.confidence * 100) : null
              return (
                <tr key={s.id}>
                  <td className="muted">{fmtTime(s.created_at)}</td>
                  <td>
                    <span className={`src-badge src-${s.source}`}>
                      {s.source === 'analyzer' ? 'Brain' : s.source}
                    </span>
                  </td>
                  <td>
                    <span className={actionClass(s.action)}>
                      {(s.action ?? '-').toUpperCase()}
                    </span>
                  </td>
                  <td>{s.symbol ?? '-'}</td>
                  <td>
                    {pct != null ? (
                      <div className="conf-cell">
                        <div className="conf-bar sm">
                          <span
                            className={`conf-fill ${actionClass(s.action)}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="mono muted">{pct}%</span>
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{s.accepted ? '✅' : '—'}</td>
                  <td className="muted sig-detail">{s.message ?? '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// Turn a duration in seconds into a compact human label (e.g. "2h 15m").
function fmtHold(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h < 24) return remM ? `${h}h ${remM}m` : `${h}h`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return remH ? `${d}d ${remH}h` : `${d}d`
}

// Realized performance analytics for the current user, computed live by the
// backend from CLOSED trades only. Read-only: this panel never places or
// changes an order. Paper and live are shown separately so simulated gains are
// never mistaken for real money, and undefined metrics stay "—" (never faked).
function PerformancePanel({ onError }: { onError: (msg: string) => void }) {
  const [perf, setPerf] = useState<Performance | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      setPerf(await api.performance())
    } catch (e) {
      setFailed(true)
      onError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [onError])

  useEffect(() => {
    load()
  }, [load])

  const cls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')
  const money = (n: number) => `${n < 0 ? '-' : ''}$${fmt(Math.abs(n))}`
  const pf = (v: number | null) => (v == null ? '—' : fmt(v))

  if (!perf) {
    if (loading) return <div className="empty">Loading…</div>
    return (
      <div className="empty">
        {failed ? "Couldn't load your performance." : 'No performance data.'}
        <button className="btn" style={{ marginLeft: 10 }} onClick={load}>
          Retry
        </button>
      </div>
    )
  }

  if (perf.closed_trades === 0) {
    return (
      <div className="empty">
        No closed trades yet. Your realized performance — win rate, profit
        factor, expectancy and drawdown — appears here as soon as positions
        close. Paper and live results are tracked separately, so simulated gains
        are never counted as real money.
      </div>
    )
  }

  // One comparison row for a paper/live bucket. Drawdown is shown as a negative
  // magnitude so a bigger drop reads as more red, consistent with PnL.
  const bucketRow = (label: string, b: PerfBucket) => (
    <tr>
      <td>{label}</td>
      <td className="mono">{b.closed_trades}</td>
      <td className="mono">{fmt(b.win_rate_pct)}%</td>
      <td className={`mono ${cls(b.total_pnl)}`}>{money(b.total_pnl)}</td>
      <td className="mono">{pf(b.profit_factor)}</td>
      <td className="mono neg">{b.max_drawdown ? money(-b.max_drawdown) : money(0)}</td>
    </tr>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <p className="hint" style={{ flex: 1, margin: 0 }}>
          Realized results from your <b>closed</b> trades — computed live, never
          fabricated. Open positions aren't counted (no realized result yet), and
          an undefined metric shows “—”, not a fake number.
        </p>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? '…' : '↻ Refresh'}
        </button>
      </div>

      <div className="stats cols-3">
        <div className="stat">
          <div className="label">Closed trades</div>
          <div className="value">{perf.closed_trades}</div>
        </div>
        <div className="stat">
          <div className="label">Win rate</div>
          <div className="value">{fmt(perf.win_rate_pct)}%</div>
        </div>
        <div className="stat">
          <div className="label">Total realized PnL</div>
          <div className={`value ${cls(perf.total_pnl)}`}>{money(perf.total_pnl)}</div>
        </div>
        <div className="stat">
          <div className="label">Profit factor</div>
          <div
            className="value"
            title={perf.profit_factor == null ? 'Undefined — no losing trades yet' : undefined}
          >
            {pf(perf.profit_factor)}
          </div>
        </div>
        <div className="stat">
          <div className="label">Expectancy / trade</div>
          <div className={`value ${cls(perf.expectancy)}`}>{money(perf.expectancy)}</div>
        </div>
        <div className="stat">
          <div className="label">Max drawdown</div>
          <div className="value neg">{perf.max_drawdown ? money(-perf.max_drawdown) : money(0)}</div>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 20 }}>
        <span className="hint">Wins <b className="pos">{perf.wins}</b></span>
        <span className="hint">Losses <b className="neg">{perf.losses}</b></span>
        <span className="hint">Breakeven <b>{perf.breakeven}</b></span>
        <span className="hint">Avg win <b className="pos">{money(perf.avg_win)}</b></span>
        <span className="hint">Avg loss <b className="neg">{money(perf.avg_loss)}</b></span>
        <span className="hint">Largest win <b className="pos">{money(perf.largest_win)}</b></span>
        <span className="hint">Largest loss <b className="neg">{money(perf.largest_loss)}</b></span>
        <span className="hint">Avg hold <b>{fmtHold(perf.avg_hold_seconds)}</b></span>
      </div>

      <div>
        <div className="panel-head" style={{ paddingLeft: 0, borderBottom: 'none' }}>
          Paper vs live
        </div>
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th className="mono">Closed</th>
              <th className="mono">Win rate</th>
              <th className="mono">Total PnL</th>
              <th className="mono">Profit factor</th>
              <th className="mono">Max DD</th>
            </tr>
          </thead>
          <tbody>
            {bucketRow('📝 Paper (simulated)', perf.paper)}
            {bucketRow('💵 Live (real money)', perf.live)}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 6 }}>
          Paper and live are kept strictly separate — simulated gains are never
          added to your real-money results.
        </p>
      </div>

      {perf.by_symbol.length > 0 && (
        <div>
          <div className="panel-head" style={{ paddingLeft: 0, borderBottom: 'none' }}>
            By symbol (best first)
          </div>
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="mono">Trades</th>
                <th className="mono">Wins</th>
                <th className="mono">Realized PnL</th>
              </tr>
            </thead>
            <tbody>
              {perf.by_symbol.map((s) => (
                <tr key={s.symbol}>
                  <td>{s.symbol}</td>
                  <td className="mono">{s.trades}</td>
                  <td className="mono">{s.wins}</td>
                  <td className={`mono ${cls(s.pnl)}`}>{money(s.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function AutonomyToggle({
  settings,
  status,
  onSaved,
  onError,
}: {
  settings: Settings | null
  status: BotStatus | null
  onSaved: (s: Settings) => void
  onError: (msg: string) => void
}) {
  const [saving, setSaving] = useState(false)
  if (!settings) return null

  const auto = settings.auto_trade_enabled
  const symbols = settings.auto_symbols?.trim() ? settings.auto_symbols : '—'

  const setAuto = async (next: boolean) => {
    if (saving) return
    // Enabling autonomous execution outside paper risks REAL funds with no
    // per-order click -> require an explicit, honest confirmation first.
    if (next && status && status.trading_mode !== 'paper') {
      const warn =
        status.trading_mode === 'live'
          ? 'Enable AUTONOMOUS LIVE trading? The bot will place REAL orders on its own, within your risk limits, with no manual click per trade.'
          : 'Trading mode is not confirmed as paper — enabling autonomous trading may place REAL orders on its own. Continue?'
      if (!window.confirm(warn)) return
    }
    setSaving(true)
    try {
      onSaved(await api.updateSettings({ auto_trade_enabled: next }))
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel autonomy">
      <div className="panel-head">
        <span>Autonomy</span>
        <span className={`mode-pill ${auto ? 'on' : ''}`}>
          {auto ? '🤖 Auto' : '✋ Manual'}
        </span>
      </div>
      <div className="panel-body">
        <div className="switch-row">
          <div>
            <div className="switch-title">
              Autonomous trading is {auto ? 'ON' : 'OFF'}
            </div>
            <div className="hint">
              {auto
                ? `The bot analyses ${symbols} on ${settings.auto_timeframe} and places orders itself, within your risk limits.`
                : `Manual mode: the bot still analyses ${symbols} and logs live verdicts to Signals, but never places an order on its own.`}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={auto}
            className={`toggle ${auto ? 'on' : ''}`}
            onClick={() => setAuto(!auto)}
            disabled={saving}
            title={auto ? 'Switch to Manual' : 'Switch to Auto'}
          >
            <span className="knob" />
          </button>
        </div>
        {settings.ai_trade_confirm && (
          <div className="hint" style={{ marginTop: 8 }}>
            🧠 AI trade review is on — it may VETO an autonomous entry it judges too
            risky (it can never invent or force a trade).
          </div>
        )}
      </div>
    </section>
  )
}

// Browser-native voice input via the Web Speech API. Not every browser ships it,
// and some (e.g. Chrome) transcribe audio via a cloud service — so it's opt-in
// and the UI says so honestly. `any` is used only for these vendor-typed events.
type SpeechRec = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: any) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
function getSpeechRecognition(): (new () => SpeechRec) | null {
  const w = window as any
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

function AssistantPanel({
  symbol,
  timeframe,
  onNavigate,
  onError,
}: {
  symbol: string
  timeframe: string
  onNavigate: (dest: TabKey) => void
  onError: (msg: string) => void
}) {
  // AI replies may carry a hidden [[goto:…]] action; we keep the resolved tab on
  // the turn so the bubble can render a "take me there" button.
  type ChatMsg = ChatTurn & { nav?: { dest: TabKey; label: string } }
  const [turns, setTurns] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [useSymbol, setUseSymbol] = useState(true)
  const [useNews, setUseNews] = useState(false)
  const [readAloud, setReadAloud] = useState(false)
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRec | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const speechSupported = typeof window !== 'undefined' && getSpeechRecognition() != null
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

  // Keep the transcript pinned to the newest turn.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [turns, busy])

  // Stop listening / speaking if the user leaves the tab.
  useEffect(
    () => () => {
      recRef.current?.stop()
      if (typeof window !== 'undefined' && 'speechSynthesis' in window)
        window.speechSynthesis.cancel()
    },
    [],
  )

  const speak = (text: string) => {
    if (!readAloud || !ttsSupported) return
    try {
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
    } catch {
      /* ignore */
    }
  }

  const send = async (q: string) => {
    const question = q.trim()
    if (!question || busy) return
    // Prior turns become the conversation history the assistant reads, so it can
    // follow a multi-step task instead of answering each question cold. Captured
    // BEFORE we append this question (setTurns is async), so it's exactly the
    // context that preceded it. Drop the synthetic "(request failed…)" bubbles —
    // those are our own error notices, not real assistant replies.
    const history = turns
      .filter((m) => m.text && !(m.role === 'ai' && m.text.startsWith('(request failed:')))
      .slice(-20)
      .map((m) => ({
        role: m.role === 'ai' ? ('assistant' as const) : ('user' as const),
        content: m.text,
      }))
    setTurns((t) => [...t, { role: 'you', text: question }])
    setInput('')
    setBusy(true)
    try {
      const res = await api.aiChat({
        question,
        symbol: useSymbol ? symbol : undefined,
        timeframe: useSymbol ? timeframe : undefined,
        include_news: useNews,
        history,
      })
      // Extract any hidden navigation action; the spoken/shown text is the reply
      // with the tag removed, and a button lets the user actually go there.
      const { text, dest } = parseNavAction(res.reply)
      setTurns((t) => [
        ...t,
        {
          role: 'ai',
          text,
          usedNews: res.used_news,
          nav: dest ? { dest, label: NAV_LABEL[dest] } : undefined,
        },
      ])
      speak(text)
    } catch (e) {
      const msg = (e as Error).message
      onError(msg)
      setTurns((t) => [...t, { role: 'ai', text: `(request failed: ${msg})` }])
    } finally {
      setBusy(false)
    }
  }

  const toggleMic = () => {
    const Rec = getSpeechRecognition()
    if (!Rec) return
    if (listening) {
      recRef.current?.stop()
      return
    }
    const rec = new Rec()
    rec.lang = 'en-US'
    rec.interimResults = false
    rec.continuous = false
    rec.onresult = (e: any) => {
      const said = e?.results?.[0]?.[0]?.transcript ?? ''
      if (said) setInput((cur) => (cur ? `${cur} ${said}` : said))
    }
    rec.onerror = () => setListening(false)
    rec.onend = () => setListening(false)
    recRef.current = rec
    setListening(true)
    try {
      rec.start()
    } catch {
      setListening(false)
    }
  }

  const suggestions = [
    'How does this app work?',
    'Am I connected to my exchange?',
    'How do I connect Binance and go live?',
    `What's your read on ${symbol} ${timeframe}?`,
    'How is my bot doing right now?',
    'Take me to settings',
  ]

  return (
    <div className="assistant">
      <div className="chat-col">
        <div className="chat-list" ref={listRef}>
            {turns.length === 0 ? (
              <div className="chat-empty">
                <p>
                  Ask about your bot, a market, or your risk — or how the app
                  works and how to do things (“how do I connect Binance?”). It sees
                  your live, non-secret account state, can pull real headlines, and
                  can take you to the right screen (“take me to settings”). It
                  advises only: it can’t place orders or change settings for you.
                </p>
                <div className="chip-row">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="chip"
                      onClick={() => send(s)}
                      disabled={busy}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((t, i) => (
                <div key={i} className={`bubble ${t.role}`}>
                  <div className="bubble-role">{t.role === 'you' ? 'You' : '🤖 AI'}</div>
                  <div className="bubble-text">{t.text}</div>
                  {t.nav && (
                    <button
                      type="button"
                      className="btn primary sm nav-cta"
                      onClick={() => onNavigate(t.nav!.dest)}
                    >
                      Take me to {t.nav.label} →
                    </button>
                  )}
                  {t.usedNews && <div className="bubble-note">grounded in live news</div>}
                </div>
              ))
            )}
            {busy && (
              <div className="bubble ai">
                <div className="bubble-role">🤖 AI</div>
                <div className="bubble-text typing">Thinking…</div>
              </div>
            )}
          </div>

          <div className="chat-controls">
            <label className="check">
              <input
                type="checkbox"
                checked={useSymbol}
                onChange={(e) => setUseSymbol(e.target.checked)}
              />
              Include {symbol} {timeframe} analysis
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={useNews}
                onChange={(e) => setUseNews(e.target.checked)}
              />
              Attach live news
            </label>
            {ttsSupported && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={readAloud}
                  onChange={(e) => setReadAloud(e.target.checked)}
                />
                Read replies aloud
              </label>
            )}
          </div>

          <div className="chat-input">
            {speechSupported && (
              <button
                type="button"
                className={`btn mic ${listening ? 'rec' : ''}`}
                onClick={toggleMic}
                title={listening ? 'Stop listening' : 'Speak your question'}
              >
                {listening ? '● Listening' : '🎤'}
              </button>
            )}
            <input
              className="input"
              placeholder="Ask the AI anything about your bot or the market…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send(input)}
              disabled={busy}
            />
            <button
              className="btn primary"
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
            >
              {busy ? '…' : 'Send'}
            </button>
          </div>
          {speechSupported && (
            <p className="hint tiny">
              🎤 Voice uses your browser’s Web Speech API; some browsers send audio to
              a cloud service to transcribe. It stays off until you press the mic.
            </p>
          )}
        </div>
      </div>
  )
}

// Dedicated News dashboard: its own tab so headlines get full width instead of
// sharing the assistant column. Real public-feed items only — an empty list
// means the feeds were unreachable (never fabricated).
function NewsPanel({ onError }: { onError: (msg: string) => void }) {
  const [news, setNews] = useState<NewsItem[]>([])
  const [newsErrors, setNewsErrors] = useState<string[]>([])
  const [newsLoading, setNewsLoading] = useState(false)
  // When the headlines were last refreshed, so the dashboard shows it's live.
  const [newsFetchedAt, setNewsFetchedAt] = useState<number | null>(null)

  const loadNews = useCallback(async () => {
    setNewsLoading(true)
    try {
      const res = await api.news(12)
      setNews(res.items)
      setNewsErrors(res.errors)
      setNewsFetchedAt(Date.now())
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setNewsLoading(false)
    }
  }, [onError])

  // Load on mount, then auto-refresh so the dashboard stays near-real-time (the
  // backend already limits results to the last day and caches briefly).
  useEffect(() => {
    loadNews()
    const id = setInterval(loadNews, 60000)
    return () => clearInterval(id)
  }, [loadNews])

  const fmtNewsTime = (iso: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
  }

  return (
    <div className="news-panel">
      <div className="news-head">
        <span>📰 Live market news</span>
        <span className="news-updated muted">
          {newsFetchedAt
            ? `updated ${new Date(newsFetchedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}`
            : ''}
        </span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={loadNews}
          disabled={newsLoading}
          title="Refresh headlines"
        >
          {newsLoading ? '…' : '↻'}
        </button>
      </div>
      <p className="hint tiny news-sub">
        Real headlines from public feeds, newest first — today’s news (or the most
        recent day if today is quiet). Never fabricated.
      </p>
      {news.length === 0 && !newsLoading ? (
        <div className="empty sm">
          {newsErrors.length
            ? 'News sources are unreachable right now. Nothing is fabricated — this is empty because the real feeds could not be fetched.'
            : 'No headlines available.'}
        </div>
      ) : (
        <ul className="news-list">
          {news.map((n, i) => (
            <li key={`${n.link ?? n.title}:${i}`}>
              {n.link ? (
                <a href={n.link} target="_blank" rel="noopener noreferrer">
                  {n.title}
                </a>
              ) : (
                <span>{n.title}</span>
              )}
              <div className="news-meta muted">
                {n.source}
                {n.published ? ` · ${fmtNewsTime(n.published)}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
      {newsErrors.length > 0 && news.length > 0 && (
        <p className="hint tiny">Some feeds failed: {newsErrors.join(', ')}.</p>
      )}
    </div>
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
  const [useSaved, setUseSaved] = useState(false)
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
          useSaved,
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
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={useSaved}
          onChange={(e) => setUseSaved(e.target.checked)}
        />
        Use my saved (trained) strategy for {symbol} if one exists
      </label>

      {result && (
        <div>
          {result.used_saved && (
            <p className="hint" style={{ color: 'var(--green, #16a34a)' }}>
              ✅ Replayed your saved <b>{result.strategy}</b> strategy for {symbol} (the
              same config the bot trades with).
            </p>
          )}
          <div className="stats cols-3">
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
  // Bumped after a successful train so the saved-strategies list below refetches
  // and the freshly-saved config appears immediately.
  const [savedKey, setSavedKey] = useState(0)

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
      const r = await api.train(symbol, strategy, timeframe)
      setReport(r)
      if (r.saved) setSavedKey((k) => k + 1) // refresh the saved list below
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
              {report.saved ? (
                <p className="hint" style={{ color: 'var(--green, #16a34a)' }}>
                  ✅ Saved to your account for <b>{report.symbol}</b>. Turn on{' '}
                  <b>“Trade with my saved strategies”</b> in Settings and the bot
                  will trade {report.symbol} with this exact setup.
                </p>
              ) : (
                <p className="hint">
                  Not saved — no configuration beat a flat baseline on this data, so
                  nothing was persisted (the bot won't trade a losing setup).
                </p>
              )}
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

      <SavedStrategiesCard refreshKey={savedKey} onError={onError} />
    </div>
  )
}

function SavedStrategiesCard({
  refreshKey,
  onError,
}: {
  refreshKey: number
  onError: (msg: string) => void
}) {
  const [saved, setSaved] = useState<SavedStrategy[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      setSaved(await api.savedStrategies())
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const remove = async (symbol: string) => {
    setBusy(symbol)
    try {
      await api.deleteSavedStrategy(symbol)
      setSaved((prev) => prev.filter((s) => s.symbol !== symbol))
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="panel-head">Your saved strategies</div>
      <div className="panel-body">
        <p className="hint">
          The setups you've trained and saved, one per symbol. When{' '}
          <b>“Trade with my saved strategies”</b> is on in Settings, the bot trades
          each of these symbols with its saved config (its buy still yields to
          capital-preservation gates; its exit is always honoured). These live on
          your account and survive restarts.
        </p>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : saved.length === 0 ? (
          <div className="empty">
            Nothing saved yet. Train a strategy above and the winning setup is saved
            here automatically.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Strategy</th>
                  <th>Timeframe</th>
                  <th className="mono">Return %</th>
                  <th className="mono">Win %</th>
                  <th className="mono">Max DD %</th>
                  <th>Trained</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {saved.map((s) => (
                  <tr key={s.symbol}>
                    <td><b>{s.symbol}</b></td>
                    <td>{s.strategy}</td>
                    <td>{s.timeframe ?? '—'}</td>
                    <td
                      className={`mono ${
                        s.metrics?.total_return_pct == null
                          ? ''
                          : s.metrics.total_return_pct >= 0
                          ? 'pos'
                          : 'neg'
                      }`}
                    >
                      {s.metrics?.total_return_pct == null ? '—' : fmt(s.metrics.total_return_pct)}
                    </td>
                    <td className="mono">
                      {s.metrics?.win_rate_pct == null ? '—' : fmt(s.metrics.win_rate_pct)}
                    </td>
                    <td className="mono">
                      {s.metrics?.max_drawdown_pct == null ? '—' : fmt(s.metrics.max_drawdown_pct)}
                    </td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                      {s.trained_at ? new Date(s.trained_at).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <button
                        className="btn danger"
                        onClick={() => remove(s.symbol)}
                        disabled={busy === s.symbol}
                      >
                        {busy === s.symbol ? '…' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsPanel({
  settings,
  loadError,
  onReload,
  access,
  onRefreshAccess,
  me,
  onSaved,
  onMeChanged,
  onError,
}: {
  settings: Settings | null
  loadError: boolean
  onReload: () => void
  access: ExchangeAccess | null
  onRefreshAccess: () => Promise<ExchangeAccess | null>
  me: Me
  onSaved: (s: Settings) => void
  onMeChanged: (m: Me) => void
  onError: (msg: string) => void
}) {
  const [form, setForm] = useState<Settings | null>(settings)
  const [copied, setCopied] = useState(false)
  const [testing, setTesting] = useState(false)
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
        paper_taker_fee_pct: form.paper_taker_fee_pct,
        min_signal_confidence: form.min_signal_confidence,
        auto_trade_enabled: form.auto_trade_enabled,
        auto_symbols: form.auto_symbols,
        auto_timeframe: form.auto_timeframe,
        auto_confirm_timeframe: form.auto_confirm_timeframe,
        use_saved_strategy: form.use_saved_strategy,
        ai_trade_confirm: form.ai_trade_confirm,
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

      <div className={`access-card ${access ? (access.ok ? 'ok' : 'bad') : ''}`}>
        <div className="access-head">
          {access
            ? `${access.ok ? '✅ Exchange ready to trade' : '⚠️ Exchange cannot trade yet'}${
                access.testnet ? ' (testnet)' : ' (live account)'
              }`
            : 'Exchange connection — not tested yet'}
          <button
            className="btn"
            style={{ marginLeft: 'auto' }}
            onClick={async () => {
              setTesting(true)
              try {
                const a = await onRefreshAccess()
                if (!a) onError('Could not reach the connection check.')
              } finally {
                setTesting(false)
              }
            }}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {access && (
          <>
            <div className="access-rows">
              <span>Public data: {access.can_read_public ? '✅' : '❌'}</span>
              <span>Account read: {access.can_read_account ? '✅' : '❌'}</span>
              <span>Trading: {access.can_trade ? '✅' : '❌'}</span>
            </div>
            <p className="hint" style={{ marginTop: 6 }}>{access.detail}</p>
          </>
        )}
        {!access && (
          <p className="hint" style={{ marginTop: 6 }}>
            Click <b>Test connection</b> to check — live — whether this app can
            reach your exchange, read your account, and place orders. Saving your
            API keys below also runs this test automatically.
          </p>
        )}
      </div>

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
        <div className="field">
          <label>Paper taker fee % (0 = off)</label>
          <input
            className="input"
            value={form.paper_taker_fee_pct}
            onChange={(e) => num('paper_taker_fee_pct', e.target.value)}
            inputMode="decimal"
          />
        </div>
      </div>
      <p className="hint">
        Paper taker fee models a real exchange fee on <b>both legs</b> of every
        simulated round trip, so your paper track record reflects the true cost of
        trading (e.g. 0.1% is Binance's standard taker rate). It only affects{' '}
        <b>paper</b> results — live P&amp;L always books the real fees already in
        your fills, never an invented number. Leave at 0 to keep paper fee-free.
      </p>

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
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={form.ai_trade_confirm}
          onChange={(e) => setForm({ ...form, ai_trade_confirm: e.target.checked })}
          disabled={!form.ai_enabled}
        />
        AI trade review (AI may VETO an autonomous entry)
      </label>
      <p className="hint">
        When on, and only while autonomous trading is on, the AI reviews each
        deterministic entry and can <b>block</b> one it judges too risky. It can
        never invent, size, or force a trade, and it never bypasses your risk
        limits — if the AI is unavailable the analyzer's own decision stands.{' '}
        {form.ai_enabled
          ? 'Test it in paper mode before trusting it with live orders.'
          : 'Add an AI key (Credentials) to enable this.'}
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={form.use_saved_strategy}
          onChange={(e) => setForm({ ...form, use_saved_strategy: e.target.checked })}
        />
        Trade with my saved (trained) strategies
      </label>
      <p className="hint">
        When on, the bot trades each symbol with the strategy you trained and
        saved for it (see <b>Train</b>) instead of its built-in analyzer. Capital
        preservation still comes first: a saved <b>BUY</b> is suppressed in a bear
        regime or a volatility shock, while its <b>SELL/exit is always honoured</b>.
        Symbols with no saved strategy fall back to the analyzer brain.
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

      <CredentialsCard
        me={me}
        onMeChanged={onMeChanged}
        onError={onError}
        onRefreshAccess={onRefreshAccess}
      />

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
  onRefreshAccess,
}: {
  me: Me
  onMeChanged: (m: Me) => void
  onError: (msg: string) => void
  onRefreshAccess: () => Promise<ExchangeAccess | null>
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
      // Don't just save-and-go quiet: immediately re-probe the exchange with the
      // new keys and report the REAL result (connected / read-only / geo-blocked)
      // so the user actually sees whether they're live, not an empty box.
      setSaved('Credentials saved (encrypted at rest). Testing connection…')
      const acc = await onRefreshAccess()
      if (!acc) {
        setSaved('Credentials saved (encrypted at rest). Could not run the connection test — hit “Test connection” above.')
      } else if (acc.can_trade) {
        setSaved(`✅ Saved & connected — ${acc.exchange ?? 'exchange'} keys work and trading is enabled (${acc.testnet ? 'testnet' : 'live'}).`)
      } else if (acc.can_read_account) {
        setSaved(`⚠️ Saved — keys authenticate and can read your account, but trading isn't available yet. ${acc.detail}`)
      } else {
        setSaved(`⚠️ Saved, but not connected: ${acc.detail}`)
      }
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
