"""Pluggable strategy framework and two reference strategies.

Strategies are used for the built-in backtester and (optionally) for local
signal generation. TradingView remains the primary live signal source, but
these let users test ideas and run the bot without TradingView.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal, Optional

import pandas as pd

Action = Literal["buy", "sell", "hold"]


@dataclass
class StrategySignal:
    action: Action
    reason: str = ""


class Strategy(ABC):
    """Base class. Implement `generate` returning a signal for the latest bar."""

    name: str = "base"

    @abstractmethod
    def generate(self, candles: pd.DataFrame) -> StrategySignal:
        """candles has columns: timestamp, open, high, low, close, volume."""
        raise NotImplementedError

    def min_bars(self) -> int:
        return 2


class MovingAverageCrossStrategy(Strategy):
    """Classic fast/slow SMA crossover."""

    name = "ma_cross"

    def __init__(self, fast: int = 9, slow: int = 21) -> None:
        if fast >= slow:
            raise ValueError("fast period must be < slow period")
        self.fast = fast
        self.slow = slow

    def min_bars(self) -> int:
        return self.slow + 1

    def generate(self, candles: pd.DataFrame) -> StrategySignal:
        if len(candles) < self.min_bars():
            return StrategySignal("hold", "not enough data")
        close = candles["close"]
        fast_ma = close.rolling(self.fast).mean()
        slow_ma = close.rolling(self.slow).mean()
        # Compare last two bars for a crossover.
        prev_fast, prev_slow = fast_ma.iloc[-2], slow_ma.iloc[-2]
        cur_fast, cur_slow = fast_ma.iloc[-1], slow_ma.iloc[-1]
        if pd.isna(prev_fast) or pd.isna(prev_slow):
            return StrategySignal("hold", "warming up")
        if prev_fast <= prev_slow and cur_fast > cur_slow:
            return StrategySignal("buy", "fast crossed above slow")
        if prev_fast >= prev_slow and cur_fast < cur_slow:
            return StrategySignal("sell", "fast crossed below slow")
        return StrategySignal("hold", "no cross")


class RsiStrategy(Strategy):
    """RSI mean-reversion: buy oversold, sell overbought."""

    name = "rsi"

    def __init__(self, period: int = 14, oversold: float = 30, overbought: float = 70) -> None:
        self.period = period
        self.oversold = oversold
        self.overbought = overbought

    def min_bars(self) -> int:
        return self.period + 2

    @staticmethod
    def _rsi(close: pd.Series, period: int) -> pd.Series:
        delta = close.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.rolling(period).mean()
        avg_loss = loss.rolling(period).mean()
        # Base Wilder-style RSI. Divide-by-zero is handled explicitly below so
        # the three degenerate cases are unambiguous:
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        # Pure gains (no losses in the window) -> fully overbought (100).
        rsi = rsi.mask((avg_loss == 0) & (avg_gain > 0), 100.0)
        # Pure losses (no gains in the window) -> fully oversold (0).
        rsi = rsi.mask((avg_gain == 0) & (avg_loss > 0), 0.0)
        # Flat market (no movement at all) -> neutral (50), NOT 0/100.
        rsi = rsi.mask((avg_gain == 0) & (avg_loss == 0), 50.0)
        # Rows still inside the rolling warm-up window remain NaN and are
        # treated as "warming up" by generate().
        return rsi

    def generate(self, candles: pd.DataFrame) -> StrategySignal:
        if len(candles) < self.min_bars():
            return StrategySignal("hold", "not enough data")
        rsi = self._rsi(candles["close"], self.period)
        prev, cur = rsi.iloc[-2], rsi.iloc[-1]
        if pd.isna(prev) or pd.isna(cur):
            return StrategySignal("hold", "warming up")
        if prev >= self.oversold and cur < self.oversold:
            return StrategySignal("buy", f"RSI {cur:.1f} entered oversold")
        if prev <= self.overbought and cur > self.overbought:
            return StrategySignal("sell", f"RSI {cur:.1f} entered overbought")
        return StrategySignal("hold", f"RSI {cur:.1f}")


STRATEGY_REGISTRY: dict[str, type[Strategy]] = {
    MovingAverageCrossStrategy.name: MovingAverageCrossStrategy,
    RsiStrategy.name: RsiStrategy,
}


def build_strategy(name: str, **params) -> Strategy:
    if name not in STRATEGY_REGISTRY:
        raise ValueError(f"Unknown strategy '{name}'. Options: {list(STRATEGY_REGISTRY)}")
    return STRATEGY_REGISTRY[name](**params)
