"""SQLAlchemy ORM models."""
from __future__ import annotations

import datetime as dt
from enum import Enum

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class OrderSide(str, Enum):
    buy = "buy"
    sell = "sell"


class TradeStatus(str, Enum):
    pending = "pending"  # limit order resting on the book, not yet filled
    open = "open"
    closed = "closed"
    canceled = "canceled"


class OrderType(str, Enum):
    market = "market"
    limit = "limit"


class UserRole(str, Enum):
    admin = "admin"
    user = "user"


class LicenseStatus(str, Enum):
    pending = "pending"    # signed up, waiting for the admin to grant a licence
    active = "active"      # licensed — may configure keys and trade
    revoked = "revoked"    # licence withdrawn by the admin


class User(Base):
    """A registered account. Each user brings their OWN exchange/AI keys.

    Secrets (Binance + AI keys) are stored ENCRYPTED at rest (Fernet, key
    derived from SECRET_KEY) — never in plaintext. Access to trading is gated by
    ``license_status``: users are ``pending`` until the admin grants a licence.
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(8), default=UserRole.user.value)
    license_status: Mapped[str] = mapped_column(
        String(12), default=LicenseStatus.pending.value, index=True
    )
    webhook_token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    binance_api_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    binance_api_secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    binance_testnet: Mapped[bool] = mapped_column(Integer, default=1)
    ai_api_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_base_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ai_model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ai_style: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    licensed_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class Trade(Base):
    """A single executed trade / position lifecycle record."""

    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    side: Mapped[str] = mapped_column(String(8))
    amount: Mapped[float] = mapped_column(Float)
    entry_price: Mapped[float] = mapped_column(Float)
    exit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    stop_loss: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(12), default=TradeStatus.open.value, index=True)
    pnl: Mapped[float] = mapped_column(Float, default=0.0)
    order_type: Mapped[str] = mapped_column(String(8), default="market")
    limit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    mode: Mapped[str] = mapped_column(String(8), default="paper")
    source: Mapped[str] = mapped_column(String(24), default="manual")
    exchange_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    stop_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    opened_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    closed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SignalLog(Base):
    """Audit log of incoming signals (TradingView webhooks, strategy triggers)."""

    __tablename__ = "signal_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    source: Mapped[str] = mapped_column(String(24), default="tradingview")
    symbol: Mapped[str | None] = mapped_column(String(32), nullable=True)
    action: Mapped[str | None] = mapped_column(String(16), nullable=True)
    raw: Mapped[str] = mapped_column(Text)
    accepted: Mapped[int] = mapped_column(Integer, default=0)  # 0/1 as bool
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class KeyValue(Base):
    """Simple persisted key/value store for runtime state.

    Used to survive restarts for things that would otherwise live only in
    memory: overridden settings and the paper-trading wallet balance. Values are
    stored as JSON text.
    """

    __tablename__ = "kv_store"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )
