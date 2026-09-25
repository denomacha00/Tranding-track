// Shared types mirroring the backend schemas.

export interface BotStatus {
  running: boolean
  trading_mode: string
  testnet: boolean
  exchange_connected: boolean
  open_positions: number
  balance: number
  equity: number
  realized_pnl: number
  unrealized_pnl: number
  day_pnl: number
  max_open_positions: number
}

export interface Trade {
  id: number
  symbol: string
  side: string
  amount: number
  entry_price: number
  exit_price: number | null
  stop_loss: number | null
  take_profit: number | null
  status: string
  order_type?: string
  limit_price?: number | null
  pnl: number
  mode: string
  source: string
  note: string | null
  opened_at: string
  closed_at: string | null
}

export interface SignalRow {
  id: number
  source: string
  symbol: string | null
  action: string | null
  accepted: number
  message: string | null
  created_at: string
  // Real model confidence (0..1) for analyzer rows; null when the source
  // (e.g. a raw TradingView alert) didn't carry one. Never fabricated.
  confidence: number | null
}

// One real, live headline from a configured public trading/market RSS feed.
// Fetched server-side; never fabricated (an empty list means the sources were
// unreachable, not that nothing is happening).
export interface NewsItem {
  title: string
  link: string
  source: string
  published: string
}

// A single turn in the AI assistant conversation (browser-local history).
export interface ChatTurn {
  role: 'you' | 'ai'
  text: string
  // Whether live news was attached to this question (shown as a small note).
  usedNews?: boolean
}

export interface Settings {
  trading_mode: string
  binance_testnet: boolean
  max_open_positions: number
  risk_per_trade_pct: number
  daily_loss_limit_pct: number
  default_stop_loss_pct: number
  default_take_profit_pct: number
  trailing_stop_pct: number
  max_total_exposure_pct: number
  min_signal_confidence: number
  auto_trade_enabled: boolean
  auto_symbols: string
  auto_timeframe: string
  auto_confirm_timeframe: string
  // When on AND autonomous trading is on, the AI reviews each deterministic
  // entry and may VETO it (it can never invent or force a trade). Off by default.
  ai_trade_confirm: boolean
  ai_enabled: boolean
  ai_model?: string
  ai_style?: string
  notifications_enabled: boolean
  api_key_set: boolean
  webhook_path: string
  webhook_secret_set: boolean
}

export interface ExecutionResult {
  accepted: boolean
  message: string
  trade: Trade | null
}

export interface ExchangeAccess {
  ok: boolean
  can_read_public: boolean
  can_read_account: boolean
  can_trade: boolean
  testnet: boolean
  // Which ccxt exchange this account talks to (e.g. "binance", "binanceus").
  exchange?: string
  detail: string
}

// Live reachability of the app-wide AI provider (never carries the key).
// Powers the assistant's connection dashboard so "AI not working" shows a
// concrete reason instead of failing silently.
export interface AiHealth {
  enabled: boolean
  ok: boolean
  model: string
  base_url: string
  style: string
  detail: string
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Ticker {
  symbol: string
  last: number
  bid: number | null
  ask: number | null
  // 24h price change percent (may be null if the exchange omits it).
  percentage: number | null
}

export interface BacktestResult {
  symbol: string
  strategy: string
  timeframe: string
  starting_balance: number
  ending_balance: number
  total_return_pct: number
  num_trades: number
  win_rate_pct: number
  max_drawdown_pct: number
  total_fees?: number
  // Exit rules the backtest applied (defaulted from live settings) so results
  // reflect how the bot actually trades, not idealised buy-and-hold.
  stop_loss_pct?: number
  take_profit_pct?: number
  trailing_stop_pct?: number
  equity_curve: number[]
}

export interface StrategyInfo {
  name: string
  params: Record<string, (number | string)[]>
}

export interface TrainingCandidate {
  params: Record<string, number | string>
  total_return_pct: number
  win_rate_pct: number
  max_drawdown_pct: number
  num_trades: number
  score: number
  validation_return_pct?: number | null
  validation_num_trades?: number | null
  overfit_gap_pct?: number | null
}

export interface TrainingReport {
  symbol: string
  strategy: string
  timeframe: string
  candles: number
  tested: number
  best: TrainingCandidate | null
  leaderboard: TrainingCandidate[]
  train_fraction: number
  warning?: string | null
}

export interface AnalysisFactor {
  name: string
  signal: 'buy' | 'sell' | 'hold'
  weight: number
  detail: string
}

export interface MarketAnalysis {
  symbol: string
  verdict: 'buy' | 'sell' | 'hold'
  confidence: number
  score: number
  price: number
  summary: string
  factors: AnalysisFactor[]
  narration?: string
  assessment?: string
  ai_enabled?: boolean
}

export type WsMessage =
  | { event: 'status'; data: BotStatus; user_id?: number }
  | { event: 'trade_opened'; data: { id: number; symbol: string; side: string } }
  | { event: 'trade_closed'; data: { id: number; symbol: string; pnl: number } }
  | { event: 'order_pending'; data: { id: number; symbol: string; side: string; limit_price: number } }
  | { event: 'order_canceled'; data: { id: number; symbol: string } }
  | { event: 'stop_trailed'; data: { id: number; symbol: string; stop_loss: number } }
  | { event: 'reconcile_closed'; data: { symbol: string; db_amount: number; exchange_amount: number; pnl: number } }
  | { event: 'reconcile_adjusted'; data: { symbol: string; db_amount: number; exchange_amount: number } }
  | {
      event: 'signal'
      data: {
        id?: number
        source: string
        action: string
        symbol: string
        accepted: boolean
        message: string
        confidence?: number
      }
    }

export interface Me {
  id: number
  email: string
  role: 'admin' | 'user'
  license_status: 'pending' | 'active' | 'revoked'
  webhook_path: string
  binance_keys_set: boolean
  binance_testnet: boolean
  ai_key_set: boolean
  ai_model: string
  secrets_storage_enabled: boolean
}

export interface UserRow {
  id: number
  email: string
  role: 'admin' | 'user'
  license_status: 'pending' | 'active' | 'revoked'
  created_at: string
  licensed_at: string | null
}

// A licence key row as the admin sees it. NEVER carries the plaintext key —
// that is shown only once, at creation, via LicenseKeyCreated.
export interface LicenseKeyRow {
  id: number
  key_prefix: string
  label: string | null
  status: 'unused' | 'redeemed' | 'revoked'
  created_at: string
  redeemed_by: number | null
  redeemed_at: string | null
}

// Returned exactly once when an admin generates a key: `key` is the full
// plaintext to copy now (never stored server-side, never returned again).
export interface LicenseKeyCreated extends LicenseKeyRow {
  key: string
}
