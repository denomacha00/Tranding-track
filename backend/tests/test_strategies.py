"""Tests for the risk manager and strategies (no network required)."""
from __future__ import annotations

import pandas as pd
import pytest

from app.config import Settings
from app.strategies import MovingAverageCrossStrategy, RsiStrategy, build_strategy


def _candles(prices: list[float]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "timestamp": range(len(prices)),
            "open": prices,
            "high": prices,
            "low": prices,
            "close": prices,
            "volume": [1.0] * len(prices),
        }
    )


def _walk(strat, prices):
    """Return every action produced as bars are revealed one at a time."""
    return [
        strat.generate(_candles(prices[:i])).action
        for i in range(strat.min_bars(), len(prices) + 1)
    ]


def test_ma_cross_buy_on_upward_cross():
    # Falling then sharply rising -> fast must cross above slow at some point.
    prices = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] + [5, 10, 20, 40, 80]
    strat = MovingAverageCrossStrategy(fast=3, slow=5)
    assert "buy" in _walk(strat, prices)


def test_ma_cross_sell_on_downward_cross():
    # Rising then sharply falling -> fast must cross below slow at some point.
    prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] + [6, 3, 1]
    strat = MovingAverageCrossStrategy(fast=3, slow=5)
    assert "sell" in _walk(strat, prices)


def test_ma_cross_requires_valid_periods():
    with pytest.raises(ValueError):
        MovingAverageCrossStrategy(fast=10, slow=5)


def test_ma_cross_holds_without_enough_data():
    strat = MovingAverageCrossStrategy(fast=3, slow=5)
    sig = strat.generate(_candles([1, 2, 3]))
    assert sig.action == "hold"


def test_rsi_buy_on_oversold_entry():
    # Rising baseline (RSI high) then a sustained sharp drop pushes RSI < 30,
    # producing an oversold entry crossing at some bar.
    prices = list(range(1, 30)) + [28, 24, 19, 13, 6, 2, 1, 1, 1, 1]
    strat = RsiStrategy(period=14, oversold=30, overbought=70)
    assert "buy" in _walk(strat, prices)


def test_rsi_flat_market_is_neutral():
    # A perfectly flat market must read as neutral (50), never oversold/overbought.
    strat = RsiStrategy(period=14)
    rsi = strat._rsi(_candles([100.0] * 30)["close"], 14)
    assert rsi.iloc[-1] == 50.0


def test_rsi_all_gains_no_crash():
    # Monotonic increase: avg_loss is 0 -> RSI must be 100, no divide-by-zero.
    prices = list(range(1, 40))
    strat = RsiStrategy(period=14)
    sig = strat.generate(_candles(prices))
    assert sig.action in {"hold", "sell"}


def test_build_strategy_unknown():
    with pytest.raises(ValueError):
        build_strategy("does_not_exist")
