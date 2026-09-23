// Thin fetch wrapper around the Tranding-track REST API.
import type {
  BacktestResult,
  BotStatus,
  Candle,
  ExecutionResult,
  MarketAnalysis,
  Settings,
  SignalRow,
  StrategyInfo,
  Trade,
  TrainingReport,
} from './types'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Optional API key (used when the backend has API_KEY set). Stored locally so
  // the dashboard keeps working once the API is locked down.
  const apiKey = typeof localStorage !== 'undefined' ? localStorage.getItem('tt_api_key') : null
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    ...init,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail ?? detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  status: () => req<BotStatus>('/api/status'),
  settings: () => req<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    req<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  trades: (status?: string) =>
    req<Trade[]>(`/api/trades${status ? `?status=${status}` : ''}`),
  signals: () => req<SignalRow[]>('/api/signals'),
  setBot: (state: 'start' | 'stop') =>
    req<{ running: boolean }>(`/api/bot/${state}`, { method: 'POST' }),
  order: (body: {
    action: 'buy' | 'sell' | 'close'
    symbol: string
    amount?: number
  }) => req<ExecutionResult>('/api/order', { method: 'POST', body: JSON.stringify(body) }),
  closeTrade: (id: number) =>
    req<ExecutionResult>(`/api/trades/${id}/close`, { method: 'POST' }),
  ohlcv: (symbol: string, timeframe = '1h', limit = 200) =>
    req<Candle[]>(`/api/ohlcv/${encodeURIComponent(symbol)}?timeframe=${timeframe}&limit=${limit}`),
  backtest: (symbol: string, strategy: string, timeframe = '1h') =>
    req<BacktestResult>(
      `/api/backtest?symbol=${encodeURIComponent(symbol)}&strategy=${strategy}&timeframe=${timeframe}`,
    ),
  strategies: () => req<StrategyInfo[]>('/api/strategies'),
  train: (symbol: string, strategy: string, timeframe = '1h') =>
    req<TrainingReport>(
      `/api/train?symbol=${encodeURIComponent(symbol)}&strategy=${strategy}&timeframe=${timeframe}`,
      { method: 'POST' },
    ),
  analyze: (symbol: string, timeframe = '1h', explain = false) =>
    req<MarketAnalysis>(
      `/api/analyze/${encodeURIComponent(symbol)}?timeframe=${timeframe}&explain=${explain}`,
    ),
  aiAsk: (question: string, symbol?: string, timeframe = '1h') =>
    req<{ answer: string; ai_enabled: boolean }>('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify({ question, symbol, timeframe }),
    }),
}
