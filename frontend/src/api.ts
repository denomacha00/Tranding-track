// Thin fetch wrapper around the Tranding-track REST API.
import type {
  BacktestResult,
  BotStatus,
  Candle,
  ExchangeAccess,
  ExecutionResult,
  MarketAnalysis,
  Me,
  Settings,
  SignalRow,
  StrategyInfo,
  Trade,
  TrainingReport,
  UserRow,
} from './types'

const TOKEN_KEY = 'tt_token'

export function getToken(): string | null {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null
}

export function setToken(token: string | null) {
  if (typeof localStorage === 'undefined') return
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

// Raised on a 401 so the app can bounce the user back to the login screen.
export class AuthError extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    if (res.status === 401) throw new AuthError(detail || 'Unauthorized')
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  // ---- auth ----
  signup: (email: string, password: string) =>
    req<{ access_token: string }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    req<{ access_token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => req<Me>('/api/auth/me'),
  updateCredentials: (body: {
    binance_api_key?: string
    binance_api_secret?: string
    binance_testnet?: boolean
    ai_api_key?: string
    ai_base_url?: string
    ai_model?: string
    ai_style?: string
  }) => req<Me>('/api/credentials', { method: 'PUT', body: JSON.stringify(body) }),

  // ---- admin ----
  adminUsers: () => req<UserRow[]>('/api/admin/users'),
  adminSetLicense: (id: number, status: 'pending' | 'active' | 'revoked') =>
    req<UserRow>(`/api/admin/users/${id}/license`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  adminDeleteUser: (id: number) =>
    req<{ deleted: number }>(`/api/admin/users/${id}`, { method: 'DELETE' }),

  // ---- trading ----
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
    limit_price?: number
  }) => req<ExecutionResult>('/api/order', { method: 'POST', body: JSON.stringify(body) }),
  closeTrade: (id: number) =>
    req<ExecutionResult>(`/api/trades/${id}/close`, { method: 'POST' }),
  ohlcv: (symbol: string, timeframe = '1h', limit = 200) =>
    req<Candle[]>(`/api/ohlcv/${encodeURIComponent(symbol)}?timeframe=${timeframe}&limit=${limit}`),
  backtest: (
    symbol: string,
    strategy: string,
    timeframe = '1h',
    feePct?: number,
    slippagePct?: number,
  ) => {
    const params = new URLSearchParams({ symbol, strategy, timeframe })
    if (feePct !== undefined) params.set('fee_pct', String(feePct))
    if (slippagePct !== undefined) params.set('slippage_pct', String(slippagePct))
    return req<BacktestResult>(`/api/backtest?${params.toString()}`)
  },
  strategies: () => req<StrategyInfo[]>('/api/strategies'),
  train: (symbol: string, strategy: string, timeframe = '1h') =>
    req<TrainingReport>(
      `/api/train?symbol=${encodeURIComponent(symbol)}&strategy=${strategy}&timeframe=${timeframe}`,
      { method: 'POST' },
    ),
  analyze: (symbol: string, timeframe = '1h', explain = false, assess = false) =>
    req<MarketAnalysis>(
      `/api/analyze/${encodeURIComponent(symbol)}?timeframe=${timeframe}&explain=${explain}&assess=${assess}`,
    ),
  aiAsk: (question: string, symbol?: string, timeframe = '1h') =>
    req<{ answer: string; ai_enabled: boolean }>('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify({ question, symbol, timeframe }),
    }),
  exchangeAccess: () => req<ExchangeAccess>('/api/exchange/access'),
}
