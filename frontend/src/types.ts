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
  ai_enabled: boolean
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

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
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
  ai_enabled?: boolean
}

export type WsMessage =
  | { event: 'status'; data: BotStatus }
  | { event: 'trade_opened'; data: { id: number; symbol: string; side: string } }
  | { event: 'trade_closed'; data: { id: number; symbol: string; pnl: number } }
  | { event: 'order_pending'; data: { id: number; symbol: string; side: string; limit_price: number } }
  | { event: 'order_canceled'; data: { id: number; symbol: string } }
  | { event: 'stop_trailed'; data: { id: number; symbol: string; stop_loss: number } }
  | { event: 'reconcile_closed'; data: { symbol: string; db_amount: number; exchange_amount: number; pnl: number } }
  | { event: 'reconcile_adjusted'; data: { symbol: string; db_amount: number; exchange_amount: number } }
  | {
      event: 'signal'
      data: { source: string; action: string; symbol: string; accepted: boolean; message: string }
    }
