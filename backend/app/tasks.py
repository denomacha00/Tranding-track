"""Background loops: market monitoring and periodic status broadcasting."""
from __future__ import annotations

import asyncio
import logging

from app.database import SessionLocal
from app.engine import TradingEngine
from app.ws import Broadcaster

logger = logging.getLogger(__name__)


def _tick(engine: TradingEngine) -> dict:
    """Synchronous DB work: run autonomous analysis, check SL/TP, snapshot status."""
    db = SessionLocal()
    try:
        # Autonomous, analysis-driven trading (only if enabled in settings).
        if getattr(engine.settings, "auto_trade_enabled", False):
            for symbol in engine.settings.auto_symbol_list:
                try:
                    engine.auto_trade_symbol(db, symbol, engine.settings.auto_timeframe)
                except Exception as exc:  # keep the loop resilient per-symbol
                    logger.warning("auto_trade %s failed: %s", symbol, exc)
        engine.check_pending_orders(db)
        engine.check_open_positions(db)
        return engine.status(db)
    finally:
        db.close()


async def monitor_loop(
    engine: TradingEngine, broadcaster: Broadcaster, interval: float = 5.0
) -> None:
    """Periodically check SL/TP and broadcast a status snapshot.

    Runs for the lifetime of the app; only does work while engine.running.
    """
    while True:
        try:
            if engine.running:
                # DB + network work is synchronous; run it off the event loop.
                status = await asyncio.to_thread(_tick, engine)
                await broadcaster.broadcast({"event": "status", "data": status})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - keep loop alive
            logger.exception("monitor_loop error: %s", exc)
        await asyncio.sleep(interval)
