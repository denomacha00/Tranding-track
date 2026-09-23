"""Risk management: pre-trade checks and position sizing."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Trade, TradeStatus


@dataclass
class RiskDecision:
    allowed: bool
    reason: str = ""
    amount: float = 0.0


class RiskManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def update(self, settings: Settings) -> None:
        self.settings = settings

    def open_positions(self, db: Session) -> list[Trade]:
        stmt = select(Trade).where(Trade.status == TradeStatus.open.value)
        return list(db.scalars(stmt).all())

    def day_realized_pnl(self, db: Session) -> float:
        start = dt.datetime.now(dt.timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        stmt = select(Trade).where(
            Trade.status == TradeStatus.closed.value, Trade.closed_at >= start
        )
        return float(sum(t.pnl for t in db.scalars(stmt).all()))

    def size_position(self, equity: float, price: float) -> float:
        """Size a position from risk-per-trade % and the configured stop distance.

        Risk amount = equity * risk_per_trade_pct%.
        With a stop at default_stop_loss_pct away, the position notional that
        risks exactly that amount is risk_amount / stop_fraction.
        """
        if price <= 0:
            return 0.0
        risk_amount = equity * (self.settings.risk_per_trade_pct / 100.0)
        stop_fraction = max(self.settings.default_stop_loss_pct / 100.0, 1e-6)
        notional = risk_amount / stop_fraction
        # Never risk more notional than the equity itself.
        notional = min(notional, equity)
        return max(notional / price, 0.0)

    def check(
        self,
        db: Session,
        *,
        equity: float,
        price: float,
        requested_amount: float | None,
        is_opening: bool,
    ) -> RiskDecision:
        """Validate a prospective trade and return a sized decision."""
        if price <= 0:
            return RiskDecision(False, "Invalid price")

        if is_opening:
            open_trades = self.open_positions(db)
            if len(open_trades) >= self.settings.max_open_positions:
                return RiskDecision(
                    False,
                    f"Max open positions reached ({self.settings.max_open_positions})",
                )

            # Daily loss limit (loss is negative pnl).
            day_pnl = self.day_realized_pnl(db)
            loss_limit = -abs(equity * (self.settings.daily_loss_limit_pct / 100.0))
            if day_pnl <= loss_limit:
                return RiskDecision(
                    False,
                    f"Daily loss limit hit (day PnL {day_pnl:.2f} <= {loss_limit:.2f})",
                )

        amount = requested_amount or self.size_position(equity, price)
        if amount <= 0:
            return RiskDecision(False, "Computed position size is zero")

        notional = amount * price
        if is_opening and notional > equity:
            return RiskDecision(
                False,
                f"Order notional {notional:.2f} exceeds available equity {equity:.2f}",
            )

        # Portfolio-level exposure cap: total open notional + this order must stay
        # under max_total_exposure_pct% of equity. Prevents many small positions
        # from quietly stacking into an oversized, correlated book.
        max_exposure_pct = getattr(self.settings, "max_total_exposure_pct", 0.0)
        if is_opening and max_exposure_pct > 0:
            open_notional = sum(
                t.amount * t.entry_price for t in self.open_positions(db)
            )
            cap = equity * (max_exposure_pct / 100.0)
            if open_notional + notional > cap:
                return RiskDecision(
                    False,
                    f"Total exposure {open_notional + notional:.2f} would exceed "
                    f"cap {cap:.2f} ({max_exposure_pct:.0f}% of equity)",
                )

        return RiskDecision(True, "ok", amount)
