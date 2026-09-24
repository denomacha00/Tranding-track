"""Tests for the risk manager using an in-memory SQLite database."""
from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.database import Base
from app.models import Trade, TradeStatus
from app.risk import RiskManager


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()


def _settings(**over) -> Settings:
    base = dict(
        trading_mode="paper",
        max_open_positions=3,
        risk_per_trade_pct=1.0,
        daily_loss_limit_pct=5.0,
        default_stop_loss_pct=2.0,
        default_take_profit_pct=4.0,
        paper_starting_balance=10_000.0,
    )
    base.update(over)
    return Settings(**base)


def test_position_sizing_respects_risk_pct():
    rm = RiskManager(_settings(risk_per_trade_pct=1.0, default_stop_loss_pct=2.0))
    # risk = 1% of 10000 = 100; stop distance 2% -> notional = 100/0.02 = 5000.
    qty = rm.size_position(equity=10_000, price=100)
    assert qty == pytest.approx(50.0)  # 5000 notional / 100 price


def test_sizing_capped_at_equity():
    # Tiny stop distance would blow notional past equity; must cap at equity.
    rm = RiskManager(_settings(risk_per_trade_pct=50.0, default_stop_loss_pct=0.1))
    qty = rm.size_position(equity=10_000, price=100)
    assert qty * 100 <= 10_000 + 1e-6


def test_sizing_uses_actual_stop_distance():
    # A wider stop than the default must yield a SMALLER position so the amount
    # actually risked stays at risk_per_trade_pct rather than ballooning.
    rm = RiskManager(_settings(risk_per_trade_pct=1.0, default_stop_loss_pct=2.0))
    default_qty = rm.size_position(equity=10_000, price=100)  # 2% stop
    wide_qty = rm.size_position(equity=10_000, price=100, stop_fraction=0.10)  # 10% stop
    assert wide_qty < default_qty
    # risk = 1% of 10000 = 100; with a 10% stop -> notional 1000 -> qty 10.
    assert wide_qty == pytest.approx(10.0)


def test_check_sizes_against_explicit_stop(db):
    # With an explicit stop_price and no requested amount, sizing must use the
    # real stop distance (entry 100 -> stop 90 = 10%), not the default 2%.
    rm = RiskManager(_settings(risk_per_trade_pct=1.0, default_stop_loss_pct=2.0))
    decision = rm.check(
        db, equity=10_000, price=100, requested_amount=None,
        is_opening=True, stop_price=90.0,
    )
    assert decision.allowed
    assert decision.amount == pytest.approx(10.0)  # risk 100 / 0.10 / price 100


def test_max_open_positions_blocks(db):
    rm = RiskManager(_settings(max_open_positions=1))
    db.add(Trade(symbol="BTC/USDT", side="buy", amount=1, entry_price=100,
                 status=TradeStatus.open.value))
    db.commit()
    decision = rm.check(db, equity=10_000, price=100, requested_amount=1, is_opening=True)
    assert not decision.allowed
    assert "Max open positions" in decision.reason


def test_daily_loss_limit_blocks(db):
    rm = RiskManager(_settings(daily_loss_limit_pct=5.0))
    # A closed losing trade today that exceeds 5% of 10000 = -500.
    db.add(Trade(symbol="ETH/USDT", side="buy", amount=1, entry_price=100,
                 exit_price=40, pnl=-600, status=TradeStatus.closed.value,
                 closed_at=dt.datetime.now(dt.timezone.utc)))
    db.commit()
    decision = rm.check(db, equity=10_000, price=100, requested_amount=1, is_opening=True)
    assert not decision.allowed
    assert "loss limit" in decision.reason.lower()


def test_notional_exceeds_equity_blocks(db):
    rm = RiskManager(_settings())
    decision = rm.check(db, equity=100, price=100, requested_amount=5, is_opening=True)
    assert not decision.allowed


def test_valid_trade_allowed(db):
    rm = RiskManager(_settings())
    decision = rm.check(db, equity=10_000, price=100, requested_amount=1, is_opening=True)
    assert decision.allowed
    assert decision.amount == 1


def test_total_exposure_cap_blocks(db):
    # Cap total open notional at 50% of equity. One open position of 3000 exists;
    # a new 3000 order would push total to 6000 > 5000 cap.
    rm = RiskManager(_settings(max_total_exposure_pct=50.0))
    db.add(Trade(symbol="BTC/USDT", side="buy", amount=30, entry_price=100,
                 status=TradeStatus.open.value))
    db.commit()
    decision = rm.check(db, equity=10_000, price=100, requested_amount=30, is_opening=True)
    assert not decision.allowed
    assert "exposure" in decision.reason.lower()


def test_total_exposure_cap_allows_within_limit(db):
    rm = RiskManager(_settings(max_total_exposure_pct=50.0))
    db.add(Trade(symbol="BTC/USDT", side="buy", amount=10, entry_price=100,
                 status=TradeStatus.open.value))
    db.commit()
    # existing 1000 + new 1000 = 2000 <= 5000 cap.
    decision = rm.check(db, equity=10_000, price=100, requested_amount=10, is_opening=True)
    assert decision.allowed


def test_total_exposure_cap_disabled_by_default(db):
    rm = RiskManager(_settings())  # max_total_exposure_pct defaults to 0 (off)
    db.add(Trade(symbol="BTC/USDT", side="buy", amount=90, entry_price=100,
                 status=TradeStatus.open.value))
    db.commit()
    decision = rm.check(db, equity=10_000, price=100, requested_amount=5, is_opening=True)
    assert decision.allowed  # no exposure cap enforced


def test_daily_loss_limit_includes_open_drawdown(db):
    # No CLOSED losses today, but current OPEN drawdown of -600 already exceeds
    # the 5% (=$500) daily limit, so new entries must be blocked before any
    # stop fires — the breaker measures total current risk, not just realized.
    rm = RiskManager(_settings(daily_loss_limit_pct=5.0))
    decision = rm.check(
        db, equity=10_000, price=100, requested_amount=1,
        is_opening=True, day_unrealized=-600.0,
    )
    assert not decision.allowed
    assert "loss limit" in decision.reason.lower()


def test_daily_loss_limit_allows_small_open_drawdown(db):
    # A small open drawdown (-100) stays under the $500 limit -> still allowed.
    rm = RiskManager(_settings(daily_loss_limit_pct=5.0))
    decision = rm.check(
        db, equity=10_000, price=100, requested_amount=1,
        is_opening=True, day_unrealized=-100.0,
    )
    assert decision.allowed
