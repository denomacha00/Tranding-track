"""Background loops: per-user market monitoring and status broadcasting."""
from __future__ import annotations

import asyncio
import logging

from app.database import SessionLocal
from app.engine import TradingEngine
from app.ws import Broadcaster

logger = logging.getLogger(__name__)


def _tick_all(manager) -> list[dict]:
    """Synchronous DB work for every active user's engine.

    Runs autonomous analysis (if the user enabled it), checks pending/open
    orders for SL/TP, and returns a status snapshot per user.
    """
    db = SessionLocal()
    statuses: list[dict] = []
    try:
        for user, engine in manager.engines_for_active_users(db):
            try:
                # New-entry analysis is gated on the bot being "running": stopping
                # the bot halts NEW trades. It does NOT stop risk management —
                # open positions must keep their SL/TP protection and the
                # drawdown kill-switch must keep watching real money regardless.
                if engine.running:
                    if getattr(engine.settings, "auto_trade_enabled", False):
                        for symbol in engine.settings.auto_symbol_list:
                            try:
                                engine.auto_trade_symbol(
                                    db, symbol, engine.settings.auto_timeframe
                                )
                            except Exception as exc:  # resilient per-symbol
                                logger.warning(
                                    "auto_trade user=%s %s failed: %s",
                                    user.id, symbol, exc,
                                )
                    else:
                        # Autonomous execution OFF: still analyse + log the brain's
                        # verdict so the Signals tab shows a live read (no orders).
                        for symbol in engine.settings.auto_symbol_list:
                            try:
                                engine.observe_symbol(
                                    db, symbol, engine.settings.auto_timeframe
                                )
                            except Exception as exc:  # resilient per-symbol
                                logger.warning(
                                    "observe user=%s %s failed: %s",
                                    user.id, symbol, exc,
                                )
                # ALWAYS: fill resting orders, run SL/TP on open positions, and
                # update the drawdown kill-switch — even when the bot is stopped.
                engine.check_pending_orders(db)
                engine.check_open_positions(db)
                engine._update_drawdown(db)
                statuses.append({"user_id": user.id, "status": engine.status(db)})
            except Exception as exc:  # keep other users' engines alive
                logger.warning("tick failed for user=%s: %s", user.id, exc)
        return statuses
    finally:
        db.close()


async def monitor_loop(manager, broadcaster: Broadcaster, interval: float = 5.0) -> None:
    """Periodically tick every active user's engine and broadcast status.

    Runs for the lifetime of the app. Status events carry a ``user_id`` so the
    WebSocket layer can route each snapshot to the right client.
    """
    while True:
        try:
            statuses = await asyncio.to_thread(_tick_all, manager)
            for item in statuses:
                await broadcaster.broadcast(
                    {"event": "status", "user_id": item["user_id"], "data": item["status"]}
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - keep loop alive
            logger.exception("monitor_loop error: %s", exc)
        await asyncio.sleep(interval)
