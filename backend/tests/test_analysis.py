"""Tests for the market analysis brain (deterministic, capital-preservation)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.analysis import MarketAnalyzer


def _frame(closes: list[float], *, high=None, low=None) -> pd.DataFrame:
    n = len(closes)
    highs = high if high is not None else [c * 1.001 for c in closes]
    lows = low if low is not None else [c * 0.999 for c in closes]
    return pd.DataFrame(
        {
            "timestamp": range(n),
            "open": closes,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": [1.0] * n,
        }
    )


def test_insufficient_data_holds_zero_confidence():
    a = MarketAnalyzer().analyze(_frame([100.0] * 10), "BTC/USDT")
    assert a.verdict == "hold"
    assert a.confidence == 0.0
    assert "Not enough data" in a.summary


def test_strong_uptrend_yields_buy():
    # Smooth, low-volatility uptrend -> trend+momentum+macd align bullish.
    closes = [100 + i * 0.8 for i in range(120)]
    a = MarketAnalyzer().analyze(_frame(closes), "BTC/USDT")
    assert a.verdict == "buy"
    assert a.confidence >= 0.4
    assert a.score > 0


def test_strong_downtrend_yields_sell():
    closes = [200 - i * 0.8 for i in range(120)]
    a = MarketAnalyzer().analyze(_frame(closes), "BTC/USDT")
    assert a.verdict == "sell"
    assert a.score < 0


def test_flat_market_holds():
    # Dead-flat market: no trend, no momentum -> must HOLD (no forced trade).
    a = MarketAnalyzer().analyze(_frame([100.0] * 120), "BTC/USDT")
    assert a.verdict == "hold"


def test_extreme_volatility_stands_aside():
    # Strong uptrend but with huge intrabar ranges -> volatility gate -> hold.
    closes = [100 + i * 0.8 for i in range(120)]
    highs = [c * 1.5 for c in closes]  # ATR will be ~ >8% of price
    lows = [c * 0.6 for c in closes]
    a = MarketAnalyzer(max_volatility_pct=8.0).analyze(
        _frame(closes, high=highs, low=lows), "BTC/USDT"
    )
    assert a.verdict == "hold"
    assert a.confidence == 0.0
    assert "aside" in a.summary.lower() or "volatility" in a.summary.lower()


def test_min_confidence_gate_forces_hold():
    # With confidence gate at 1.0, nothing can clear it -> always hold.
    closes = [100 + i * 0.8 for i in range(120)]
    a = MarketAnalyzer(min_confidence=1.0).analyze(_frame(closes), "BTC/USDT")
    assert a.verdict == "hold"


def test_as_dict_shape():
    a = MarketAnalyzer().analyze(_frame([100 + i * 0.5 for i in range(120)]), "X")
    d = a.as_dict()
    assert set(d) >= {"symbol", "verdict", "confidence", "score", "price", "factors", "summary"}
    assert all({"name", "signal", "weight", "detail"} <= set(f) for f in d["factors"])
