import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { PriceChart } from './PriceChart'
import { useSocket } from './useSocket'
import type { BotStatus, Candle, MarketAnalysis, Settings, SignalRow, StrategyInfo, Trade, TrainingReport } from './types'

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT']
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d']

function fmt(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

type Toast = { kind: 'ok' | 'error'; text: string } | null

export default function App() {
  const [status, setStatus] = useState<BotStatus | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [signals, setSignals] = useState<SignalRow[]>([])
  const [candles, setCandles] = useState<Candle[]>([])
  const [symbol, setSymbol] = useState(SYMBOLS[0])
  const [timeframe, setTimeframe] = useState('1h')
  const [amount, setAmount] = useState('')
  const [toast, setToast] = useState<Toast>(null)
  const [tab, setTab] = useState<'trades' | 'signals' | 'analyze' | 'train' | 'settings'>('trades')

  const showToast = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 4000)
  }, [])

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

  const { connected } = useSocket({
    onStatus: setStatus,
    onEvent: (m) => {
      if (m.event === 'trade_opened' || m.event === 'trade_closed') {
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
    api.settings().then(setSettings).catch(() => {})
    refreshTrades()
    refreshSignals()
  }, [refreshTrades, refreshSignals])

  // Load candles when symbol/timeframe changes, and poll periodically.
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .ohlcv(symbol, timeframe, 200)
        .then((c) => alive && setCandles(c))
        .catch(() => alive && setCandles([]))
    load()
    const id = setInterval(load, 15000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [symbol, timeframe])

  const openTrades = useMemo(() => trades.filter((t) => t.status === 'open'), [trades])

  const doOrder = async (action: 'buy' | 'sell') => {
    try {
      const res = await api.order({
        action,
        symbol,
        amount: amount ? Number(amount) : undefined,
      })
      showToast(res.accepted ? 'ok' : 'error', res.message)
      refreshTrades()
    } catch (e) {
      showToast('error', (e as Error).message)
    }
  }

  const closeTrade = async (id: number) => {
    try {
      const res = await api.closeTrade(id)
      showToast(res.accepted ? 'ok' : 'error', res.message)
      refreshTrades()
    } catch (e) {
      showToast('error', (e as Error).message)
    }
  }

  const toggleBot = async () => {
    if (!status) return
    try {
      const res = await api.setBot(status.running ? 'stop' : 'start')
      setStatus({ ...status, running: res.running })
    } catch (e) {
      showToast('error', (e as Error).message)
    }
  }

  const pnlClass = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')

  return (
    <div className="app">
      <header className="topbar">
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
        <span className="hint">{connected ? 'live' : 'reconnecting…'}</span>
        <span className={`ws-dot ${connected ? 'connected' : ''}`} />
        <button className="btn primary" onClick={toggleBot}>
          {status?.running ? 'Stop bot' : 'Start bot'}
        </button>
      </header>

      <div className="body">
        <div className="col">
          <StatsRow status={status} />

          <section className="panel">
            <div className="panel-head">
              <span>Price</span>
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
                <PriceChart candles={candles} />
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
                <button className="btn buy" onClick={() => doOrder('buy')}>
                  Buy
                </button>
                <button className="btn sell" onClick={() => doOrder('sell')}>
                  Sell
                </button>
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                Orders respect your risk settings. In <b>paper</b> mode nothing hits the exchange.
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
                  className={`tab ${tab === 'settings' ? 'active' : ''}`}
                  onClick={() => setTab('settings')}
                >
                  Settings
                </span>
              </div>
            </div>
            <div className="panel-body">
              {tab === 'trades' && (
                <TradesTable
                  trades={trades}
                  openTrades={openTrades}
                  onClose={closeTrade}
                  pnlClass={pnlClass}
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
              {tab === 'settings' && (
                <SettingsPanel
                  settings={settings}
                  onSaved={(s) => {
                    setSettings(s)
                    showToast('ok', 'Settings saved')
                  }}
                  onError={(msg) => showToast('error', msg)}
                />
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
}: {
  trades: Trade[]
  openTrades: Trade[]
  onClose: (id: number) => void
  pnlClass: (n: number) => string
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
            <td className="mono">{fmt(t.entry_price)}</td>
            <td className={`mono ${pnlClass(t.pnl)}`}>{fmt(t.pnl)}</td>
            <td>
              <span className={`tag ${t.status}`}>{t.status}</span>
            </td>
            <td>
              {openIds.has(t.id) && (
                <button className="btn" onClick={() => onClose(t.id)}>
                  Close
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
  onSaved,
  onError,
}: {
  settings: Settings | null
  onSaved: (s: Settings) => void
  onError: (msg: string) => void
}) {
  const [form, setForm] = useState<Settings | null>(settings)
  useEffect(() => setForm(settings), [settings])
  if (!form) return <div className="empty">Loading…</div>

  const webhookUrl = `${location.origin}${form.webhook_path}`
  const num = (k: keyof Settings, v: string) =>
    setForm({ ...form, [k]: v === '' ? 0 : Number(v) } as Settings)

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
    { secret: 'YOUR_SECRET', action: 'buy', symbol: 'BTC/USDT', amount: 0.001 },
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
        {form.ai_enabled ? '✅ AI commentary is configured.' : 'AI commentary is off (set AI_API_KEY to enable).'}
      </p>
      <p className="hint">
        Trailing stop ratchets an open long's stop-loss upward as price rises to
        lock in gains (never loosened). API auth:{' '}
        {form.api_key_set ? '✅ X-API-Key required' : '⚠️ open — set API_KEY before exposing the port'}
        . Telegram alerts: {form.notifications_enabled ? '✅ on' : 'off'}.
      </p>

      <button className="btn primary" onClick={save}>
        Save settings
      </button>

      <div className="panel" style={{ marginTop: 6 }}>
        <div className="panel-head">TradingView webhook</div>
        <div className="panel-body">
          <p className="hint">Point your TradingView alert's webhook URL here:</p>
          <code className="inline">{webhookUrl}</code>
          <p className="hint" style={{ marginTop: 10 }}>
            Secret configured: {form.webhook_secret_set ? '✅ yes' : '❌ using default — change it in .env'}
          </p>
          <p className="hint" style={{ marginTop: 10 }}>Alert message (JSON):</p>
          <pre className="code">{alertExample}</pre>
        </div>
      </div>
    </div>
  )
}
