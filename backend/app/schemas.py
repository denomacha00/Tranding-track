"""Pydantic request/response schemas for the API."""
from __future__ import annotations

import datetime as dt
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class TradingViewSignal(BaseModel):
    """Payload sent by a TradingView alert webhook.

    Example alert message (JSON):
        {"secret": "...", "action": "buy", "symbol": "BTC/USDT", "amount": 0.001}
    """

    secret: str
    action: Literal["buy", "sell", "close"]
    symbol: str
    # Optional explicit amount (base currency). If omitted, risk manager sizes it.
    amount: Optional[float] = Field(default=None, gt=0)
    # Optional overrides
    price: Optional[float] = Field(default=None, gt=0)
    limit_price: Optional[float] = Field(default=None, gt=0)  # resting limit entry
    stop_loss: Optional[float] = Field(default=None, gt=0)
    take_profit: Optional[float] = Field(default=None, gt=0)
    note: Optional[str] = None


class ManualOrder(BaseModel):
    action: Literal["buy", "sell", "close"]
    symbol: str
    amount: Optional[float] = Field(default=None, gt=0)
    limit_price: Optional[float] = Field(default=None, gt=0)  # resting limit entry
    stop_loss: Optional[float] = Field(default=None, gt=0)
    take_profit: Optional[float] = Field(default=None, gt=0)


class TradeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    symbol: str
    side: str
    amount: float
    entry_price: float
    exit_price: Optional[float]
    stop_loss: Optional[float]
    take_profit: Optional[float]
    status: str
    order_type: str = "market"
    limit_price: Optional[float] = None
    pnl: float
    mode: str
    source: str
    note: Optional[str]
    opened_at: dt.datetime
    closed_at: Optional[dt.datetime]


class SignalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str
    symbol: Optional[str]
    action: Optional[str]
    accepted: int
    message: Optional[str]
    created_at: dt.datetime


class ExecutionResult(BaseModel):
    accepted: bool
    message: str
    trade: Optional[TradeOut] = None


class TickerOut(BaseModel):
    symbol: str
    last: float
    bid: Optional[float] = None
    ask: Optional[float] = None
    percentage: Optional[float] = None


class BotStatus(BaseModel):
    running: bool
    trading_mode: str
    testnet: bool
    exchange_connected: bool
    open_positions: int
    balance: float
    equity: float
    realized_pnl: float
    unrealized_pnl: float
    day_pnl: float
    max_open_positions: int


class SettingsOut(BaseModel):
    trading_mode: str
    binance_testnet: bool
    max_open_positions: int
    risk_per_trade_pct: float
    daily_loss_limit_pct: float
    default_stop_loss_pct: float
    default_take_profit_pct: float
    trailing_stop_pct: float
    max_total_exposure_pct: float
    min_signal_confidence: float
    auto_trade_enabled: bool
    auto_symbols: str
    auto_timeframe: str
    auto_confirm_timeframe: str
    ai_enabled: bool
    ai_model: str = ""
    ai_style: str = ""
    notifications_enabled: bool
    api_key_set: bool
    webhook_path: str
    webhook_secret_set: bool


class SettingsUpdate(BaseModel):
    trading_mode: Optional[Literal["paper", "live"]] = None
    max_open_positions: Optional[int] = Field(default=None, ge=1, le=100)
    risk_per_trade_pct: Optional[float] = Field(default=None, gt=0, le=100)
    daily_loss_limit_pct: Optional[float] = Field(default=None, gt=0, le=100)
    default_stop_loss_pct: Optional[float] = Field(default=None, gt=0, le=100)
    default_take_profit_pct: Optional[float] = Field(default=None, gt=0, le=100)
    min_signal_confidence: Optional[float] = Field(default=None, ge=0, le=1)
    auto_trade_enabled: Optional[bool] = None
    auto_symbols: Optional[str] = None
    auto_timeframe: Optional[str] = None
    auto_confirm_timeframe: Optional[str] = None
    trailing_stop_pct: Optional[float] = Field(default=None, ge=0, le=100)
    max_total_exposure_pct: Optional[float] = Field(default=None, ge=0, le=1000)
